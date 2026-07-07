import { forwardRef, useRef, useState } from 'react'
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
  // Show the active line plus two neighbors on each side, dimmed by distance.
  const from = Math.max(0, activeIdx - 2)
  const to = Math.min(lines.length, (activeIdx < 0 ? 0 : activeIdx) + 3)
  const window = lines.slice(from, to)
  return (
    <>
      {window.map((l, i) => {
        const idx = from + i
        return (
          <span
            key={idx}
            className={`card__lyric-line ${idx === activeIdx ? 'is-active' : ''}`}
          >
            {l.text}
          </span>
        )
      })}
    </>
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
      }`}
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
              <span className="card__quote-lines">{quote}</span>
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
