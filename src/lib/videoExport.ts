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
//   • WebCodecs (Chromium): the target path. Runs in two real-time passes to
//     keep the CPU free during each. Pass 1 plays the clip and taps its audio
//     through the WebAudio graph into an AAC AudioEncoder. Pass 2 replays the
//     clip and composites each presented frame into a hardware H.264
//     VideoEncoder. Both streams mux straight to MP4 with mp4-muxer — no ffmpeg
//     transcode (that transcode, single-threaded WASM, was the slow
//     "Convertendo…" step). Splitting audio from video means neither pass ever
//     starves the other, so the video never drops/duplicates frames.
//   • Legacy fallback (Safari/older Firefox): MediaRecorder + ffmpeg.wasm.

import { toPng } from 'html-to-image'
import { activeLineIndex, type SyncedLine } from './lyrics'
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

/** Time-synced lyric layer: an active line is drawn per frame over the card. */
export interface LyricLayerOpts {
  /** Sorted synced lines (index-aligned with the pre-rendered images). */
  lines: SyncedLine[]
  /** Card variant, used to style the pre-rendered line images. */
  variant: 'story' | 'feed'
  /** Song time (s) that the clip's first frame (at `start`) corresponds to. */
  offset: number
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
  /** When set, the active lyric line is composited per frame (lyric mode). */
  lyric?: LyricLayerOpts
}

/** A prepared lyric layer: one image per line + where to draw it in the card. */
interface PreparedLyric {
  images: HTMLImageElement[]
  lines: SyncedLine[]
  shifts: number[]
  rect: Rect
  offset: number
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

/**
 * Pre-renders each synced lyric line to a transparent PNG sized to the card's
 * lyric box, so the compositor can blit the active line per frame without
 * styling text on the canvas (keeps the CSS-driven look). Returns the images
 * plus the box rect (relative to the card) to draw them at.
 *
 * Performance optimization: Only pre-renders lines that will actually be visible
 * during the duration of the exported video clip to avoid freezing/crashing the
 * browser when processing the entire song's lyrics.
 */
async function prepareLyricFrames(
  overlayNode: HTMLElement,
  lyric: LyricLayerOpts,
  _clipStart: number,
  clipDuration: number,
): Promise<PreparedLyric | null> {
  const box = overlayNode.querySelector('.card__lyric') as HTMLElement | null
  if (!box || lyric.lines.length === 0) return null

  const cardRect = overlayNode.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  const rect: Rect = {
    x: boxRect.left - cardRect.left,
    y: boxRect.top - cardRect.top,
    w: boxRect.width,
    h: boxRect.height,
  }
  if (rect.w < 1 || rect.h < 1) return null

  // Slice only the lyrics that will be active in the clip window. Song time is
  // rebased to the clip start, so it runs [offset, offset + clipDuration].
  const minTime = lyric.offset
  const maxTime = lyric.offset + clipDuration

  const firstActiveIdx = Math.max(0, activeLineIndex(lyric.lines, minTime))
  const lastActiveIdx = activeLineIndex(lyric.lines, maxTime)
  // Include the next line as well to prevent any cutoffs/glitches at the boundary.
  const endIdx = lastActiveIdx >= 0 ? Math.min(lyric.lines.length - 1, lastActiveIdx + 1) : 0

  const slicedLines = lyric.lines.slice(firstActiveIdx, endIdx + 1)
  if (slicedLines.length === 0) {
    return { images: [], lines: [], shifts: [], rect, offset: lyric.offset }
  }

  // Offscreen render node: a lyric box fixed to the measured size, wrapped in the
  // card/variant classes so the ancestor CSS (font sizes, colors, vars) applies.
  // The wrap is forced to block/fixed-width: the feed card is `display:flex`, so
  // as a flex container it would collapse the box's width (via `.card__lyric`'s
  // flex:1) and push the text out of frame. `flex:none` on the box guards the
  // same for good measure.
  const wrap = document.createElement('div')
  wrap.className = `card card--${lyric.variant} card--lyric`
  wrap.style.cssText = `position:fixed;left:-99999px;top:0;display:block;width:${rect.w}px;`
  
  // Disable transitions and animations during pre-rendering to prevent any timing or interpolation issues.
  const styleEl = document.createElement('style')
  styleEl.textContent = `
    .card__lyric-track, .card__lyric-line {
      transition: none !important;
      animation: none !important;
    }
  `
  wrap.appendChild(styleEl)

  const renderBox = document.createElement('div')
  renderBox.className = 'card__lyric'
  renderBox.style.width = `${rect.w}px`
  renderBox.style.height = `${rect.h}px`
  renderBox.style.flex = 'none'
  wrap.appendChild(renderBox)
  document.body.appendChild(wrap)

  try {
    const images: HTMLImageElement[] = []
    const shifts: number[] = []
    // Pre-render each active line in the full context of slicedLines
    // so offsetTop values grow linearly and scrolling calculations are accurate!
    for (let idx = 0; idx < slicedLines.length; idx++) {
      // Clear previous elements in the render box
      renderBox.innerHTML = ''

      // Re-create the track container to mimic the LiveLyrics structure and styles perfectly
      const trackEl = document.createElement('div')
      trackEl.className = 'card__lyric-track'
      renderBox.appendChild(trackEl)

      let centerEl: HTMLSpanElement | null = null

      for (let i = 0; i < slicedLines.length; i++) {
        const line = slicedLines[i]
        const lineEl = document.createElement('span')
        lineEl.className = `card__lyric-line ${i === idx ? 'is-active' : ''}`
        
        // Calculate distance from currently active index (idx)
        const dist = Math.abs(i - idx)
        lineEl.setAttribute('data-dist', dist.toString())
        lineEl.textContent = line.text

        // Hide lines outside RADIUS = 1 window to match LiveLyrics behavior while preserving layout spacing
        if (dist > 1) {
          lineEl.style.opacity = '0'
          lineEl.style.pointerEvents = 'none'
        }
        
        trackEl.appendChild(lineEl)

        if (i === idx) {
          centerEl = lineEl
        }
      }

      // Read offsetTop and offsetHeight of centerEl to force a reflow,
      // and translate trackEl UP so centerEl's center is perfectly aligned at 50% height
      let lineShift = 0
      if (centerEl) {
        const offsetTop = centerEl.offsetTop
        const offsetHeight = centerEl.offsetHeight
        const shift = -(offsetTop + offsetHeight / 2)
        trackEl.style.transform = `translateY(${shift}px)`
        lineShift = shift
      }
      shifts.push(lineShift)

      const url = await toPng(renderBox, { pixelRatio: 1, cacheBust: true })
      images.push(await loadImage(url))
    }
    return { images, lines: slicedLines, shifts, rect, offset: lyric.offset }
  } finally {
    document.body.removeChild(wrap)
  }
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
  overlayNode: HTMLElement,
  lyric: PreparedLyric | null,
  clipStart: number,
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

  // Find the minutes text bounding rect relative to the overlay container
  const minutesEl = overlayNode.querySelector('.card__minutes-value') as HTMLElement | null
  let minutesRect: Rect | null = null
  if (minutesEl) {
    const containerRect = overlayNode.getBoundingClientRect()
    const elRect = minutesEl.getBoundingClientRect()
    minutesRect = {
      x: elRect.left - containerRect.left,
      y: elRect.top - containerRect.top,
      w: elRect.width,
      h: elRect.height,
    }
  }

  // Get computed accent color from the DOM
  const accentColor = getComputedStyle(overlayNode).getPropertyValue('--c-accent').trim() || '#e0472d'

  // Offscreen canvas for drawing color animated minutes text
  const tempCanvas = document.createElement('canvas')
  if (minutesRect && minutesRect.w > 0 && minutesRect.h > 0) {
    tempCanvas.width = minutesRect.w
    tempCanvas.height = minutesRect.h
  }
  const tempCtx = tempCanvas.getContext('2d')

  let frameCount = 0
  let lastLyricIdx = -2

  // `mediaTime` (video playback time, s) drives the lyric line; it's undefined
  // for the recap path, which animates purely off frameCount.
  const composite = (mediaTime?: number) => {
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

    // Draw the active lyric line into the lyric box (lyric mode only).
    if (lyric && mediaTime != null) {
      // `mediaTime` is the raw video timeline; rebase to the clip start so
      // `offset` is the song position (s) playing at the start of the clip.
      const songTime = mediaTime - clipStart + lyric.offset
      const idx = activeLineIndex(lyric.lines, songTime)
      lastLyricIdx = idx

      if (idx >= 0) {
        const line = lyric.lines[idx]
        const transitionDur = 0.35 // 350ms transition between verses
        const timeSinceLineStart = songTime - line.t

        if (timeSinceLineStart < transitionDur && timeSinceLineStart >= 0) {
          const progress = timeSinceLineStart / transitionDur
          // Apply trigonometric Cosine Ease-In-Out for a highly organic, ultra-smooth transition
          const eased = (1 - Math.cos(progress * Math.PI)) / 2
          const prevIdx = idx - 1

          const origAlpha = ctx.globalAlpha
          // Calculate the physical scroll offset in pixels between the previous and current line
          const prevShift = prevIdx >= 0 && lyric.shifts ? lyric.shifts[prevIdx] : 0
          const currShift = lyric.shifts ? lyric.shifts[idx] : 0
          const scrollOffset = currShift - prevShift

          // Clip the drawing context to the bounding box of the lyric container
          // to prevent any overflowing scrolled text from rendering on top of the footer.
          ctx.save()
          ctx.beginPath()
          ctx.rect(lyric.rect.x, lyric.rect.y, lyric.rect.w, lyric.rect.h)
          ctx.clip()

          // Fade out the previous line and scroll it upwards
          if (prevIdx >= 0) {
            ctx.globalAlpha = origAlpha * (1 - eased)
            ctx.drawImage(
              lyric.images[prevIdx],
              lyric.rect.x,
              lyric.rect.y + eased * scrollOffset
            )
          }
          // Fade in the current line and scroll it from downwards into the center
          ctx.globalAlpha = origAlpha * eased
          ctx.drawImage(
            lyric.images[idx],
            lyric.rect.x,
            lyric.rect.y + (eased - 1) * scrollOffset
          )
          
          ctx.restore()
          ctx.globalAlpha = origAlpha
        } else {
          // Beyond the transition window, draw normally
          ctx.drawImage(lyric.images[idx], lyric.rect.x, lyric.rect.y)
        }
      }
    } else if (lyric && lastLyricIdx >= 0) {
      // No fresh mediaTime this frame — keep showing the last active line.
      ctx.drawImage(lyric.images[lastLyricIdx], lyric.rect.x, lyric.rect.y)
    }

    // Render animated color sweep over minutes text if available
    if (minutesRect && minutesRect.w > 0 && minutesRect.h > 0 && tempCtx) {
      const t = (frameCount % 60) / 60 // 2-second loop at 30fps
      const grad = tempCtx.createLinearGradient(
        -minutesRect.w + 2 * minutesRect.w * t,
        0,
        2 * minutesRect.w * t,
        0
      )
      grad.addColorStop(0, '#ffffff')
      grad.addColorStop(0.25, accentColor)
      grad.addColorStop(0.5, '#ffffff')
      grad.addColorStop(0.75, accentColor)
      grad.addColorStop(1.0, '#ffffff')

      tempCtx.globalCompositeOperation = 'source-over'
      tempCtx.clearRect(0, 0, minutesRect.w, minutesRect.h)
      tempCtx.drawImage(
        overlay,
        minutesRect.x,
        minutesRect.y,
        minutesRect.w,
        minutesRect.h,
        0,
        0,
        minutesRect.w,
        minutesRect.h
      )
      tempCtx.globalCompositeOperation = 'source-in'
      tempCtx.fillStyle = grad
      tempCtx.fillRect(0, 0, minutesRect.w, minutesRect.h)

      ctx.drawImage(tempCanvas, minutesRect.x, minutesRect.y)
    }

    frameCount++
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

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false
    const done = () => {
      if (resolved) return
      resolved = true
      video.removeEventListener('seeked', onSeeked)
      clearTimeout(timeout)
      resolve()
    }
    const onSeeked = () => {
      done()
    }
    // requestVideoFrameCallback fires as soon as the decoded frame is actually
    // presented — a tighter, more direct signal than 'seeked' (which can lag
    // behind the frame being ready), so it resolves each step sooner when
    // available (Chromium, same tier required by the rest of this path).
    const rvfc = (
      video as unknown as { requestVideoFrameCallback?: (cb: () => void) => number }
    ).requestVideoFrameCallback?.bind(video)
    if (rvfc) rvfc(done)
    else video.addEventListener('seeked', onSeeked)
    // High-performance backstop: resolve after 150ms if the frame is delayed
    const timeout = setTimeout(done, 150)
    video.currentTime = time
  })
}

async function exportViaWebCodecs(opts: VideoExportOpts): Promise<Blob> {
  const { overlayNode, video, canvasW, canvasH, hero, start, duration, onStatus } = opts
  const AUDIO_PLAYBACK_SPEED = 1.0

  onStatus?.('Preparando…')
  const overlayUrl = await toPng(overlayNode, { pixelRatio: 1, cacheBust: true })
  const overlay = await loadImage(overlayUrl)
  const preparedLyric = opts.lyric
    ? await prepareLyricFrames(overlayNode, opts.lyric, start, duration)
    : null

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
  const trackSettings = audioTrack.getSettings()
  const audioSampleRate = trackSettings.sampleRate || ctx.sampleRate
  const audioChannels = trackSettings.channelCount || 2

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
  let currentAudioTimestamp = 0
  // A clip shorter than the requested duration is looped (see `clipLen`
  // below); while that first loop is captured in real time, its encoded
  // chunks are also buffered here so the remaining loops can be synthesized
  // from these bytes instead of re-playing (and re-capturing) identical audio
  // — see the loop-replication step after Phase 1.
  let captureLoopAudio = true
  const loopAudioChunks: { type: EncodedAudioChunk['type']; duration: number; data: ArrayBuffer }[] = []
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      const chunkDuration = (chunk.duration ?? 0) * AUDIO_PLAYBACK_SPEED
      const data = new ArrayBuffer(chunk.byteLength)
      chunk.copyTo(data)
      if (captureLoopAudio) loopAudioChunks.push({ type: chunk.type, duration: chunkDuration, data })
      const newChunk = new EncodedAudioChunk({
        type: chunk.type,
        timestamp: currentAudioTimestamp,
        duration: chunkDuration,
        data: data,
      })
      currentAudioTimestamp += chunkDuration
      muxer.addAudioChunk(newChunk, meta)
    },
    error: onEncErr,
  })
  audioEncoder.configure({
    codec: 'mp4a.40.2',
    sampleRate: audioSampleRate,
    numberOfChannels: audioChannels,
    bitrate: AUDIO_BITRATE,
  })

  const { canvas, composite } = buildCompositor(overlay, video, canvasW, canvasH, hero, overlayNode, preparedLyric, start)

  const totalFrames = Math.max(1, Math.round(duration * FPS))
  const frameDurUs = 1_000_000 / FPS

  // Length of the segment available; a shorter clip loops to fill the duration.
  const segMax = Number.isFinite(video.duration) ? video.duration - start : duration
  const clipLen = Math.max(1 / FPS, Math.min(duration, segMax))

  await prepareVideo(video, start)

  // ---- PHASE 1: AUDIO CAPTURE ----
  // We play the video in real-time, but do NOT render any canvas or encode any video.
  // This ensures the CPU is completely free to capture the audio stream perfectly.
  onStatus?.('Gravando áudio… 0%')
  video.muted = false
  video.playbackRate = AUDIO_PLAYBACK_SPEED
  await video.play()

  function onLoopEnded() {
    try {
      video.currentTime = start
    } catch {
      /* not seekable yet */
    }
    void video.play().catch(() => {})
  }
  video.addEventListener('ended', onLoopEnded)

  let capturing = true
  const reader = new MediaStreamTrackProcessor({ track: audioTrack }).readable.getReader()
  // Capture only one loop's worth of real audio — the rest (if the clip is
  // shorter than `duration`) is synthesized from it after Phase 1.
  const audioCaptureLen = Math.min(duration, clipLen)
  const audioPump = (async () => {
    let firstTs = -1
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!capturing || encoderError) {
        value.close()
        break
      }
      if (firstTs < 0) firstTs = value.timestamp

      const elapsed = (value.timestamp - firstTs) / 1_000_000
      const physicalDurationNeeded = audioCaptureLen / AUDIO_PLAYBACK_SPEED
      const pct = Math.min(100, Math.round((elapsed / physicalDurationNeeded) * 100))
      onStatus?.(`Gravando áudio… ${pct}%`)

      if (elapsed >= physicalDurationNeeded) {
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

  // Wait for audio recording to finish
  await audioPump
  video.pause()
  video.muted = true
  video.playbackRate = 1.0
  video.removeEventListener('ended', onLoopEnded)
  capturing = false
  try {
    await reader.cancel()
  } catch {
    /* already ended */
  }
  source.disconnect() // stop feeding the tap; keep ctx/source cached for reuse
  captureLoopAudio = false

  if (encoderError) {
    videoEncoder.close()
    audioEncoder.close()
    throw encoderError
  }

  // A clip shorter than `duration` was captured once above, in real time;
  // fill the remaining loops from the buffered bytes instead of re-playing
  // (and re-capturing) identical audio — same result, far less wall-clock
  // time for the short-clip-looped-to-a-longer-duration case.
  if (clipLen < duration && loopAudioChunks.length) {
    await audioEncoder.flush() // drain the first loop's chunks before reusing their bytes
    const targetUs = duration * 1_000_000
    while (currentAudioTimestamp < targetUs) {
      for (const c of loopAudioChunks) {
        if (currentAudioTimestamp >= targetUs) break
        const chunkDuration = Math.min(c.duration, targetUs - currentAudioTimestamp)
        muxer.addAudioChunk(
          new EncodedAudioChunk({
            type: c.type,
            timestamp: currentAudioTimestamp,
            duration: chunkDuration,
            data: c.data,
          }),
        )
        currentAudioTimestamp += chunkDuration
      }
    }
  }

  // ---- PHASE 2: VIDEO REAL-TIME CAPTURE ----
  // The previous approach seeked the element frame-by-frame — hundreds of
  // blocking seeks (much slower than real time), and its 150ms stale-frame
  // backstop encoded duplicate frames whenever a seek ran long, which is what
  // made the exported clip judder. Instead we play the clip once in real time
  // and composite whatever frame the browser is actually presenting. Audio is
  // already captured (Phase 1), so the CPU here only composites + H.264-encodes,
  // which Chrome's hardware encoder handles comfortably at 30fps. Output frames
  // are emitted on a fixed 30fps wall clock (CFR) so players never judder.
  onStatus?.('Gravando vídeo… 0%')

  // Rewind to the segment start (Phase 1 left the playhead mid-clip) and play.
  video.muted = true
  video.playbackRate = 1.0
  await seekTo(video, start)

  // Loop the segment if the clip is shorter than the requested duration.
  const onVideoLoopEnded = () => {
    try {
      video.currentTime = start
    } catch {
      /* not seekable yet */
    }
    void video.play().catch(() => {})
  }
  video.addEventListener('ended', onVideoLoopEnded)
  await video.play()

  const frameDurMs = 1000 / FPS
  const captureStart = performance.now()
  // A keyframe every 2s keeps the file scrubbable and broadly decodable
  // (WhatsApp/Instagram) instead of relying on a single leading keyframe.
  const keyframeInterval = FPS * 2

  for (let outIdx = 0; outIdx < totalFrames; outIdx++) {
    // Pace each output frame to the wall clock so the frame the browser is
    // presenting lines up with this frame's position in the clip. If
    // compositing falls behind real time we simply don't wait — the presented
    // frame is still the correct real-time position, so the timeline stays
    // consistent (we never seek, so there are no stale duplicates).
    const targetMs = captureStart + outIdx * frameDurMs
    for (let waitMs = targetMs - performance.now(); waitMs > 0; waitMs = targetMs - performance.now()) {
      await new Promise((r) => setTimeout(r, waitMs))
    }

    // If the segment ended between frames, make sure playback resumes so we
    // never composite a frozen last frame while the loop-seek is pending.
    if (video.paused && !video.seeking) void video.play().catch(() => {})

    // Composite using linear, continuous song time (the lyric/animation layers
    // advance with the output timeline, independent of the video's own loop).
    composite(start + outIdx / FPS)

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(outIdx * frameDurUs),
      duration: Math.round(frameDurUs),
    })
    videoEncoder.encode(frame, { keyFrame: outIdx % keyframeInterval === 0 })
    frame.close()

    // Handle encoder backpressure.
    while (videoEncoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 0))
    }

    if (outIdx % 5 === 0 || outIdx === totalFrames - 1) {
      const pct = Math.min(100, Math.round((outIdx / totalFrames) * 100))
      onStatus?.(`Gravando vídeo… ${pct}%`)
    }
  }

  video.pause()
  video.removeEventListener('ended', onVideoLoopEnded)

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
  const preparedLyric = opts.lyric
    ? await prepareLyricFrames(overlayNode, opts.lyric, start, duration)
    : null

  const { canvas, composite } = buildCompositor(overlay, video, canvasW, canvasH, hero, overlayNode, preparedLyric, start)

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
    // Restart the segment when a short clip reaches its end so playback keeps
    // going (a paused, ended video would otherwise freeze the recorded frames).
    function onLoopEnded() {
      if (done) return
      try {
        video.currentTime = start
      } catch {
        /* not seekable yet */
      }
      void video.play().catch(() => {})
    }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(watchdog)
      video.removeEventListener('ended', onLoopEnded)
      resolve()
    }
    video.addEventListener('ended', onLoopEnded)
    const watchdog = setTimeout(finish, (duration + 1) * 1000)
    const schedule = () => {
      if (rvfc) rvfc(frame)
      else requestAnimationFrame(frame)
    }
    const frame = () => {
      if (done) return
      composite(video.currentTime)
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
      if (video.currentTime >= start + duration || video.ended) {
        video.currentTime = start
        if (video.paused) void video.play().catch(() => {})
      }
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
