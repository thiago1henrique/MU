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
//   only returns *ranked* top lists. So the per-item playcounts, Recap.scrobbles
//   and Recap.minutes are all left undefined for this source; the card hides
//   those numbers. In their place we surface the user's top genres (aggregated
//   from the top artists' genre tags), which the API does return reliably.
// - Only three fixed windows: short_term (~4 weeks), medium_term (~6 months),
//   long_term (~1 year). No weekly view. See SOURCE_PERIODS in types.ts.

const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const API = 'https://api.spotify.com/v1'
// user-top-read: the ranked top lists (all we need — genres ride along on the
// top-artists response).
const SCOPE = 'user-top-read'

const LS = {
  clientId: 'spotify_client_id',
  verifier: 'spotify_pkce_verifier',
  state: 'spotify_pkce_state',
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
  // Opaque, single-use value echoed back by Spotify — lets us reject a redirect
  // we didn't initiate (CSRF protection), on top of what PKCE already covers.
  const state = randomString(16)
  localStorage.setItem(LS.verifier, verifier)
  localStorage.setItem(LS.state, state)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPE,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    redirect_uri: redirectUri(),
    state,
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
      localStorage.removeItem(LS.state)
      localStorage.removeItem(LS.verifier)
      url.searchParams.delete('error')
      url.searchParams.delete('state')
      window.history.replaceState({}, '', url.pathname + url.search)
    }
    return isConnected()
  }

  const returnedState = url.searchParams.get('state')
  const savedState = localStorage.getItem(LS.state)
  const verifier = localStorage.getItem(LS.verifier)
  const clientId = getClientId()

  // Strip the code from the URL regardless of outcome (it's single-use).
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  window.history.replaceState({}, '', url.pathname + url.search)

  // Consume the one-time CSRF state and reject any mismatch (a redirect we
  // didn't start). Missing saved state = same failure.
  localStorage.removeItem(LS.state)
  if (!verifier || !clientId) return false
  if (!savedState || returnedState !== savedState) {
    localStorage.removeItem(LS.verifier)
    return false
  }

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
  genres?: string[]
}
interface SpTrack {
  name: string
  artists?: { name: string }[]
  album?: { images?: SpImage[] }
}

const firstImage = (imgs?: SpImage[]) => imgs?.[0]?.url

// How many genre tags to surface on the card.
const MAX_GENRES = 4

/**
 * Aggregates the top artists' genre tags into a ranked list, most frequent
 * first. Ties break by the order the artist appears in (higher-ranked artist's
 * genres win), so the tags track what the user actually listens to most.
 */
function topGenres(artists: SpArtist[]): string[] {
  const counts = new Map<string, { count: number; firstSeen: number }>()
  let seen = 0
  for (const artist of artists) {
    for (const genre of artist.genres ?? []) {
      const existing = counts.get(genre)
      if (existing) existing.count++
      else counts.set(genre, { count: 1, firstSeen: seen++ })
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].firstSeen - b[1].firstSeen)
    .slice(0, MAX_GENRES)
    .map(([genre]) => genre)
}

/**
 * Builds a recap from Spotify's top lists. No play counts / minutes: the public
 * API doesn't expose them, so those fields stay undefined and the card hides
 * the corresponding numbers — the top genres stand in for them instead.
 */
export async function fetchRecap(_user: string, period: Period): Promise<Recap> {
  const range = TIME_RANGE[period]
  const [me, artistsResp, tracksResp] = await Promise.all([
    api<{ display_name?: string; id: string }>('/me'),
    api<{ items: SpArtist[] }>(`/me/top/artists?limit=5&time_range=${range}`),
    api<{ items: SpTrack[] }>(`/me/top/tracks?limit=5&time_range=${range}`),
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
    // No minutes/scrobbles — the API exposes no play counts. Top genres stand in.
    genres: topGenres(artists),
  }
}
