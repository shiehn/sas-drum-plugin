/**
 * buildDrumUserPrompt — the shared USER-prompt builder for the panel and
 * the agent-skill path (drum-interplay Phase A).
 *
 * Contract pinned here:
 *  - concurrentBlock (when present) leads, verbatim.
 *  - The user request is always quoted the same way as the historical
 *    hand-assembled strings ('User request: "..."').
 *  - targetRole non-null → target-role statement (regenerate path); the
 *    "listed above" clause appears only when there ARE siblings.
 *  - targetRole null + siblings → role-CHOICE line (prefer an uncovered
 *    kit piece).
 *  - targetRole null + no siblings → no interplay line at all; output is
 *    byte-identical to the pre-Phase-A prompt (solo first generation).
 */
import { describe, it, expect } from '@jest/globals';
import { buildDrumUserPrompt } from '../src/drum-user-prompt';

const BLOCK = 'Concurrent tracks in scene (already generated):\n  - role=kick name="Kick" prompt="four on the floor"';

describe('buildDrumUserPrompt', () => {
  it('no siblings, no role → byte-identical to the legacy hand-assembled prompt', () => {
    const prompt = buildDrumUserPrompt({ concurrentBlock: '', userRequest: 'dusty boom bap', targetRole: null });
    expect(prompt).toBe(
      'User request: "dusty boom bap"\n\nGenerate a drum-pattern MIDI clip that fits this context.',
    );
  });

  it('siblings + no role → role-choice line, prefer uncovered kit pieces', () => {
    const prompt = buildDrumUserPrompt({ concurrentBlock: BLOCK, userRequest: 'add some toms', targetRole: null });
    expect(prompt.startsWith(`${BLOCK}\n\nUser request: "add some toms"`)).toBe(true);
    expect(prompt).toContain("First choose this layer's role — prefer a kit piece NOT already covered");
    expect(prompt.endsWith('Generate a drum-pattern MIDI clip that fits this context.')).toBe(true);
  });

  it('siblings + role → target-role statement with the same-drummer clause', () => {
    const prompt = buildDrumUserPrompt({ concurrentBlock: BLOCK, userRequest: 'busier', targetRole: 'tom-low' });
    expect(prompt).toContain('You are generating the "tom-low" layer of this kit.');
    expect(prompt).toContain('The drum layers listed above are played by the SAME drummer');
    expect(prompt).toContain('Keep "role" as "tom-low" unless the user request explicitly asks for a different drum.');
    // Never both interplay lines at once.
    expect(prompt).not.toContain("First choose this layer's role");
  });

  it('role but no siblings → target-role statement WITHOUT the "listed above" clause', () => {
    const prompt = buildDrumUserPrompt({ concurrentBlock: '', userRequest: 'four on the floor', targetRole: 'kick' });
    expect(prompt).toContain('You are generating the "kick" layer of this kit.');
    expect(prompt).not.toContain('listed above');
  });

  it('concurrent block is included verbatim and first', () => {
    const prompt = buildDrumUserPrompt({ concurrentBlock: BLOCK, userRequest: 'x', targetRole: null });
    expect(prompt.indexOf(BLOCK)).toBe(0);
  });
});
