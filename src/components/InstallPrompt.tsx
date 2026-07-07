import { useEffect, useState } from 'react'
import './InstallPrompt.css'

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
  prompt(): Promise<void>
}

interface NavigatorStandalone extends Navigator {
  standalone?: boolean
}

interface CustomWindow extends Window {
  opera?: unknown
  MSStream?: unknown
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showBanner, setShowBanner] = useState(false)

  const [isIOS] = useState(() => {
    if (typeof window === 'undefined') return false
    const customWindow = window as unknown as CustomWindow
    const userAgent = navigator.userAgent || navigator.vendor || (customWindow.opera as string)
    return /iPad|iPhone|iPod/.test(userAgent) && !customWindow.MSStream
  })

  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === 'undefined') return false
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as NavigatorStandalone).standalone === true
    )
  })

  useEffect(() => {
    const isDismissed = localStorage.getItem('pwa_prompt_dismissed') === 'true'

    if (isStandalone || isDismissed) {
      return
    }

    // Double check standalone state in case it updates
    const handleDisplayModeChange = () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches
      setIsStandalone(standalone)
    }
    const mediaQuery = window.matchMedia('(display-mode: standalone)')
    mediaQuery.addEventListener('change', handleDisplayModeChange)

    // Handler for standard beforeinstallprompt
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setShowBanner(true)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)

    // For iOS, since beforeinstallprompt is not fired, we show the banner manually
    // but only if it's iOS, not standalone, and not dismissed, and we can show after a short delay
    let timer: number | undefined
    if (isIOS && !isStandalone) {
      timer = window.setTimeout(() => {
        setShowBanner(true)
      }, 3000) // 3 seconds delay to let the user see the page first
    }

    return () => {
      mediaQuery.removeEventListener('change', handleDisplayModeChange)
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [isIOS, isStandalone])

  const handleInstallClick = async () => {
    if (!deferredPrompt) return

    // Show the browser install prompt
    await deferredPrompt.prompt()

    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice

    if (outcome === 'accepted') {
      console.log('User accepted the install prompt')
    } else {
      console.log('User dismissed the install prompt')
    }

    // We no longer need the prompt, clear it
    setDeferredPrompt(null)
    setShowBanner(false)
  }

  const handleDismiss = () => {
    setShowBanner(false)
    // Persist user preference so they aren't bothered on every refresh
    localStorage.setItem('pwa_prompt_dismissed', 'true')
  }

  if (!showBanner || isStandalone) {
    return null
  }

  return (
    <div className="install-banner">
      <div className="install-banner__content">
        <img src="/pwa-icon.svg" alt="Echo Icon" className="install-banner__icon" />
        <div className="install-banner__text">
          <h4 className="install-banner__title">Instalar Echo</h4>
          {isIOS ? (
            <p className="install-banner__desc">
              Toque no botão de compartilhar{' '}
              <span className="install-banner__inline-icon" aria-label="compartilhar">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', display: 'inline' }}>
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </span>{' '}
              e selecione <strong>Adicionar à Tela de Início</strong>.
            </p>
          ) : (
            <p className="install-banner__desc">
              Adicione o app à sua tela inicial para acesso rápido e melhor experiência.
            </p>
          )}
        </div>
      </div>
      <div className="install-banner__actions">
        {!isIOS && (
          <button onClick={handleInstallClick} className="btn btn--primary install-banner__btn">
            Instalar
          </button>
        )}
        <button onClick={handleDismiss} className="install-banner__close" aria-label="Fechar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
