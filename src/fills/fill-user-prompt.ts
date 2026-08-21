/**
 * Shared drum-fill USER prompt builder — the panel and the sas-app skill
 * handler both call this (the buildDrumUserPrompt contract: one builder so
 * the two generation surfaces can never drift).
 *
 * The concurrent block is the fill's groove-awareness: the caller pins the
 * groove tracks into the generation context and passes
 * formatConcurrentTracks' output through. Existing-fill summaries steer
 * VARIETY — each subsequent fill is told what the earlier ones already do.
 */

export interface FillUserPromptOptions {
  /** formatConcurrentTracks(generationContext) over the pinned groove — '' when empty. */
  concurrentBlock: string;
  /** The user's free-text fill description, or null for "your choice". */
  userRequest: string | null;
  /** One line per already-generated fill (see describeFillForPrompt). */
  existingFillSummaries: readonly string[];
}

/** One-line fill summary for the variety block ("Snare rush: snare, 1 bar"). */
export function describeFillForPrompt(
  name: string,
  roles: readonly string[],
  lengthBars: number
): string {
  return `${name}: ${roles.join(' + ')}, ${lengthBars} bar${lengthBars === 1 ? '' : 's'}`;
}

export function buildFillUserPrompt(opts: FillUserPromptOptions): string {
  const { concurrentBlock, userRequest, existingFillSummaries } = opts;
  const parts: string[] = [];
  if (concurrentBlock) {
    parts.push(concurrentBlock, '');
  }
  if (userRequest && userRequest.trim().length > 0) {
    parts.push(`User request: "${userRequest.trim()}"`, '');
  }
  if (existingFillSummaries.length > 0) {
    parts.push(
      'Fills already generated for this loop (one plays per pass, rotating):',
      ...existingFillSummaries.map((s) => `- ${s}`),
      'Make this fill CONTRAST with them — different sounds, density, or gesture.',
      ''
    );
  }
  parts.push(
    'Generate ONE drum fill for the final bars of this loop, played on top of the groove above.'
  );
  return parts.join('\n');
}
