import fs from 'node:fs'
import path from 'node:path'
import { MEDIA_DIR, WORK_DIR } from './paths'
import { runFfmpeg, CancelToken } from './ffmpeg-pool'
import { probeHasAudio } from './ffmpeg'
import type { Scan, BatchVerifyPart, ChunkMatch } from './types'

export interface MinuteSegmentPlan {
  minuteIndex: number
  minStart: number
  minEnd: number
  parts: BatchVerifyPart[]
}

/**
 * Plan matched scene segments for a specific 1-minute window of the short video.
 * Gaps (unmatched/missing seconds) are naturally omitted from the plan.
 */
export function planMinuteSegments(scan: Scan, minuteIndex: number): MinuteSegmentPlan {
  const minStart = minuteIndex * 60
  const minEnd = (minuteIndex + 1) * 60

  // Ensure all matches have stable IDs for resilient lookup
  for (let i = 0; i < (scan.matches || []).length; i++) {
    const m = scan.matches[i]
    if (!m.id) {
      m.id = `m_${i}_${m.shortStart.toFixed(3)}_${m.movieStart.toFixed(3)}_${m.chunkIndex}`
    }
  }

  // All matches that overlap this minute, prioritizing user picks and verified scenes
  const candidateMatches: ChunkMatch[] = (scan.matches || [])
    .filter((m) => m.shortStart < minEnd && m.shortEnd > minStart)
    .sort(
      (a, b) =>
        a.shortStart - b.shortStart ||
        Number(b.userPick === true) - Number(a.userPick === true) ||
        Number(b.verified === true || b.batchVerified === 'confirmed') -
          Number(a.verified === true || a.batchVerified === 'confirmed') ||
        (b.confidence || 0) - (a.confidence || 0) ||
        a.movieStart - b.movieStart,
    )

  const parts: BatchVerifyPart[] = []
  let runningLocalClock = 0
  let lastEnd = minStart

  for (const m of candidateMatches) {
    const sStart = Math.max(minStart, m.shortStart)
    const sEnd = Math.min(minEnd, m.shortEnd)

    // Skip tiny slices < 0.15s or inverted ranges
    if (sEnd - sStart < 0.15) continue

    // If there's an overlap with previous segment, adjust start
    const adjustedStart = Math.max(sStart, lastEnd)
    if (sEnd - adjustedStart < 0.15) continue

    const dur = sEnd - adjustedStart
    const offsetInMatch = adjustedStart - m.shortStart
    const mStart = Math.max(0, m.movieStart + offsetInMatch)
    const mEnd = mStart + dur

    const partIndex = parts.length + 1
    const localStart = runningLocalClock
    const localEnd = runningLocalClock + dur
    runningLocalClock += dur
    lastEnd = sEnd

    parts.push({
      partIndex,
      matchId: m.id,
      chunkIndex: m.chunkIndex,
      matchIndex: scan.matches.indexOf(m),
      shortStart: adjustedStart,
      shortEnd: sEnd,
      movieStart: mStart,
      movieEnd: mEnd,
      localStart,
      localEnd,
      duration: dur,
    })
  }

  return {
    minuteIndex,
    minStart,
    minEnd,
    parts,
  }
}

/**
 * Stitch matched short and movie segments into 24 FPS paired verification videos.
 * Missing short segments are excluded from BOTH videos so they remain in 1:1 sync.
 */
export async function stitchMinuteVerificationClips(
  scanId: string,
  minuteIndex: number,
  parts: BatchVerifyPart[],
  token?: CancelToken,
): Promise<{
  shortClipPath: string
  movieClipPath: string
  totalDurationSec: number
  parts: BatchVerifyPart[]
}> {
  if (parts.length === 0) {
    throw new Error(`No matched scenes found for minute ${minuteIndex + 1}`)
  }

  const shortSource = path.join(MEDIA_DIR, scanId, 'short.mp4')
  const movieSource = path.join(MEDIA_DIR, scanId, 'movie.mp4')

  if (!fs.existsSync(shortSource)) throw new Error(`Short video not found at ${shortSource}`)
  if (!fs.existsSync(movieSource)) throw new Error(`Movie video not found at ${movieSource}`)

  const outDir = path.join(WORK_DIR, scanId, 'batch-verify', `min-${minuteIndex}`)
  fs.mkdirSync(outDir, { recursive: true })

  const shortClipPath = path.join(outDir, `short-min-${minuteIndex}-24fps.mp4`)
  const movieClipPath = path.join(outDir, `movie-min-${minuteIndex}-24fps.mp4`)

  const hasShortAudio = await probeHasAudio(shortSource).catch(() => false)
  const hasMovieAudio = await probeHasAudio(movieSource).catch(() => false)

  // 1. Build Short Stitched Video
  await stitchSourceParts(shortSource, parts.map((p) => ({ start: p.shortStart, dur: p.duration })), shortClipPath, hasShortAudio, `Short Min ${minuteIndex + 1}`, token)

  // 2. Build Movie Stitched Video
  await stitchSourceParts(movieSource, parts.map((p) => ({ start: p.movieStart, dur: p.duration })), movieClipPath, hasMovieAudio, `Movie Min ${minuteIndex + 1}`, token)

  const totalDurationSec = parts.reduce((acc, p) => acc + p.duration, 0)

  return {
    shortClipPath,
    movieClipPath,
    totalDurationSec,
    parts,
  }
}

/**
 * Internal helper to stitch multiple time segments from a source file into a single 24 FPS MP4.
 */
async function stitchSourceParts(
  sourceFile: string,
  segments: Array<{ start: number; dur: number }>,
  outFile: string,
  hasAudio: boolean,
  label: string,
  token?: CancelToken,
): Promise<void> {
  const inArgs: string[] = ['-y']
  const vFilters: string[] = []
  const aFilters: string[] = []
  const vLabels: string[] = []
  const aLabels: string[] = []

  segments.forEach((seg, i) => {
    inArgs.push('-fflags', '+genpts', '-ss', seg.start.toFixed(3), '-t', seg.dur.toFixed(3), '-i', sourceFile)
    vFilters.push(`[${i}:v]scale=640:-2,fps=24,setsar=1[v${i}]`)
    vLabels.push(`[v${i}]`)

    if (hasAudio) {
      aFilters.push(`[${i}:a]aresample=48000:async=1,aformat=channel_layouts=mono[a${i}]`)
      aLabels.push(`[a${i}]`)
    }
  })

  // FFmpeg concat filter with v=1:a=1 requires interleaved stream inputs: [v0][a0][v1][a1]...
  const interleavedLabels: string[] = []
  segments.forEach((_, i) => {
    interleavedLabels.push(`[v${i}]`)
    if (hasAudio) {
      interleavedLabels.push(`[a${i}]`)
    }
  })

  let filterComplex = ''
  if (segments.length === 1) {
    if (hasAudio) {
      filterComplex = `${vFilters[0]};${aFilters[0]}`
    } else {
      filterComplex = vFilters[0]
    }
  } else {
    if (hasAudio) {
      filterComplex = `${vFilters.join(';')};${aFilters.join(';')};${interleavedLabels.join('')}concat=n=${segments.length}:v=1:a=1[v][a]`
    } else {
      filterComplex = `${vFilters.join(';')};${vLabels.join('')}concat=n=${segments.length}:v=1:a=0[v]`
    }
  }

  const outArgs: string[] = [
    ...inArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    segments.length === 1 ? '[v0]' : '[v]',
  ]

  if (hasAudio) {
    outArgs.push('-map', segments.length === 1 ? '[a0]' : '[a]', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000')
  } else {
    outArgs.push('-an')
  }

  outArgs.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'cfr',
    '-threads',
    '1',
    '-movflags',
    '+faststart',
    outFile,
  )

  await runFfmpeg(outArgs, { label: `stitch ${label} (${segments.length} segments)`, token })
}
