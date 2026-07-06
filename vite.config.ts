import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Serves the /api/lastfm serverless function during `vite dev`. In production
// Vercel runs api/lastfm.ts for us, but plain `vite dev` doesn't — without this
// the browser's fetch('/api/lastfm') falls through to the SPA and gets back
// index.html (HTML), so res.json() blows up with "unexpected character at
// line 1 column 1". Here we load the same handler and adapt Node's req/res to
// the minimal shape it expects, reading LASTFM_API_KEY from .env.
function lastfmApiDev(env: Record<string, string>): Plugin {
  return {
    name: 'lastfm-api-dev',
    configureServer(server) {
      // The key isn't VITE_-prefixed (server-only), so it's not on process.env
      // in dev unless the shell set it — pull it from the loaded .env.
      if (!process.env.LASTFM_API_KEY && env.LASTFM_API_KEY) {
        process.env.LASTFM_API_KEY = env.LASTFM_API_KEY
      }
      server.middlewares.use('/api/lastfm', async (req, res) => {
        try {
          const mod = await server.ssrLoadModule('/api/lastfm.ts')
          const handler = mod.default as (req: unknown, res: unknown) => Promise<void>
          // connect strips the mount path from req.url; originalUrl keeps the query.
          const raw = (req as { originalUrl?: string }).originalUrl ?? req.url ?? ''
          const url = new URL(raw, 'http://localhost')
          const query: Record<string, string> = {}
          url.searchParams.forEach((v, k) => (query[k] = v))
          const shim = {
            status(code: number) {
              res.statusCode = code
              return shim
            },
            setHeader(name: string, value: string) {
              res.setHeader(name, value)
            },
            send(body: string) {
              res.end(body)
            },
            json(body: unknown) {
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify(body))
            },
          }
          await handler({ query }, shim)
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: `Proxy dev falhou: ${(err as Error).message}` }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), lastfmApiDev(env)],
    // Pin host+port so the dev URL always matches the Spotify Redirect URI
    // (http://127.0.0.1:5173/). strictPort fails loudly instead of silently
    // switching to 5174 if 5173 is taken. 127.0.0.1 (not localhost) because
    // Spotify treats them as different origins.
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    // ffmpeg.wasm ships its own worker; pre-bundling it breaks the worker URL.
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core'],
    },
  }
})
