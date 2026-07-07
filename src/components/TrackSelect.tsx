import { useEffect, useRef, useState } from 'react'
import type { TrackStat } from '../types'

interface Props {
  tracks: TrackStat[]
  value: number
  onChange: (idx: number) => void
}

/**
 * Album-cover dropdown for picking the quote's track. A native <select> can't
 * render images in its options, so this is a custom listbox styled to match the
 * app's liner-notes design system. Closes on outside click or Escape.
 */
export function TrackSelect({ tracks, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const selected = tracks[value]

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="track-select" ref={wrapRef}>
      <button
        type="button"
        className={`track-select__trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <TrackRow track={selected} />
        <svg
          className="track-select__chev"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <ul className="track-select__menu" role="listbox">
          {tracks.map((t, i) => (
            <li key={i} role="option" aria-selected={i === value}>
              <button
                type="button"
                className={`track-select__opt ${i === value ? 'is-active' : ''}`}
                onClick={() => {
                  onChange(i)
                  setOpen(false)
                }}
              >
                <TrackRow track={t} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TrackRow({ track }: { track: TrackStat }) {
  return (
    <span className="track-select__row">
      {track.image ? (
        <img className="track-select__cover" src={track.image} alt="" />
      ) : (
        <span className="track-select__cover track-select__cover--empty" />
      )}
      <span className="track-select__meta">
        <span className="track-select__name">{track.name}</span>
        <span className="track-select__artist">{track.artist}</span>
      </span>
    </span>
  )
}
