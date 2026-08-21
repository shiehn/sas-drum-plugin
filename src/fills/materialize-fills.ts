/**
 * Fill materialization — the host-driven orchestrator behind Generate /
 * Regenerate / Delete fill, used by BOTH the panel and the sas-app
 * agent-skill handler (the applyHatInterplay contract: one orchestrator so
 * the two surfaces can never drift).
 *
 * One fill = 1..MAX_FILL_PARTS drum-plugin-owned tracks (one per borrowed
 * kit sound), grouped as ONE alt-track UNIT so exactly one fill sounds per
 * loop pass while the groove always plays. Sounds, per-track volume/pan and
 * external FX are copied from the SOURCE groove track at creation; the panel
 * bus is shared automatically (same plugin_id). Sound changes AFTER creation
 * propagate via fill-sound-follow, not from here.
 *
 * Ordering note: a structurally-regenerated fill (different borrowed sounds)
 * re-enters the rotation at the END (its unit is removed and a new one
 * appended) — rotation rank is cosmetic for round-robin, and this avoids
 * tearing the whole group down. Same-sounds regeneration rewrites clips in
 * place and never touches the grouping.
 */

import type {
  PluginHost,
  MusicalContext,
  PluginMidiNote,
  MidiClipData,
} from '@signalsandsorcery/plugin-sdk';
import {
  panelClipEndSeconds,
  panelMeter,
  panelQuarterNotesPerBar,
} from '@signalsandsorcery/plugin-sdk';
import { buildFillSystemPrompt } from './fill-system-prompt';
import {
  buildFillUserPrompt,
  describeFillForPrompt,
} from './fill-user-prompt';
import { parseFillResponse, type LLMFillResponse } from './parse-fill-response';
import { clampToTail } from './fill-notes';
import {
  fillKey,
  type FillMemberMeta,
  type ParsedFill,
} from './fill-meta';

/** A groove (non-fill) drum track a fill can borrow its sound from. */
export interface FillSourceTrack {
  dbId: string;
  engineTrackId: string;
  role: string;
  samplePath: string | null;
}

export interface MaterializeFillContext {
  sceneId: string;
  mc: MusicalContext;
  /** Groove tracks with roles — the borrowable kit. */
  grooveTracks: readonly FillSourceTrack[];
  /** formatConcurrentTracks over the pinned groove ('' when empty). */
  concurrentBlock: string;
  /** Current fills (variety summaries + next unit order + numbering). */
  existingFills: readonly ParsedFill[];
  /** Optional user description of the fill. */
  prompt: string | null;
  /** Combined groove + fill member track count right now. */
  currentTrackCount: number;
  /** The plugin's track ceiling (16). */
  maxTracks: number;
}

export interface MaterializedFillMember {
  dbId: string;
  engineTrackId: string;
  role: string;
  sourceTrackDbId: string;
}

export interface MaterializedFill {
  fillId: string;
  name: string;
  unitOrder: number;
  lengthBars: number;
  members: MaterializedFillMember[];
}

/** User-presentable failure (budget, no roles, LLM shape) — not a bug. */
export class FillGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FillGenerationError';
  }
}

function uniqueRoles(grooveTracks: readonly FillSourceTrack[]): string[] {
  const roles: string[] = [];
  for (const t of grooveTracks) {
    if (t.role && !roles.includes(t.role)) roles.push(t.role);
  }
  return roles;
}

/** Prefer a source that actually has a sample loaded. */
function sourceForRole(
  grooveTracks: readonly FillSourceTrack[],
  role: string
): FillSourceTrack | undefined {
  return (
    grooveTracks.find((t) => t.role === role && t.samplePath) ??
    grooveTracks.find((t) => t.role === role)
  );
}

function nextUnitOrder(existingFills: readonly ParsedFill[]): number {
  let max = -1;
  for (const f of existingFills) {
    if (f.unitOrder > max) max = f.unitOrder;
  }
  return max + 1;
}

async function generateFillResponse(
  host: PluginHost,
  ctx: MaterializeFillContext,
  grooveRoles: readonly string[]
): Promise<LLMFillResponse> {
  const summaries = ctx.existingFills.map((f) =>
    describeFillForPrompt(
      f.name,
      f.members.map((m) => m.meta.role),
      // Stored fills don't persist lengthBars; summarize as 1 bar minimum —
      // the variety block only needs the gesture, roles carry the contrast.
      1
    )
  );
  const llmResult = await host.generateWithLLM({
    system: buildFillSystemPrompt(grooveRoles, panelMeter(ctx.mc), ctx.mc.bars),
    user: buildFillUserPrompt({
      concurrentBlock: ctx.concurrentBlock,
      userRequest: ctx.prompt,
      existingFillSummaries: summaries,
    }),
    responseFormat: 'json',
  });
  const parsed = parseFillResponse(llmResult.content, {
    grooveRoles,
    bars: ctx.mc.bars,
  });
  if (!parsed) {
    throw new FillGenerationError('The model returned no usable fill — try again.');
  }
  return parsed;
}

/**
 * Post-process one part's notes exactly like the groove path: flatten to the
 * sampler's neutral pitch, clamp to the loop tail, then the host's
 * no-quantize overlap cleanup.
 */
async function processPartNotes(
  host: PluginHost,
  mc: MusicalContext,
  lengthBars: number,
  notes: readonly PluginMidiNote[]
): Promise<PluginMidiNote[]> {
  const qpb = panelQuarterNotesPerBar(mc);
  const totalBeats = mc.bars * qpb;
  const flattened = notes.map((n) => ({ ...n, pitch: 60 }));
  const tailOnly = clampToTail(flattened, totalBeats, lengthBars * qpb);
  if (tailOnly.length === 0) return [];
  return host.postProcessMidi(tailOnly, { quantize: false, removeOverlaps: true });
}

/**
 * Generate ONE fill and materialize it: create a track per part, copy the
 * source sound/volume/pan/FX, write the tail-only clip, persist the fill
 * meta. LIFO rollback of created tracks on any failure (the crossfade
 * precedent). Does NOT touch alt grouping — call regroupAllFills after.
 */
export async function generateAndMaterializeFill(
  host: PluginHost,
  ctx: MaterializeFillContext
): Promise<MaterializedFill> {
  const grooveRoles = uniqueRoles(ctx.grooveTracks);
  if (grooveRoles.length === 0) {
    throw new FillGenerationError(
      'Generate a drum groove first — fills borrow the kit sounds the groove already uses.'
    );
  }
  const response = await generateFillResponse(host, ctx, grooveRoles);
  return materializeFromResponse(host, ctx, response);
}

/** A fill's members with their live engine ids (resolved by the caller). */
export interface FillUnitRef {
  memberEngineIds: readonly string[];
}

/**
 * (Re)apply the alt-unit grouping over ALL fills of the scene, sorted by
 * unit order. Idempotent: already-grouped units pass through untouched, new
 * units append. A LONE fill stays ungrouped on purpose — it simply plays
 * every loop (grouping needs ≥2 units); the second fill forms the group.
 * No-op on hosts without the surface (builtins ship in lockstep, so unit
 * support is present whenever the method is).
 */
export async function regroupAllFills(
  host: PluginHost,
  units: readonly FillUnitRef[]
): Promise<void> {
  if (typeof host.groupTrackAlternatives !== 'function') return;
  const nonEmpty = units.filter((u) => u.memberEngineIds.length > 0);
  if (nonEmpty.length < 2) return;
  await host.groupTrackAlternatives(nonEmpty.map((u) => [...u.memberEngineIds]));
}

/**
 * Delete a fill: ungroup its unit FIRST (so alt columns + engine mutes are
 * cleanly lifted), then delete each member track and its scene-data rows
 * (scene-data cleanup is manual — the handleDeleteTrack contract).
 */
export async function deleteFill(
  host: PluginHost,
  sceneId: string,
  members: ReadonlyArray<{ dbId: string; engineTrackId: string }>
): Promise<void> {
  const first = members[0];
  if (first && typeof host.removeTrackAlternative === 'function') {
    await host.removeTrackAlternative(first.engineTrackId, { unit: true }).catch(() => {});
  }
  for (const member of members) {
    await host.deleteTrack(member.engineTrackId).catch(() => {});
    await host.deleteSceneData(sceneId, fillKey(member.dbId)).catch(() => {});
    await host.deleteSceneData(sceneId, `track:${member.dbId}:samplePath`).catch(() => {});
  }
}

/**
 * Regenerate a fill in place. Same borrowed-sound set → rewrite each
 * member's clip (no track churn, unit untouched) and refresh the meta.
 * Different set → delete the old members and materialize a replacement
 * (its unit re-enters the rotation at the end — see header note).
 * Returns the fill as it now stands.
 */
export async function regenerateFill(
  host: PluginHost,
  ctx: MaterializeFillContext,
  fill: ParsedFill,
  fillEngineIdByDbId: ReadonlyMap<string, string>
): Promise<MaterializedFill> {
  const grooveRoles = uniqueRoles(ctx.grooveTracks);
  if (grooveRoles.length === 0) {
    throw new FillGenerationError(
      'Generate a drum groove first — fills borrow the kit sounds the groove already uses.'
    );
  }
  // Variety block should exclude the fill being replaced.
  const others = ctx.existingFills.filter((f) => f.fillId !== fill.fillId);
  const response = await generateFillResponse(host, { ...ctx, existingFills: others }, grooveRoles);

  const currentRoles = [...fill.members.map((m) => m.meta.role)].sort();
  const newRoles = [...response.parts.map((p) => p.role)].sort();
  const sameShape =
    currentRoles.length === newRoles.length &&
    currentRoles.every((r, i) => r === newRoles[i]);

  if (sameShape) {
    // In-place: rewrite clips + meta; sounds, mix, FX, grouping all stand.
    const members: MaterializedFillMember[] = [];
    for (const part of response.parts) {
      const member = fill.members.find((m) => m.meta.role === part.role);
      const engineId = member ? fillEngineIdByDbId.get(member.dbId) : undefined;
      if (!member || !engineId) continue;
      const notes = await processPartNotes(host, ctx.mc, response.lengthBars, part.notes);
      if (notes.length === 0) continue;
      await host.writeMidiClip(engineId, {
        startTime: 0,
        endTime: panelClipEndSeconds(ctx.mc),
        tempo: ctx.mc.bpm,
        notes,
      });
      const meta: FillMemberMeta = {
        ...member.meta,
        fillName: response.name,
        fillPrompt: ctx.prompt ?? member.meta.fillPrompt,
      };
      await host.setSceneData(ctx.sceneId, fillKey(member.dbId), meta);
      members.push({
        dbId: member.dbId,
        engineTrackId: engineId,
        role: part.role,
        sourceTrackDbId: member.meta.sourceTrackDbId,
      });
    }
    if (members.length === 0) {
      throw new FillGenerationError(
        'The regenerated fill had no notes inside the loop tail — try again.'
      );
    }
    return {
      fillId: fill.fillId,
      name: response.name,
      unitOrder: fill.unitOrder,
      lengthBars: response.lengthBars,
      members,
    };
  }

  // Structural change: replace the fill wholesale.
  const oldMembers = fill.members.map((m) => ({
    dbId: m.dbId,
    engineTrackId: fillEngineIdByDbId.get(m.dbId) ?? '',
  }));
  await deleteFill(host, ctx.sceneId, oldMembers.filter((m) => m.engineTrackId));
  const replacementCtx: MaterializeFillContext = {
    ...ctx,
    existingFills: others,
    currentTrackCount: ctx.currentTrackCount - fill.members.length,
  };
  return materializeFromResponse(host, replacementCtx, response);
}

/**
 * Materialize an already-parsed response — the single track-creation body
 * behind generateAndMaterializeFill and the structural-regenerate tail.
 */
async function materializeFromResponse(
  host: PluginHost,
  ctx: MaterializeFillContext,
  response: LLMFillResponse
): Promise<MaterializedFill> {
  if (ctx.currentTrackCount + response.parts.length > ctx.maxTracks) {
    throw new FillGenerationError(
      `Not enough track slots for a ${response.parts.length}-sound fill (${ctx.currentTrackCount}/${ctx.maxTracks} used) — delete a track or a fill first.`
    );
  }
  const unitOrder = nextUnitOrder(ctx.existingFills);
  const fillNumber = ctx.existingFills.length + 1;
  const fillId =
    globalThis.crypto?.randomUUID?.() ?? `fill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created: Array<{ id: string; dbId: string }> = [];
  try {
    const members: MaterializedFillMember[] = [];
    for (const part of response.parts) {
      const source = sourceForRole(ctx.grooveTracks, part.role);
      if (!source) continue;
      const notes = await processPartNotes(host, ctx.mc, response.lengthBars, part.notes);
      if (notes.length === 0) continue;
      const handle = await host.createTrack({ name: `Fill ${fillNumber} · ${part.role}` });
      created.push({ id: handle.id, dbId: handle.dbId });
      await host.setTrackRole(handle.id, part.role).catch(() => {});
      await host.writeMidiClip(handle.id, {
        startTime: 0,
        endTime: panelClipEndSeconds(ctx.mc),
        tempo: ctx.mc.bpm,
        notes,
      });
      let samplePath = source.samplePath;
      if (!samplePath && host.getTrackSound) {
        const snap = await host.getTrackSound(source.dbId).catch(() => null);
        if (snap && snap.kind === 'sample') samplePath = snap.samplePath;
      }
      if (samplePath) {
        await host.setTrackDrumKit(handle.id, { samplePath });
      }
      try {
        const info = await host.getTrackInfo(source.engineTrackId);
        await host.setTrackVolume(handle.id, info.volume);
        await host.setTrackPan(handle.id, info.pan);
      } catch {
        // Defaults are fine.
      }
      if (host.copyTrackFxFrom) {
        await host.copyTrackFxFrom(handle.id, source.dbId).catch(() => {});
      }
      const meta: FillMemberMeta = {
        version: 1,
        fillId,
        fillName: response.name,
        fillPrompt: ctx.prompt,
        unitOrder,
        role: part.role,
        sourceTrackDbId: source.dbId,
        createdAt: Date.now(),
      };
      await host.setSceneData(ctx.sceneId, fillKey(handle.dbId), meta);
      members.push({
        dbId: handle.dbId,
        engineTrackId: handle.id,
        role: part.role,
        sourceTrackDbId: source.dbId,
      });
    }
    if (members.length === 0) {
      throw new FillGenerationError(
        'The generated fill had no notes inside the loop tail — try again.'
      );
    }
    return { fillId, name: response.name, unitOrder, lengthBars: response.lengthBars, members };
  } catch (err) {
    for (const t of [...created].reverse()) {
      await host.deleteTrack(t.id).catch(() => {});
      await host.deleteSceneData(ctx.sceneId, fillKey(t.dbId)).catch(() => {});
      await host.deleteSceneData(ctx.sceneId, `track:${t.dbId}:samplePath`).catch(() => {});
    }
    throw err;
  }
}
