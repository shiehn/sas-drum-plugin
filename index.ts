/**
 * @signalsandsorcery/drum-generator — Built-in Drum Generator Plugin
 *
 * AI-powered drum-pattern MIDI generation with a built-in sample-based
 * drum sampler. Mirrors @signalsandsorcery/synth-generator's UX, but
 * drum tracks load a custom sampler (sas.drum-sampler) instead of
 * Surge XT and the LLM is prompted for percussion patterns.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  PluginSkill,
  MusicalContext,
} from '@signalsandsorcery/plugin-sdk';
import { DrumGeneratorPanel } from './DrumGeneratorPanel';
import drumManifest from './plugin.json';

/** Plugin manifest (re-exported so the host registers it from the package root). */
export { drumManifest };

// Generation primitives — re-exported so the host's skill bridge
// (plugin-skill-handlers) can drive the `generate_drums` skill without reaching
// into the plugin's internals. These are the same modules the panel uses.
export { buildDrumSystemPrompt } from './src/drum-system-prompt';
export { buildDrumUserPrompt } from './src/drum-user-prompt';
export type { DrumUserPromptOptions } from './src/drum-user-prompt';
export { createKitResolver } from './src/kit-resolver';
export { parseLLMDrumResponse } from './src/parse-llm-response';

// Hat interplay — open/closed hats act as one physical hi-hat. Same
// shared-module pattern: the panel and the agent skill handler both call
// applyHatInterplay after any hat-affecting change.
export {
  HAT_ROLE_ARTICULATION,
  HAT_ARTICULATION_RANK,
  HAT_COLLISION_EPSILON_BEATS,
  hatArticulationForRole,
  resolveHatInterplay,
} from './src/hat-interplay';
export type {
  HatArticulation,
  HatTrackSource,
  ResolvedHatNote,
  HatTrackResolution,
} from './src/hat-interplay';
export { mergeResolvedEditIntoSource } from './src/hat-edit-merge';
export type { HatEditMergeResult } from './src/hat-edit-merge';
export {
  HAT_GROUP_SIG_KEY,
  hatSourceKey,
  computeHatGroupSig,
  resolveCurrentGroup,
  applyHatInterplay,
} from './src/hat-interplay-apply';
export type {
  HatSourceData,
  HatClipEnvelope,
  HatGroupMember,
  HatApplyMemberOutcome,
  HatApplyOutcome,
} from './src/hat-interplay-apply';

// Tom interplay — tom-hi/mid/low are one drummer's two hands: over-limit
// same-instant collisions suppress (max two simultaneous toms). Same shared
// source/projection contract as hats; deliberately duplicated modules (see
// src/tom-interplay.ts header).
export {
  TOM_ROLE_DEPTH,
  MAX_SIMULTANEOUS_TOMS,
  TOM_COLLISION_EPSILON_BEATS,
  normalizeTomRole,
  tomDepthForRole,
  resolveTomInterplay,
} from './src/tom-interplay';
export type {
  TomRole,
  TomTrackSource,
  ResolvedTomNote,
  TomTrackResolution,
} from './src/tom-interplay';
export {
  TOM_GROUP_SIG_KEY,
  tomSourceKey,
  computeTomGroupSig,
  resolveCurrentTomGroup,
  applyTomInterplay,
} from './src/tom-interplay-apply';
export type {
  TomSourceData,
  TomClipEnvelope,
  TomGroupMember,
  TomApplyMemberOutcome,
  TomApplyOutcome,
} from './src/tom-interplay-apply';

// Drum fills — pre-generated fills that rotate one-per-loop on top of the
// groove (alt-track UNITS, SDK 3.10.0). Same shared-module contract: the
// panel and the `drum_fills` skill handler both drive these.
export {
  fillKey,
  isFillMemberMeta,
  parseFills,
  fillMemberDbIds,
  dependentsOfSource,
} from './src/fills/fill-meta';
export type { FillMemberMeta, ParsedFill, ParsedFillMember } from './src/fills/fill-meta';
export { clampToTail } from './src/fills/fill-notes';
export {
  MAX_FILL_PARTS,
  allowedFillLengthBars,
  buildFillSystemPrompt,
} from './src/fills/fill-system-prompt';
export { buildFillUserPrompt, describeFillForPrompt } from './src/fills/fill-user-prompt';
export type { FillUserPromptOptions } from './src/fills/fill-user-prompt';
export { parseFillResponse } from './src/fills/parse-fill-response';
export type { LLMFillResponse, LLMFillPart } from './src/fills/parse-fill-response';
export {
  generateAndMaterializeFill,
  regenerateFill,
  deleteFill,
  regroupAllFills,
  FillGenerationError,
} from './src/fills/materialize-fills';
export type {
  FillSourceTrack,
  MaterializeFillContext,
  MaterializedFill,
  MaterializedFillMember,
  FillUnitRef,
} from './src/fills/materialize-fills';
export { applyFillSoundFollow } from './src/fills/fill-sound-follow';

export class DrumGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/drum-generator';
  readonly displayName = 'Drums';
  readonly version = '1.0.0';
  readonly description = 'AI-powered drum-pattern MIDI generation with a built-in sample-based drum sampler';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[DrumGeneratorPlugin] Activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
    console.log('[DrumGeneratorPlugin] Deactivated');
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return DrumGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }

  async onSceneChanged(_sceneId: string | null): Promise<void> {
    // Drum tracks are loaded by the host on scene change
  }

  onContextChanged(_context: MusicalContext): void {
    // Could trigger re-generation suggestions when chords change
  }

  /**
   * LLM-callable skills — the agent equivalents of the panel's Generate
   * button and 🎲 shuffle button. Orchestration lives in main
   * (src/main/services/plugin-skill-handlers.ts), which runs the SAME
   * host-method flow the panel does so the two paths can't drift.
   *
   * `generate_drums` is surfaced on the default tool list (its registration
   * sets deferLoading:false) — it's a core creative action and must be
   * reachable without a tool_search detour, on par with the visible Surge
   * `dsl_generate_drums`. The descriptions steer the agent: THIS for real /
   * sampled drums, `dsl_generate_drums` for synthesized Surge percussion.
   */
  getSkills(): PluginSkill[] {
    return [
      {
        id: 'generate_drums',
        description:
          'Generate a sample-based drum pattern: creates a new drum track in the active scene, has the LLM compose a rhythmic MIDI pattern from your text prompt, then loads a real one-shot drum sample matching the chosen role (kick, snare, hat, clap, perc, …). Use for "make a drum beat", "add a four-on-the-floor kick", "lay down a trap hi-hat pattern", "give me a breakbeat" — any request for REAL / sampled / acoustic drums. For synthesized Surge-XT percussion instead, use dsl_generate_drums. Returns the new track id, the chosen role, and the loaded sample filename.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Natural-language description of the drum part — feel, density, and which kit piece (e.g. "punchy four-on-the-floor kick, 124 BPM" or "busy 16th-note closed hats with ghost notes").',
            },
            name: {
              type: 'string',
              description:
                'Optional display name for the new track. Defaults to a timestamped name.',
            },
          },
          required: ['prompt'],
        },
      },
      {
        id: 'drum_fills',
        description:
          'Manage rotating drum FILLS for the active scene: pre-generated fills built from the groove\'s own kit sounds (same samples, mix, FX, and drum bus) that play ON TOP of the groove — exactly ONE fill per loop pass, round-robining each repeat. Use for "add some drum fills", "give the loop variety at the end", "regenerate the second fill as a tom build". action="generate" creates `count` new fills (LLM-composed against the current groove; optional `prompt` steers them); "list" reports the scene\'s fills; "regenerate" replaces one fill\'s pattern (`fill` selector by name or number, optional `prompt`); "remove" deletes one fill. Fills follow the kit automatically when drum samples change. Requires an existing sampled-drum groove (generate_drums) with roles.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['generate', 'list', 'regenerate', 'remove'],
              description:
                'generate = create new fills; list = report the fills; regenerate = replace one fill; remove = delete one fill.',
            },
            count: {
              type: 'number',
              description:
                'For generate: how many fills to create (1-4, default 3; capped by free track slots).',
            },
            prompt: {
              type: 'string',
              description:
                'Optional fill description for generate/regenerate (e.g. "snare roll building into the drop").',
            },
            fill: {
              type: 'string',
              description:
                'For regenerate/remove: which fill — its name ("Snare rush") or 1-based number ("2").',
            },
          },
          required: ['action'],
        },
      },
      {
        id: 'shuffle_drum_sample',
        description:
          'Swap the drum sample on an existing drum track for a different one in the SAME role (e.g. a different kick WAV). The sample-based counterpart to dsl_shuffle_preset (which only works on Surge-synth tracks, not sample tracks). Use when the user says "change the snare sound", "try a different kick", or "shuffle the hats". Keeps the MIDI pattern; only the loaded sample changes. The track must have been created by generate_drums (it needs a role).',
        inputSchema: {
          type: 'object',
          properties: {
            track: {
              type: 'string',
              description:
                'Which drum track to reshuffle — a track name or natural selector like "the kick" / "snare".',
            },
          },
          required: ['track'],
        },
      },
    ];
  }
}

export default DrumGeneratorPlugin;
