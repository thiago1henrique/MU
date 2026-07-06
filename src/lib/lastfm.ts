import type { ArtistStat, Period, Recap, TrackStat } from '../types'
import { fetchArtistImage, fetchTrackCover, proxied, toDataUrl } from './images'

// Calls go through our own serverless proxy (api/lastfm.ts) so the Last.fm API
// key stays server-side and never enters the client bundle. Requires the site
// to be served by Vercel (or `vercel dev` locally); plain `vite dev` doesn't
// serve /api.
const BASE = '/api/lastfm'

// Maps our UI period to Last.fm's period param and to a day window (used for
// the exact scrobble count via user.getRecentTracks).
const PERIOD_MAP: Record<Period, { lfm: string; days: number }> = {
  week: { lfm: '7day', days: 7 },
  month: { lfm: '1month', days: 30 },
  year: { lfm: '12month', days: 365 },
  all: { lfm: 'overall', days: 0 },
}

const AVG_TRACK_SECONDS = 210 // fallback when Last.fm has no duration data

class LastfmError extends Error {}

async function call<T>(params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${BASE}?${qs.toString()}`)
  const data = await res.json()
  // Both Last.fm (`error` number + `message`) and our proxy (`error` string)
  // report failures on the `error` field.
  if (data.error) {
    const msg =
      data.message || (typeof data.error === 'string' ? data.error : 'Erro na API do Last.fm.')
    throw new LastfmError(msg)
  }
  if (!res.ok) throw new LastfmError(`Last.fm respondeu ${res.status}.`)
  return data as T
}

// Last.fm image arrays: [{'#text': url, size: 'small'|...|'extralarge'}]
type LfmImage = { '#text': string; size: string }
function pickImage(images?: LfmImage[]): string | undefined {
  if (!images?.length) return undefined
  const order = ['extralarge', 'large', 'medium', 'small']
  for (const s of order) {
    const found = images.find((i) => i.size === s && i['#text'])
    if (found) return found['#text']
  }
  return images.find((i) => i['#text'])?.['#text']
}

interface TopArtistsResp {
  topartists: { artist: { name: string; playcount: string }[] }
}
interface TopTracksResp {
  toptracks: {
    track: {
      name: string
      playcount: string
      duration: string
      artist: { name: string }
      image: LfmImage[]
    }[]
  }
}
interface RecentResp {
  recenttracks: { '@attr'?: { total?: string } }
}

async function getTopArtists(user: string, period: Period, limit: number): Promise<ArtistStat[]> {
  const data = await call<TopArtistsResp>({
    method: 'user.gettopartists',
    user,
    period: PERIOD_MAP[period].lfm,
    limit: String(limit),
  })
  return (data.topartists?.artist ?? []).map((a) => ({
    name: a.name,
    playcount: Number(a.playcount) || 0,
  }))
}

async function getTopTracks(user: string, period: Period, limit: number) {
  const data = await call<TopTracksResp>({
    method: 'user.gettoptracks',
    user,
    period: PERIOD_MAP[period].lfm,
    limit: String(limit),
  })
  return data.toptracks?.track ?? []
}

/** Exact number of scrobbles in the period window (or ever, for 'all'). */
async function getScrobbleCount(user: string, period: Period): Promise<number> {
  const params: Record<string, string> = {
    method: 'user.getrecenttracks',
    user,
    limit: '1',
  }
  // 'all' = whole account history: omit the window and use the total count.
  if (period !== 'all') {
    const to = Math.floor(Date.now() / 1000)
    const from = to - PERIOD_MAP[period].days * 24 * 60 * 60
    params.from = String(from)
    params.to = String(to)
  }
  const data = await call<RecentResp>(params)
  return Number(data.recenttracks?.['@attr']?.total) || 0
}

/**
 * Builds the full recap. Minutes are ESTIMATED: exact scrobble count in the
 * window × average track length (derived from your top tracks when available).
 */
export async function fetchRecap(userRaw: string, period: Period): Promise<Recap> {
  const user = userRaw.trim()
  if (!user) throw new LastfmError('Informe seu usuário do Last.fm.')

  // Fetch in parallel. Pull 50 top tracks to estimate an average duration.
  const [topArtists, rawTracks, scrobbles] = await Promise.all([
    getTopArtists(user, period, 5),
    getTopTracks(user, period, 50),
    getScrobbleCount(user, period),
  ])

  const top5Tracks = rawTracks.slice(0, 5)

  // Resolve raw source URLs: album covers from Deezer (fallback Last.fm),
  // artist photos from Deezer.
  const [trackCovers, artistImages] = await Promise.all([
    Promise.all(top5Tracks.map((t) => fetchTrackCover(t.artist?.name ?? '', t.name))),
    Promise.all(topArtists.map((a) => fetchArtistImage(a.name))),
  ])

  // Bake every image into a data URL (see toDataUrl for why). Done in parallel.
  const [heroImage, artistDataImages, trackDataImages] = await Promise.all([
    toDataUrl(proxied(artistImages[0], 1000)),
    Promise.all(artistImages.map((u) => toDataUrl(proxied(u, 300)))),
    Promise.all(
      top5Tracks.map((t, i) => toDataUrl(proxied(trackCovers[i] ?? pickImage(t.image), 300))),
    ),
  ])

  const topTracks: TrackStat[] = top5Tracks.map((t, i) => ({
    name: t.name,
    artist: t.artist?.name ?? '',
    playcount: Number(t.playcount) || 0,
    image: trackDataImages[i],
  }))

  // Average duration from tracks that report one, else fallback.
  const durations = rawTracks.map((t) => Number(t.duration)).filter((d) => d > 0)
  const avgSeconds = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : AVG_TRACK_SECONDS
  const minutes = Math.round((scrobbles * avgSeconds) / 60)

  const artistsWithImages: ArtistStat[] = topArtists.map((a, i) => ({
    ...a,
    image: artistDataImages[i],
  }))

  const heroArtist = artistsWithImages[0] ?? null

  return {
    source: 'lastfm',
    user,
    period,
    topArtists: artistsWithImages,
    topTracks,
    heroArtist,
    heroImage,
    scrobbles,
    minutes,
  }
}
