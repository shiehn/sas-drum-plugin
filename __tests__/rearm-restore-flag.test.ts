/**
 * Sampler re-arm on scene load must be a RESTORE, not a sound edit.
 *
 * The panel replays each track's persisted sample (`track:<dbId>:samplePath`
 * scene data) through `host.setTrackDrumKit` on every scene load, because the
 * engine sampler forgets its sound when projects reopen. The host treats a
 * kit set as a sound edit and auto-unfreezes frozen tracks so the edit is
 * audible — correct for user changes, wrong for the replay: without the
 * `restore: true` marker, switching scenes silently unfroze every frozen
 * drum track (2026-07-27 bug).
 *
 * Host-side behavior (restore skips the freeze gate + re-persistence) is
 * covered in sas-app's `drum-kit-restore-freeze-gate.test.ts`. This guard
 * pins the panel's side of the contract: the re-arm call — and ONLY the
 * re-arm call — passes `restore: true`. Every user-driven kit set (generate,
 * shuffle, sound-history restore, sample picker) must keep edit semantics.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import type { DrumKit } from '@signalsandsorcery/plugin-sdk';

const PANEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'DrumGeneratorPanel.tsx'),
  'utf-8'
);

/** Every `setTrackDrumKit(...)` call in the panel, with balanced parens. */
function extractSetTrackDrumKitCalls(source: string): Array<{ args: string; offset: number }> {
  const calls: Array<{ args: string; offset: number }> = [];
  const marker = 'setTrackDrumKit(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    let depth = 1;
    let i = start + marker.length;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    calls.push({ args: source.slice(start + marker.length, i - 1), offset: start });
    from = i;
  }
  return calls;
}

describe('DrumGeneratorPanel setTrackDrumKit restore discipline', () => {
  const calls = extractSetTrackDrumKitCalls(PANEL_SOURCE);

  it('the SDK DrumKit contract accepts the restore marker (stale-SDK guard)', () => {
    // Type-level: fails to compile against an SDK build without the field.
    const replay: DrumKit = { samplePath: '/lib/kick.wav', restore: true };
    expect(replay.restore).toBe(true);
  });

  it('finds the panel call sites (extraction sanity)', () => {
    // Generate, re-arm-on-load, sound-history restore x2, picker paths.
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it('exactly ONE call passes restore: true — the re-arm-on-load replay', () => {
    const restoreCalls = calls.filter((c) => /restore:\s*true/.test(c.args));
    expect(restoreCalls).toHaveLength(1);

    // It must be the documented re-arm block, not a user-facing path.
    const preceding = PANEL_SOURCE.slice(
      Math.max(0, restoreCalls[0].offset - 600),
      restoreCalls[0].offset
    );
    expect(preceding).toMatch(/Re-arm the drum sampler/);
  });

  it('every user-driven kit set keeps sound-edit semantics (no restore flag)', () => {
    const editCalls = calls.filter((c) => !/restore:\s*true/.test(c.args));
    expect(editCalls.length).toBe(calls.length - 1);
    for (const call of editCalls) {
      expect(call.args).not.toMatch(/restore/);
    }
  });
});
