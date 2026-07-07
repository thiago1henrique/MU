// Image helpers.
//
// Two problems this file solves:
// 1. Last.fm deprecated artist photos (their API returns a placeholder star),
//    so we fetch real artist pictures from Deezer via JSONP (no CORS/backend).
// 2. Canvas export (html-to-image) taints on cross-origin images. We route every
//    external image through wsrv.nl, which serves them CORS-enabled, so
//    the PNG export works reliably.

/** Runs a JSONP request (used for Deezer, which has no CORS headers). */
function jsonp<T>(url: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__jsonp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    const script = document.createElement('script')
    let done = false

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[cb]
      script.remove()
      clearTimeout(timer)
    }

    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('JSONP timeout'))
    }, timeoutMs)

    ;(window as unknown as Record<string, unknown>)[cb] = (data: T) => {
      if (done) return
      done = true
      cleanup()
      resolve(data)
    }

    script.onerror = () => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('JSONP error'))
    }

    const sep = url.includes('?') ? '&' : '?'
    script.src = `${url}${sep}output=jsonp&callback=${cb}`
    document.body.appendChild(script)
  })
}

interface DeezerArtist {
  picture_xl?: string
  picture_big?: string
  picture_medium?: string
}
interface DeezerArtistSearch {
  data?: DeezerArtist[]
}

interface DeezerAlbum {
  cover_xl?: string
  cover_big?: string
  cover_medium?: string
}
interface DeezerTrackSearch {
  data?: { album?: DeezerAlbum }[]
}

/** Returns a real artist photo URL from Deezer, or undefined if not found. */
export async function fetchArtistImage(name: string): Promise<string | undefined> {
  try {
    const url = `https://api.deezer.com/search/artist?limit=1&q=${encodeURIComponent(name)}`
    const res = await jsonp<DeezerArtistSearch>(url)
    const a = res.data?.[0]
    return a?.picture_xl || a?.picture_big || a?.picture_medium || undefined
  } catch {
    return undefined
  }
}

/** Returns the album cover art for a track from Deezer, or undefined. */
export async function fetchTrackCover(
  artist: string,
  track: string,
): Promise<string | undefined> {
  try {
    const q = `artist:"${artist}" track:"${track}"`
    const url = `https://api.deezer.com/search?limit=1&q=${encodeURIComponent(q)}`
    const res = await jsonp<DeezerTrackSearch>(url)
    const album = res.data?.[0]?.album
    return album?.cover_xl || album?.cover_big || album?.cover_medium || undefined
  } catch {
    return undefined
  }
}

/**
 * Wraps any image URL in the weserv proxy so it is served with CORS headers
 * (required for fetching cross-origin images into a data URL). Optionally resizes.
 */
export function proxied(url: string | undefined, size?: number): string | undefined {
  if (!url) return undefined
  const sizeParam = size ? `&w=${size}&h=${size}&fit=cover` : ''
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}${sizeParam}`
}

/**
 * Fetches an image and returns it as a self-contained data URL.
 *
 * We bake images into data URLs (rather than letting html-to-image fetch them
 * at export time) because its internal blob cache keys by URL *path only* —
 * all our proxy URLs share the same path, so they would collide and every
 * image in the PNG would become a copy of the first one loaded.
 */
export async function toDataUrl(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const blob = await res.blob()
    return await new Promise<string | undefined>((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result as string)
      fr.onerror = () => resolve(undefined)
      fr.readAsDataURL(blob)
    })
  } catch {
    return undefined
  }
}
