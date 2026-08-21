/**
 * Drum fills — pure module tests: scene-data meta parse/dependents, the
 * tail clamp, prompt builders, and the LLM response parser's fill contract
 * (groove-roles-only, part cap, duplicate merge, lengthBars clamp).
 */

import {
  fillKey,
  isFillMemberMeta,
  parseFills,
  fillMemberDbIds,
  dependentsOfSource,
  type FillMemberMeta,
} from '../src/fills/fill-meta';
import { clampToTail } from '../src/fills/fill-notes';
import {
  MAX_FILL_PARTS,
  allowedFillLengthBars,
  buildFillSystemPrompt,
} from '../src/fills/fill-system-prompt';
import { buildFillUserPrompt, describeFillForPrompt } from '../src/fills/fill-user-prompt';
import { parseFillResponse } from '../src/fills/parse-fill-response';

function meta(overrides: Partial<FillMemberMeta> = {}): FillMemberMeta {
  return {
    version: 1,
    fillId: 'fill-1',
    fillName: 'Snare rush',
    fillPrompt: null,
    unitOrder: 0,
    role: 'snare',
    sourceTrackDbId: 'groove-snare',
    createdAt: 1000,
    ...overrides,
  };
}

describe('fill-meta', () => {
  it('round-trips the key shape and validates meta', () => {
    expect(fillKey('abc')).toBe('track:abc:fill');
    expect(isFillMemberMeta(meta())).toBe(true);
    expect(isFillMemberMeta({ version: 2 })).toBe(false);
    expect(isFillMemberMeta(null)).toBe(false);
    expect(isFillMemberMeta({ ...meta(), role: '' })).toBe(false);
  });

  it('parseFills groups members by fillId, sorted by unitOrder', () => {
    const sceneData: Record<string, unknown> = {
      [fillKey('t-kick')]: meta({ fillId: 'fill-2', fillName: 'Kick build', unitOrder: 1, role: 'kick', sourceTrackDbId: 'groove-kick' }),
      [fillKey('t-tom')]: meta({ fillId: 'fill-2', fillName: 'Kick build', unitOrder: 1, role: 'tom-low', sourceTrackDbId: 'groove-tom' }),
      [fillKey('t-snare')]: meta(),
      'track:t-x:samplePath': '/some/path.wav', // unrelated keys ignored
      [fillKey('t-bad')]: { nope: true }, // malformed row skipped
    };
    const fills = parseFills(sceneData);
    expect(fills.map((f) => f.fillId)).toEqual(['fill-1', 'fill-2']);
    expect(fills[0].name).toBe('Snare rush');
    expect(fills[1].members.map((m) => m.meta.role)).toEqual(['kick', 'tom-low']);
    expect(fillMemberDbIds(fills)).toEqual(new Set(['t-snare', 't-kick', 't-tom']));
  });

  it('dependentsOfSource finds every member borrowing one groove sound', () => {
    const fills = parseFills({
      [fillKey('t1')]: meta({ fillId: 'a' }),
      [fillKey('t2')]: meta({ fillId: 'b', unitOrder: 1 }),
      [fillKey('t3')]: meta({ fillId: 'b', unitOrder: 1, role: 'kick', sourceTrackDbId: 'groove-kick' }),
    });
    const deps = dependentsOfSource(fills, 'groove-snare');
    expect(deps.map((d) => d.dbId).sort()).toEqual(['t1', 't2']);
    expect(dependentsOfSource(fills, 'groove-kick').map((d) => d.dbId)).toEqual(['t3']);
    expect(dependentsOfSource(fills, 'nope')).toEqual([]);
  });
});

describe('clampToTail', () => {
  const n = (startBeat: number, durationBeats = 0.2) => ({
    pitch: 60,
    startBeat,
    durationBeats,
    velocity: 100,
  });

  it('keeps only notes inside the final fillBeats and clamps durations', () => {
    // 4 bars of 4/4 = 16 beats, 1-bar fill = tail [12, 16)
    const out = clampToTail([n(0), n(11.9), n(12), n(14.5), n(15.9, 1.0), n(16.2)], 16, 4);
    expect(out.map((x) => x.startBeat)).toEqual([12, 14.5, 15.9]);
    const last = out[out.length - 1];
    expect(last.durationBeats).toBeCloseTo(0.1, 5);
  });

  it('tolerates float edges at the tail boundary', () => {
    const out = clampToTail([n(11.9995)], 16, 4);
    expect(out).toHaveLength(1);
  });
});

describe('fill prompts', () => {
  it('system prompt states groove roles and the numeric tail window', () => {
    const prompt = buildFillSystemPrompt(['kick', 'snare', 'hat-closed'], '4/4', 4);
    expect(prompt).toContain('kick, snare, hat-closed');
    expect(prompt).toContain('16 quarter-note beats');
    expect(prompt).toContain('1 or 2');
    expect(prompt).toContain(String(MAX_FILL_PARTS));
    expect(prompt).not.toContain('METER RULES'); // 4/4 carries no meter block
  });

  it('short loops only allow 1-bar fills', () => {
    expect(allowedFillLengthBars(2)).toEqual([1]);
    expect(allowedFillLengthBars(4)).toEqual([1, 2]);
    expect(allowedFillLengthBars(16)).toEqual([1, 2]);
  });

  it('user prompt carries context, request, and variety summaries', () => {
    const prompt = buildFillUserPrompt({
      concurrentBlock: 'Concurrent tracks in scene:\n- kick: ...',
      userRequest: 'snare roll into the drop',
      existingFillSummaries: [describeFillForPrompt('Kick build', ['kick', 'tom-low'], 2)],
    });
    expect(prompt).toContain('Concurrent tracks in scene');
    expect(prompt).toContain('User request: "snare roll into the drop"');
    expect(prompt).toContain('- Kick build: kick + tom-low, 2 bars');
    expect(prompt).toContain('CONTRAST');
  });

  it('user prompt omits empty sections', () => {
    const prompt = buildFillUserPrompt({
      concurrentBlock: '',
      userRequest: null,
      existingFillSummaries: [],
    });
    expect(prompt).not.toContain('User request');
    expect(prompt).not.toContain('already generated');
    expect(prompt).toContain('Generate ONE drum fill');
  });
});

describe('parseFillResponse', () => {
  const OPTS = { grooveRoles: ['kick', 'snare', 'tom-low'], bars: 4 };
  const note = { pitch: 60, startBeat: 14, durationBeats: 0.15, velocity: 100 };

  it('parses a valid multi-part response (fenced or bare)', () => {
    const body = JSON.stringify({
      name: 'Tom cascade',
      lengthBars: 2,
      parts: [
        { role: 'snare', notes: [note] },
        { role: 'tom-low', notes: [note, { ...note, startBeat: 15 }] },
      ],
    });
    for (const content of [body, '```json\n' + body + '\n```']) {
      const parsed = parseFillResponse(content, OPTS);
      expect(parsed).not.toBeNull();
      expect(parsed!.name).toBe('Tom cascade');
      expect(parsed!.lengthBars).toBe(2);
      expect(parsed!.parts.map((p) => p.role).sort()).toEqual(['snare', 'tom-low']);
    }
  });

  it('drops hallucinated roles (fills only borrow groove sounds)', () => {
    const parsed = parseFillResponse(
      JSON.stringify({
        name: 'x',
        lengthBars: 1,
        parts: [
          { role: 'timpani', notes: [note] },
          { role: 'snare', notes: [note] },
        ],
      }),
      OPTS
    );
    expect(parsed!.parts.map((p) => p.role)).toEqual(['snare']);
  });

  it('caps parts at MAX_FILL_PARTS and merges duplicate roles', () => {
    const parsed = parseFillResponse(
      JSON.stringify({
        name: 'x',
        lengthBars: 1,
        parts: [
          { role: 'kick', notes: [note] },
          { role: 'kick', notes: [{ ...note, startBeat: 15 }] },
          { role: 'snare', notes: [note] },
          { role: 'tom-low', notes: [note] },
        ],
      }),
      OPTS
    );
    expect(parsed!.parts).toHaveLength(3);
    expect(parsed!.parts.find((p) => p.role === 'kick')!.notes).toHaveLength(2);
  });

  it('clamps lengthBars to the loop-allowed set', () => {
    const long = parseFillResponse(
      JSON.stringify({ name: 'x', lengthBars: 8, parts: [{ role: 'snare', notes: [note] }] }),
      OPTS
    );
    expect(long!.lengthBars).toBe(2);
    const shortLoop = parseFillResponse(
      JSON.stringify({ name: 'x', lengthBars: 2, parts: [{ role: 'snare', notes: [note] }] }),
      { ...OPTS, bars: 2 }
    );
    expect(shortLoop!.lengthBars).toBe(1);
  });

  it('returns null for garbage, empty parts, or all-invalid notes', () => {
    expect(parseFillResponse('not json', OPTS)).toBeNull();
    expect(parseFillResponse(JSON.stringify({ name: 'x', parts: [] }), OPTS)).toBeNull();
    expect(
      parseFillResponse(
        JSON.stringify({
          name: 'x',
          lengthBars: 1,
          parts: [{ role: 'snare', notes: [{ pitch: 60, startBeat: -1, durationBeats: 0, velocity: 0 }] }],
        }),
        OPTS
      )
    ).toBeNull();
  });
});
