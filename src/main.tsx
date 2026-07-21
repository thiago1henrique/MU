import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted so the type is embedded in the PNG/MP4 export (no CDN request).
import '@fontsource-variable/bricolage-grotesque/index.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registra o service worker (PWA). Só em produção — em dev o SW atrapalha o HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Falha no registro não deve quebrar o app; segue como web normal.
    })
  })
}
