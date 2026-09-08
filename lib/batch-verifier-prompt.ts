import type { BatchVerifyPart } from './types'

export function fmtMs(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const remSec = (s % 60).toFixed(3)
  return `${String(m).padStart(2, '0')}:${remSec.padStart(6, '0')}`
}

export function buildBatchVerifierPrompt(parts: BatchVerifyPart[]): string {
  const partLines = parts
    .map(
      (p) =>
        `PART ${p.partIndex}: Stitched Local [${fmtMs(p.localStart)} - ${fmtMs(p.localEnd)}] | Short Original [${fmtMs(p.shortStart)} - ${fmtMs(p.shortEnd)}] <==> Movie Original [${fmtMs(p.movieStart)} - ${fmtMs(p.movieEnd)}] (Dur: ${p.duration.toFixed(3)}s)`,
    )
    .join('\n')

  return `You are a master forensic video analyst and verifier. You are given TWO stitched videos:
- Video 1: Stitched SHORT VIDEO segments (at exactly 24 FPS).
- Video 2: Stitched ORIGINAL MOVIE footage segments (at exactly 24 FPS).

Both videos are encoded at strictly 24 FPS CFR and have been constructed such that any missing/unmatched gaps from the short timeline have been excluded from BOTH videos.
Therefore, at every local timestamp in Video 1 and Video 2, you are comparing the corresponding paired scene segment:

=========================================
TIMELINE PART MAP (${parts.length} PAIRED SEGMENTS)
=========================================
${partLines}

=========================================
FORENSIC VERIFICATION CRITERIA (24 FPS PRECISION)
=========================================
Analyze each PART sequentially frame-by-frame and listen to the audio carefully.

1. DIALOGUE & AUDIO MATCH (Strongest Fingerprint):
   - Listen to the spoken words in Video 1 and Video 2 for this part.
   - Quote spoken dialogue VERBATIM in its original language.
   - If spoken words/dialogue are identical in both videos at that moment, it is a definitive match.
   - If Video 1 has dialogue but Video 2 has completely different spoken words or silence, mark as REJECTED.
   - If audio in Video 1 is replaced by loud background music or muted, evaluate purely based on visual action and camera takes.

2. VISUAL ACTIONS & MOVEMENTS:
   - Check character movements, gestures, expressions, object interactions, and choreography.
   - Verify that the EXACT same take / take angles and movement beats are occurring in the same order.
   - Similar actors in the same clothes doing a DIFFERENT action (or a different take) = REJECTED.

3. QUALITY DIFFERENCES ARE NOT MISMATCHES:
   - IGNORE superficial differences: crop, zoom, 9:16 vs 16:9 aspect ratio, black bars, compression artifacts, blur, color grading, saturation/contrast adjustments, watermarks, text subtitles, background music overlay, or re-encoding noise.
   - If the underlying captured scene footage is the exact same recording and moment, it is CONFIRMED.

4. DECISION RULE FOR EACH PART:
   - CONFIRMED: The segment in Video 1 and Video 2 is undeniably the same recorded moment, take, and footage.
   - REJECTED: The segment is from a different scene, different take, different action, wrong dialogue, or not matching footage. For any rejected part, mark rescanRequired as true so a full rescanning can be triggered.

=========================================
REQUIRED OUTPUT FORMAT
=========================================
You MUST respond with a JSON object containing an array of verdicts for all ${parts.length} parts.
Respond with valid JSON in the following format:

\`\`\`json
{
  "verdicts": [
    {
      "partIndex": 1,
      "verdict": "CONFIRMED",
      "confidence": 0.98,
      "dialogueQuote": "exact verbatim dialogue heard or 'NONE / MUSIC'",
      "reason": "Clear, concise forensic explanation in Hinglish explaining why this part is confirmed or why it is rejected",
      "rescanRequired": false
    }
  ]
}
\`\`\`

Ensure you provide an entry for every single PART from 1 to ${parts.length}.`
}
