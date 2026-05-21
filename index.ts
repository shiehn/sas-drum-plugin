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
  MusicalContext,
} from '@signalsandsorcery/plugin-sdk';
import { DrumGeneratorPanel } from './DrumGeneratorPanel';

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
}

export default DrumGeneratorPlugin;
