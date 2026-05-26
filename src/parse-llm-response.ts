/**
 * Parser for the drum-pattern LLM response.
 *
 * Extracted from DrumGeneratorPanel.tsx so the SAME parser backs both
 * generation paths:
 *   - the panel's "Generate" button (renderer), and
 *   - the agent-facing `generate_drums` plugin skill (main process,
 *     see src/main/services/plugin-skill-handlers.ts).
 *
 * Keeping one parser means the agent path can never silently drift from
 * what a human gets clicking the button. Pure function, no I/O — safe to
 * import into either process.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

export interface LLMDrumResponse {
  notes: PluginMidiNote[];
  role?: string;
  // subRole removed in Phase 0.8 — role is the folder name (flat taxonomy)
}

export function parseLLMDrumResponse(content: string): LLMDrumResponse | null {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null || !('notes' in parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.notes)) {
      return null;
    }

    const validNotes: PluginMidiNote[] = [];
    for (const raw of obj.notes) {
      if (typeof raw !== 'object' || raw === null) continue;
      const note = raw as Record<string, unknown>;

      const pitch = typeof note.pitch === 'number' ? note.pitch : NaN;
      const startBeat = typeof note.startBeat === 'number' ? note.startBeat : NaN;
      const durationBeats = typeof note.durationBeats === 'number' ? note.durationBeats : NaN;
      const velocity = typeof note.velocity === 'number' ? note.velocity : NaN;

      if (
        !isNaN(pitch) && pitch >= 0 && pitch <= 127 &&
        !isNaN(startBeat) && startBeat >= 0 &&
        !isNaN(durationBeats) && durationBeats > 0 &&
        !isNaN(velocity) && velocity >= 1 && velocity <= 127
      ) {
        validNotes.push({
          pitch: Math.round(pitch),
          startBeat,
          durationBeats,
          velocity: Math.round(velocity),
        });
      }
    }

    const role = typeof obj.role === 'string' ? obj.role : undefined;
    // subRole removed in Phase 0.8 — if the LLM still emits one (drift while
    // the prompt change propagates), we ignore it; the role field now carries
    // the literal folder name.

    return { notes: validNotes, role };
  } catch {
    return null;
  }
}
