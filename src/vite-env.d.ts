/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Note: the Last.fm key is NOT here on purpose — it lives server-side
  // (LASTFM_API_KEY, read by api/lastfm.ts), never in the client bundle.
  // The Spotify Client ID is public by design, so VITE_ is fine.
  readonly VITE_SPOTIFY_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
