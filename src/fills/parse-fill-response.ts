/**
 * Parser for the drum-FILL LLM response — same defensive posture as
 * parse-llm-response.ts (fence-strip, per-note validation), plus the fill
 * contract: parts capped at MAX_FILL_PARTS, every role must be one of the
 * groove's roles (a fill only borrows sounds already in the kit), duplicate
 * roles merge, lengthBars clamps to the allowed set for the loop size.
 *
 * Pure function, no I/O — shared by the panel and the agent-skill path so
 * the two can never drift.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { MAX_FILL_PARTS, allowedFillLengthBars } from './fill-system-prompt';

export interface LLMFillPart {
  role: string;
  notes: PluginMidiNote[];
}

export interface LLMFillResponse {
  name: string;
  lengthBars: number;
  parts: LLMFillPart[];
}

function validNotes(raw: unknown): PluginMidiNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: PluginMidiNote[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const note = item as Record<string, unknown>;
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
      notes.push({
        pitch: Math.round(pitch),
        startBeat,
        durationBeats,
        velocity: Math.round(velocity),
      });
    }
  }
  return notes;
}

export function parseFillResponse(
  content: string,
  opts: { grooveRoles: readonly string[]; bars: number }
): LLMFillResponse | null {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.parts)) return null;

    const roleSet = new Set(opts.grooveRoles);
    const byRole = new Map<string, PluginMidiNote[]>();
    for (const rawPart of obj.parts) {
      if (byRole.size >= MAX_FILL_PARTS) break;
      if (typeof rawPart !== 'object' || rawPart === null) continue;
      const part = rawPart as Record<string, unknown>;
      const role = typeof part.role === 'string' ? part.role : '';
      // A fill only borrows sounds the groove already has — hallucinated
      // roles are dropped, not guessed at.
      if (!roleSet.has(role)) continue;
      const notes = validNotes(part.notes);
      if (notes.length === 0) continue;
      const existing = byRole.get(role);
      if (existing) {
        existing.push(...notes);
      } else {
        byRole.set(role, notes);
      }
    }
    if (byRole.size === 0) return null;

    const allowed = allowedFillLengthBars(opts.bars);
    const rawLength = typeof obj.lengthBars === 'number' ? Math.round(obj.lengthBars) : NaN;
    const lengthBars = allowed.includes(rawLength)
      ? rawLength
      : allowed[allowed.length - 1];

    const name =
      typeof obj.name === 'string' && obj.name.trim().length > 0
        ? obj.name.trim().slice(0, 40)
        : 'Fill';

    return {
      name,
      lengthBars,
      parts: [...byRole.entries()].map(([role, notes]) => ({ role, notes })),
    };
  } catch {
    return null;
  }
}
