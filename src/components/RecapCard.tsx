import { forwardRef } from 'react'
import type { Recap } from '../types'
import { periodLabel, SOURCE_LABEL } from '../types'
import { fmt, minutesLabel, plays } from '../lib/format'
import { FadeImg, HeroVideo } from './cardMedia'
import './RecapCard.css'

export type CardVariant = 'story' | 'feed'

interface Props {
  recap: Recap
  variant: CardVariant
  /** Optional lyric quote shown between the lists and the minutes footer. */
  quote?: string
  /** Name of the song the quote is from. */
  quoteSong?: string
  /** Object URL of an uploaded video to show in the hero. */
  videoUrl?: string
  /** Start (s) of the shown clip segment. */
  videoStart?: number
  /** Duration (s) of the shown clip segment. */
  videoDuration?: number
  /**
   * 'overlay' renders the card with a transparent hero (no image/video) — used
   * to capture the static overlay that is composited over the video on export.
   */
  mode?: 'normal' | 'overlay'
  /** Whether the hero video should be paused (disable playback & CPU usage off-screen). */
  paused?: boolean
}

/**
 * The shareable card. `story` = 1080×1920 (Instagram story, vertical),
 * `feed` = 1600×900 (Twitter feed, landscape). Both render at exact pixel
 * sizes so html-to-image exports them 1:1.
 */
export const RecapCard = forwardRef<HTMLDivElement, Props>(
  (
    { recap, variant, quote, quoteSong, videoUrl, videoStart = 0, videoDuration = 15, mode = 'normal', paused = false },
    ref,
  ) => {
  const { minutes, hours } = minutesLabel(recap.minutes ?? 0)
  const period = periodLabel(recap.source, recap.period)
  const overlay = mode === 'overlay'
  const hasMinutes = recap.minutes != null
  const hasScrobbles = recap.scrobbles != null
  // Spotify exposes no play counts; its top genres stand in for the number.
  const genres = recap.genres ?? []
  const hasGenres = !hasMinutes && genres.length > 0

  return (
    <div ref={ref} className={`card card--${variant} card--${recap.source} ${overlay ? 'card--overlay' : ''} ${videoUrl ? 'card--has-video' : ''}`}>
      <div className="card__hero">
        {overlay ? null : videoUrl ? (
          <HeroVideo src={videoUrl} start={videoStart} duration={videoDuration} paused={paused} />
        ) : recap.heroImage ? (
          <FadeImg className="card__hero-img" src={recap.heroImage} />
        ) : (
          <div className="card__hero-img card__hero-img--empty" />
        )}
        <div className="card__hero-overlay" />
        <div className="card__hero-text">
          <span className="card__eyebrow">Recap · {period}</span>
          <span className="card__hero-label">Artista mais ouvido</span>
          <span className="card__hero-name">{recap.heroArtist?.name ?? '—'}</span>
          {recap.heroArtist?.playcount != null && (
            <span className="card__hero-plays">{plays(recap.heroArtist.playcount)}</span>
          )}
        </div>
      </div>

      <div className="card__body">
        <div className="card__lists">
          <section className="card__list">
            <h3 className="card__list-title">Top artistas</h3>
            <ol className="card__items">
              {recap.topArtists.map((a, i) => (
                <li className="card__item" key={`a-${i}`}>
                  <span className="card__rank">{i + 1}</span>
                  {a.image ? (
                    <FadeImg className="card__thumb" src={a.image} />
                  ) : (
                    <span className="card__thumb card__thumb--empty" />
                  )}
                  <span className="card__item-text">
                    <span className="card__item-name">{a.name}</span>
                    {a.playcount != null && (
                      <span className="card__item-sub">{plays(a.playcount)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="card__list">
            <h3 className="card__list-title">Top músicas</h3>
            <ol className="card__items">
              {recap.topTracks.map((t, i) => (
                <li className="card__item" key={`t-${i}`}>
                  <span className="card__rank">{i + 1}</span>
                  {t.image ? (
                    <FadeImg className="card__thumb" src={t.image} />
                  ) : (
                    <span className="card__thumb card__thumb--empty" />
                  )}
                  <span className="card__item-text">
                    <span className="card__item-name">{t.name}</span>
                    <span className="card__item-sub">{t.artist}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="card__quote">
          {quote && (
            <blockquote className="card__quote-text">
              <span className="card__quote-mark">“</span>
              <span className="card__quote-lines">
                {quote.split('\n').map((line, idx) => (
                  <span key={idx} className="card__quote-line">
                    {line || '\u00A0'}
                  </span>
                ))}
              </span>
              {quoteSong && <cite className="card__quote-cite">{quoteSong}</cite>}
            </blockquote>
          )}
        </div>

        <div className="card__footer">
          {hasMinutes && (
            <div className="card__minutes">
              <span className="card__minutes-value">{minutes}</span>
              <span className="card__minutes-unit">minutos ouvidos*</span>
            </div>
          )}
          {hasGenres && (
            <div className="card__genres">
              <span className="card__genres-label">Top gêneros</span>
              <span className="card__genres-list">{genres.join(' · ')}</span>
            </div>
          )}
          <div className="card__footer-meta">
            {hasScrobbles && (
              <span>~{hours}h · {fmt(recap.scrobbles ?? 0)} scrobbles</span>
            )}
            <span className="card__handle">@{recap.user} · {SOURCE_LABEL[recap.source]}</span>
          </div>
        </div>
      </div>
    </div>
  )
})

RecapCard.displayName = 'RecapCard'
