import type { VercelRequest, VercelResponse } from '@vercel/node'

// Server-side proxy for the Last.fm API.
//
// Keeps the API key out of the client bundle: the browser calls /api/lastfm and
// this function injects the key from a server-only env var. The var is
// LASTFM_API_KEY (NOT prefixed VITE_ — anything VITE_* is inlined into the
// public bundle, which is exactly the leak we're avoiding here).
//
// Only the handful of read methods the app actually uses are allowed, and only a
// known set of params is forwarded, so the proxy can't be turned into a
// general-purpose Last.fm relay against your key.

const BASE = 'https://ws.audioscrobbler.com/2.0/'

const ALLOWED_METHODS = new Set([
  'user.gettopartists',
  'user.gettoptracks',
  'user.getrecenttracks',
])

// Params the client may forward. api_key/format are set server-side; anything
// else the caller sends is dropped.
const ALLOWED_PARAMS = ['method', 'user', 'period', 'limit', 'from', 'to', 'page']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = process.env.LASTFM_API_KEY
  if (!key) {
    res.status(500).json({ error: 'LASTFM_API_KEY não configurada no servidor.' })
    return
  }

  const method = String(req.query.method ?? '')
  if (!ALLOWED_METHODS.has(method)) {
    res.status(400).json({ error: 'method não permitido.' })
    return
  }

  const params = new URLSearchParams()
  for (const name of ALLOWED_PARAMS) {
    const v = req.query[name]
    if (typeof v === 'string' && v.length > 0) params.set(name, v)
  }
  params.set('api_key', key)
  params.set('format', 'json')

  try {
    const upstream = await fetch(`${BASE}?${params.toString()}`)
    const body = await upstream.text()
    // Cache successful reads briefly at the edge to spare the shared rate limit.
    if (upstream.ok) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600')
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.status(upstream.status).send(body)
  } catch {
    res.status(502).json({ error: 'Falha ao contatar o Last.fm.' })
  }
}
