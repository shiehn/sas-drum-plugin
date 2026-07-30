/**
 * Drum-interplay style bullets (Phase A prompt hardening).
 *
 * The one-drummer / tom-voice / one-riding-hand / interlock rules are
 * meter-INDEPENDENT style guidance — they must survive every meter path
 * (legacy 4/4 bytes AND the meter-derived rewrites), exactly like the
 * hat-interplay bullet they sit beside. The 4/4 byte identity itself is
 * pinned by meter-prompt.test.ts; this suite pins presence + phrasing.
 */
import { describe, it, expect } from '@jest/globals';
import { buildDrumSystemPrompt } from '../src/drum-system-prompt';

const SAMPLE_ROLES = ['kick', 'snare', 'hat-closed', 'hat-open', 'tom-hi', 'tom-mid', 'tom-low'] as const;

const METERS: readonly (string | undefined)[] = [undefined, '4/4', '3/4', '6/8', '7/8', '12/8'];

describe('drum-interplay style bullets — present in every meter', () => {
  it('one drummer, one kit (limb rule, kick exempt)', () => {
    for (const meter of METERS) {
      const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, meter);
      expect(prompt).toContain('One drummer, one kit: every drum layer in this scene is played by the SAME imaginary drummer');
      expect(prompt).toContain('more than TWO stick-struck pieces');
      expect(prompt).toContain('the kick is foot-played and exempt');
    }
  });

  it('tom voice — one melodic voice, gaps, descending, accent-only unisons', () => {
    for (const meter of METERS) {
      const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, meter);
      expect(prompt).toContain('Tom voice: "tom-hi", "tom-mid", and "tom-low" are ONE melodic voice');
      expect(prompt).toContain('write INTO their gaps');
      expect(prompt).toContain('conventionally descending (hi → mid → low)');
      expect(prompt).toContain('only as an isolated accent, never as sustained parallel streams');
    }
  });

  it('one riding hand — single timekeeping voice, thin during tom activity', () => {
    for (const meter of METERS) {
      const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, meter);
      expect(prompt).toContain('One riding hand: only one continuous timekeeping voice at a time');
      expect(prompt).toContain('thin or drop timekeeping where the toms are busy');
    }
  });

  it('interlock into gaps — double siblings only on structural accents', () => {
    for (const meter of METERS) {
      const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, meter);
      expect(prompt).toContain('Interlock into gaps: place your hits in the silences of the drum layers already listed');
      expect(prompt).toContain('only on a structural accent (downbeat, backbeat, section start)');
    }
  });

  it('sits with (not instead of) the hat-interplay bullet', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES);
    expect(prompt).toContain('Hi-hat interplay: "hat-open" and "hat-closed" tracks act as ONE physical hi-hat.');
  });
});
