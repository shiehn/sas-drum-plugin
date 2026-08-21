/**
 * Fill metadata — the scene-data model behind drum FILLS.
 *
 * A fill is a UNIT of 1..n drum-plugin-owned tracks (one per borrowed kit
 * sound) that plays ON TOP of the groove, exactly one fill per loop pass
 * (alt-track unit rotation, SDK 3.10.0). Each member track carries ONE
 * scene-scoped plugin_data row under `track:<dbId>:fill` — the same
 * per-member-key shape as crossfade metadata (`parseCrossfadePairs`), chosen
 * over a central index because loadTracks already fetches the full scene
 * snapshot and an out-of-band track deletion then simply drops out of the
 * parse instead of dangling in an index.
 *
 * Fill-level fields (name/prompt/unitOrder) are duplicated across members —
 * the accepted redundancy of the crossfade precedent; parse resolves them
 * first-member-wins.
 *
 * Pure functions, no I/O — shared by the panel, the sas-app skill handler,
 * and the dsl_set_drum_kit sound-follow (all import from the package root).
 */

/** Scene-data key holding a member's FillMemberMeta. */
export function fillKey(dbId: string): string {
  return `track:${dbId}:fill`;
}

const FILL_KEY_RE = /^track:(.+):fill$/;

export interface FillMemberMeta {
  version: 1;
  /** Shared by every member of one fill (uuid). */
  fillId: string;
  /** Display name ("Fill 1" or the LLM's name). Duplicated per member. */
  fillName: string;
  /** Last prompt used to generate this fill (regenerate default). */
  fillPrompt: string | null;
  /** The alt-group unit order this fill occupies. */
  unitOrder: number;
  /** FS-discovered kit role of the borrowed sound (e.g. "snare"). */
  role: string;
  /** Groove track whose sound this member borrows (tracks.id DB UUID). */
  sourceTrackDbId: string;
  createdAt: number;
}

export function isFillMemberMeta(value: unknown): value is FillMemberMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.fillId === 'string' && v.fillId.length > 0 &&
    typeof v.fillName === 'string' &&
    (v.fillPrompt === null || typeof v.fillPrompt === 'string') &&
    typeof v.unitOrder === 'number' &&
    typeof v.role === 'string' && v.role.length > 0 &&
    typeof v.sourceTrackDbId === 'string' && v.sourceTrackDbId.length > 0 &&
    typeof v.createdAt === 'number'
  );
}

export interface ParsedFillMember {
  /** The FILL track's dbId (extracted from the scene-data key). */
  dbId: string;
  meta: FillMemberMeta;
}

export interface ParsedFill {
  fillId: string;
  name: string;
  prompt: string | null;
  unitOrder: number;
  /** Sorted by role then dbId (deterministic). */
  members: ParsedFillMember[];
}

/**
 * Group the scene snapshot's fill rows into fills, sorted by unitOrder
 * (creation order). Malformed rows are skipped — a fill whose every member
 * row is gone simply vanishes.
 */
export function parseFills(sceneData: Record<string, unknown>): ParsedFill[] {
  const byFillId = new Map<string, ParsedFillMember[]>();
  for (const [key, value] of Object.entries(sceneData)) {
    const match = FILL_KEY_RE.exec(key);
    if (!match || !isFillMemberMeta(value)) continue;
    const member: ParsedFillMember = { dbId: match[1], meta: value };
    const list = byFillId.get(value.fillId) ?? [];
    list.push(member);
    byFillId.set(value.fillId, list);
  }
  const fills: ParsedFill[] = [];
  for (const [fillId, members] of byFillId.entries()) {
    members.sort(
      (a, b) =>
        a.meta.role.localeCompare(b.meta.role) || a.dbId.localeCompare(b.dbId)
    );
    const first = members[0];
    fills.push({
      fillId,
      name: first.meta.fillName,
      prompt: first.meta.fillPrompt,
      unitOrder: first.meta.unitOrder,
      members,
    });
  }
  fills.sort((a, b) => a.unitOrder - b.unitOrder || a.fillId.localeCompare(b.fillId));
  return fills;
}

/** dbIds of every fill member — the set the panel hides from its track list. */
export function fillMemberDbIds(fills: readonly ParsedFill[]): Set<string> {
  const out = new Set<string>();
  for (const fill of fills) {
    for (const m of fill.members) out.add(m.dbId);
  }
  return out;
}

/**
 * Fill members borrowing their sound from `sourceTrackDbId` — the set a
 * sound swap on that groove track must re-arm (sound-follow).
 */
export function dependentsOfSource(
  fills: readonly ParsedFill[],
  sourceTrackDbId: string
): ParsedFillMember[] {
  const out: ParsedFillMember[] = [];
  for (const fill of fills) {
    for (const m of fill.members) {
      if (m.meta.sourceTrackDbId === sourceTrackDbId) out.push(m);
    }
  }
  return out;
}
