/**
 * Meter-awareness of the drum system prompt (P8a multi-time-signature).
 *
 * BYTE-IDENTITY PIN: the snapshot pins the canonical 4/4 prompt — with the
 * meter parameter omitted OR passed explicitly as '4/4' — byte-for-byte.
 * Originally recorded from the PRE-meter implementation; last deliberately
 * revised for the drum-interplay style bullets — one-drummer, tom voice,
 * one riding hand, interlock (2026-07-29, hand-edited snap).
 * Never `--ci`-update this snapshot as part of a METER change; a diff here
 * means 4/4 behavior drifted. Any intentional prompt revision must hand-edit
 * the snap and update this note.
 */
import { describe, it, expect } from '@jest/globals';
import { buildDrumSystemPrompt } from '../src/drum-system-prompt';

const SAMPLE_ROLES = ['kick', 'snare', 'hat-closed', 'hat-open', 'clap', 'perc'] as const;

describe('buildDrumSystemPrompt — 4/4 byte identity', () => {
  it('4/4 output is byte-identical to the pre-meter prompt (snapshot pin)', () => {
    expect(buildDrumSystemPrompt(SAMPLE_ROLES)).toMatchSnapshot();
  });

  it("omitted, explicit '4/4', and unparseable meters all produce the identical legacy prompt", () => {
    const legacy = buildDrumSystemPrompt(SAMPLE_ROLES);
    expect(buildDrumSystemPrompt(SAMPLE_ROLES, '4/4')).toBe(legacy);
    expect(buildDrumSystemPrompt(SAMPLE_ROLES, 'waltz')).toBe(legacy);
    expect(buildDrumSystemPrompt(SAMPLE_ROLES, '')).toBe(legacy);
  });
});

describe('buildDrumSystemPrompt — non-4/4 meters', () => {
  it('3/4 drops the 4/4 idiom lines and appends waltz meter rules', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, '3/4');
    // 4/4 idioms are replaced, not kept.
    expect(prompt).not.toContain('A "4 on the floor" kick = quarter notes on beats 1, 2, 3, 4.');
    expect(prompt).not.toContain('A "backbeat snare" = quarter notes on beats 2 and 4.');
    // Meter-derived subdivision counts (3 qn/bar → 6 eighths, 12 sixteenths).
    expect(prompt).toContain('8th-note hats = 6 notes per bar');
    expect(prompt).toContain('16th = 12 per bar');
    // Bar arithmetic names the meter.
    expect(prompt).toContain('each bar of 3/4 spans 3 quarter-note beats');
    // Appended family rules: waltz, no backbeat.
    expect(prompt).toContain('Time signature 3/4 — meter rules:');
    expect(prompt).toContain('NO beats-2-and-4 backbeat');
  });

  it('6/8 states the compound second-pulse backbeat and eighth-note slots', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, '6/8');
    expect(prompt).toContain('The scene is in 6/8, NOT 4/4');
    expect(prompt).toContain('8th-note hats = 6 notes per bar'); // 3 qn × 2
    expect(prompt).toContain('Time signature 6/8 — meter rules:');
    expect(prompt).toContain('SECOND pulse');
    expect(prompt).toContain('one slot = one eighth note = 0.5 qn');
  });

  it('7/8 handles the fractional bar span (3.5 qn) with the stated grouping', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, '7/8');
    expect(prompt).toContain('each bar of 7/8 spans 3.5 quarter-note beats');
    expect(prompt).toContain('8th-note hats = 7 notes per bar');
    expect(prompt).toContain('2+2+3');
  });

  it('12/8 appends the shuffle rules', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, '12/8');
    expect(prompt).toContain('shuffle');
    expect(prompt).toContain('swung 4/4');
  });

  it('non-4/4 prompts keep the meter-independent contract lines (pitch 60, roles, no quantize)', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, '5/4');
    expect(prompt).toContain('pitch: ALWAYS 60');
    expect(prompt).toContain('does NOT quantize');
    expect(prompt).toContain(SAMPLE_ROLES.join(', '));
  });

  it('the hat-interplay idiom bullet is present in every meter', () => {
    for (const meter of [undefined, '4/4', '3/4', '6/8', '7/8']) {
      const prompt = buildDrumSystemPrompt(SAMPLE_ROLES, meter);
      expect(prompt).toContain('Hi-hat interplay: "hat-open" and "hat-closed" tracks act as ONE physical hi-hat.');
      expect(prompt).toContain('ring length is computed for you');
    }
  });
});
