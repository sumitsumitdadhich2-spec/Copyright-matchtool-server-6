import fs from 'node:fs'
import { GoogleGenAI } from '@google/genai'
import { getScan, saveScan, addLog, getAllApiKeys } from './store'
import { getAllUserApiKeys } from './user-keys'
import { globalGeminiCoordinator, type CandidateLane } from './global-gemini-coordinator'
import { uploadVideo, deleteFileQuiet, extractResponseText, classifyError, getClient } from './gemini'
import { planMinuteSegments, stitchMinuteVerificationClips } from './batch-minute-stitcher'
import { buildBatchVerifierPrompt, fmtMs } from './batch-verifier-prompt'
import { CancelToken } from './ffmpeg-pool'
import type { Scan, BatchMinuteResult, BatchVerifyPart, BatchVerifyState } from './types'

const BATCH_VERIFY_MODELS = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']

// In-memory registry of cancel tokens per scan
const activeCancelTokens = new Map<string, CancelToken>()

function logScan(scanId: string, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  const scan = getScan(scanId)
  if (scan) {
    addLog(scan, level, msg)
    saveScan(scan)
  }
}

export function getOrCreateBatchVerifyState(scan: Scan): BatchVerifyState {
  if (!scan.batchVerify) {
    scan.batchVerify = {
      status: 'idle',
      results: {},
    }
  }
  return scan.batchVerify
}

/**
 * Parses Gemini response text into structured part verdicts.
 * Handles JSON blocks, arrays, and structured regex fallback.
 */
export function parseBatchVerifierResponse(
  rawText: string,
  plannedParts: BatchVerifyPart[],
): BatchVerifyPart[] {
  const partsMap = new Map<number, BatchVerifyPart>()
  for (const p of plannedParts) {
    partsMap.set(p.partIndex, { ...p, verdict: 'REJECTED', rescanRequired: true, reason: 'Pending verification' })
  }

  // 1. Try extracting JSON block
  try {
    const jsonMatch =
      rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
      rawText.match(/(\{[\s\S]*"verdicts"[\s\S]*\})/) ||
      rawText.match(/(\[\s*\{[\s\S]*\}\s*\])/)
    let jsonString = jsonMatch ? jsonMatch[1] : rawText.trim()
    // Sanitize trailing commas before closing braces/brackets
    jsonString = jsonString.replace(/,\s*([\]}])/g, '$1')
    const parsed = JSON.parse(jsonString)
    const list = Array.isArray(parsed)
      ? parsed
      : parsed.verdicts || parsed.parts || parsed.results || parsed.data || []

    if (Array.isArray(list) && list.length > 0) {
      for (const item of list) {
        const idx = Number(item.partIndex || item.part || item.index)
        if (partsMap.has(idx)) {
          const rawVerdict = String(item.verdict || '').toUpperCase()
          const isConfirmed = rawVerdict.includes('CONFIRM') || rawVerdict.includes('SAME') || rawVerdict.includes('MATCH')
          const existing = partsMap.get(idx)!
          partsMap.set(idx, {
            ...existing,
            verdict: isConfirmed ? 'CONFIRMED' : 'REJECTED',
            confidence: typeof item.confidence === 'number' ? item.confidence : isConfirmed ? 0.95 : 0.1,
            dialogueQuote: item.dialogueQuote ? String(item.dialogueQuote).trim() : undefined,
            reason: item.reason ? String(item.reason).trim() : isConfirmed ? 'Forensic scene analysis confirmed same take and action' : 'Scene or action mismatch detected',
            rescanRequired: !isConfirmed,
          })
        }
      }
      return Array.from(partsMap.values()).sort((a, b) => a.partIndex - b.partIndex)
    }
  } catch {
    // Fall back to line-by-line regex parsing
  }

  // 2. Regex fallback for line-by-line formats
  for (const p of plannedParts) {
    const pRegex = new RegExp(`PART\\s*${p.partIndex}[^\\n]*?(CONFIRMED|REJECTED|SAME|DIFFERENT|MATCH|MISMATCH)[^\\n]*`, 'gi')
    const match = pRegex.exec(rawText)
    if (match) {
      const vText = match[1].toUpperCase()
      const isConfirmed = vText === 'CONFIRMED' || vText === 'SAME' || vText === 'MATCH'
      const existing = partsMap.get(p.partIndex)!
      partsMap.set(p.partIndex, {
        ...existing,
        verdict: isConfirmed ? 'CONFIRMED' : 'REJECTED',
        confidence: isConfirmed ? 0.9 : 0.1,
        reason: `Verdict: ${vText}`,
        rescanRequired: !isConfirmed,
      })
    }
  }

  return Array.from(partsMap.values()).sort((a, b) => a.partIndex - b.partIndex)
}

/**
 * Gathers candidate lanes across all available API keys for the 3 allowed models.
 */
async function getBatchCandidateLanes(scan: Scan): Promise<CandidateLane[]> {
  const userKeys = scan.ownerUsername ? await getAllUserApiKeys(scan.ownerUsername) : []
  const systemKeys = getAllApiKeys()
  const envKey = process.env.GEMINI_API_KEY
  const allKeys = Array.from(new Set([...userKeys, ...systemKeys, ...(envKey ? [envKey] : [])])).filter(Boolean)

  if (allKeys.length === 0) {
    throw new Error('No Gemini API keys configured. Please add an API key in Settings.')
  }

  const lanes: CandidateLane[] = []
  allKeys.forEach((apiKey, keyIdx) => {
    for (const modelId of BATCH_VERIFY_MODELS) {
      lanes.push({
        apiKey,
        keyIdx: keyIdx + 1,
        modelId,
        rpd: 20,
      })
    }
  })

  return lanes
}

/**
 * Execute batch verification for a single 1-minute window.
 */
export async function verifySingleMinute(
  scanId: string,
  minuteIndex: number,
  token?: CancelToken,
): Promise<BatchMinuteResult> {
  const scan = getScan(scanId)
  if (!scan) throw new Error(`Scan ${scanId} not found`)

  const state = getOrCreateBatchVerifyState(scan)
  const minStart = minuteIndex * 60
  const minEnd = (minuteIndex + 1) * 60

  const plan = planMinuteSegments(scan, minuteIndex)
  if (plan.parts.length === 0) {
    const emptyResult: BatchMinuteResult = {
      minuteIndex,
      shortStart: minStart,
      shortEnd: minEnd,
      status: 'done',
      totalScenes: 0,
      confirmedCount: 0,
      rejectedCount: 0,
      parts: [],
      updatedAt: Date.now(),
    }
    state.results[minuteIndex] = emptyResult
    saveScan(scan)
    return emptyResult
  }

  const minuteResult: BatchMinuteResult = {
    minuteIndex,
    shortStart: minStart,
    shortEnd: minEnd,
    status: 'preparing',
    totalScenes: plan.parts.length,
    confirmedCount: 0,
    rejectedCount: 0,
    parts: plan.parts,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  state.results[minuteIndex] = minuteResult
  saveScan(scan)

  logScan(scanId, 'info', `[Batch Verifier] Min ${minuteIndex + 1} (${fmtMs(minStart)}–${fmtMs(minEnd)}): Stitched ${plan.parts.length} matched scenes at 24 FPS...`)

  let shortClipPath: string | null = null
  let movieClipPath: string | null = null

  try {
    // 1. Stitch videos at 24 FPS (excluding missing gaps from both)
    const stitched = await stitchMinuteVerificationClips(scanId, minuteIndex, plan.parts, token)
    shortClipPath = stitched.shortClipPath
    movieClipPath = stitched.movieClipPath

    minuteResult.status = 'verifying'
    minuteResult.updatedAt = Date.now()
    const scanBeforeVerify = getScan(scanId)
    if (scanBeforeVerify) {
      const stateBeforeVerify = getOrCreateBatchVerifyState(scanBeforeVerify)
      stateBeforeVerify.results[minuteIndex] = minuteResult
      saveScan(scanBeforeVerify)
    }

    // 2. Acquire available lane from Gemini 3.6, 3.7, or 3.8
    const candidateLanes = await getBatchCandidateLanes(scan)
    logScan(
      scanId,
      'info',
      `[Batch Verifier] Min ${minuteIndex + 1}: Waiting for first available lane (${BATCH_VERIFY_MODELS.join(', ')})...`,
    )

    let attempts = 0
    const maxAttempts = 3
    let verifiedParts: BatchVerifyPart[] = []
    let chosenModel = ''

    while (attempts < maxAttempts) {
      if (token?.isCancelled()) throw new Error('Verification cancelled')
      attempts++

      let releaseLane: ((dur?: number) => void) | null = null
      let uploadedShort: { uri: string; name: string } | null = null
      let uploadedMovie: { uri: string; name: string } | null = null
      let aiClient: GoogleGenAI | null = null

      try {
        const { selected: lane, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
          candidates: candidateLanes,
          scanId,
          scanTitle: scan.shortName || scanId,
          operation: `Batch Verify Min ${minuteIndex + 1}`,
          videoSeconds: Math.ceil(stitched.totalDurationSec),
          isStopping: () => token?.isCancelled() || false,
          onWait: (msg) => logScan(scanId, 'info', msg),
        })

        releaseLane = release
        chosenModel = lane.modelId
        minuteResult.model = chosenModel
        aiClient = getClient(lane.apiKey)

        logScan(
          scanId,
          'info',
          `[Batch Verifier] Min ${minuteIndex + 1}: Acquired lane Key ${lane.keyIdx} (${chosenModel}). Uploading paired clips...`,
        )

        // Upload both 24 FPS clips
        uploadedShort = await uploadVideo(aiClient, shortClipPath)
        uploadedMovie = await uploadVideo(aiClient, movieClipPath)

        const prompt = buildBatchVerifierPrompt(plan.parts)

        logScan(
          scanId,
          'info',
          `[Batch Verifier] Min ${minuteIndex + 1}: Analyzing ${plan.parts.length} scenes frame-by-frame on ${chosenModel}...`,
        )

        const response = await aiClient.models.generateContent({
          model: chosenModel,
          contents: [
            { fileData: { fileUri: uploadedShort.uri, mimeType: 'video/mp4' } },
            { fileData: { fileUri: uploadedMovie.uri, mimeType: 'video/mp4' } },
            { text: prompt },
          ],
          config: {
            maxOutputTokens: 65536,
          },
        })

        const rawText = extractResponseText(response)
        verifiedParts = parseBatchVerifierResponse(rawText, plan.parts)
        break // Success!
      } catch (err) {
        const geminiErr = classifyError(err)
        logScan(
          scanId,
          'warn',
          `[Batch Verifier] Min ${minuteIndex + 1} attempt ${attempts} failed on ${chosenModel || 'model'}: ${geminiErr.message}`,
        )

        if (attempts >= maxAttempts) {
          throw err
        }
        await new Promise((r) => setTimeout(r, 2500 * attempts))
      } finally {
        if (releaseLane) releaseLane(Math.ceil(stitched.totalDurationSec))
        if (aiClient && uploadedShort?.name) void deleteFileQuiet(aiClient, uploadedShort.name)
        if (aiClient && uploadedMovie?.name) void deleteFileQuiet(aiClient, uploadedMovie.name)
      }
    }

    // 3. Update Scan Matches and Candidate Groups on FRESH scan
    const freshScan = getScan(scanId) || scan
    const freshState = getOrCreateBatchVerifyState(freshScan)

    const confirmedCount = verifiedParts.filter((p) => p.verdict === 'CONFIRMED').length
    const rejectedCount = verifiedParts.length - confirmedCount

    minuteResult.status = 'done'
    minuteResult.confirmedCount = confirmedCount
    minuteResult.rejectedCount = rejectedCount
    minuteResult.parts = verifiedParts
    minuteResult.model = chosenModel
    minuteResult.finishedAt = Date.now()
    minuteResult.updatedAt = Date.now()
    freshState.results[minuteIndex] = minuteResult

    // Apply verdicts to freshScan.matches
    for (const p of verifiedParts) {
      const isConfirmed = p.verdict === 'CONFIRMED'
      let match = (p.matchIndex !== undefined && freshScan.matches[p.matchIndex])
        ? freshScan.matches[p.matchIndex]
        : null

      if (!match) {
        match = freshScan.matches.find(
          (m) =>
            (Math.abs(m.shortStart - p.shortStart) < 0.25 && Math.abs(m.shortEnd - p.shortEnd) < 0.25) ||
            Math.max(0, Math.min(m.shortEnd, p.shortEnd) - Math.max(m.shortStart, p.shortStart)) > 0.1,
        ) || null
      }

      if (match) {
        match.batchVerified = isConfirmed ? 'confirmed' : 'rejected'
        match.batchVerdict = p.verdict
        match.batchReason = p.reason
        match.batchModel = chosenModel
        match.batchTimestamp = Date.now()
        match.rescanRequired = !isConfirmed
        if (isConfirmed) {
          match.verified = true
          match.rejected = false
        } else {
          match.verified = false
          match.rejected = true
        }
      }

      // Also update CandidateGroups if present
      if (freshScan.candidateGroups) {
        const group = freshScan.candidateGroups.find(
          (g) =>
            (Math.abs(g.shortStart - p.shortStart) < 0.35 && Math.abs(g.shortEnd - p.shortEnd) < 0.35) ||
            Math.max(0, Math.min(g.shortEnd, p.shortEnd) - Math.max(g.shortStart, p.shortStart)) > 0.1,
        )
        if (group) {
          if (isConfirmed) {
            group.status = 'confirmed'
          } else {
            group.status = 'rejected'
          }
        }
      }
    }

    saveScan(freshScan)
    logScan(
      scanId,
      'success',
      `[Batch Verifier] Min ${minuteIndex + 1} complete on ${chosenModel}! ✅ ${confirmedCount} Confirmed · ❌ ${rejectedCount} Rejected (Rescan Required)`,
    )

    return minuteResult
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    minuteResult.status = 'error'
    minuteResult.error = msg
    minuteResult.updatedAt = Date.now()
    const errorScan = getScan(scanId)
    if (errorScan) {
      const errorState = getOrCreateBatchVerifyState(errorScan)
      errorState.results[minuteIndex] = minuteResult
      saveScan(errorScan)
    }
    logScan(scanId, 'error', `[Batch Verifier] Min ${minuteIndex + 1} failed: ${msg}`)
    throw err
  } finally {
    // Cleanup local temp clips
    if (shortClipPath && fs.existsSync(/*turbopackIgnore: true*/ shortClipPath)) {
      try {
        fs.unlinkSync(shortClipPath)
      } catch {}
    }
    if (movieClipPath && fs.existsSync(/*turbopackIgnore: true*/ movieClipPath)) {
      try {
        fs.unlinkSync(movieClipPath)
      } catch {}
    }
  }
}

/**
 * Execute batch verification for ALL minutes of the short video concurrently.
 */
export async function startBatchVerificationAll(scanId: string): Promise<void> {
  const existingToken = activeCancelTokens.get(scanId)
  if (existingToken && !existingToken.isCancelled()) {
    logScan(scanId, 'info', `[Batch Verifier] Verification is already running for this scan.`)
    return
  }

  const scan = getScan(scanId)
  if (!scan) throw new Error(`Scan ${scanId} not found`)

  const totalDuration = scan.shortDuration || 60
  const minuteCount = Math.max(1, Math.ceil(totalDuration / 60))

  const token = new CancelToken()
  activeCancelTokens.set(scanId, token)

  const state = getOrCreateBatchVerifyState(scan)
  state.status = 'running'
  state.startedAt = Date.now()
  state.finishedAt = null
  state.progress = `Starting verification across ${minuteCount} minute(s)...`
  saveScan(scan)

  logScan(scanId, 'info', `[Batch Verifier] Starting all-in-one 24 FPS verification for ${minuteCount} minute(s)...`)

  // Process minutes in parallel / available lane pool
  const minutePromises = Array.from({ length: minuteCount }, (_, minIdx) => minIdx).map(async (minIdx) => {
    try {
      if (token.isCancelled()) return
      await verifySingleMinute(scanId, minIdx, token)
    } catch (err) {
      console.warn(`[Batch Verifier] Error in minute ${minIdx + 1}:`, err)
    }
  })

  void Promise.allSettled(minutePromises).then(() => {
    activeCancelTokens.delete(scanId)
    const latestScan = getScan(scanId)
    if (latestScan && latestScan.batchVerify) {
      latestScan.batchVerify.status = token.isCancelled() ? 'stopped' : 'done'
      latestScan.batchVerify.finishedAt = Date.now()
      saveScan(latestScan)
      logScan(scanId, 'success', `[Batch Verifier] All ${minuteCount} minute(s) verification completed.`)
    }
  })
}

/**
 * Cancel active batch verification for a scan.
 */
export function stopBatchVerification(scanId: string): void {
  const token = activeCancelTokens.get(scanId)
  if (token) {
    token.cancel()
    activeCancelTokens.delete(scanId)
  }
  const scan = getScan(scanId)
  if (scan && scan.batchVerify) {
    scan.batchVerify.status = 'stopped'
    saveScan(scan)
    logScan(scanId, 'warn', `[Batch Verifier] Verification stopped by user.`)
  }
}
