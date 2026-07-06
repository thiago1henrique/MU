// Video export pipeline.
//
// Composites an uploaded video clip into the card's hero region and records the
// whole card as a video, then transcodes to MP4 (postable on Instagram/Twitter)
// with ffmpeg.wasm.
//
// Per frame we draw: (1) the card background gradient, (2) the video frame
// (object-fit: cover) into the hero rect, (3) a pre-rendered overlay PNG of the
// card with a transparent hero — its gradient/text sit over the video, and its
// body sits over the background.

import { toPng } from 'html-to-image'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
// Self-hosted ffmpeg core (served same-origin by Vite) — avoids the ~30MB CDN
// download. Only used as a fallback when the browser can't record MP4 directly.
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface VideoExportOpts {
  overlayNode: HTMLElement
  video: HTMLVideoElement
  canvasW: number
  canvasH: number
  hero: Rect
  start: number
  duration: number
  onStatus?: (s: string) => void
}

const FPS = 30

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Falha ao carregar overlay.'))
    img.src = src
  })
}

/** Source-rect crop so the video covers the destination rect (object-fit: cover). */
function coverCrop(vw: number, vh: number, dw: number, dh: number) {
  const dAsp = dw / dh
  const sAsp = vw / vh
  if (sAsp > dAsp) {
    const sw = vh * dAsp
    return { sx: (vw - sw) / 2, sy: 0, sw, sh: vh }
  }
  const sh = vw / dAsp
  return { sx: 0, sy: (vh - sh) / 2, sw: vw, sh }
}

// Prefer a codec MediaRecorder can write straight to MP4 (Chrome/Edge 130+,
// Safari). When the recorder produces MP4, we skip the ffmpeg transcode
// entirely — that transcode is the slow "Convertendo…" step. WebM codecs are
// the fallback for browsers without native MP4 recording.
function pickRecording(): { mime: string; ext: 'mp4' | 'webm' } {
  const supported = (m: string) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)

  const mp4 = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ]
  for (const m of mp4) if (supported(m)) return { mime: m, ext: 'mp4' }

  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  for (const m of webm) if (supported(m)) return { mime: m, ext: 'webm' }

  return { mime: 'video/webm', ext: 'webm' }
}

let ffmpegInstance: FFmpeg | null = null
async function getFFmpeg(onStatus?: (s: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance
  const ff = new FFmpeg()
  ff.on('log', ({ message }) => console.log('[ffmpeg]', message))
  ff.on('progress', ({ progress }) => onStatus?.(`Convertendo… ${Math.round(progress * 100)}%`))
  onStatus?.('Carregando conversor (só na 1ª vez)…')
  // Absolute, same-origin URLs so the module worker's dynamic import() resolves
  // regardless of how the worker itself is served.
  const core = new URL(coreURL, document.baseURI).href
  const wasm = new URL(wasmURL, document.baseURI).href

  const load = ff.load({ coreURL: core, wasmURL: wasm })
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Tempo esgotado ao carregar o conversor (ffmpeg).')), 30_000),
  )
  await Promise.race([load, timeout])
  ffmpegInstance = ff
  return ff
}

interface CaptureVideo extends HTMLVideoElement {
  captureStream?: () => MediaStream
}

/** Records the composited card and returns an MP4 blob (WebM if MP4 fails). */
export async function exportCardVideo(
  opts: VideoExportOpts,
): Promise<{ blob: Blob; ext: 'mp4' | 'webm' }> {
  const { overlayNode, video, canvasW, canvasH, hero, start, duration, onStatus } = opts

  onStatus?.('Preparando…')
  // Overlay: capture with a transparent background so the hero shows the video.
  const overlayUrl = await toPng(overlayNode, { pixelRatio: 1, cacheBust: true })
  const overlay = await loadImage(overlayUrl)

  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  // `alpha: false` lets the compositor skip per-pixel blending against the page;
  // the background gradient fills the whole canvas each frame anyway.
  const ctx = canvas.getContext('2d', { alpha: false })!

  // Background gradient is constant — build it once instead of allocating a new
  // gradient object every frame (per-frame allocation pressures the GC and can
  // cause the exact hitches we're trying to avoid).
  const bgGradient = ctx.createLinearGradient(0, 0, canvasW * 0.4, canvasH)
  bgGradient.addColorStop(0, '#17121f')
  bgGradient.addColorStop(1, '#0d0b14')
  const drawBackground = () => {
    ctx.fillStyle = bgGradient
    ctx.fillRect(0, 0, canvasW, canvasH)
  }

  // Offscreen buffer used to dissolve the video's trailing edge into
  // transparency, so the hero blends into the body instead of ending on a hard
  // line — mirrors the CSS mask on .card__hero-img in RecapCard.css.
  const heroCanvas = document.createElement('canvas')
  heroCanvas.width = hero.w
  heroCanvas.height = hero.h
  const hctx = heroCanvas.getContext('2d')!
  // Story hero is a top band (fade down); feed hero is a left column (fade right).
  const fadeVertical = hero.h < canvasH
  const FADE_START = fadeVertical ? 0.48 : 0.52
  const fadeMask = fadeVertical
    ? hctx.createLinearGradient(0, 0, 0, hero.h)
    : hctx.createLinearGradient(0, 0, hero.w, 0)
  fadeMask.addColorStop(0, 'rgba(0,0,0,0)')
  fadeMask.addColorStop(FADE_START, 'rgba(0,0,0,0)')
  fadeMask.addColorStop(1, 'rgba(0,0,0,1)')

  // Build the recording stream: canvas video + the clip's audio.
  const canvasStream = canvas.captureStream(FPS)
  const tracks = [...canvasStream.getVideoTracks()]
  const cv = video as CaptureVideo
  const grab = cv.captureStream?.bind(cv)
  let hasAudio = false
  if (grab) {
    try {
      const audioTracks = grab().getAudioTracks()
      audioTracks.forEach((t) => tracks.push(t))
      hasAudio = audioTracks.length > 0
    } catch {
      /* no audio track — export silently */
    }
  }
  const stream = new MediaStream(tracks)

  const { mime, ext: recordedExt } = pickRecording()
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const recorded = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }))
  })

  // Make sure the video is decodable (readyState >= HAVE_CURRENT_DATA) so that
  // videoWidth/Height are known — otherwise drawImage() throws.
  video.muted = true
  if (video.readyState < 2) {
    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup()
        resolve()
      }
      const fail = () => {
        cleanup()
        reject(new Error('Não consegui carregar o vídeo enviado.'))
      }
      const cleanup = () => {
        video.removeEventListener('loadeddata', ok)
        video.removeEventListener('error', fail)
      }
      video.addEventListener('loadeddata', ok)
      video.addEventListener('error', fail)
      video.load()
    })
  }
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('O vídeo não tem dimensões válidas.')
  }

  // Seek to the segment start. Setting currentTime to its current value does
  // not fire 'seeked', so fall back to a short timeout.
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('seeked', finish)
      resolve()
    }
    video.addEventListener('seeked', finish)
    video.currentTime = start
    setTimeout(finish, 500)
  })
  await video.play()

  // Source crop is constant for the whole recording (video dimensions and the
  // hero rect never change) — compute it once instead of per frame.
  const { sx, sy, sw, sh } = coverCrop(video.videoWidth, video.videoHeight, hero.w, hero.h)

  const composite = () => {
    drawBackground()
    // Draw the video into the offscreen buffer, then erase its trailing edge
    // with the fade gradient so the background (already on ctx) shows through.
    hctx.globalCompositeOperation = 'source-over'
    hctx.clearRect(0, 0, hero.w, hero.h)
    hctx.drawImage(video, sx, sy, sw, sh, 0, 0, hero.w, hero.h)
    hctx.globalCompositeOperation = 'destination-out'
    hctx.fillStyle = fadeMask
    hctx.fillRect(0, 0, hero.w, hero.h)
    ctx.drawImage(heroCanvas, hero.x, hero.y)
    ctx.drawImage(overlay, 0, 0, canvasW, canvasH)
  }

  // Prefer requestVideoFrameCallback: it fires once per *decoded* video frame,
  // so we composite exactly when there is new content (≈ the clip's native fps)
  // instead of blindly at rAF's ~60Hz — that halved the wasted draws that were
  // starving MediaRecorder on slower devices and dropping frames. Falls back to
  // rAF where rVFC is unavailable (older Firefox).
  // Cast through unknown rather than extending HTMLVideoElement: some TS DOM
  // libs type requestVideoFrameCallback as a required method (with a different
  // callback signature), which makes an `extends` redeclaration a type error.
  // It's genuinely absent on older Firefox, so we still probe for it at runtime.
  const rvfc = (
    video as unknown as { requestVideoFrameCallback?: (cb: () => void) => number }
  ).requestVideoFrameCallback?.bind(video)

  onStatus?.('Gravando… 0%')
  recorder.start()
  const startedAt = performance.now()
  let lastPct = -1

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(watchdog)
      resolve()
    }
    // rVFC only fires on new decoded frames, so a stalled video would hang the
    // loop forever. This wall-clock backstop guarantees we stop recording.
    const watchdog = setTimeout(finish, (duration + 1) * 1000)
    const schedule = () => {
      if (rvfc) rvfc(frame)
      else requestAnimationFrame(frame)
    }
    const frame = () => {
      if (done) return
      composite()

      const elapsed = (performance.now() - startedAt) / 1000
      const pct = Math.min(100, Math.round((elapsed / duration) * 100))
      if (pct !== lastPct) {
        lastPct = pct
        onStatus?.(`Gravando… ${pct}%`)
      }
      if (elapsed >= duration) {
        finish()
        return
      }
      // Loop the clip if it is shorter than the requested duration.
      if (video.currentTime >= start + duration || video.ended) video.currentTime = start
      schedule()
    }
    schedule()
  })

  recorder.stop()
  video.pause()
  const recording = await recorded

  // Always transcode through ffmpeg — even when the browser recorded MP4
  // natively. MediaRecorder emits a *variable* frame rate (VFR), which some
  // players/devices judder on during playback. Re-encoding to a constant 30fps
  // (`-r`/`-fps_mode cfr`) is what makes the downloaded file play smoothly
  // everywhere. If ffmpeg fails, fall back to the raw recording so the export
  // still produces a usable file.
  //
  // WhatsApp is fussy about MP4s: it refuses to preview/play files with no
  // audio stream (they open as a "document") and older Android decoders choke
  // on H.264 High profile. So we force main profile + level 4.0 and always
  // guarantee an audio track — the clip's real audio when it has one, a silent
  // track (`anullsrc`) otherwise.
  const inName = `in.${recordedExt}`
  try {
    onStatus?.('Convertendo para MP4…')
    const ff = await getFFmpeg(onStatus)
    await ff.writeFile(inName, await fetchFile(recording))
    await ff.exec([
      '-i',
      inName,
      // Silent audio fallback so the output always has a stream WhatsApp can read.
      ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
      // Map the video, plus the clip's audio (0:a) or the silent input (1:a).
      '-map',
      '0:v:0',
      '-map',
      hasAudio ? '0:a:0' : '1:a:0',
      // With the silent input we need -shortest so it doesn't run forever.
      ...(hasAudio ? [] : ['-shortest']),
      // Force constant frame rate — the whole point of the transcode.
      '-r',
      String(FPS),
      '-fps_mode',
      'cfr',
      '-c:v',
      'libx264',
      // Broad decoder compatibility (WhatsApp, older Android).
      '-profile:v',
      'main',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      'out.mp4',
    ])
    const data = (await ff.readFile('out.mp4')) as Uint8Array
    // Copy into a plain ArrayBuffer-backed view so it is a valid BlobPart.
    const bytes = new Uint8Array(data.byteLength)
    bytes.set(data)
    onStatus?.('Pronto!')
    return { blob: new Blob([bytes], { type: 'video/mp4' }), ext: 'mp4' }
  } catch (err) {
    console.error('Conversão CFR falhou, salvando gravação original:', err)
    onStatus?.('Conversão falhou — salvando arquivo original…')
    return { blob: recording, ext: recordedExt }
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
