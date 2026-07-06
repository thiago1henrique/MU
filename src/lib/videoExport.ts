// Video export pipeline.
//
// Composites an uploaded video clip into the card's hero region and encodes the
// whole card as an MP4.
//
// Per frame we draw: (1) the card background gradient, (2) the video frame
// (object-fit: cover) into the hero rect, (3) a pre-rendered overlay PNG of the
// card with a transparent hero — its gradient/text sit over the video, and its
// body sits over the background.
//
// Two encoders:
//   • WebCodecs (Chromium): the clip plays once in real time while we composite
//     each frame and feed it to a hardware H.264 VideoEncoder; its audio is
//     tapped through the WebAudio graph into an AAC AudioEncoder. Both streams
//     mux straight to MP4 with mp4-muxer — no ffmpeg transcode (that transcode,
//     single-threaded WASM, was the slow "Convertendo…" step). This is the fast
//     path: capture ≈ clip length, then an instant mux.
//   • Legacy fallback (Safari/older Firefox): MediaRecorder + ffmpeg.wasm.

import { toPng } from 'html-to-image'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
// Self-hosted ffmpeg core (served same-origin by Vite) — avoids the ~30MB CDN
// download. Only used by the legacy fallback path.
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

// MediaStreamTrackProcessor (Chromium) isn't in the TS DOM lib yet. Minimal
// declaration for the audio-track reader we use in the WebCodecs path.
declare global {
  interface MediaStreamTrackProcessor<T = AudioData> {
    readable: ReadableStream<T>
  }
  var MediaStreamTrackProcessor: {
    prototype: MediaStreamTrackProcessor
    new (init: { track: MediaStreamTrack; maxBufferSize?: number }): MediaStreamTrackProcessor<AudioData>
  }
}

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
// H.264 Main profile, level 4.0 — broad decoder compatibility (WhatsApp, older
// Android). Level 4.0 covers both 1080×1920 and 1600×900.
const AVC_CODEC = 'avc1.4D0028'
const VIDEO_BITRATE = 6_000_000
const AUDIO_BITRATE = 128_000

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

// ---------------------------------------------------------------------------
// Shared compositor: builds the canvas + per-frame draw routine used by both
// the WebCodecs and legacy paths.
// ---------------------------------------------------------------------------
function buildCompositor(
  overlay: HTMLImageElement,
  video: HTMLVideoElement,
  canvasW: number,
  canvasH: number,
  hero: Rect,
) {
  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  // `alpha: false` lets the compositor skip per-pixel blending against the page;
  // the background gradient fills the whole canvas each frame anyway.
  const ctx = canvas.getContext('2d', { alpha: false })!

  // Background gradient is constant — build it once instead of allocating a new
  // gradient object every frame.
  const bgGradient = ctx.createLinearGradient(0, 0, canvasW * 0.4, canvasH)
  bgGradient.addColorStop(0, '#17121f')
  bgGradient.addColorStop(1, '#0d0b14')

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

  // Source crop is constant for the whole recording (video dimensions and the
  // hero rect never change) — compute it once.
  const { sx, sy, sw, sh } = coverCrop(video.videoWidth, video.videoHeight, hero.w, hero.h)

  const composite = () => {
    ctx.fillStyle = bgGradient
    ctx.fillRect(0, 0, canvasW, canvasH)
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

  return { canvas, composite }
}

/** Wait for the video to be decodable and seek to the segment start. */
async function prepareVideo(video: HTMLVideoElement, start: number) {
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
}

// ===========================================================================
// WebCodecs path (fast)
// ===========================================================================

function hasWebCodecs(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    // We tap the clip's audio through a MediaStreamTrackProcessor; without it
    // (Safari) there's no audio, so defer to the MediaRecorder fallback.
    typeof MediaStreamTrackProcessor !== 'undefined'
  )
}

async function videoConfigSupported(width: number, height: number): Promise<boolean> {
  try {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: AVC_CODEC,
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
    })
    return !!supported
  } catch {
    return false
  }
}

// A MediaElementAudioSourceNode can be created only once per element, and
// creating it permanently reroutes the element's audio into the graph. Cache it
// so re-exports reuse the same node instead of throwing.
interface AudioGraph {
  ctx: AudioContext
  source: MediaElementAudioSourceNode
}
const audioGraphs = new WeakMap<HTMLVideoElement, AudioGraph>()
function getAudioGraph(video: HTMLVideoElement): AudioGraph {
  let g = audioGraphs.get(video)
  if (!g) {
    const ctx = new AudioContext()
    // Once this node exists the element no longer plays to the speakers unless
    // we connect it to ctx.destination (we never do) — so audio stays silent
    // for the user while we tap it for the export.
    const source = ctx.createMediaElementSource(video)
    g = { ctx, source }
    audioGraphs.set(video, g)
  }
  return g
}

async function exportViaWebCodecs(opts: VideoExportOpts): Promise<Blob> {
  const { overlayNode, video, canvasW, canvasH, hero, start, duration, onStatus } = opts

  onStatus?.('Preparando…')
  const overlayUrl = await toPng(overlayNode, { pixelRatio: 1, cacheBust: true })
  const overlay = await loadImage(overlayUrl)

  // Tap the clip's audio through the WebAudio graph. decodeAudioData can't be
  // used here — it throws EncodingError on most *video* containers — so we route
  // the element's live audio into a MediaStreamAudioDestinationNode and read it
  // as AudioData during playback. The destination always yields audio (silence
  // if the clip has none), guaranteeing an audio track for WhatsApp.
  const { ctx, source } = getAudioGraph(video)
  if (ctx.state === 'suspended') await ctx.resume()
  const dest = ctx.createMediaStreamDestination()
  source.disconnect()
  source.connect(dest)
  const audioTrack = dest.stream.getAudioTracks()[0]
  const audioSampleRate = ctx.sampleRate
  const audioChannels = 2

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: canvasW, height: canvasH, frameRate: FPS },
    audio: { codec: 'aac', numberOfChannels: audioChannels, sampleRate: audioSampleRate },
    fastStart: 'in-memory', // metadata at the front — the +faststart equivalent.
    // The audio tap's timestamps are wall-clock (document age), not zero-based;
    // 'offset' rebases each track to start at 0 so playback isn't front-padded.
    firstTimestampBehavior: 'offset',
  })

  let encoderError: Error | null = null
  const onEncErr = (e: Error) => {
    if (!encoderError) encoderError = e
  }
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: onEncErr,
  })
  videoEncoder.configure({
    codec: AVC_CODEC,
    width: canvasW,
    height: canvasH,
    bitrate: VIDEO_BITRATE,
    framerate: FPS,
    // 'avc' → decoderConfig carries the avcC box the muxer needs.
    avc: { format: 'avc' },
  })
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: onEncErr,
  })
  audioEncoder.configure({
    codec: 'mp4a.40.2',
    sampleRate: audioSampleRate,
    numberOfChannels: audioChannels,
    bitrate: AUDIO_BITRATE,
  })

  const { canvas, composite } = buildCompositor(overlay, video, canvasW, canvasH, hero)

  await prepareVideo(video, start)
  // Unmute so the tap carries real audio; the source node above keeps the
  // speakers silent (its output is never connected to ctx.destination).
  video.muted = false
  await video.play()

  const totalFrames = Math.max(1, Math.round(duration * FPS))
  const frameDurUs = 1_000_000 / FPS
  let outIdx = 0

  // Emit constant-frame-rate frames from the *current* canvas for every output
  // slot up to `effSec` of composited playback time. Decouples output pacing
  // from decode jitter: a slow frame duplicates, a fast one is sampled down.
  const emitUpTo = (effSec: number) => {
    while (outIdx < totalFrames && outIdx / FPS <= effSec + 1e-6) {
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(outIdx * frameDurUs),
        duration: Math.round(frameDurUs),
      })
      videoEncoder.encode(frame, { keyFrame: outIdx === 0 })
      frame.close()
      outIdx++
    }
  }

  // ---- Audio pump: read AudioData frames and feed the encoder concurrently. ----
  let audioStop = false
  const reader = new MediaStreamTrackProcessor({ track: audioTrack }).readable.getReader()
  const audioPump = (async () => {
    let firstTs = -1
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (audioStop || encoderError) {
        value.close()
        break
      }
      if (firstTs < 0) firstTs = value.timestamp
      // Trim to the target duration by the audio's own timeline, so its length
      // matches the CFR video regardless of wall-clock capture time.
      if ((value.timestamp - firstTs) / 1_000_000 >= duration) {
        value.close()
        break
      }
      try {
        audioEncoder.encode(value)
      } catch (e) {
        onEncErr(e as Error)
      }
      value.close()
    }
  })()

  // Pull video frames. requestVideoFrameCallback fires once per decoded frame.
  const rvfc = (
    video as unknown as {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
    }
  ).requestVideoFrameCallback?.bind(video)

  onStatus?.('Gravando… 0%')
  let lastMedia = -1
  let base = 0 // accumulated playback time across loop restarts
  let lastPct = -1

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(watchdog)
      resolve()
    }
    // rVFC only fires on new decoded frames, so a stalled clip would hang the
    // loop. This wall-clock backstop guarantees we stop.
    const watchdog = setTimeout(finish, (duration + 4) * 1000)

    const onDecoded = async (mediaTime: number) => {
      if (done) return
      composite()

      // Detect a loop restart (mediaTime jumped backwards) and carry the span.
      if (lastMedia >= 0 && mediaTime + 1e-3 < lastMedia) base += lastMedia - start
      lastMedia = mediaTime
      const eff = base + (mediaTime - start)

      emitUpTo(eff)

      const pct = Math.min(100, Math.round((outIdx / totalFrames) * 100))
      if (pct !== lastPct) {
        lastPct = pct
        onStatus?.(`Gravando… ${pct}%`)
      }

      if (encoderError || outIdx >= totalFrames) {
        finish()
        return
      }
      // Loop the clip if it is shorter than the requested duration (the app
      // normally clamps duration ≤ clip length, so this rarely triggers).
      if (video.currentTime >= start + duration || video.ended) video.currentTime = start

      // Backpressure: don't let VideoFrames pile up faster than the hardware
      // encoder drains them (each frame holds a full-res GPU buffer).
      while (videoEncoder.encodeQueueSize > 8 && !done) {
        await new Promise((r) => setTimeout(r, 0))
      }
      schedule()
    }
    const schedule = () => {
      if (rvfc) rvfc((_now, meta) => void onDecoded(meta.mediaTime))
      else requestAnimationFrame(() => void onDecoded(video.currentTime))
    }
    schedule()
  })

  // Playback may have ended a hair early — pad the tail so the output is exactly
  // `duration` long.
  if (!encoderError) emitUpTo(duration)

  video.pause()
  video.muted = true
  audioStop = true
  try {
    await reader.cancel()
  } catch {
    /* already ended */
  }
  await audioPump
  source.disconnect() // stop feeding the tap; keep ctx/source cached for reuse

  if (encoderError) {
    videoEncoder.close()
    audioEncoder.close()
    throw encoderError
  }
  await videoEncoder.flush()
  videoEncoder.close()
  onStatus?.('Processando áudio…')
  await audioEncoder.flush()
  audioEncoder.close()
  if (encoderError) throw encoderError

  onStatus?.('Finalizando…')
  muxer.finalize()
  const { buffer } = muxer.target as ArrayBufferTarget
  onStatus?.('Pronto!')
  return new Blob([buffer], { type: 'video/mp4' })
}

// ===========================================================================
// Legacy path (MediaRecorder + ffmpeg.wasm) — fallback for browsers without
// WebCodecs (e.g. older Firefox).
// ===========================================================================

// Prefer a codec MediaRecorder can write straight to MP4. WebM codecs are the
// fallback for browsers without native MP4 recording.
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

async function exportViaMediaRecorder(
  opts: VideoExportOpts,
): Promise<{ blob: Blob; ext: 'mp4' | 'webm' }> {
  const { overlayNode, video, canvasW, canvasH, hero, start, duration, onStatus } = opts

  onStatus?.('Preparando…')
  const overlayUrl = await toPng(overlayNode, { pixelRatio: 1, cacheBust: true })
  const overlay = await loadImage(overlayUrl)

  const { canvas, composite } = buildCompositor(overlay, video, canvasW, canvasH, hero)

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

  await prepareVideo(video, start)
  await video.play()

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
      if (video.currentTime >= start + duration || video.ended) video.currentTime = start
      schedule()
    }
    schedule()
  })

  recorder.stop()
  video.pause()
  const recording = await recorded

  // Re-encode to constant 30fps MP4 — MediaRecorder emits VFR that some players
  // judder on, and we force main/level 4.0 + a guaranteed audio track for
  // WhatsApp compatibility. If ffmpeg fails, keep the raw recording.
  const inName = `in.${recordedExt}`
  try {
    onStatus?.('Convertendo para MP4…')
    const ff = await getFFmpeg(onStatus)
    await ff.writeFile(inName, await fetchFile(recording))
    await ff.exec([
      '-i',
      inName,
      ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
      '-map',
      '0:v:0',
      '-map',
      hasAudio ? '0:a:0' : '1:a:0',
      ...(hasAudio ? [] : ['-shortest']),
      '-r',
      String(FPS),
      '-fps_mode',
      'cfr',
      '-c:v',
      'libx264',
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

// ===========================================================================
// Public entry point: pick the fast WebCodecs path when available, else the
// MediaRecorder + ffmpeg fallback.
// ===========================================================================

/** Records the composited card and returns an MP4 blob (WebM if everything fails). */
export async function exportCardVideo(
  opts: VideoExportOpts,
): Promise<{ blob: Blob; ext: 'mp4' | 'webm' }> {
  if (hasWebCodecs() && (await videoConfigSupported(opts.canvasW, opts.canvasH))) {
    try {
      const blob = await exportViaWebCodecs(opts)
      return { blob, ext: 'mp4' }
    } catch (err) {
      // WebCodecs can fail mid-encode on some drivers — fall back to the
      // battle-tested MediaRecorder path rather than failing the export.
      console.error('WebCodecs falhou, usando MediaRecorder:', err)
    }
  }
  return exportViaMediaRecorder(opts)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
