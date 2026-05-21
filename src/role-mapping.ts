/**
 * Maps the 14 drum-sample folders under the configured sample root to
 * the host's canonical role taxonomy (see PluginHost.getValidRoles()
 * and plugin-sdk.types.ts: 'kicks', 'snares', 'hats', 'clap', 'perc').
 *
 * A "sub-role" is a plugin-local hint preserved in scene data so the
 * shuffle button can re-pick from the same folder ("a different closed
 * hat") rather than wandering across the broader role bucket.
 */

export type DrumRole = 'kicks' | 'snares' | 'hats' | 'clap' | 'perc';

export interface DrumFolderMapping {
  folder: string;
  role: DrumRole;
  subRole: string;
}

export const DRUM_FOLDER_MAPPINGS: readonly DrumFolderMapping[] = [
  { folder: 'kick', role: 'kicks', subRole: 'kick' },
  { folder: 'snare-standard', role: 'snares', subRole: 'snare' },
  { folder: 'snare-rim', role: 'snares', subRole: 'rim' },
  { folder: 'hat-closed', role: 'hats', subRole: 'closed' },
  { folder: 'hat-open', role: 'hats', subRole: 'open' },
  { folder: 'tom-hi', role: 'perc', subRole: 'tom-hi' },
  { folder: 'tom-mid', role: 'perc', subRole: 'tom-mid' },
  { folder: 'tom-low', role: 'perc', subRole: 'tom-low' },
  { folder: 'cymbal-crash', role: 'perc', subRole: 'crash' },
  { folder: 'cymbal-ride', role: 'perc', subRole: 'ride' },
  { folder: 'cymbal-splash', role: 'perc', subRole: 'splash' },
  { folder: 'tamborine', role: 'perc', subRole: 'tamborine' },
  { folder: 'shaker', role: 'perc', subRole: 'shaker' },
  { folder: 'hit', role: 'perc', subRole: 'hit' },
] as const;

const SUBROLE_TO_FOLDER = new Map<string, string>(
  DRUM_FOLDER_MAPPINGS.map(m => [m.subRole, m.folder])
);

const ROLE_TO_FOLDERS = new Map<DrumRole, string[]>();
for (const m of DRUM_FOLDER_MAPPINGS) {
  const list = ROLE_TO_FOLDERS.get(m.role) ?? [];
  list.push(m.folder);
  ROLE_TO_FOLDERS.set(m.role, list);
}

/** Folder corresponding to a sub-role hint, or null if unknown. */
export function folderForSubRole(subRole: string | undefined): string | null {
  if (!subRole) return null;
  return SUBROLE_TO_FOLDER.get(subRole) ?? null;
}

/** All folders that contribute samples for a canonical role. */
export function foldersForRole(role: string): readonly string[] {
  return ROLE_TO_FOLDERS.get(role as DrumRole) ?? [];
}

export function isDrumRole(role: string): role is DrumRole {
  return ROLE_TO_FOLDERS.has(role as DrumRole);
}

/** Canonical roles this plugin emits — used to build the LLM prompt. */
export const DRUM_ROLES: readonly DrumRole[] = ['kicks', 'snares', 'hats', 'clap', 'perc'];

/** Sub-role hint list flat-mapped for the LLM prompt. */
export const SUBROLE_HINTS: readonly string[] = DRUM_FOLDER_MAPPINGS.map(m => m.subRole);
