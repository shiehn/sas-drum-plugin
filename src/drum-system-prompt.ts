/**
 * Build the drum-pattern system prompt for the LLM.
 *
 * Drums differ from melodic generation in three ways the LLM has to know:
 *   1. Output is a rhythmic pattern, not melodic content — feel and
 *      placement carry the music; pitch carries nothing.
 *   2. The drum sampler is configured one-sample-per-track. Every note,
 *      whatever its pitch, triggers the same WAV. The plugin normalises
 *      pitch to a fixed neutral value before writing, so emitting
 *      varied pitches is pure waste — keep them all at 60.
 *   3. Velocity variation, ghost notes, and role-appropriate rhythms
 *      (4-on-floor kicks, backbeat snares, 8th/16th hats) ARE the
 *      groove. The plugin does NOT quantize the output, so micro-timing
 *      pushes/pulls survive into the rendered audio.
 *
 * Phase 0.8 change: role vocabulary is DYNAMIC now — the panel passes
 * the actual folder names it discovered under the drum library root, so
 * the LLM can only emit roles that map to real on-disk content. Adding a
 * new drum folder under the library auto-extends the vocabulary on the
 * next plugin activate. No subRole anymore — folder name IS the role
 * (flat taxonomy, replacing the previous kicks/snares/hats/clap/perc
 * grouping).
 *
 * P8a (multi-time-signature): `timeSignature` is the scene meter ("N/D").
 * Omitted / '4/4' / unparseable → the prompt is BYTE-IDENTICAL to the
 * legacy 4/4 text (pinned by __tests__/meter-prompt.test.ts). Any other
 * meter swaps the 4/4-idiom style lines ("4 on the floor" on 4 beats,
 * beats-2-and-4 backbeat, 8-per-bar hats) for meter-derived equivalents
 * and appends the SDK's per-family meter rules.
 */
import {
  buildPluginMeterGuidance,
  formatPluginMeterGuidance,
  tryParseTimeSignature,
} from '@signalsandsorcery/plugin-sdk';

/** Integers clean, halves as ".5" (meter-derived counts are dyadic-exact). */
function fmtCount(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function buildDrumSystemPrompt(
  availableRoles: readonly string[],
  timeSignature: string = '4/4',
): string {
  const rolesList = availableRoles.length > 0
    ? availableRoles.join(', ')
    : '(no drum folders found — empty library)';

  // Meter-dependent style lines. The 4/4 strings are the EXACT legacy text —
  // never edit them without expecting the byte-identity snapshot to fail.
  const parsed = tryParseTimeSignature(timeSignature);
  const guidance = buildPluginMeterGuidance(timeSignature);
  const is44 = !parsed || !guidance.rhythm; // '4/4' or unparseable → legacy path
  const barCountLine = is44
    ? `- Match the bar count and tempo from the musical context.`
    : `- Match the bar count and tempo from the musical context — each bar of ${timeSignature} spans ${fmtCount(parsed!.quarterNotesPerBar)} quarter-note beats, so N bars cover startBeat 0 to N×${fmtCount(parsed!.quarterNotesPerBar)}.`;
  const rhythmIdiomLines = is44
    ? `- A "4 on the floor" kick = quarter notes on beats 1, 2, 3, 4.
- A "backbeat snare" = quarter notes on beats 2 and 4.
- 8th-note hats = 8 notes per bar (every 0.5 beats); 16th = 16 per bar (every 0.25 beats).`
    : `- The scene is in ${timeSignature}, NOT 4/4 — classic 4/4 patterns ("4 on the floor" across 4 beats, a beats-2-and-4 backbeat) do not transfer literally; follow the meter rules below instead.
- 8th-note hats = ${fmtCount(parsed!.quarterNotesPerBar * 2)} notes per bar (every 0.5 beats); 16th = ${fmtCount(parsed!.quarterNotesPerBar * 4)} per bar (every 0.25 beats).`;
  const meterRulesBlock = is44 ? '' : `\n\n${formatPluginMeterGuidance(timeSignature)}`;

  return `You are a drum-pattern composition AI. Given a musical context and a text description, generate a rhythmic MIDI drum pattern.

Respond with ONLY a JSON object in this format:
{
  "notes": [
    { "pitch": 60, "startBeat": 0, "durationBeats": 0.25, "velocity": 110 }
  ],
  "role": "kick",
  "sound": "vintage warm analog tape dusty"
}

Rules:
- pitch: ALWAYS 60. The drum sampler triggers the same one-shot sample on every note-on; the plugin forces pitch to 60 (the sampler's neutral key) so the sample plays at its native pitch. Do not vary pitch — focus your tokens on rhythm + velocity.
- startBeat: position in quarter-note beats from start of clip (0-based). Use precise sub-beat values when the groove calls for it (e.g. 0.083 for a triplet push, 0.04 for a slight pre-hit). The plugin does NOT quantize — your micro-timing IS the feel.
- durationBeats: duration in quarter-note beats. Drum hits should be short — 0.1-0.25 is typical, longer for sustained cymbals.
- velocity: 1-127. The sampler scales sample gain by velocity (≈ -20 dB at velocity 0, full at 127), so velocity directly controls how loud each hit sounds. Use velocity variation for groove: accent the downbeats (110-120), softer ghost notes (40-70), open hats louder than closed (90-110), and remember to vary slightly even on the "same" hit so the pattern doesn't sound machine-flat.
- role: MUST be one of: ${rolesList}. This is the literal folder name under the drum library — the plugin uses it to pick which sample folder to draw from.
- sound: a SHORT phrase (3-8 words) describing the desired TIMBRE / CHARACTER of the sample for this role. The plugin matches it against a library of per-sample text descriptions to pick the closest-sounding one. Translate era / genre / mood cues into concrete sonic words: "1950s" → "vintage warm analog tape", "trap" → "booming distorted 808 sub", "lo-fi" → "dusty saturated vinyl", "techno" → "punchy analog hard transient". Describe tone / material / era / character only — NOT rhythm or which drum it is. Omit the field only when the request implies no particular timbre.

Style guidance:
${barCountLine}
- If "Concurrent tracks in scene" or "REFERENCE TRACKS" are listed, interlock with them: line the kick up with (or deliberately around) the bassline's root hits, keep snare/hat accents out of the way of busy melodic syncopation, and leave space where the arrangement is already dense.
${rhythmIdiomLines}
- Vary velocity to create groove — never use a constant velocity for an entire pattern.
- Keep one track focused on one role — don't try to fit kick AND snare on the same track.${meterRulesBlock}`;
}
