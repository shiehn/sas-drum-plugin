/**
 * Build the drum-FILL system prompt for the LLM.
 *
 * Fills differ from groove generation (drum-system-prompt.ts) in three ways
 * the model has to know:
 *   1. The vocabulary is the GROOVE's roles only — a fill borrows sounds
 *      already in the kit (same sample, same mix, same bus), it never
 *      introduces a new kit piece.
 *   2. The output may span MULTIPLE roles (a kick+tom build is one fill in
 *      two parts) — up to MAX_FILL_PARTS parts, one per role.
 *   3. Placement is the loop TAIL, stated numerically and enforced by
 *      clampToTail afterwards: the groove always plays; the fill answers its
 *      final bars and hands the energy back to the downbeat.
 *
 * The sampler rules (pitch ALWAYS 60, velocity IS the dynamics, no quantize
 * — micro-timing survives) are the same as the groove prompt's; restated
 * here because the two prompts are independent strings.
 */
import { tryParseTimeSignature, formatPluginMeterGuidance } from '@signalsandsorcery/plugin-sdk';

/** Max sounds (parts/tracks) one fill may borrow. */
export const MAX_FILL_PARTS = 3;

/** Fill lengths (bars) valid for a loop of `bars` — at most half the loop. */
export function allowedFillLengthBars(bars: number): number[] {
  const allowed = [1, 2].filter((len) => len <= bars / 2);
  return allowed.length > 0 ? allowed : [1];
}

/** Integers clean, halves as ".5" (meter-derived counts are dyadic-exact). */
function fmtCount(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function buildFillSystemPrompt(
  grooveRoles: readonly string[],
  timeSignature: string = '4/4',
  bars: number = 4
): string {
  const parsed = tryParseTimeSignature(timeSignature);
  const qpb = parsed?.quarterNotesPerBar ?? 4;
  const totalBeats = bars * qpb;
  const lengths = allowedFillLengthBars(bars);
  const rolesList = grooveRoles.length > 0 ? grooveRoles.join(', ') : '(none)';
  const is44 = !parsed || timeSignature === '4/4';
  const meterRulesBlock = is44 ? '' : `\n\n${formatPluginMeterGuidance(timeSignature)}`;

  const lengthExamples = lengths
    .map((len) => `lengthBars ${len} → startBeat ≥ ${fmtCount(totalBeats - len * qpb)}`)
    .join('; ');

  return `You are a drum-fill composition AI. Given a groove that loops, write ONE drum fill that plays ON TOP of it over the loop's FINAL bars — building tension and handing the energy back to the downbeat when the loop restarts.

Respond with ONLY a JSON object in this format:
{
  "name": "Snare rush",
  "lengthBars": ${lengths[lengths.length - 1]},
  "parts": [
    { "role": "snare", "notes": [ { "pitch": 60, "startBeat": ${fmtCount(totalBeats - qpb)}, "durationBeats": 0.15, "velocity": 95 } ] }
  ]
}

Rules:
- name: a SHORT evocative name for the fill (1-3 words, e.g. "Snare rush", "Tom cascade", "Kick stutter").
- lengthBars: ${lengths.join(' or ')}. How many final bars of the loop the fill occupies.
- parts: 1 to ${MAX_FILL_PARTS} parts, each a DIFFERENT role. role MUST be one of: ${rolesList}. These are the kit sounds already in the groove — the fill BORROWS them (same sample, same mix); never invent a role that is not listed.
- TAIL PLACEMENT (hard requirement): the loop is ${bars} bars of ${timeSignature} = ${fmtCount(totalBeats)} quarter-note beats (startBeat 0 to ${fmtCount(totalBeats)}). The fill occupies ONLY the final lengthBars bars: every note's startBeat must be ≥ ${fmtCount(totalBeats)} − lengthBars×${fmtCount(qpb)} and < ${fmtCount(totalBeats)} (${lengthExamples}). Notes outside the tail are DELETED.
- pitch: ALWAYS 60. The drum sampler triggers one sample per note-on at its native pitch; vary rhythm + velocity, never pitch.
- startBeat: position in quarter-note beats from the start of the LOOP (0-based, absolute — not relative to the fill). Use precise sub-beat values; the plugin does NOT quantize — your micro-timing IS the feel.
- durationBeats: keep drum hits short — 0.1-0.25 typical, longer only for sustained cymbals.
- velocity: 1-127, and velocity IS the fill's shape: a build crescendos (e.g. 60 → 115 across the roll), ghost notes sit at 40-70, the final accent lands hardest. Never flat velocity.

Fill craft:
- ANSWER the groove, don't restate it: read the concurrent tracks and place the fill's hits in and around their pattern. A fill that duplicates the groove's own kick/snare placement adds nothing.
- Density rises toward the loop end — sparse entry, busiest in the final beats.
- Land the last hit just BEFORE the loop restarts, then STOP: leave the downbeat itself to the groove. Silence on the last 16th before the restart is often stronger than one more hit.
- One drummer, one kit: never require more than TWO stick-struck pieces at the same instant (kick is foot-played and exempt).
- Multi-part fills are ONE gesture across the kit (e.g. snare roll cascading into toms), not independent patterns per part.${meterRulesBlock}`;
}
