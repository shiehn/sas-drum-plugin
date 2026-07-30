/**
 * Shared drum-generation USER prompt builder.
 *
 * The panel (DrumGeneratorPanel.handleGenerate) and the agent-skill path
 * (sas-app plugin-skill-handlers drumGenerate) each hand-assembled this
 * string historically and had already drifted. One builder keeps the two
 * generation surfaces byte-aligned — same reason buildDrumSystemPrompt is
 * shared.
 *
 * Target-role statement (drum-interplay Phase A): the system prompt's
 * interplay rules ("one drummer, one kit", tom voice, interlock into gaps)
 * only bite if the model knows WHICH layer it is writing. On regenerate the
 * panel knows the track's role and passes it; fresh tracks and the agent
 * path don't know it yet (role is an LLM output, validated after the fact),
 * so they pass null and get a role-CHOICE instruction instead — prefer a
 * kit piece the scene doesn't already cover. Determination is structural
 * (track state), never parsed out of the user's prose.
 */

export interface DrumUserPromptOptions {
  /**
   * Output of formatConcurrentTracks(generationContext) — '' when the
   * scene has no other generated tracks. Included verbatim at the top.
   */
  concurrentBlock: string;
  /** The user's free-text pattern description (panel track prompt / skill prompt param). */
  userRequest: string;
  /**
   * The kit role this track already has (regenerate), or null when the
   * role is still the LLM's choice (fresh track, agent path).
   */
  targetRole: string | null;
}

export function buildDrumUserPrompt(opts: DrumUserPromptOptions): string {
  const { concurrentBlock, userRequest, targetRole } = opts;
  const parts: string[] = [];
  if (concurrentBlock) {
    parts.push(concurrentBlock, '');
  }
  parts.push(`User request: "${userRequest}"`, '');

  if (targetRole) {
    const againstSiblings = concurrentBlock
      ? ' The drum layers listed above are played by the SAME drummer — obey the interplay rules against them.'
      : '';
    parts.push(
      `You are generating the "${targetRole}" layer of this kit.${againstSiblings} Keep "role" as "${targetRole}" unless the user request explicitly asks for a different drum.`,
      '',
    );
  } else if (concurrentBlock) {
    parts.push(
      `First choose this layer's role — prefer a kit piece NOT already covered by a drum layer listed above — then write the pattern as that layer of the same drummer's performance.`,
      '',
    );
  }

  parts.push(`Generate a drum-pattern MIDI clip that fits this context.`);
  return parts.join('\n');
}
