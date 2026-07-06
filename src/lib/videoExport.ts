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
  const ctx = canvas.getContext('2d')!

  const drawBackground = () => {
    const g = ctx.createLinearGradient(0, 0, canvasW * 0.4, canvasH)
    g.addColorStop(0, '#17121f')
    g.addColorStop(1, '#0d0b14')
    ctx.fillStyle = g
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
  if (grab) {
    try {
      grab()
        .getAudioTracks()
        .forEach((t) => tracks.push(t))
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

  onStatus?.('Gravando… 0%')
  recorder.start()
  const startedAt = performance.now()
  let lastPct = -1

  await new Promise<void>((resolve) => {
    const frame = () => {
      drawBackground()
      const { sx, sy, sw, sh } = coverCrop(video.videoWidth, video.videoHeight, hero.w, hero.h)
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

      const elapsed = (performance.now() - startedAt) / 1000
      const pct = Math.min(100, Math.round((elapsed / duration) * 100))
      if (pct !== lastPct) {
        lastPct = pct
        onStatus?.(`Gravando… ${pct}%`)
      }
      if (elapsed >= duration) {
        resolve()
        return
      }
      // Loop the clip if it is shorter than the requested duration.
      if (video.currentTime >= start + duration || video.ended) video.currentTime = start
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

  recorder.stop()
  video.pause()
  const recording = await recorded

  // Fast path: the browser already recorded MP4, so there is nothing to
  // transcode — return it immediately (this skips the slow ffmpeg step).
  if (recordedExt === 'mp4') {
    onStatus?.('Pronto!')
    return { blob: recording, ext: 'mp4' }
  }

  // Fallback: transcode the recorded WebM to MP4. If ffmpeg fails, fall back to
  // the WebM so the export still produces a file.
  try {
    onStatus?.('Convertendo para MP4…')
    const ff = await getFFmpeg(onStatus)
    await ff.writeFile('in.webm', await fetchFile(recording))
    await ff.exec([
      '-i',
      'in.webm',
      '-c:v',
      'libx264',
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
    return { blob: new Blob([bytes], { type: 'video/mp4' }), ext: 'mp4' }
  } catch (err) {
    console.error('Conversão para MP4 falhou, salvando WebM:', err)
    onStatus?.('Conversão MP4 falhou — salvando WebM…')
    return { blob: recording, ext: 'webm' }
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
