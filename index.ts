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
