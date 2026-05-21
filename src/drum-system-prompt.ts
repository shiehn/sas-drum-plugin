import { DRUM_ROLES, SUBROLE_HINTS } from './role-mapping';

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
 * The plugin owns the canonical role list emitted to the LLM (drum
 * roles only — kicks/snares/hats/clap/perc — out of the wider host
 * taxonomy). Sub-role hints disambiguate which sample folder to pick.
 */
export function buildDrumSystemPrompt(): string {
  return `You are a drum-pattern composition AI. Given a musical context and a text description, generate a rhythmic MIDI drum pattern.

Respond with ONLY a JSON object in this format:
{
  "notes": [
    { "pitch": 60, "startBeat": 0, "durationBeats": 0.25, "velocity": 110 }
  ],
  "role": "kicks",
  "subRole": "kick"
}

Rules:
- pitch: ALWAYS 60. The drum sampler triggers the same one-shot sample on every note-on; the plugin forces pitch to 60 (the sampler's neutral key) so the sample plays at its native pitch. Do not vary pitch — focus your tokens on rhythm + velocity.
- startBeat: position in quarter-note beats from start of clip (0-based). Use precise sub-beat values when the groove calls for it (e.g. 0.083 for a triplet push, 0.04 for a slight pre-hit). The plugin does NOT quantize — your micro-timing IS the feel.
- durationBeats: duration in quarter-note beats. Drum hits should be short — 0.1-0.25 is typical, longer for sustained cymbals.
- velocity: 1-127. The sampler scales sample gain by velocity (≈ -20 dB at velocity 0, full at 127), so velocity directly controls how loud each hit sounds. Use velocity variation for groove: accent the downbeats (110-120), softer ghost notes (40-70), open hats louder than closed (90-110), and remember to vary slightly even on the "same" hit so the pattern doesn't sound machine-flat.
- role: MUST be one of: ${DRUM_ROLES.join(', ')}
- subRole: a hint about which kind of drum within the role. One of: ${SUBROLE_HINTS.join(', ')}. The plugin uses this to pick which sample folder to draw from.

Style guidance:
- Match the bar count and tempo from the musical context.
- A "4 on the floor" kick = quarter notes on beats 1, 2, 3, 4.
- A "backbeat snare" = quarter notes on beats 2 and 4.
- 8th-note hats = 8 notes per bar (every 0.5 beats); 16th = 16 per bar (every 0.25 beats).
- Vary velocity to create groove — never use a constant velocity for an entire pattern.
- For "perc" tracks, lean on the sub-role hint (tom-hi/ride/shaker/etc.) to pick the right feel.
- Keep one track focused on one role — don't try to fit kick AND snare on the same track.`;
}
