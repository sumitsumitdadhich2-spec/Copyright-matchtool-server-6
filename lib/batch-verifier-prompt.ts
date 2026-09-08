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
        `PART ${p.partIndex}: Stitched Local [${fmtMs(p.localStart)} - ${fmtMs(p.localEnd)}] | Short Original [${fmtMs(p.shortStart)} - ${fmtMs(p.shortEnd)}] <==> Movie Original [${fmtMs(p.movieStart)} - ${fmtMs(p.movieEnd)}] (Duration: ${p.duration.toFixed(3)}s)`,
    )
    .join('\n')

  return `You are an EXPERT FORENSIC VIDEO ANALYST acting as a STRICT, SKEPTICAL VISUAL AUDITOR.
You are comparing TWO synchronized 24 FPS stitched video streams:
- Video 1: Stitched SHORT VIDEO / REEL clips (Vertical 9:16 format, at exactly 24 FPS).
- Video 2: Stitched CANDIDATE ORIGINAL MOVIE clips (Widescreen 16:9 format, at exactly 24 FPS).

Both video streams have been frame-stitched at strictly 24 FPS Constant Frame Rate (CFR) to match the identical local timeline.

=========================================
🔇 AUDIO RULE: 100% PURE VISUAL ANALYSIS (IGNORE AUDIO)
=========================================
- The Short Video (Video 1) is a narration / voice-over video. It contains external third-party voice-over commentary or unrelated audio.
- Original movie dialogue and movie soundtrack DO NOT EXIST in the short video.
- COMPLETELY IGNORE ALL AUDIO. DO NOT listen to spoken words. DO NOT attempt lip-syncing or dialogue verification.
- Your entire forensic verdict MUST BE BASED SOLELY AND EXCLUSIVELY ON VISUAL FOOTAGE at 24 FPS.

=========================================
📐 ASPECT RATIO REALITY: 9:16 VERTICAL CROP OF 16:9 WIDESCREEN
=========================================
- Video 1 (Short) is a VERTICAL 9:16 PORTRAIT CROP extracted from the original 16:9 widescreen movie (Video 2).
- The cropped window in Video 1 can be located ANYWHERE within Video 2's widescreen frame:
  * LEFT-SIDE CROP: Tracking a character standing on the left side of the widescreen movie.
  * CENTER CROP: Cropped around the center of the widescreen frame.
  * RIGHT-SIDE CROP: Tracking a character or object on the right side of the widescreen frame.
  * PAN & SCAN / DYNAMIC TRACKING: The crop window slides left or right to follow character movement.
  * PUNCH-IN / ZOOM CROP: An intense crop zoomed into a character's face, hands, weapon, or specific object.
- YOUR JOB: Verify whether the visual content of Video 1 is a valid spatial crop sub-region of Video 2 at that exact fraction of a second.

=========================================
⚠️ THE "SIMILAR SCENE / WRONG MOMENT" TRAP (READ CAREFULLY!)
=========================================
Movie scenes typically run for 2 to 5 minutes in a single room with the same actors wearing identical clothing.
Candidate search algorithms frequently retrieve clips from the SAME SCENE, but offset by 5, 15, or 45 seconds!
DO NOT be fooled by the same actors wearing the same clothes in the same room.

Example of False Match:
- Video 1 shows Actor with right hand raised pointing finger, looking left.
- Video 2 candidate shows Actor in the same room and same clothes, but both hands resting on table, looking forward (8 seconds later).
=> VERDICT MUST BE REJECTED! Even though the scene and clothes are identical, the moment and action are DIFFERENT.

=========================================
TIMELINE PART MAP (${parts.length} PAIRED SEGMENTS)
=========================================
${partLines}

=========================================
THE 7-POINT PURE-VISUAL FORENSIC CHECKLIST
For EVERY SINGLE PART, evaluate all 7 visual checkpoints:
=========================================

1. MICRO-ACTIONS, GESTURES & POSTURE (24 FPS Precision):
   - Check exact body posture: seated vs standing, leaning forward vs back, spine angle.
   - Hand & arm placement: which hand is moving, angle of elbows, fingers open vs clenched fist.
   - Head orientation: exact tilt, nodding, turning from left to right, chin angle.
   - Facial micro-expressions: exact moment of eye blink, eyebrow raise, smile, frown, tension in jaw.

2. OBJECTS, PROPS & PHYSICAL INTERACTIONS:
   - Identify specific props in the frame: guns, phones, glasses, coffee cups, pens, steering wheels, cigarettes, bags, bottles.
   - How is the prop being manipulated? Is it held in hand, raised to mouth, placed on table, or pointed?
   - The state, position, and timing of prop manipulation must match frame-by-frame.

3. MOTION TRAJECTORIES & TIMING DYNAMICS:
   - Walking, running, or standing up: direction of travel across the screen and footstep timing.
   - Arm swing or punching/blocking trajectories: speed, direction, and extension of movement.
   - If character turns head at +0.4s in Video 1, they MUST turn their head at +0.4s in Video 2.

4. CLOTHING FOLDS, HAIR DYNAMICS & ACCESSORIES:
   - Hair movement: wind blowing hair strands, wet hair, disheveled hair.
   - Clothing dynamics: jacket swinging open, collar position, wrinkles and folds during movement.
   - Specific accessories: wristwatch, necklace, belt buckle, hats, bandages.

5. LIGHTING, SHADOWS, REFLECTIONS & PARTICLES:
   - Direction and angle of scene lighting and cast shadows.
   - Moving light sources: car headlights, flashlights, campfire flicker, muzzle flashes.
   - Environmental elements: smoke, steam, rain droplets, sparks, glass reflections.

6. BACKGROUND ELEMENTS & SECONDARY MOVEMENT:
   - Check background details visible inside the crop window: furniture, pictures on walls, doorway shapes.
   - Background extras or vehicles: moving pedestrians, background cars, trees swaying.

7. CUT & TRANSITION BOUNDARIES:
   - If there is a visual cut or camera angle switch inside the segment, does it occur at the exact same relative frame in both videos?
   - If Video 2 candidate starts too late or cuts away too early, REJECT.

=========================================
PERMISSIBLE NON-MISMATCH EDITING DIFFERENCES (DO NOT REJECT FOR THESE):
=========================================
- Vertical 9:16 crop vs 16:9 widescreen framing.
- Creator overlays: subtitles, text captions, emojis, channel logos, watermarks, progress bars.
- Color grading, contrast/saturation boost, slight darkening, or HDR-to-SDR color shifts.
- Compression artifacts, video grain, or lower resolution in the short video.

=========================================
DECISION RULES: ZERO TOLERANCE FOR FALSE POSITIVES
=========================================
- "CONFIRMED": ONLY when you are completely certain that Video 1 is an exact spatial crop sub-region of Video 2 at the exact same fraction of a second, with 100% matching actions, postures, props, and micro-movements. Confidence >= 0.85.
- "REJECTED": If there is ANY timing discrepancy, different moment in the scene, different action, wrong prop state, or different camera angle. rescanRequired must be true.
- RULE: When in doubt, REJECT. A false confirmation corrupts the final video; a rejected part will be cleanly rescanned.

=========================================
REQUIRED OUTPUT FORMAT (JSON ONLY)
=========================================
Respond with a single valid JSON object containing an array of verdicts for all ${parts.length} parts.
Do NOT include markdown commentary outside the JSON block.

\`\`\`json
{
  "verdicts": [
    {
      "partIndex": 1,
      "verdict": "CONFIRMED",
      "confidence": 0.98,
      "cropPosition": "Center 9:16 crop tracking character face",
      "visualAnchorProof": "At +0.4s character turns head to left, raising right hand with glass while smiling",
      "reason": "Exact frame-for-frame visual match. All micro-movements, facial expressions, and prop positions align perfectly with the widescreen movie footage.",
      "rescanRequired": false
    },
    {
      "partIndex": 2,
      "verdict": "REJECTED",
      "confidence": 0.15,
      "cropPosition": "Left-side crop",
      "visualAnchorProof": "Video 1 character holds phone to ear; Video 2 candidate has phone on desk with arms crossed",
      "reason": "Similar scene trap: candidate is from the same room and wardrobe but 14 seconds earlier. Physical action and prop state do not match.",
      "rescanRequired": true
    }
  ]
}
\`\`\`

Ensure you provide an entry for every single PART from 1 to ${parts.length}.`
}

