import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, Ref } from 'react'
import type { Period, Recap, Source } from './types'
import { periodLabel, SOURCE_PERIODS } from './types'
import { fetchRecap } from './lib/lastfm'
import * as spotify from './lib/spotify'
import { fetchLyricLines, fetchSyncedLyrics } from './lib/lyrics'
import type { SyncedLine } from './lib/lyrics'
import { searchTracks, proxied, toDataUrl } from './lib/images'
import type { TrackHit } from './lib/images'
import { nodeToPngBlob } from './lib/exportPng'
import { exportCardVideo } from './lib/videoExport'
import { downloadBlob } from './lib/download'
import { RecapCard } from './components/RecapCard'
import { LyricCard } from './components/LyricCard'
import { TrackSelect } from './components/TrackSelect'
import { InstallPrompt } from './components/InstallPrompt'
import './App.css'

type AppMode = 'recap' | 'lyric'

const MAX_CLIP = 60

// Above this width the video preview mock lives in the desktop side-margin (a
// fixed dock); below it, it drops inline between the video panel and the encarte.
// Must match the .video-dock breakpoint in App.css.
const WIDE_MQ = '(min-width: 1360px)'

// Login com Spotify está desativado por ora (app ainda em Development Mode no
// dashboard do Spotify, sem Extended Quota Mode — só contas na allowlist passam).
// Todo o código do Spotify continua no lugar; basta voltar para `true` para
// reexibir o seletor de fonte e o fluxo de conexão.
const SHOW_SPOTIFY = false

/** Seconds as a clock: 58 → "58s", 60 → "1:00", 81 → "1:21". */
function clock(seconds: number): string {
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Dispatches the recap fetch to the selected source. */
function fetchFor(source: Source, user: string, period: Period): Promise<Recap> {
  return source === 'spotify' ? spotify.fetchRecap(user, period) : fetchRecap(user, period)
}

// Firefox can't record MP4 natively and we no longer ship the slow ffmpeg
// fallback path for it, so video export is disabled there — PNG still works.
const IS_FIREFOX =
  typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')

// Hero rectangles per format (must match RecapCard.css hero sizes). The lyric
// story card uses a full-bleed 1485px hero; the recap story card keeps a compact
// 770px band so the lists stay visible, so its hero is overridden at the call
// site below.
const DIMS = {
  story: { canvasW: 1080, canvasH: 1920, hero: { x: 0, y: 0, w: 1080, h: 1485 } },
  feed: { canvasW: 1600, canvasH: 900, hero: { x: 0, y: 0, w: 620, h: 900 } },
}
// Recap story hero — the compact band matching .card--story:not(.card--lyric).
const RECAP_STORY_HERO = { x: 0, y: 0, w: 1080, h: 770 }

export default function App() {
  // Top-level experience: the recap (top artists/tracks) or the lyric card.
  const [appMode, setAppMode] = useState<AppMode>('recap')
  const [source, setSource] = useState<Source>(() =>
    SHOW_SPOTIFY ? (localStorage.getItem('recap_source') as Source) || 'lastfm' : 'lastfm',
  )
  const [user, setUser] = useState(() => localStorage.getItem('lastfm_user') ?? '')
  const [period, setPeriod] = useState<Period>('month')
  // Which format the preview shows (also what the toggle above it drives). Both
  // formats are always exportable regardless of what's previewed.
  const [previewFmt, setPreviewFmt] = useState<'story' | 'feed'>('story')
  // Which editor panel is shown below the export bar — same swap idea as the
  // Story↔Feed toggle above, applied to Capa / Lado B / Verso em destaque, so
  // only one panel renders at a time instead of stacking all three in a row.
  const [editorTab, setEditorTab] = useState<'cover' | 'video' | 'quote'>('cover')
  const EDITOR_TABS = ['cover', 'video', 'quote'] as const
  // Spotify auth state.
  const [spClientId, setSpClientId] = useState(spotify.getClientId())
  const [spConnected, setSpConnected] = useState(spotify.isConnected())
  // All periods are fetched up front and cached here, so switching the period
  // tab is instant (no refetch). Keyed by Period.
  const [recaps, setRecaps] = useState<Partial<Record<Period, Recap>>>({})
  const recap = recaps[period] ?? null
  // True once a recap has been generated. Hides the "Gerar recap" button.
  const [generated, setGenerated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [vstatus, setVstatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Lyric-quote state
  const [quote, setQuote] = useState('')
  const [quoteSongIdx, setQuoteSongIdx] = useState(0)
  const [lyricLines, setLyricLines] = useState<string[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyricsError, setLyricsError] = useState<string | null>(null)

  // Lyric-mode state (song search → pick → synced lyrics).
  const [lyricQuery, setLyricQuery] = useState('')
  const [lyricHits, setLyricHits] = useState<TrackHit[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedHit, setSelectedHit] = useState<TrackHit | null>(null)
  // Album cover baked into a data URL (see toDataUrl in images.ts for why) so PNG/MP4
  // export doesn't depend on the CORS proxy being reachable at export time.
  const [coverDataUrl, setCoverDataUrl] = useState<string | undefined>(undefined)
  const [syncedLines, setSyncedLines] = useState<SyncedLine[]>([])
  // Song time (s) that the clip's first frame maps to — the animation anchor.
  // Set from the line the user marks (its lrclib timestamp), so that line shows
  // at the clip start and the following lines animate in as the clip plays.
  const [lyricOffset, setLyricOffset] = useState(0)
  // Small manual nudge (s) on top of the anchor, to fine-tune the animation
  // against the clip's audio. Added to lyricOffset when driving the lyrics.
  const [lyricNudge, setLyricNudge] = useState(0)

  // Custom hero cover: lets the user replace the auto-fetched cover (album art /
  // artist photo) with their own image. Independent of — and overridden by — the
  // video hero below; persists across song/recap picks, same as the video does.
  const [customCoverUrl, setCustomCoverUrl] = useState('')

  // Video-hero state
  const [videoUrl, setVideoUrl] = useState('')
  const [videoDur, setVideoDur] = useState(0)
  const [clipStart, setClipStart] = useState(0)
  const [clipLen, setClipLen] = useState(MAX_CLIP)
  // Whether we're on a wide (desktop) viewport — decides if the video preview
  // mock renders in the side-margin or inline. Tracked in JS (not just CSS) so
  // only one of the two mocks mounts, i.e. we never decode the clip twice.
  const [isWide, setIsWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(WIDE_MQ).matches,
  )
  // Viewport width, tracked so the Feed side-dock can grow to fill the left
  // gutter on wide screens (see DOCK_W below) without overlapping the column.
  const [winW, setWinW] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth : 1440),
  )

  // Preview scaling: the RecapCard renders at exact export px (1080×1920 story,
  // 1600×900 feed); we measure the frame's real width and scale the card down
  // to fit it, so the preview stays crisp and responsive at any screen size.
  // A callback ref (re)attaches the observer whenever the frame mounts, which
  // matters because it only exists once a recap has been generated.
  const [previewW, setPreviewW] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const previewRef = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    if (!node) return
    setPreviewW(node.clientWidth)
    roRef.current = new ResizeObserver(([entry]) => setPreviewW(entry.contentRect.width))
    roRef.current.observe(node)
  }, [])
  const previewBase = previewFmt === 'story' ? { w: 1080, h: 1920 } : { w: 1600, h: 900 }
  const previewScale = previewW ? previewW / previewBase.w : 0
  const previewH = previewW * (previewBase.h / previewBase.w)

  // Mobile swipe-to-switch: drag the preview card sideways (Tinder-style) to
  // flip between Story and Feed instead of the desktop segmented toggle. Only
  // armed when !isWide — see WIDE_MQ above for the same mobile/desktop split
  // used by the video dock.
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<number | null>(null)
  // Hides the "arraste" hint once the user has discovered the gesture once —
  // persisted so it doesn't reappear on a later visit.
  const [hasSwiped, setHasSwiped] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem('echo_swiped') === '1',
  )

  // Mobile swipe-to-switch, same idea applied to the Capa / Lado B / Verso
  // editor tabs: drag the panel sideways (Tinder-style) to step to the next/
  // previous tab instead of tapping the desktop segmented toggle.
  const [editorDragX, setEditorDragX] = useState(0)
  const [editorDragging, setEditorDragging] = useState(false)
  const editorDragStartRef = useRef<number | null>(null)
  const [hasSwipedEditor, setHasSwipedEditor] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem('echo_swiped_editor') === '1',
  )

  const storyRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const overlayStoryRef = useRef<HTMLDivElement>(null)
  const overlayFeedRef = useRef<HTMLDivElement>(null)
  const exportVideoRef = useRef<HTMLVideoElement>(null)

  const hasClientId = spClientId.trim().length > 0
  const periods = SOURCE_PERIODS[source]
  // Ready to generate: Last.fm needs a username (the API key lives server-side,
  // behind the /api/lastfm proxy); Spotify needs a connected account.
  const ready = source === 'spotify' ? spConnected : user.trim().length > 0
  const quoteTrack = recap?.topTracks[quoteSongIdx]
  // Citation shown under the lyric quote: "Song, Artist".
  const quoteSong = quoteTrack
    ? [quoteTrack.name, quoteTrack.artist].filter(Boolean).join(', ')
    : undefined
  const maxStart = Math.max(0, videoDur - clipLen)
  const start = Math.min(clipStart, maxStart)

  // Whether there's a card to preview/export (recap generated, or a song picked).
  const showCard = appMode === 'recap' ? !!recap : !!selectedHit

  // Side-dock mock geometry. Story stays a fixed 320px (it's tall — 9:16 — so a
  // wider mock would overflow the viewport height). Feed is 16:9 and short, so
  // it can grow to fill the left gutter on wide screens: we size it to the space
  // between the viewport margin (24px) and the centered 640px column minus the
  // 32px gap (half column = 320px), capped at 560px and floored at 320px. This
  // keeps the same 32px gap to the column at every width, so it never overlaps.
  // Only height and the card scale change per format, and both ease (CSS) so
  // Story↔Feed morphs smoothly. Story card = 1080×1920, Feed = 1600×900.
  const dockIsStory = previewFmt === 'story'
  const feedDockW = Math.min(560, Math.max(320, Math.floor(winW / 2 - 320 - 32 - 24)))
  const DOCK_W = dockIsStory ? 320 : feedDockW
  const dockScale = DOCK_W / (dockIsStory ? 1080 : 1600)
  const dockH = Math.round((dockIsStory ? 1920 : 900) * dockScale)

  // On load, complete a Spotify OAuth redirect if we just came back from one.
  useEffect(() => {
    spotify.handleRedirect().then(setSpConnected).catch(() => {})
  }, [])

  // Keep isWide in sync with the viewport so the mock hops between the side-dock
  // and the inline slot as the window crosses the breakpoint.
  useEffect(() => {
    const mq = window.matchMedia(WIDE_MQ)
    const onChange = () => setIsWide(mq.matches)
    const onResize = () => setWinW(window.innerWidth)
    mq.addEventListener('change', onChange)
    window.addEventListener('resize', onResize)
    return () => {
      mq.removeEventListener('change', onChange)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Fetch lyrics whenever the recap or the chosen song changes (recap mode only;
  // lyric mode loads lyrics on song pick instead).
  useEffect(() => {
    if (appMode !== 'recap' || !recap) return
    const song = recap.topTracks[quoteSongIdx]
    if (!song) {
      setTimeout(() => setLyricLines([]), 0)
      return
    }
    let active = true
    setTimeout(() => {
      setLyricsLoading(true)
      setLyricsError(null)
      setLyricLines([])
    }, 0)
    fetchLyricLines(song.artist, song.name)
      .then((lines) => active && setLyricLines(lines))
      .catch((e) => active && setLyricsError(e instanceof Error ? e.message : 'Erro na letra.'))
      .finally(() => active && setLyricsLoading(false))
    return () => {
      active = false
    }
  }, [appMode, recap, quoteSongIdx])

  // Live song search: debounce the lyric query and fetch hits as the user
  // types (no "Buscar" button). Skips the text we auto-filled after a pick.
  useEffect(() => {
    if (appMode !== 'lyric') return
    const q = lyricQuery.trim()
    if (selectedHit && lyricQuery === `${selectedHit.title} — ${selectedHit.artist}`) return
    if (q.length < 2) {
      const handle = setTimeout(() => {
        setLyricHits([])
        setSearching(false)
      }, 0)
      return () => clearTimeout(handle)
    }
    let active = true
    const hSearch = setTimeout(() => {
      setSearching(true)
    }, 0)
    const t = setTimeout(async () => {
      try {
        const hits = await searchTracks(q)
        if (active) setLyricHits(hits)
      } catch {
        if (active) setError('Erro ao buscar músicas.')
      } finally {
        if (active) setSearching(false)
      }
    }, 300)
    return () => {
      active = false
      clearTimeout(hSearch)
      clearTimeout(t)
    }
  }, [lyricQuery, appMode, selectedHit])

  // Bake the picked song's cover into a data URL (mirrors the recap hero image
  // pipeline). Without this, PNG/MP4 export depends on the wsrv.nl proxy being
  // reachable at export time, which isn't always true (ad-blockers, private DNS).
  useEffect(() => {
    const cover = selectedHit?.cover
    if (!cover) {
      const handle = setTimeout(() => setCoverDataUrl(undefined), 0)
      return () => clearTimeout(handle)
    }
    let active = true
    toDataUrl(proxied(cover, 1000)).then((url) => {
      if (active) setCoverDataUrl(url)
    })
    return () => {
      active = false
    }
  }, [selectedHit?.cover])

  // Switching to a different period shows a different dataset — clear the
  // lyric-quote selection so it isn't carried over.
  useEffect(() => {
    setTimeout(() => {
      setQuote('')
      setSelected([])
      setQuoteSongIdx(0)
    }, 0)
  }, [period])

  async function generate(e?: FormEvent) {
    e?.preventDefault()
    setError(null)
    setLoading(true)
    setRecaps({})
    setQuote('')
    setSelected([])
    setQuoteSongIdx(0)
    try {
      if (source === 'lastfm') localStorage.setItem('lastfm_user', user.trim())
      // Fetch every supported period in parallel so switching tabs is instant.
      const results = await Promise.allSettled(periods.map((p) => fetchFor(source, user, p)))
      const next: Partial<Record<Period, Recap>> = {}
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') next[periods[i]] = r.value
      })
      if (Object.keys(next).length === 0) {
        const rejected = results.find((r) => r.status === 'rejected')
        throw (rejected as PromiseRejectedResult | undefined)?.reason ?? new Error('Erro ao buscar dados.')
      }
      setRecaps(next)
      setGenerated(true)
      // Re-arm the "arraste para o lado" hint on every fresh generation, even if
      // the user already discovered the swipe gesture in a past visit.
      setHasSwiped(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao buscar dados.')
    } finally {
      setLoading(false)
    }
  }

  // ---- Quote helpers ----
  function selectSong(idx: number) {
    setQuoteSongIdx(idx)
    setSelected([])
    setQuote('')
  }
  // Timestamp (song seconds) of a picker line, or null when there's no synced
  // data for it. Prefers direct index alignment (lrclib's plain & synced lists
  // usually match 1:1); otherwise matches by text, counting occurrences so a
  // repeated line (e.g. a chorus) resolves to the right instance.
  function syncedTimeForLine(i: number): number | null {
    if (syncedLines.length === 0) return null
    if (syncedLines.length === lyricLines.length) return syncedLines[i].t
    const text = lyricLines[i]
    let occ = 0
    for (let k = 0; k <= i; k++) if (lyricLines[k] === text) occ++
    let seen = 0
    for (const s of syncedLines) {
      if (s.text === text && ++seen === occ) return s.t
    }
    return null
  }
  function toggleLine(i: number) {
    const next =
      appMode === 'recap'
        ? selected.includes(i)
          ? []
          : [i]
        : selected.includes(i)
        ? selected.filter((x) => x !== i)
        : [...selected, i]
    setSelected(next)
    setQuote(
      [...next]
        .sort((a, b) => a - b)
        .map((idx) => lyricLines[idx])
        .join('\n'),
    )
    // With a video loaded, the animation anchors to the *earliest* marked line:
    // that line shows at the clip start, and the following lines roll in as the
    // clip plays. Anchoring to the earliest (not the last clicked) keeps the
    // order stable regardless of the click sequence.
    if (videoUrl && next.length > 0) {
      const t = syncedTimeForLine(Math.min(...next))
      if (t != null) setLyricOffset(t)
    }
  }
  function clearQuote() {
    setQuote('')
    setSelected([])
  }

  // ---- Lyric-mode helpers ----
  async function pickHit(hit: TrackHit) {
    setSelectedHit(hit)
    setLyricHits([])
    setLyricQuery(`${hit.title} — ${hit.artist}`)
    // A new song is a fresh dataset — reset the verse + lyrics.
    setQuote('')
    setSelected([])
    setSyncedLines([])
    setLyricOffset(0)
    setLyricNudge(0)
    setLyricLines([])
    setLyricsError(null)
    setLyricsLoading(true)
    try {
      const { plain, synced } = await fetchSyncedLyrics(hit.artist, hit.title)
      setSyncedLines(synced)
      // Prefer the plain lines for the verse picker; fall back to the synced text.
      setLyricLines(plain.length ? plain : synced.map((s) => s.text))
      if (plain.length === 0 && synced.length === 0) {
        setLyricsError('Letra não encontrada. Escreva o verso à mão abaixo.')
      }
    } catch (e) {
      setLyricsError(e instanceof Error ? e.message : 'Erro ao buscar a letra.')
    } finally {
      setLyricsLoading(false)
    }
  }

  function changeAppMode(next: AppMode) {
    if (next === appMode) return
    setAppMode(next)
    setError(null)
    setEditorTab('cover')
    // Reset per-experience derived state so nothing carries over.
    setQuote('')
    setSelected([])
    setLyricLines([])
    setSyncedLines([])
    setLyricOffset(0)
    setLyricNudge(0)
    setLyricsError(null)
    setLyricHits([])
    setSelectedHit(null)
    setLyricQuery('')
    removeVideo()
    removeCustomCover()
  }

  /** Renders the right card for the current mode with the given role/format. */
  function renderCard(
    variant: 'story' | 'feed',
    o: { mode?: 'normal' | 'overlay'; live?: boolean; offscreen?: boolean; ref?: Ref<HTMLDivElement> } = {},
  ) {
    if (appMode === 'lyric') {
      return (
        <LyricCard
          ref={o.ref}
          variant={variant}
          title={selectedHit?.title ?? ''}
          artist={selectedHit?.artist ?? ''}
          album={selectedHit?.album ?? ''}
          cover={customCoverUrl || coverDataUrl}
          syncedLines={syncedLines}
          lyricOffset={lyricOffset + lyricNudge}
          quote={quote}
          live={o.live}
          mode={o.mode}
          paused={o.offscreen}
          {...(videoUrl
            ? { videoUrl, videoStart: start, videoDuration: clipLen }
            : {})}
        />
      )
    }
    return (
      <RecapCard
        ref={o.ref}
        recap={customCoverUrl ? { ...recap!, heroImage: customCoverUrl } : recap!}
        variant={variant}
        quote={quote}
        quoteSong={quoteSong}
        mode={o.mode}
        paused={o.offscreen}
        {...(o.mode === 'overlay' ? { videoUrl } : videoProps)}
      />
    )
  }

  // ---- Swipe helpers (mobile Story ⇄ Feed) ----
  const SWIPE_THRESHOLD = 60
  const SWIPE_FLY_DISTANCE = 500
  function handleSwipeStart(e: ReactPointerEvent<HTMLDivElement>) {
    if (isWide) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStartRef.current = e.clientX
    setDragging(true)
  }
  function handleSwipeMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragStartRef.current == null) return
    setDragX(e.clientX - dragStartRef.current)
  }
  function handleSwipeEnd() {
    if (dragStartRef.current == null) return
    dragStartRef.current = null
    setDragging(false)
    if (Math.abs(dragX) > SWIPE_THRESHOLD) {
      const dir = dragX > 0 ? 1 : -1
      setDragX(dir * SWIPE_FLY_DISTANCE)
      if (!hasSwiped) {
        setHasSwiped(true)
        localStorage.setItem('echo_swiped', '1')
      }
      window.setTimeout(() => {
        setPreviewFmt((f) => (f === 'story' ? 'feed' : 'story'))
        setDragX(0)
      }, 220)
    } else {
      setDragX(0)
    }
  }

  // ---- Swipe helpers (mobile Capa ⇄ Lado B ⇄ Verso) ----
  // Same fly-off-then-swap gesture as the Story⇄Feed one above, generalized to
  // step forward/backward through a 3-tab sequence (dragging right steps back,
  // dragging left steps forward) instead of just flipping a binary format.
  function handleEditorSwipeStart(e: ReactPointerEvent<HTMLDivElement>) {
    if (isWide) return
    e.currentTarget.setPointerCapture(e.pointerId)
    editorDragStartRef.current = e.clientX
    setEditorDragging(true)
  }
  function handleEditorSwipeMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (editorDragStartRef.current == null) return
    setEditorDragX(e.clientX - editorDragStartRef.current)
  }
  function handleEditorSwipeEnd() {
    if (editorDragStartRef.current == null) return
    editorDragStartRef.current = null
    setEditorDragging(false)
    if (Math.abs(editorDragX) > SWIPE_THRESHOLD) {
      const dir = editorDragX > 0 ? 1 : -1
      const curIdx = EDITOR_TABS.indexOf(editorTab)
      const nextIdx = (curIdx - dir + EDITOR_TABS.length) % EDITOR_TABS.length
      setEditorDragX(dir * SWIPE_FLY_DISTANCE)
      if (!hasSwipedEditor) {
        setHasSwipedEditor(true)
        localStorage.setItem('echo_swiped_editor', '1')
      }
      window.setTimeout(() => {
        setEditorTab(EDITOR_TABS[nextIdx])
        setEditorDragX(0)
      }, 220)
    } else {
      setEditorDragX(0)
    }
  }

  // ---- Video helpers ----
  function onVideoFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    const url = URL.createObjectURL(file)
    setVideoUrl(url)
    setClipStart(0)
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    const applyDur = (d: number) => {
      const real = Number.isFinite(d) && d > 0 ? d : 0
      setVideoDur(real)
      setClipLen(Math.min(MAX_CLIP, real || MAX_CLIP))
    }
    probe.onloadedmetadata = () => {
      // Some containers (e.g. many WebM/MediaRecorder files) report the duration
      // as Infinity until the element seeks to the end. Force that so the clip
      // controls clamp to the real length instead of over-running on export.
      if (Number.isFinite(probe.duration) && probe.duration > 0) {
        applyDur(probe.duration)
        return
      }
      const onSeeked = () => {
        probe.removeEventListener('seeked', onSeeked)
        applyDur(probe.duration)
      }
      probe.addEventListener('seeked', onSeeked)
      probe.currentTime = 1e101
    }
    probe.src = url
  }
  function removeVideo() {
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    setVideoUrl('')
    setVideoDur(0)
    setClipStart(0)
    setClipLen(MAX_CLIP)
  }

  // ---- Custom cover helpers ----
  function onCoverFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (customCoverUrl) URL.revokeObjectURL(customCoverUrl)
    setCustomCoverUrl(URL.createObjectURL(file))
  }
  function removeCustomCover() {
    if (customCoverUrl) URL.revokeObjectURL(customCoverUrl)
    setCustomCoverUrl('')
  }

  // ---- Exports ----
  /** Slugified base filename for downloads, valid in both recap and lyric mode. */
  function exportName(kind: 'story' | 'feed') {
    const slug = (s: string) =>
      s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'echo'
    const base =
      appMode === 'lyric'
        ? `letra-${slug(`${selectedHit?.title ?? ''}-${selectedHit?.artist ?? ''}`)}`
        : `recap-${recap?.user ?? 'echo'}-${recap?.period ?? ''}`
    return `${base}-${kind}`
  }

  /**
   * Renders the export asset without downloading or sharing it — a video if a
   * clip is loaded (and the browser can record one), a PNG otherwise. Shared by
   * the plain-download handlers below and by the share-to-platform flow, so
   * there's exactly one place that knows how to produce each format.
   */
  async function renderExportAsset(kind: 'story' | 'feed', customDuration?: number) {
    if (videoUrl && !IS_FIREFOX) {
      const overlayNode = kind === 'story' ? overlayStoryRef.current : overlayFeedRef.current
      const video = exportVideoRef.current
      if (!overlayNode || !video) return null
      const duration = customDuration ?? clipLen
      const maxStartForDur = Math.max(0, videoDur - duration)
      const startForExport = Math.min(clipStart, maxStartForDur)
      setVstatus('Preparando…')
      const { blob, ext } = await exportCardVideo({
        overlayNode,
        video,
        ...DIMS[kind],
        // Recap story hero is a compact band, not the full-bleed lyric hero.
        ...(kind === 'story' && appMode === 'recap' ? { hero: RECAP_STORY_HERO } : {}),
        start: startForExport,
        duration,
        onStatus: setVstatus,
        lyric:
          appMode === 'lyric' && syncedLines.length > 0
            ? { lines: syncedLines, variant: kind, offset: lyricOffset + lyricNudge }
            : undefined,
      })
      return {
        blob,
        filename: `${exportName(kind)}.${ext}`,
        mime: ext === 'mp4' ? 'video/mp4' : 'video/webm',
        isFallbackWebm: ext === 'webm',
      }
    }
    const node = kind === 'story' ? storyRef.current : feedRef.current
    if (!node) return null
    setVstatus('Gerando imagem…')
    const blob = await nodeToPngBlob(node)
    return { blob, filename: `${exportName(kind)}.png`, mime: 'image/png', isFallbackWebm: false }
  }

  /**
   * Always downloads the still image, regardless of a loaded video clip. Used
   * both as the share-flow's fallback (keyed by `kind`, so it lines up with
   * whichever brand button triggered it) and by the plain "baixar foto" button
   * (keyed by its own 'photo' id, so it doesn't light up a brand button that
   * the user never clicked).
   */
  async function handlePngExport(kind: 'story' | 'feed', exportingKey: string = kind) {
    const node = kind === 'story' ? storyRef.current : feedRef.current
    if (!node || !showCard) return
    setExporting(exportingKey)
    setVstatus('Gerando imagem…')
    try {
      const blob = await nodeToPngBlob(node)
      downloadBlob(blob, `${exportName(kind)}.png`)
    } catch {
      setError('Falha ao gerar o PNG. Tente gerar o recap novamente.')
    } finally {
      setExporting(null)
      setVstatus(null)
    }
  }

  async function handleVideoExport(kind: 'story' | 'feed', customDuration?: number) {
    if (!showCard) return
    setExporting(kind)
    try {
      const asset = await renderExportAsset(kind, customDuration)
      if (!asset) return
      downloadBlob(asset.blob, asset.filename)
      if (asset.isFallbackWebm) {
        setError(
          'Não consegui gerar MP4 neste navegador (o conversor falhou) — baixei em WebM. ' +
            'Tente no Chrome/Edge para MP4, ou veja o console para o erro do ffmpeg.',
        )
      }
    } catch (err) {
      console.error('Falha ao gerar o vídeo:', err)
      const detail =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setError(`Falha ao gerar o vídeo — ${detail}`)
    } finally {
      setExporting(null)
      setVstatus(null)
    }
  }

  /**
   * Story/Feed buttons: try to hand the exported file straight to the OS share
   * sheet (Web Share API), so the user can pick Instagram or X and post from
   * there directly — no true web deep link into either app's composer exists
   * without a registered native app, so the share sheet is the closest thing.
   * Falls back to a plain download wherever Web Share (with files) isn't
   * supported — desktop Firefox, older browsers — or if the user's browser
   * rejects/cancels the share.
   */
  async function handleShareExport(kind: 'story' | 'feed') {
    if (!showCard) return
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>
      canShare?: (data: ShareData) => boolean
    }
    if (!nav.share || !nav.canShare) {
      return videoUrl && !IS_FIREFOX ? handleVideoExport(kind) : handlePngExport(kind)
    }
    setExporting(kind)
    try {
      const asset = await renderExportAsset(kind)
      if (!asset) return
      if (asset.isFallbackWebm) {
        setError(
          'Não consegui gerar MP4 neste navegador (o conversor falhou) — baixei em WebM. ' +
            'Tente no Chrome/Edge para MP4, ou veja o console para o erro do ffmpeg.',
        )
      }
      const file = new File([asset.blob], asset.filename, { type: asset.mime })
      if (!nav.canShare({ files: [file] })) {
        downloadBlob(asset.blob, asset.filename)
        return
      }
      setVstatus('Abrindo…')
      try {
        await nav.share({
          files: [file],
          title: 'Echo',
          text:
            kind === 'story'
              ? 'Meu recap do Echo — bora pro Story!'
              : 'Meu recap do Echo',
        })
      } catch (shareErr) {
        // The user closing the share sheet also lands here as an AbortError —
        // that's a normal cancel, not a failure, so it gets no fallback download.
        if (shareErr instanceof DOMException && shareErr.name === 'AbortError') return
        downloadBlob(asset.blob, asset.filename)
      }
    } catch (err) {
      console.error('Falha ao gerar o arquivo para compartilhar:', err)
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setError(
        videoUrl && !IS_FIREFOX
          ? `Falha ao gerar o vídeo — ${detail}`
          : 'Falha ao gerar o PNG. Tente gerar o recap novamente.',
      )
    } finally {
      setExporting(null)
      setVstatus(null)
    }
  }

  function changeSource(next: Source) {
    if (next === source) return
    setSource(next)
    localStorage.setItem('recap_source', next)
    // Keep the period valid for the new source (Spotify has no weekly view).
    if (!SOURCE_PERIODS[next].includes(period)) setPeriod(SOURCE_PERIODS[next][0])
    // A different source is a different dataset — reset everything derived.
    setRecaps({})
    setGenerated(false)
    setError(null)
    setQuote('')
    setSelected([])
    setQuoteSongIdx(0)
  }

  async function connectSpotify() {
    setError(null)
    try {
      spotify.setClientId(spClientId)
      await spotify.login() // navigates away to Spotify
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao conectar ao Spotify.')
    }
  }

  function disconnectSpotify() {
    spotify.logout()
    setSpConnected(false)
    setRecaps({})
    setGenerated(false)
  }

  const videoProps = videoUrl
    ? { videoUrl, videoStart: start, videoDuration: clipLen }
    : {}

  // While a card is exporting, the clicked button carries its live status inline
  // (percent + a loading fill); the other buttons just disable. The percent is
  // parsed from the status string ("Gravando… 13%", "Convertendo… 40%").
  const exportPct = vstatus?.match(/(\d+)%/)?.[1]
  const exportLabel = vstatus ?? 'Gerando…'
  function exportBtnProps(kind: 'story' | 'feed') {
    const active = exporting === kind
    return {
      className:
        `btn btn--${kind === 'story' ? 'instagram' : 'x'}` +
        (active ? ' is-exporting' : '') +
        (active && !exportPct ? ' is-indeterminate' : ''),
      disabled: !!exporting,
      style:
        active && exportPct
          ? ({ '--progress': `${exportPct}%` } as CSSProperties)
          : undefined,
    }
  }
  // The plain "baixar foto" button is keyed by its own id (not 'story'/'feed')
  // so it never lights up a brand button the user didn't click.
  const dlActive = exporting === 'photo'
  const dlBtnProps = {
    className:
      'btn btn--download' + (dlActive ? ' is-exporting' : '') + (dlActive && !exportPct ? ' is-indeterminate' : ''),
    disabled: !!exporting,
    style: dlActive && exportPct ? ({ '--progress': `${exportPct}%` } as CSSProperties) : undefined,
  }

  return (
    <>
    <div className="app" data-source={source}>
      <header className="masthead">
        <span className="masthead__cat">Ecoe para todos</span>
        <h1 className="masthead__title">Echo</h1>
        <p className="masthead__sub">
          Um retrato do que você andou ouvindo, prensado numa imagem pronta pra
          story do Instagram e feed do Twitter.
        </p>
      </header>

      {/* Top-level mode switch: the recap experience or the lyric card. */}
      <div className="segmented segmented--mode">
        <span
          className="segmented__slider"
          style={{ width: '50%', transform: `translateX(${appMode === 'lyric' ? 100 : 0}%)` }}
        />
        <button
          type="button"
          className={`segmented__opt ${appMode === 'recap' ? 'is-active' : ''}`}
          onClick={() => changeAppMode('recap')}
        >
          Top álbuns
        </button>
        <button
          type="button"
          className={`segmented__opt ${appMode === 'lyric' ? 'is-active' : ''}`}
          onClick={() => changeAppMode('lyric')}
        >
          Letra
        </button>
      </div>

      {appMode === 'recap' && (
      <>
      {/* Source selector: choose between Last.fm and Spotify. */}
      {SHOW_SPOTIFY && (
      <div className="segmented segmented--source">
        <span
          className="segmented__slider"
          style={{ width: '50%', transform: `translateX(${source === 'spotify' ? 100 : 0}%)` }}
        />
        <button
          type="button"
          className={`segmented__opt ${source === 'lastfm' ? 'is-active' : ''}`}
          onClick={() => changeSource('lastfm')}
        >
          Last.fm
        </button>
        <button
          type="button"
          className={`segmented__opt ${source === 'spotify' ? 'is-active' : ''}`}
          onClick={() => changeSource('spotify')}
        >
          Spotify
        </button>
      </div>
      )}

      {SHOW_SPOTIFY && source === 'spotify' && !spConnected && (
        <div className="keybox">
          {hasClientId ? (
            <>
              <p className="keybox__hint keybox__hint--center">
                Entre com seu spotify para começar a ecoar seu som para todos.
              </p>
              <button className="btn btn--spotify" onClick={connectSpotify}>
                <svg className="btn__spotify-mark" viewBox="0 0 168 168" aria-hidden fill="currentColor">
                  <path d="M83.996.277C37.747.277.253 37.77.253 84.019c0 46.251 37.494 83.741 83.743 83.741 46.254 0 83.744-37.49 83.744-83.741 0-46.246-37.49-83.738-83.745-83.738l.001-.004zm38.404 120.78a5.217 5.217 0 01-7.18 1.73c-19.662-12.01-44.414-14.73-73.564-8.07a5.222 5.222 0 01-6.249-3.93 5.213 5.213 0 013.926-6.25c31.9-7.291 59.263-4.15 81.337 9.34 2.46 1.51 3.24 4.72 1.73 7.18zm10.25-22.805c-1.89 3.075-5.91 4.045-8.98 2.155-22.51-13.839-56.823-17.846-83.448-9.764-3.453 1.043-7.1-.903-8.148-4.35a6.538 6.538 0 014.354-8.143c30.413-9.228 68.222-4.758 94.072 11.127 3.07 1.89 4.04 5.91 2.15 8.976v-.001zm.88-23.744c-26.99-16.031-71.52-17.505-97.289-9.684-4.138 1.255-8.514-1.081-9.768-5.219a7.835 7.835 0 015.221-9.771c29.581-8.98 78.756-7.245 109.83 11.202a7.823 7.823 0 012.74 10.733c-2.2 3.722-7.02 4.949-10.73 2.739z" />
                </svg>{' '}
                Entrar com Spotify
              </button>
            </>
          ) : (
            <>
              <p className="keybox__hint">
                Cole o <strong>Client ID</strong> do seu app do Spotify (crie em{' '}
                <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                  developer.spotify.com/dashboard
                </a>
                ) e cadastre esta URL como <em>Redirect URI</em>. Depois é só conectar.
              </p>
              <div className="keybox__row">
                <input
                  className="input"
                  type="text"
                  placeholder="Spotify Client ID"
                  value={spClientId}
                  onChange={(e) => setSpClientId(e.target.value)}
                />
                <button className="btn" onClick={connectSpotify} disabled={!spClientId.trim()}>
                  Conectar Spotify
                </button>
              </div>
              <p className="keybox__hint">
                Redirect URI: <code>{window.location.origin + window.location.pathname}</code>
              </p>
            </>
          )}
        </div>
      )}

      {SHOW_SPOTIFY && source === 'spotify' && spConnected && (
        <div className="keybox keybox--row">
          <span className="keybox__hint">✓ Conta do Spotify conectada.</span>
          <button className="btn" onClick={disconnectSpotify}>
            Desconectar
          </button>
        </div>
      )}

      <form className="controls" onSubmit={generate}>
        {source === 'lastfm' && (
          <input
            className="input input--user"
            placeholder="usuário do Last.fm"
            value={user}
            onChange={(e) => {
              setUser(e.target.value)
              // Editing the user requires generating again — bring the button back.
              setGenerated(false)
            }}
          />
        )}
        <div className="segmented">
          <span
            className="segmented__slider"
            style={{
              width: `${100 / periods.length}%`,
              transform: `translateX(${periods.indexOf(period) * 100}%)`,
            }}
          />
          {periods.map((p) => (
            <button
              type="button"
              key={p}
              className={`segmented__opt ${p === period ? 'is-active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {periodLabel(source, p)}
            </button>
          ))}
        </div>
        {!generated && (
          <button
            className="btn btn--primary"
            type="submit"
            disabled={loading || !ready}
          >
            {loading ? 'Gerando…' : 'Gerar recap'}
          </button>
        )}
      </form>
      </>
      )}

      {appMode === 'lyric' && (
        <div className="lyric-search">
          <input
            className="input input--user"
            placeholder="nome da música…"
            value={lyricQuery}
            onChange={(e) => setLyricQuery(e.target.value)}
            autoComplete="off"
          />
          {searching && lyricHits.length === 0 && (
            <div className="lyric-hits lyric-hits--status">Buscando…</div>
          )}
          {lyricHits.length > 0 && (
            <ul className="lyric-hits" role="listbox">
              {lyricHits.map((hit) => (
                <li key={hit.id} role="option" aria-selected={selectedHit?.id === hit.id}>
                  <button
                    type="button"
                    className={`lyric-hit ${selectedHit?.id === hit.id ? 'is-active' : ''}`}
                    onClick={() => pickHit(hit)}
                  >
                    {hit.cover ? (
                      <img className="lyric-hit__cover" src={proxied(hit.cover, 96)} alt="" />
                    ) : (
                      <span className="lyric-hit__cover lyric-hit__cover--empty" />
                    )}
                    <span className="lyric-hit__meta">
                      <span className="lyric-hit__title">{hit.title}</span>
                      <span className="lyric-hit__sub">
                        {[hit.artist, hit.album].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {generated && !recap && !loading && !error && (
        <p className="quote-editor__hint">Sem dados para este período.</p>
      )}

      {showCard && (
        <>
          {/* Format toggle — drives which layout the preview below shows. Desktop
              only; on mobile the card itself is swiped (see .swipe-cue below). */}
          {isWide && (
            <div className="segmented segmented--format">
              <span
                className="segmented__slider"
                style={{ width: '50%', transform: `translateX(${previewFmt === 'feed' ? 100 : 0}%)` }}
              />
              <button
                type="button"
                className={`segmented__opt ${previewFmt === 'story' ? 'is-active' : ''}`}
                onClick={() => setPreviewFmt('story')}
              >
                Story · 9:16
              </button>
              <button
                type="button"
                className={`segmented__opt ${previewFmt === 'feed' ? 'is-active' : ''}`}
                onClick={() => setPreviewFmt('feed')}
              >
                Feed · 16:9
              </button>
            </div>
          )}

          <div className="preview">
            <div
              className={`preview__frame preview__frame--${previewFmt}`}
              ref={previewRef}
              style={{ height: previewH || undefined }}
            >
              <div
                className={`preview__anim ${!isWide ? 'preview__anim--swipeable' : ''} ${dragging ? 'is-dragging' : ''}`}
                key={`${appMode}-${selectedHit?.id ?? period}-${previewFmt}`}
                style={{
                  transform: `translateX(${dragX}px) rotate(${dragX / 24}deg) scale(${previewScale})`,
                }}
                {...(!isWide
                  ? {
                      onPointerDown: handleSwipeStart,
                      onPointerMove: handleSwipeMove,
                      onPointerUp: handleSwipeEnd,
                      onPointerCancel: handleSwipeEnd,
                    }
                  : {})}
              >
                {renderCard(previewFmt, { live: appMode === 'lyric' && !!videoUrl })}
              </div>
            </div>
          </div>

          {/* Mobile stand-in for the desktop segmented toggle: the card itself is
              dragged sideways (Tinder-style) to flip Story ⇄ Feed. The phone
              icons double as a tap fallback; the hint text fades out after the
              first successful swipe (remembered in localStorage). */}
          {!isWide && !hasSwiped && (
            <span className="swipe-cue__hint">arraste para o lado para trocar</span>
          )}
          {!isWide && (
            <div className="swipe-cue">
              <div className="swipe-cue__phones" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewFmt === 'story'}
                  aria-label="Story · 9:16"
                  className={`swipe-cue__phone ${previewFmt === 'story' ? 'is-active' : ''}`}
                  onClick={() => setPreviewFmt('story')}
                >
                  <svg viewBox="0 0 14 22" width="14" height="22" aria-hidden focusable="false">
                    <rect x="1" y="1" width="12" height="20" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                    <circle cx="7" cy="18.1" r="0.9" fill="currentColor" />
                  </svg>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewFmt === 'feed'}
                  aria-label="Feed · 16:9"
                  className={`swipe-cue__phone ${previewFmt === 'feed' ? 'is-active' : ''}`}
                  onClick={() => setPreviewFmt('feed')}
                >
                  <svg viewBox="0 0 22 14" width="22" height="14" aria-hidden focusable="false">
                    <rect x="1" y="1" width="20" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                    <circle cx="18.1" cy="7" r="0.9" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Floating side-dock: a story-format phone mock that stays pinned in
              the desktop margin while a video is loaded, so the clip stays
              visible while the user scrubs the controls further down the page.
              Hidden on narrow viewports (CSS) — there's no room beside the column. */}
          {videoUrl && isWide && (
            <aside
              className="video-dock"
              aria-hidden
              style={{ '--dock-w': `${DOCK_W}px` } as CSSProperties}
            >
              <span className="video-dock__label">
                Preview do vídeo · {dockIsStory ? 'Story' : 'Feed'}
              </span>
              <div className="video-dock__phone" style={{ height: dockH }}>
                <div className="video-dock__scale" style={{ transform: `scale(${dockScale})` }}>
                  {renderCard(previewFmt, { live: appMode === 'lyric' && !!videoUrl })}
                </div>
              </div>
            </aside>
          )}

          <div className="export-bar">
            <button {...exportBtnProps('story')} onClick={() => handleShareExport('story')}>
              <svg className="btn__brand-mark" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="20" rx="5.5" />
                <circle cx="12" cy="12" r="5" />
                <circle cx="17.6" cy="6.4" r="1.15" fill="currentColor" stroke="none" />
              </svg>
              {exporting === 'story' ? exportLabel : 'Story'}
            </button>
            <button {...exportBtnProps('feed')} onClick={() => handleShareExport('feed')}>
              <svg className="btn__brand-mark" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
              </svg>
              {exporting === 'feed' ? exportLabel : 'Feed'}
            </button>
            <button
              {...dlBtnProps}
              onClick={() => handlePngExport(previewFmt, 'photo')}
              title={`Baixar o recap em ${previewFmt === 'story' ? 'Story' : 'Feed'} (${previewFmt === 'story' ? '1080×1920' : '1600×900'}), sem tentar compartilhar.`}
            >
              <svg className="btn__brand-mark" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12m0 0-4-4m4 4 4-4" />
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              {dlActive ? exportLabel : `Baixar recap · ${previewFmt === 'story' ? 'Story' : 'Feed'}`}
            </button>
          </div>
          {videoUrl && !IS_FIREFOX && (
            <p className="quote-editor__hint">
              Story e Feed abrem o compartilhamento do seu aparelho — escolha o Instagram ou o
              X pra postar. Sem suporte a isso, o arquivo é só baixado.
            </p>
          )}
          {videoUrl && IS_FIREFOX && (
            <p className="quote-editor__hint">
              ⚠ Exportar vídeo não é suportado no Firefox. O clipe aparece no preview, mas o
              download aqui é o PNG (foto). Para gerar o MP4, abra no Chrome, Edge ou Safari.
            </p>
          )}

          {/* Editor tabs: Capa / Lado B / Verso — desktop keeps the segmented
              toggle; mobile swaps it for a dragged (Tinder-style) panel, same
              split as the Story↔Feed toggle above. Only one panel renders
              below at a time instead of stacking all three in a long scroll. */}
          {isWide && (
            <div className="segmented segmented--editor">
              <span
                className="segmented__slider"
                style={{
                  width: `${100 / EDITOR_TABS.length}%`,
                  transform: `translateX(${EDITOR_TABS.indexOf(editorTab) * 100}%)`,
                }}
              />
              <button
                type="button"
                className={`segmented__opt ${editorTab === 'cover' ? 'is-active' : ''} ${
                  customCoverUrl ? 'has-content' : ''
                }`}
                onClick={() => setEditorTab('cover')}
              >
                Capa
              </button>
              <button
                type="button"
                className={`segmented__opt ${editorTab === 'video' ? 'is-active' : ''} ${
                  videoUrl ? 'has-content' : ''
                }`}
                onClick={() => setEditorTab('video')}
              >
                Lado B
              </button>
              <button
                type="button"
                className={`segmented__opt ${editorTab === 'quote' ? 'is-active' : ''} ${
                  quote ? 'has-content' : ''
                }`}
                onClick={() => setEditorTab('quote')}
              >
                Verso
              </button>
            </div>
          )}

          {!isWide && !hasSwipedEditor && (
            <span className="swipe-cue__hint">arraste o painel para o lado para trocar</span>
          )}
          {!isWide && (
            <div className="swipe-cue swipe-cue--editor">
              <div className="swipe-cue__dots" role="tablist">
                {([
                  ['cover', 'Capa', customCoverUrl],
                  ['video', 'Lado B', videoUrl],
                  ['quote', 'Verso', quote],
                ] as const).map(([tab, label, hasContent]) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={editorTab === tab}
                    aria-label={label}
                    className={`swipe-cue__dot ${editorTab === tab ? 'is-active' : ''} ${
                      hasContent ? 'has-content' : ''
                    }`}
                    onClick={() => setEditorTab(tab)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {editorTab === 'cover' && (
          <div
            className={`editor-panel ${!isWide ? 'editor-panel--swipeable' : ''} ${
              editorDragging ? 'is-dragging' : ''
            }`}
            style={!isWide ? { transform: `translateX(${editorDragX}px) rotate(${editorDragX / 32}deg)` } : undefined}
            {...(!isWide
              ? {
                  onPointerDown: handleEditorSwipeStart,
                  onPointerMove: handleEditorSwipeMove,
                  onPointerUp: handleEditorSwipeEnd,
                  onPointerCancel: handleEditorSwipeEnd,
                }
              : {})}
          >
          <section className="panel cover-editor">
            <div className="panel__head">
              <span className="eyebrow">Capa · opcional</span>
              <h2 className="panel__title">Imagem de capa</h2>
            </div>
            <p className="panel__hint">
              Por padrão usamos a capa encontrada automaticamente. Se preferir, suba a sua
              própria foto para o topo do card (ela é substituída pelo vídeo, se você subir um).
            </p>
            <div className="cover-editor__actions">
              <input
                id="cover-file"
                className="filepicker__input"
                type="file"
                accept="image/*"
                onChange={onCoverFile}
              />
              <label htmlFor="cover-file" className="btn btn--primary">
                {customCoverUrl ? 'Trocar imagem' : 'Escolher imagem'}
              </label>
              {customCoverUrl && (
                <button className="btn" onClick={removeCustomCover}>
                  Usar capa padrão
                </button>
              )}
            </div>
          </section>
          </div>
          )}

          {editorTab === 'video' && (
          <div
            className={`editor-panel ${!isWide ? 'editor-panel--swipeable' : ''} ${
              editorDragging ? 'is-dragging' : ''
            }`}
            style={!isWide ? { transform: `translateX(${editorDragX}px) rotate(${editorDragX / 32}deg)` } : undefined}
            {...(!isWide
              ? {
                  onPointerDown: handleEditorSwipeStart,
                  onPointerMove: handleEditorSwipeMove,
                  onPointerUp: handleEditorSwipeEnd,
                  onPointerCancel: handleEditorSwipeEnd,
                }
              : {})}
          >
          <section
            className={`panel video-editor ${IS_FIREFOX ? 'is-disabled' : ''}`}
            aria-disabled={IS_FIREFOX}
          >
            <div className="panel__head">
              <span className="eyebrow">Lado B · opcional</span>
              <h2 className="panel__title">Vídeo no topo</h2>
            </div>
            <p className="panel__hint">
              Suba um clipe da música mais ouvida. Ele vira o fundo do topo e o download
              passa a ser MP4 (máx. {MAX_CLIP}s).
            </p>
            {IS_FIREFOX && (
              <p className="panel__note">
                ⚠ Indisponível no Firefox: ele não consegue gravar vídeo em MP4 (o navegador
                não suporta esse formato no MediaRecorder), então o clipe não pode ser
                exportado por aqui. Abra no Chrome, Edge ou Safari para usar o vídeo no topo —
                a foto (PNG) continua funcionando normalmente.
              </p>
            )}
            <div className="filepicker">
              <input
                id="video-file"
                className="filepicker__input"
                type="file"
                accept="video/*"
                onChange={onVideoFile}
                disabled={IS_FIREFOX}
              />
              <label htmlFor="video-file" className="btn btn--primary">
                {videoUrl ? 'Trocar vídeo' : 'Escolher vídeo'}
              </label>
              {videoUrl && (
                <button className="btn" onClick={removeVideo}>
                  Remover vídeo
                </button>
              )}
            </div>
            {videoUrl && !IS_FIREFOX && (
              <div className="video-editor__controls">
                <label className="video-editor__row">
                  <span>Início do trecho: {clock(start)}</span>
                  <input
                    type="range"
                    min={0}
                    max={videoDur ? Math.max(0, videoDur - 1) : MAX_CLIP}
                    step={0.1}
                    value={clipStart}
                    onChange={(e) => {
                      const val = Number(e.target.value)
                      setClipStart(val)
                      if (videoDur && val + clipLen > videoDur) {
                        setClipLen(Math.max(1, videoDur - val))
                      }
                    }}
                  />
                </label>
                <label className="video-editor__row">
                  <span>Duração: {clock(clipLen)} (máx {clock(MAX_CLIP)})</span>
                  <input
                    type="range"
                    min={1}
                    max={Math.min(MAX_CLIP, videoDur || MAX_CLIP)}
                    step={0.5}
                    value={clipLen}
                    onChange={(e) => {
                      const val = Number(e.target.value)
                      setClipLen(val)
                      if (videoDur && clipStart + val > videoDur) {
                        setClipStart(Math.max(0, videoDur - val))
                      }
                    }}
                  />
                </label>
                <div className="video-editor__presets">
                  <span className="video-editor__presets-label">exporte diretamente o clipe em:</span>
                  <div className="video-editor__presets-row">
                    <button
                      className="btn"
                      disabled={!!exporting}
                      onClick={() => {
                        const d = Math.min(15, videoDur || 15)
                        setClipLen(d)
                        const maxS = Math.max(0, videoDur - d)
                        setClipStart(prev => Math.min(prev, maxS))
                        handleVideoExport(previewFmt, d)
                      }}
                    >
                      15 segundos
                    </button>
                    <button
                      className="btn"
                      disabled={!!exporting}
                      onClick={() => {
                        const d = Math.min(30, videoDur || 30)
                        setClipLen(d)
                        const maxS = Math.max(0, videoDur - d)
                        setClipStart(prev => Math.min(prev, maxS))
                        handleVideoExport(previewFmt, d)
                      }}
                    >
                      30 segundos
                    </button>
                    <button
                      className="btn"
                      disabled={!!exporting}
                      onClick={() => {
                        const d = Math.min(60, videoDur || 60)
                        setClipLen(d)
                        const maxS = Math.max(0, videoDur - d)
                        setClipStart(prev => Math.min(prev, maxS))
                        handleVideoExport(previewFmt, d)
                      }}
                    >
                      1 minuto
                    </button>
                  </div>
                </div>
                <button className="btn" onClick={removeVideo}>
                  Remover vídeo
                </button>
              </div>
            )}
          </section>
          </div>
          )}

          {/* Mobile counterpart of the side-dock: on narrow viewports the fixed
              dock is gone, so the live mock drops in here, expanding in when a
              clip is loaded. Shown regardless of which editor tab is active —
              same as the desktop dock — since it's a standing reminder of the
              video hero, not part of any one panel. */}
          {videoUrl && !isWide && (
            <section
              className="video-mock"
              aria-hidden
              style={{ '--dock-w': `${DOCK_W}px` } as CSSProperties}
            >
              <span className="video-dock__label">
                Preview do vídeo · {dockIsStory ? 'Story' : 'Feed'}
              </span>
              <div className="video-dock__phone" style={{ height: dockH }}>
                <div className="video-dock__scale" style={{ transform: `scale(${dockScale})` }}>
                  {renderCard(previewFmt, { live: appMode === 'lyric' && !!videoUrl })}
                </div>
              </div>
            </section>
          )}

          {editorTab === 'quote' && (
          <div
            className={`editor-panel ${!isWide ? 'editor-panel--swipeable' : ''} ${
              editorDragging ? 'is-dragging' : ''
            }`}
            style={!isWide ? { transform: `translateX(${editorDragX}px) rotate(${editorDragX / 32}deg)` } : undefined}
            {...(!isWide
              ? {
                  onPointerDown: handleEditorSwipeStart,
                  onPointerMove: handleEditorSwipeMove,
                  onPointerUp: handleEditorSwipeEnd,
                  onPointerCancel: handleEditorSwipeEnd,
                }
              : {})}
          >
          <section className="panel encarte">
            <div className="panel__head">
              <span className="eyebrow">Encarte</span>
              <h2 className="panel__title">Verso em destaque</h2>
              <p className="panel__lead">
                {appMode === 'lyric'
                  ? 'No PNG sai o verso marcado. No vídeo, marque a linha cantada no início do clipe: ela aparece primeiro e as seguintes vão surgindo animadas.'
                  : 'Marque os versos da letra e eles saem impressos no card.'}
              </p>
            </div>

            {appMode === 'recap' && recap && (
              <div className="encarte__field">
                <span className="field__label">Faixa</span>
                <TrackSelect
                  tracks={recap.topTracks}
                  value={quoteSongIdx}
                  onChange={selectSong}
                />
              </div>
            )}

            {appMode === 'lyric' && videoUrl && syncedLines.length > 0 && (
              <label className="encarte__field">
                <span className="field__label">
                  Ajuste fino da sincronia: {lyricNudge > 0 ? '+' : ''}
                  {lyricNudge.toFixed(1)}s
                </span>
                <input
                  type="range"
                  min={-5}
                  max={5}
                  step={0.1}
                  value={lyricNudge}
                  onChange={(e) => setLyricNudge(Number(e.target.value))}
                />
                <span className="panel__hint">
                  Marque a linha cantada no começo do clipe para ancorar a
                  animação; use este controle para acertar o tempo com o áudio.
                </span>
              </label>
            )}

            {lyricsLoading && <p className="quote-editor__hint">Buscando letra…</p>}
            {lyricsError && <p className="error">{lyricsError}</p>}
            {!lyricsLoading && !lyricsError && lyricLines.length === 0 && (
              <p className="quote-editor__hint">
                Letra não encontrada. Escreva o verso à mão abaixo.
              </p>
            )}

            {lyricLines.length > 0 && (
              <div className="encarte__field">
                <div className="lyric-sheet__meta">
                  <span className="field__label">Letra</span>
                  <span className="lyric-sheet__count">
                    {selected.length > 0
                      ? `${selected.length} ${selected.length === 1 ? 'linha' : 'linhas'} marcada${
                          selected.length === 1 ? '' : 's'
                        }`
                      : 'toque para marcar'}
                  </span>
                </div>
                <div className="lyric-lines">
                  {lyricLines.map((line, i) => (
                    <button
                      type="button"
                      key={i}
                      className={`lyric-line ${selected.includes(i) ? 'is-selected' : ''}`}
                      onClick={() => toggleLine(i)}
                    >
                      <span className="lyric-line__num">{String(i + 1).padStart(2, '0')}</span>
                      <span className="lyric-line__text">{line}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="encarte__field">
              <span className="field__label">Seu verso</span>
              <textarea
                className="input quote-editor__text"
                rows={appMode === 'recap' ? 1 : 3}
                placeholder={
                  appMode === 'recap'
                    ? "Toque na linha acima ou escreva o verso aqui…"
                    : "Toque nas linhas acima ou escreva o verso aqui…"
                }
                value={quote}
                onChange={(e) => {
                  const val = e.target.value
                  setQuote(appMode === 'recap' ? val.replace(/[\r\n]+/g, ' ') : val)
                }}
                onKeyDown={
                  appMode === 'recap'
                    ? (e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                        }
                      }
                    : undefined
                }
              />
            </label>
            {quote && (
              <button className="btn quote-editor__clear" onClick={clearQuote}>
                Limpar verso
              </button>
            )}
          </section>
          </div>
          )}
        </>
      )}

      {/* Off-screen render targets (kept in DOM, out of view). */}
      {showCard && (
        <div className="offscreen" aria-hidden>
          {renderCard('story', { ref: storyRef, offscreen: true })}
          {renderCard('feed', { ref: feedRef, offscreen: true })}
          {renderCard('story', { mode: 'overlay', ref: overlayStoryRef, offscreen: true })}
          {renderCard('feed', { mode: 'overlay', ref: overlayFeedRef, offscreen: true })}
          {videoUrl && (
            <video ref={exportVideoRef} src={videoUrl} muted playsInline preload="auto" />
          )}
        </div>
      )}

      {appMode === 'recap' && recap?.source === 'lastfm' && (
        <p className="disclaimer">
          * minutos são estimados (scrobbles no período × duração média das faixas) — o
          Last.fm não expõe tempo real de escuta.
        </p>
      )}
    </div>

    {showCard && (
      <footer className="site-footer">
        <a
          className="site-footer__credit"
          href="https://manguehouse.com/"
          target="_blank"
          rel="noreferrer"
        >
          <span className="site-footer__logo" aria-hidden />
          Desenvolvido por Mangue House
        </a>
      </footer>
    )}
    <InstallPrompt />
    </>
  )
}
