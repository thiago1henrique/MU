import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SyncedLine } from '../lib/lyrics'
import { activeLineIndex } from '../lib/lyrics'
import { FadeImg, HeroVideo } from './cardMedia'
import type { CardVariant } from './RecapCard'
import './RecapCard.css'
import './LyricCard.css'

interface Props {
  variant: CardVariant
  /** Track title, shown in the hero. */
  title: string
  /** Artist name, shown in the hero. */
  artist: string
  /** Album name, shown as the eyebrow in the hero. */
  album?: string
  /** Album cover URL (hero background when no video is uploaded). */
  cover?: string
  /** Object URL of an uploaded video to show in the hero. */
  videoUrl?: string
  videoStart?: number
  videoDuration?: number
  /** Time-synced lyric lines (empty when lrclib has no LRC). */
  syncedLines?: SyncedLine[]
  /**
   * Song time (s) that the clip's first frame corresponds to — the anchor. Set
   * from the line the user marks: that line shows at the clip start, and the
   * following lines animate in as the clip plays.
   */
  lyricOffset?: number
  /** Selected verse, printed statically on the PNG (and when there's no video). */
  quote?: string
  /**
   * When true (on-screen preview with a video), the lyric body follows the
   * playing clip and animates the lines forward. Off (PNG / off-screen node)
   * shows the static verse instead.
   */
  live?: boolean
  /**
   * 'overlay' renders a transparent hero + an empty lyric slot — the video
   * compositor draws the clip behind and the active line into the slot.
   */
  mode?: 'normal' | 'overlay'
  /** Whether the hero video should be paused (disable playback & CPU usage off-screen). */
  paused?: boolean
}

/** Rolling window of lyric lines centered on the active one (preview only). */
function LiveLyrics({
  lines,
  activeIdx,
}: {
  lines: SyncedLine[]
  activeIdx: number
}) {
  const base = activeIdx < 0 ? 0 : activeIdx

  // Lyric lines wrap to different heights, so flexbox centering alone lets the
  // current line drift off-centre (worst at the first/last line). Instead the
  // track is absolutely pinned with its top at the container's vertical centre
  // (CSS `top: 50%`), and we translate it UP by exactly the current line's centre
  // offset — so that line's centre always lands on 50%, whether it's the first,
  // last, or a middle line. The track scrolls smoothly (CSS transition) as
  // playback advances.
  const trackRef = useRef<HTMLDivElement>(null)
  const centerRef = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)

  const measure = useCallback(() => {
    const center = centerRef.current
    if (!center) return
    // offsetTop/offsetHeight are layout values (unaffected by the track's own
    // transform), so this stays stable across re-measures.
    setShift(-(center.offsetTop + center.offsetHeight / 2))
  }, [])

  useLayoutEffect(measure, [measure, activeIdx, lines])

  // Re-centre when the card is resized (responsive breakpoints / font swaps).
  useEffect(() => {
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    if (track.parentElement) ro.observe(track.parentElement)
    return () => ro.disconnect()
  }, [measure])

  return (
    <div
      className="card__lyric-track"
      ref={trackRef}
      style={{ transform: `translateY(${shift}px)` }}
    >
      {lines.map((line, idx) => {
        const dist = Math.abs(idx - base)
        const isActive = idx === activeIdx
        const isVisible = dist <= 1

        return (
          <span
            key={idx}
            // The centre line (active, or the first line before playback starts) is
            // the measurement anchor.
            ref={idx === base ? centerRef : undefined}
            className={`card__lyric-line ${isActive ? 'is-active' : ''}`}
            data-dist={dist}
            style={!isVisible ? { opacity: 0, pointerEvents: 'none' } : undefined}
          >
            {line.text}
          </span>
        )
      })}
    </div>
  )
}

/**
 * Single-song lyric card: album cover (or an uploaded clip) up top, lyrics
 * below. `story` = 1080×1920, `feed` = 1600×900 — same shell/geometry as
 * RecapCard so the PNG/MP4 export pipeline is shared.
 */
export const LyricCard = forwardRef<HTMLDivElement, Props>(function LyricCard(
  {
    variant,
    title,
    artist,
    album,
    cover,
    videoUrl,
    videoStart = 0,
    videoDuration = 15,
    syncedLines = [],
    lyricOffset = 0,
    quote,
    live = false,
    mode = 'normal',
    paused = false,
  },
  ref,
) {
  const overlay = mode === 'overlay'
  const showLive = live && !!videoUrl && syncedLines.length > 0

  // Active line, updated as the clip plays. Kept as an index in state (not the
  // raw time) so the card only re-renders when the highlighted line changes.
  const [activeIdx, setActiveIdx] = useState(-1)
  const lastIdx = useRef(-1)
  const onTime = (ct: number) => {
    // `ct` is the raw video timeline. Rebase it to the clip start so the marked
    // line (`lyricOffset` = its song time) shows at the start of the clip and
    // the following lines animate in as playback advances.
    const songTime = ct - videoStart + lyricOffset
    const idx = activeLineIndex(syncedLines, songTime)
    if (idx !== lastIdx.current) {
      lastIdx.current = idx
      setActiveIdx(idx)
    }
  }

  return (
    <div
      ref={ref}
      className={`card card--${variant} card--lyric ${overlay ? 'card--overlay' : ''} ${
        videoUrl ? 'card--has-video' : ''
      } ${!showLive && quote ? 'card--lyric-static' : ''}`}
    >
      <div className="card__hero">
        {overlay ? null : videoUrl ? (
          <HeroVideo
            src={videoUrl}
            start={videoStart}
            duration={videoDuration}
            onTime={showLive ? onTime : undefined}
            paused={paused}
          />
        ) : cover ? (
          <FadeImg className="card__hero-img" src={cover} />
        ) : (
          <div className="card__hero-img card__hero-img--empty" />
        )}
        <div className="card__hero-overlay" />
        <div className="card__brand" aria-label="echo">
          <svg
            className="card__brand-mark"
            viewBox="0 0 12 17"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M4 10H2V17H4V10Z" />
            <path d="M9.00004 2.04L8.04004 3V9L9.00004 9.94L11.04 11.94V0L9.00004 2.04Z" />
            <path d="M7.04 3H0V9H7.04V3Z" />
          </svg>
          <span className="card__brand-name">echo</span>
        </div>
        <div className="card__hero-text">
          <span className="card__eyebrow">{album || 'Letra'}</span>
          <span className="card__hero-name">{title || '—'}</span>
          {artist && <span className="card__hero-plays">{artist}</span>}
        </div>
      </div>

      <div className="card__body">
        <div className="card__lyric">
          {overlay ? (
            // Empty slot — the compositor blits the active line here per frame.
            <div className="card__lyric-slot" />
          ) : showLive ? (
            <LiveLyrics lines={syncedLines} activeIdx={activeIdx} />
          ) : quote ? (
            <blockquote className="card__quote-text">
              <span className="card__quote-mark">“</span>
              <span className="card__quote-lines">
                {quote.split('\n').map((line, idx) => (
                  <span key={idx} className="card__quote-line">
                    {line || '\u00A0'}
                  </span>
                ))}
              </span>
            </blockquote>
          ) : null}
        </div>
        {(artist || title) && (
          <div className="card__lyric-cite">
            {[title, artist].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
})
