import type { ArtistStat, Period, Recap, TrackStat } from '../types'
import { proxied, toDataUrl } from './images'

// Spotify integration.
//
// Auth uses the Authorization Code flow with PKCE, which runs entirely in the
// browser (no client secret, no backend). The user logs in on Spotify and is
// redirected back here with a code we exchange for a token.
//
// IMPORTANT limitations of the public Web API (vs. Last.fm):
// - No play counts per track/artist and no total "minutes listened" — the API
//   only returns *ranked* top lists. So the per-item playcounts and
//   Recap.scrobbles are left undefined for this source.
// - Only three fixed windows: short_term (~4 weeks), medium_term (~6 months),
//   long_term (~1 year). No weekly view. See SOURCE_PERIODS in types.ts.
//
// Listening minutes are therefore ESTIMATED, not measured: we read the last ~50
// plays (/me/player/recently-played), derive a daily listening rate from the
// real durations + timestamps, and extrapolate it across the period window. It's
// a rough figure (the card marks it with an asterisk), but grounded in the
// user's actual recent behaviour rather than invented.

const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const API = 'https://api.spotify.com/v1'
// user-top-read: the ranked top lists. user-read-recently-played: the last ~50
// plays, which we use to estimate listening minutes (the API exposes no totals).
const SCOPE = 'user-top-read user-read-recently-played'

const LS = {
  clientId: 'spotify_client_id',
  verifier: 'spotify_pkce_verifier',
  token: 'spotify_token',
}

class SpotifyError extends Error {}

/** Client ID from env, falling back to a value saved in the UI. */
export function getClientId(): string {
  const fromEnv = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined
  return fromEnv || localStorage.getItem(LS.clientId) || ''
}

export function setClientId(id: string) {
  localStorage.setItem(LS.clientId, id.trim())
}

/** Must be registered as a Redirect URI in the Spotify app dashboard. */
function redirectUri(): string {
  return window.location.origin + window.location.pathname
}

// ---- PKCE helpers ----
function randomString(len: number): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ---- Token storage ----
interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_at: number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

function saveToken(data: TokenResponse, fallbackRefresh?: string) {
  const t: TokenSet = {
    access_token: data.access_token,
    // Spotify omits refresh_token on refresh responses — keep the old one.
    refresh_token: data.refresh_token ?? fallbackRefresh,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
  localStorage.setItem(LS.token, JSON.stringify(t))
}

function loadToken(): TokenSet | null {
  const raw = localStorage.getItem(LS.token)
  if (!raw) return null
  try {
    return JSON.parse(raw) as TokenSet
  } catch {
    return null
  }
}

export function isConnected(): boolean {
  return !!loadToken()
}

export function logout() {
  localStorage.removeItem(LS.token)
}

/** Kicks off the login redirect. Returns a never-resolving promise (navigates away). */
export async function login(): Promise<void> {
  const clientId = getClientId()
  if (!clientId) throw new SpotifyError('Client ID do Spotify não configurado.')
  const verifier = randomString(64)
  const challenge = base64url(await sha256(verifier))
  localStorage.setItem(LS.verifier, verifier)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPE,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    redirect_uri: redirectUri(),
  })
  window.location.assign(`${AUTH_URL}?${params.toString()}`)
}

/**
 * Call once on app load. If the URL carries an auth code (we just came back
 * from Spotify), exchanges it for a token. Always strips the code from the URL.
 * Returns whether we end up connected.
 */
export async function handleRedirect(): Promise<boolean> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const hadError = url.searchParams.get('error')

  if (!code) {
    // Clean a leftover ?error=access_denied if the user cancelled.
    if (hadError) {
      url.searchParams.delete('error')
      url.searchParams.delete('state')
      window.history.replaceState({}, '', url.pathname + url.search)
    }
    return isConnected()
  }

  const verifier = localStorage.getItem(LS.verifier)
  const clientId = getClientId()

  // Strip the code from the URL regardless of outcome (it's single-use).
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  window.history.replaceState({}, '', url.pathname + url.search)

  if (!verifier || !clientId) return false

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  localStorage.removeItem(LS.verifier)
  if (!res.ok) return false
  saveToken((await res.json()) as TokenResponse)
  return true
}

async function refreshToken(current: TokenSet): Promise<TokenSet | null> {
  if (!current.refresh_token) return null
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: getClientId(),
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) return null
  saveToken((await res.json()) as TokenResponse, current.refresh_token)
  return loadToken()
}

/** Returns a valid access token, refreshing if it's about to expire. */
async function accessToken(): Promise<string> {
  let t = loadToken()
  if (!t) throw new SpotifyError('Conecte sua conta do Spotify.')
  if (Date.now() > t.expires_at - 60_000) {
    const refreshed = await refreshToken(t)
    if (refreshed) t = refreshed
  }
  return t.access_token
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  })
  if (res.status === 401) {
    logout()
    throw new SpotifyError('Sessão do Spotify expirou. Conecte novamente.')
  }
  if (!res.ok) throw new SpotifyError(`Spotify respondeu ${res.status}.`)
  return (await res.json()) as T
}

const TIME_RANGE: Record<Period, string> = {
  week: 'short_term',
  month: 'short_term',
  year: 'medium_term',
  all: 'long_term',
}

interface SpImage {
  url: string
}
interface SpArtist {
  name: string
  images?: SpImage[]
}
interface SpTrack {
  name: string
  artists?: { name: string }[]
  album?: { images?: SpImage[] }
}

const firstImage = (imgs?: SpImage[]) => imgs?.[0]?.url

// Real length of each top-list window, used to extrapolate the recent listening
// rate. Spotify only serves short/medium/long term (see SOURCE_PERIODS), so
// 'week' never reaches here, but we map it for completeness.
const PERIOD_DAYS: Record<Period, number> = {
  week: 7,
  month: 28, // short_term ≈ 4 weeks
  year: 182, // medium_term ≈ 6 months
  all: 365, // long_term ≈ 1 year
}

// A single person can't realistically average more than this many minutes/day of
// listening; caps the extrapolation when the recent window is a dense binge.
const MAX_MINUTES_PER_DAY = 600

interface SpRecentItem {
  track?: { duration_ms?: number }
  played_at?: string
}

/**
 * Estimates minutes listened over the period from the last ~50 plays. Returns
 * undefined if there isn't enough recent history to say anything meaningful.
 */
async function estimateMinutes(period: Period): Promise<number | undefined> {
  let items: SpRecentItem[]
  try {
    const resp = await api<{ items: SpRecentItem[] }>('/me/player/recently-played?limit=50')
    items = resp.items ?? []
  } catch {
    return undefined // e.g. missing scope on an old token — degrade gracefully.
  }
  if (items.length < 2) return undefined

  const totalMs = items.reduce((sum, it) => sum + (it.track?.duration_ms ?? 0), 0)
  const times = items
    .map((it) => (it.played_at ? Date.parse(it.played_at) : NaN))
    .filter((t) => !Number.isNaN(t))
  if (times.length < 2) return undefined

  const spanMs = Math.max(...times) - Math.min(...times)
  if (spanMs <= 0) return undefined

  // Fraction of wall-clock time spent listening across the recent window, turned
  // into minutes/day, capped so a short binge doesn't extrapolate to absurdity.
  const minutesPerDay = Math.min((totalMs / spanMs) * 24 * 60, MAX_MINUTES_PER_DAY)
  return Math.round(minutesPerDay * PERIOD_DAYS[period])
}

/**
 * Builds a recap from Spotify's top lists. No play counts / minutes: the public
 * API doesn't expose them, so those fields stay undefined and the card hides
 * the corresponding numbers.
 */
export async function fetchRecap(_user: string, period: Period): Promise<Recap> {
  const range = TIME_RANGE[period]
  const [me, artistsResp, tracksResp, minutes] = await Promise.all([
    api<{ display_name?: string; id: string }>('/me'),
    api<{ items: SpArtist[] }>(`/me/top/artists?limit=5&time_range=${range}`),
    api<{ items: SpTrack[] }>(`/me/top/tracks?limit=5&time_range=${range}`),
    estimateMinutes(period),
  ])

  const artists = artistsResp.items ?? []
  const tracks = tracksResp.items ?? []

  // Bake images into data URLs via the same proxy path Last.fm uses, so the
  // PNG/video export doesn't taint the canvas.
  const [heroImage, artistImages, trackImages] = await Promise.all([
    toDataUrl(proxied(firstImage(artists[0]?.images), 1000)),
    Promise.all(artists.map((a) => toDataUrl(proxied(firstImage(a.images), 300)))),
    Promise.all(tracks.map((t) => toDataUrl(proxied(firstImage(t.album?.images), 300)))),
  ])

  const topArtists: ArtistStat[] = artists.map((a, i) => ({
    name: a.name,
    image: artistImages[i],
  }))
  const topTracks: TrackStat[] = tracks.map((t, i) => ({
    name: t.name,
    artist: t.artists?.[0]?.name ?? '',
    image: trackImages[i],
  }))

  return {
    source: 'spotify',
    user: me.display_name || me.id || 'spotify',
    period,
    topArtists,
    topTracks,
    heroArtist: topArtists[0] ?? null,
    heroImage,
    // Estimated from recent plays (see estimateMinutes); the card asterisks it.
    // scrobbles stays undefined — the API exposes no play counts at all.
    minutes,
  }
}
