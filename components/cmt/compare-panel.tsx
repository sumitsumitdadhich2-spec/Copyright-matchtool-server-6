'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  SplitSquareHorizontal,
} from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { candidateOptionsFor, hasAlternatives } from '@/lib/candidate-pick'
import { CandidateChooser } from './candidate-chooser'

/** Side-by-side preview of matched windows: each parsed "Short X --> Movie Y" line
 *  is one pair with (near-)equal durations on both sides.
 *
 *  CANDIDATES: when the short window of a pair has alternative movie windows
 *  (other candidates of its group — confirmed, unverified, rejected or not yet
 *  checked), extra Prev/Next-candidate buttons appear. Browsing swaps ONLY the
 *  movie side so the user compares each candidate against the same short clip,
 *  and "Make this the main clip" turns that candidate into the pair used by the
 *  stitched preview and the export.
 *
 *  RESCAN / RETRY: Users can click the Retry / Rescan button to hunt for this exact
 *  short segment in the full chunk. The newly found rescan match immediately becomes
 *  the MAIN clip (with the previous match stored in candidates), marked with Rescan
 *  branding for user review. */
export function ComparePanel({ scan }: { scan: Scan }) {
  const { mutate } = useSWRConfig()
  const pairs = scan.matches || []
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  // null = the pair's own movie window; a number = options[candIdx] on the movie side
  const [candIdx, setCandIdx] = useState<number | null>(null)
  const [shortProgress, setShortProgress] = useState(0)
  const [movieProgress, setMovieProgress] = useState(0)
  const [rescanning, setRescanning] = useState(false)
  const [rescanModel, setRescanModel] = useState<string | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [rescanFeedback, setRescanFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)
  const animFrameRef = useRef<number | null>(null)
  const isSeekingRef = useRef(false)

  const pair = pairs[Math.min(idx, Math.max(0, pairs.length - 1))]
  const pairShortStart = pair?.shortStart ?? 0
  const pairShortEnd = pair?.shortEnd ?? 0

  const options = useMemo(
    () => (pair ? candidateOptionsFor(scan, pairShortStart, pairShortEnd) : []),
    [scan, pair, pairShortStart, pairShortEnd],
  )
  const showChooser = hasAlternatives(options)
  const viewing = candIdx === null ? null : options[Math.min(candIdx, options.length - 1)]

  // Movie-side window actually shown (candidate or the pair's own window).
  const movieStart = viewing ? viewing.movieStart : pair?.movieStart ?? 0
  const movieEnd = viewing ? viewing.movieEnd : pair?.movieEnd ?? 0
  const shortStart = pair?.shortStart ?? 0
  const shortEnd = pair?.shortEnd ?? 0
  const shortDur = Math.max(0.1, shortEnd - shortStart)
  const movieDur = Math.max(0.1, movieEnd - movieStart)

  const isCurrentRescanned = !!(
    pair?.viaRescan ||
    pair?.origin === 'rescan' ||
    viewing?.viaRescan ||
    viewing?.origin === 'rescan'
  )

  // Keep index in range when pairs change between refreshes.
  useEffect(() => {
    if (idx > 0 && idx >= pairs.length) {
      setIdx(Math.max(0, pairs.length - 1))
    }
  }, [idx, pairs.length])

  // Leaving a pair always returns to its main window and clears temporary feedback.
  useEffect(() => {
    setCandIdx(null)
    setRescanFeedback(null)
  }, [idx, pairShortStart])

  // Safe seek helper to prevent video decode lockup during rapid switching
  const safeSeek = useCallback((video: HTMLVideoElement | null, targetTime: number) => {
    if (!video) return
    try {
      video.pause()
      if (Number.isFinite(targetTime) && targetTime >= 0) {
        if ('fastSeek' in video && typeof (video as unknown as { fastSeek: (t: number) => void }).fastSeek === 'function') {
          (video as unknown as { fastSeek: (t: number) => void }).fastSeek(targetTime)
        } else {
          video.currentTime = targetTime
        }
      }
    } catch {}
  }, [])

  // Seek both players to window start whenever shown windows change
  useEffect(() => {
    if (!pair) return
    isSeekingRef.current = true
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }

    const sv = shortRef.current
    const mv = movieRef.current
    safeSeek(sv, shortStart)
    safeSeek(mv, movieStart)
    setShortProgress(0)
    setMovieProgress(0)
    setPlaying(false)
    isSeekingRef.current = false
  }, [pair, pairShortStart, movieStart, candIdx, safeSeek, shortStart])

  // High-frequency synchronized frame loop during playback
  useEffect(() => {
    if (!playing || !pair) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      return
    }

    let isRunning = true
    const checkFrames = () => {
      if (!isRunning) return

      const sv = shortRef.current
      const mv = movieRef.current

      let shortEnded = false
      let movieEnded = false

      if (sv) {
        const cur = sv.currentTime
        const rel = Math.max(0, cur - shortStart)
        setShortProgress(Math.min(100, (rel / shortDur) * 100))

        if (cur >= shortEnd - 0.03 || cur < shortStart - 0.2) {
          sv.pause()
          sv.currentTime = shortEnd
          shortEnded = true
        }
      } else {
        shortEnded = true
      }

      if (mv) {
        const cur = mv.currentTime
        const rel = Math.max(0, cur - movieStart)
        setMovieProgress(Math.min(100, (rel / movieDur) * 100))

        if (cur >= movieEnd - 0.03 || cur < movieStart - 0.2) {
          mv.pause()
          mv.currentTime = movieEnd
          movieEnded = true
        }
      } else {
        movieEnded = true
      }

      // When BOTH videos have reached their respective cuts, stop playback cleanly!
      if (shortEnded && movieEnded) {
        setPlaying(false)
        return
      }

      animFrameRef.current = requestAnimationFrame(checkFrames)
    }

    animFrameRef.current = requestAnimationFrame(checkFrames)

    return () => {
      isRunning = false
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }
  }, [playing, pair, shortStart, shortEnd, movieStart, movieEnd, shortDur, movieDur])

  const togglePlay = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (!sv || !mv || !pair) return

    if (playing) {
      sv.pause()
      mv.pause()
      setPlaying(false)
    } else {
      // Re-align to start if either has reached the end
      if (sv.currentTime >= shortEnd - 0.05 || sv.currentTime < shortStart) {
        sv.currentTime = shortStart
      }
      if (mv.currentTime >= movieEnd - 0.05 || mv.currentTime < movieStart) {
        mv.currentTime = movieStart
      }

      const p1 = sv.play().catch(() => {})
      const p2 = mv.play().catch(() => {})
      void Promise.all([p1, p2]).then(() => {
        setPlaying(true)
      })
    }
  }, [playing, pair, shortStart, shortEnd, movieStart, movieEnd])

  const restart = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) {
      sv.pause()
      sv.currentTime = shortStart
    }
    if (mv) {
      mv.pause()
      mv.currentTime = movieStart
    }
    setShortProgress(0)
    setMovieProgress(0)
    setPlaying(false)
  }, [shortStart, movieStart])

  // Fast match cycling helper (instant and responsive)
  const handleCycleMatch = useCallback((delta: number) => {
    if (pairs.length <= 1) return
    setIdx((cur) => (cur + delta + pairs.length) % pairs.length)
  }, [pairs.length])

  // Targeted Rescan / Retry handler with Gemini Model choice (3.6, 3.7, 3.8)
  async function handleRescanScene(chosenModel?: string) {
    if (rescanning || !pair) return
    setShowModelPicker(false)
    setRescanning(true)
    setRescanModel(chosenModel || null)
    setRescanFeedback(null)

    try {
      const activeChunk = viewing ? viewing.chunkIndex : (pair.chunkIndex ?? Math.max(0, Math.floor((movieStart || 0) / 60)))
      const res = await fetch(`/api/scans/${scan.id}/rescan-scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shortStart: pair.shortStart,
          shortEnd: pair.shortEnd,
          chunkIndex: activeChunk,
          movieStart,
          movieEnd,
          model: chosenModel || undefined,
        }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok || !data.ok) {
        setRescanFeedback({
          ok: false,
          msg: data.error || 'Rescan could not find a matching scene in this chunk.',
        })
        return
      }

      setRescanFeedback({
        ok: true,
        msg: `Rescan Successful! Found movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)} on ${displayModelName(data.model)}. Set as MAIN clip (User Review).`,
      })

      // Reset candidate viewing so the user is immediately on the new MAIN rescan clip
      setCandIdx(null)
      await mutate(`/api/scans/${scan.id}`)
    } catch {
      setRescanFeedback({
        ok: false,
        msg: 'Network error while rescanning scene. Please try again.',
      })
    } finally {
      setRescanning(false)
    }
  }

  // Keyboard navigation for smooth review
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleCycleMatch(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleCycleMatch(1)
      } else if (e.key === ' ' && !e.repeat) {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        restart()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleCycleMatch, togglePlay, restart])

  if (!pair) return null

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`

  return (
    <section aria-label="Side-by-side comparison" className="panel relative">
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Side-by-Side Match Comparison</h2>

        <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs font-medium">
          match {idx + 1} / {pairs.length}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          {shortDur.toFixed(3)}s
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          chunk {viewing ? viewing.chunkIndex : pair.chunkIndex}
        </span>

        {/* Rescan Branding Badge */}
        {isCurrentRescanned && (
          <span className="flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-indigo-400">
            <RotateCcw className="size-3 animate-spin-slow" aria-hidden />
            🔄 Rescanned (User Review)
          </span>
        )}

        {/* Batch Verifier Verdict Badge */}
        {pair.batchVerified === 'confirmed' && (
          <span className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-emerald-400">
            <CheckCircle2 className="size-3" aria-hidden />
            Batch Verified: CONFIRMED
          </span>
        )}
        {pair.batchVerified === 'rejected' && (
          <span className="flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-rose-400" title={pair.batchReason}>
            <AlertCircle className="size-3" aria-hidden />
            Batch Verifier: REJECTED (Rescan Required)
          </span>
        )}

        {showChooser && (
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-xs text-primary font-medium">
            {options.length} candidates
          </span>
        )}

        {pair.userPick && !viewing && !isCurrentRescanned && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
            your choice
          </span>
        )}

        {/* Fast Navigation Buttons */}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => handleCycleMatch(-1)}
            disabled={pairs.length <= 1 || rescanning}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary active:scale-95 disabled:opacity-40"
            title="Previous match (← Left Arrow)"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Prev
          </button>
          <span className="font-mono text-[11px] text-muted-foreground select-none">
            {idx + 1}/{pairs.length}
          </span>
          <button
            type="button"
            onClick={() => handleCycleMatch(1)}
            disabled={pairs.length <= 1 || rescanning}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary active:scale-95 disabled:opacity-40"
            title="Next match (→ Right Arrow)"
          >
            Next <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* Video Preview Grid */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
        {/* Short Video View */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium text-foreground">Short video</span>
            <span className="font-mono text-muted-foreground text-[11px]">
              {fmtTime(shortStart)} – {fmtTime(shortEnd)}
            </span>
          </figcaption>
          <div className="relative overflow-hidden rounded-md border border-border bg-black">
            <video
              ref={shortRef}
              src={src('short')}
              preload="auto"
              muted
              playsInline
              className="aspect-video w-full object-contain"
            />
            {/* Progress line for short video */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div
                className="h-full bg-primary transition-all duration-75"
                style={{ width: `${shortProgress}%` }}
              />
            </div>
          </div>
        </figure>

        {/* Movie Video View */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {viewing ? 'Movie — candidate' : isCurrentRescanned ? 'Movie — Rescanned' : 'Movie'}
              </span>
              {isCurrentRescanned && (
                <span className="rounded bg-indigo-500/20 px-1 py-0.2 text-[9px] font-mono font-medium text-indigo-300">
                  RESCAN
                </span>
              )}
            </div>
            <span className="font-mono text-muted-foreground text-[11px]">
              {fmtTime(movieStart)} – {fmtTime(movieEnd)}
            </span>
          </figcaption>
          <div className={`relative overflow-hidden rounded-md border bg-black ${viewing ? 'border-primary' : isCurrentRescanned ? 'border-indigo-500/60' : 'border-border'}`}>
            <video
              ref={movieRef}
              src={src('movie')}
              preload="auto"
              muted
              playsInline
              className="aspect-video w-full object-contain"
            />
            {/* Progress line for movie video */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div
                className={`h-full transition-all duration-75 ${isCurrentRescanned ? 'bg-indigo-400' : 'bg-primary'}`}
                style={{ width: `${movieProgress}%` }}
              />
            </div>
          </div>
        </figure>
      </div>

      {/* Batch Verifier Forensic Note */}
      {pair.batchReason && (
        <div className={`mt-2.5 rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${
          pair.batchVerified === 'confirmed'
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
            : 'border-rose-500/30 bg-rose-500/5 text-rose-300'
        }`}>
          <span className="font-semibold text-foreground shrink-0">Batch Verifier:</span>
          <span>{pair.batchReason}</span>
        </div>
      )}

      {/* Candidate Chooser with full alternative list */}
      {showChooser && (
        <div className="mt-3">
          <CandidateChooser scan={scan} options={options} viewIdx={candIdx} onView={setCandIdx} />
        </div>
      )}

      {/* Rescan Notification Banner */}
      {rescanFeedback && (
        <div
          role="status"
          className={`mt-3 flex items-center gap-2 rounded-md border p-2.5 text-xs ${
            rescanFeedback.ok
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          }`}
        >
          {rescanFeedback.ok ? (
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
          )}
          <span className="flex-1 font-medium">{rescanFeedback.msg}</span>
          <button
            type="button"
            onClick={() => setRescanFeedback(null)}
            className="text-[10px] underline opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Bottom Action Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-transform active:scale-95"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>

        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input bg-card px-3 py-2 text-xs font-medium hover:bg-secondary transition-colors"
          title="Restart playback from match start (R)"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart match
        </button>

        {/* Retry / Rescan Button with Model Selection (3.6, 3.7, 3.8) */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (rescanning) return
              setShowModelPicker((prev) => !prev)
            }}
            disabled={rescanning}
            className="flex items-center gap-1.5 rounded-md border border-indigo-500/50 bg-indigo-500/10 px-3.5 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/20 active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
            title="Choose Gemini Model (3.6, 3.7, 3.8) to rescan this scene"
          >
            {rescanning ? (
              <Loader2 className="size-3.5 animate-spin text-indigo-400" aria-hidden />
            ) : (
              <Sparkles className="size-3.5 text-indigo-400" aria-hidden />
            )}
            {rescanning ? (
              <span>Rescanning {rescanModel ? `(${displayModelName(rescanModel)})` : ''}...</span>
            ) : (
              <>
                <span>Rescan Scene (Retry)</span>
                <ChevronDown className="size-3 opacity-70" />
              </>
            )}
          </button>

          {/* Model Selection Menu */}
          {showModelPicker && !rescanning && (
            <div className="absolute bottom-full left-0 mb-2 w-60 rounded-lg border border-indigo-500/30 bg-card/95 p-1.5 shadow-xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95">
              <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground border-b border-border/50 mb-1 flex items-center justify-between">
                <span>Choose Rescan Model:</span>
                <button
                  type="button"
                  onClick={() => setShowModelPicker(false)}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.7-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                  <span className="font-medium">Gemini 3.7 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">High Precision</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.8-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span className="font-medium">Gemini 3.8 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Latest Gen</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.6-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                  <span className="font-medium">Gemini 3.6 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Fast Pool</span>
              </button>
              <div className="border-t border-border/40 my-1"></div>
              <button
                type="button"
                onClick={() => void handleRescanScene(undefined)}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
                  <span className="font-medium">Auto (First Free)</span>
                </div>
                <span className="text-[10px] text-muted-foreground">3.6 / 3.7 / 3.8</span>
              </button>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isCurrentRescanned && (
            <span className="rounded-full bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-mono text-indigo-300">
              User Verified
            </span>
          )}
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {displayModelName(viewing ? viewing.model : pair.model)}
          </span>
        </div>
      </div>
    </section>
  )
}
