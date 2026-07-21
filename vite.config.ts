import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// public/sw.js is copied to dist as-is (Vite doesn't process publicDir files),
// so its CACHE name never changes between deploys — the browser only detects
// a new service worker when sw.js's bytes differ, so an unversioned name means
// the SW (and whatever it cached) never updates, and stale artist photos/covers
// stick around until the user manually clears site data. Stamping the build's
// commit SHA into CACHE here makes every deploy ship a byte-different sw.js,
// so the browser installs it and the existing activate handler's cache
// cleanup (already coded in sw.js) actually gets a chance to run.
function versionServiceWorker(): Plugin {
  return {
    name: 'version-service-worker',
    apply: 'build',
    closeBundle() {
      const buildId = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? String(Date.now())
      const swPath = join(process.cwd(), 'dist', 'sw.js')
      const contents = readFileSync(swPath, 'utf-8')
      writeFileSync(swPath, contents.replace('echo-shell-v1', `echo-shell-${buildId}`))
    },
  }
}

// Serves our /api/* serverless functions during `vite dev`. In production
// Vercel runs api/*.ts for us, but plain `vite dev` doesn't — without this
// the browser's fetch('/api/lastfm' | '/api/deezer') falls through to the SPA
// and gets back index.html (HTML), so res.json() blows up with "unexpected
// character at line 1 column 1". Here we load the same handlers and adapt
// Node's req/res to the minimal shape they expect, reading LASTFM_API_KEY
// from .env.
function apiDev(env: Record<string, string>): Plugin {
  // Each api route -> the module file that handles it.
  const routes: Record<string, string> = {
    '/api/lastfm': '/api/lastfm.ts',
    '/api/deezer': '/api/deezer.ts',
    '/api/lyrics': '/api/lyrics.ts',
  }
  return {
    name: 'api-dev',
    configureServer(server) {
      // The key isn't VITE_-prefixed (server-only), so it's not on process.env
      // in dev unless the shell set it — pull it from the loaded .env.
      if (!process.env.LASTFM_API_KEY && env.LASTFM_API_KEY) {
        process.env.LASTFM_API_KEY = env.LASTFM_API_KEY
      }
      for (const [route, modulePath] of Object.entries(routes)) {
        server.middlewares.use(route, async (req, res) => {
          try {
            const mod = await server.ssrLoadModule(modulePath)
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
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), apiDev(env), versionServiceWorker()],
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
