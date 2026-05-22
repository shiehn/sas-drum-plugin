/**
 * Kit resolver — picks a random WAV from the configured drum library
 * for a given role. Phase 0.8 redesign: roles are flat (each folder under
 * the library root IS a role) and discovered from the filesystem on first
 * load, rather than mapped through a hardcoded role-mapping table.
 *
 * The root path can be supplied directly (string) or lazily resolved via
 * an async function — the latter is how the in-repo built-in passes the
 * bundled resources path, which depends on `app.isPackaged` and must be
 * resolved in main.
 *
 * File listing happens once, lazily, via `host.listAudioFiles`, then is
 * cached for the lifetime of the resolver. Calling `reset()` forces
 * a re-scan (used when the sample library content changes underneath).
 *
 * The discovered-role list (computed from the same cache) is what the
 * drum panel hands to buildDrumSystemPrompt at generate time, so the
 * LLM's role vocabulary always matches what's actually on disk.
 */

import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

/**
 * Fallback root used when no override is provided AND the host can't
 * resolve a bundled path. Kept for backwards-compat with the prototype;
 * in production the in-repo plugin passes a runtime-resolved path.
 */
export const DEFAULT_SAMPLE_ROOT = '/Users/stevehiehn/Downloads/outputs/processed';

export type SampleRootSource = string | (() => Promise<string | null>);

export interface KitResolver {
  /**
   * Pick a random WAV path for the given role (= folder name). If
   * `excludePath` is provided AND the role's pool has more than one
   * candidate, that path is filtered out — used by shuffle so the user
   * hears a different sample on each click.
   *
   * Returns `null` if the role is unknown or empty.
   */
  pick(role: string, excludePath?: string): Promise<string | null>;

  /**
   * The list of role names (= folder names) discovered under the library
   * root. Phase 0.8 — drum-system-prompt receives this list and bakes it
   * into the LLM prompt so the LLM is constrained to the actual on-disk
   * vocabulary. Empty if the library hasn't been scanned yet OR the root
   * doesn't exist.
   */
  getDiscoveredRoles(): Promise<string[]>;

  /** Force a re-scan of the library on the next pick / getDiscoveredRoles. */
  reset(): void;
}

export function createKitResolver(host: PluginHost, root: SampleRootSource = DEFAULT_SAMPLE_ROOT): KitResolver {
  /** Lazily-populated map: folder name → list of absolute WAV paths. */
  let cache: Map<string, string[]> | null = null;
  let listingPromise: Promise<Map<string, string[]>> | null = null;

  async function resolveRoot(): Promise<string> {
    if (typeof root === 'string') return root;
    const resolved = await root();
    if (resolved && resolved.length > 0) return resolved;
    // Host couldn't resolve (e.g. mocked Electron in tests) — fall back to
    // the prototype path. listAudioFiles will return [] if it doesn't
    // exist, which the rest of the resolver handles cleanly.
    return DEFAULT_SAMPLE_ROOT;
  }

  async function getCache(): Promise<Map<string, string[]>> {
    if (cache) return cache;
    if (listingPromise) return listingPromise;

    listingPromise = (async () => {
      try {
        const rootPath = await resolveRoot();
        const paths = await host.listAudioFiles(rootPath, { extensions: ['.wav'], recursive: true });
        const byFolder = new Map<string, string[]>();
        for (const p of paths) {
          // The folder we care about is the immediate parent dir name —
          // e.g. ".../processed/kick/kick-12345.wav" → "kick".
          const parts = p.split('/');
          const folder = parts[parts.length - 2] ?? '';
          if (!folder) continue;
          const list = byFolder.get(folder) ?? [];
          list.push(p);
          byFolder.set(folder, list);
        }
        cache = byFolder;
        return byFolder;
      } finally {
        // Always clear so a transient failure (disk hiccup, racing scene
        // load) doesn't permanently poison the resolver — the next pick
        // gets a fresh attempt.
        listingPromise = null;
      }
    })();

    return listingPromise;
  }

  async function pick(role: string, excludePath?: string): Promise<string | null> {
    if (!role) return null;

    let byFolder: Map<string, string[]>;
    try {
      byFolder = await getCache();
    } catch (err: unknown) {
      console.warn('[kit-resolver] Failed to list samples:', err);
      return null;
    }

    const pool = byFolder.get(role);
    if (!pool || pool.length === 0) return null;

    const filtered = (excludePath && pool.length > 1)
      ? pool.filter(p => p !== excludePath)
      : pool;
    const idx = Math.floor(Math.random() * filtered.length);
    return filtered[idx] ?? null;
  }

  async function getDiscoveredRoles(): Promise<string[]> {
    let byFolder: Map<string, string[]>;
    try {
      byFolder = await getCache();
    } catch (err: unknown) {
      console.warn('[kit-resolver] Failed to list samples for role discovery:', err);
      return [];
    }
    // Filter out folders that contain no audio (unlikely after the walk
    // but defensive) and skip _-prefixed admin folders consistent with the
    // instrument-resolver convention.
    return Array.from(byFolder.entries())
      .filter(([folder, list]) => folder.length > 0 && !folder.startsWith('_') && list.length > 0)
      .map(([folder]) => folder)
      .sort();
  }

  return {
    pick,
    getDiscoveredRoles,
    reset(): void {
      cache = null;
      listingPromise = null;
    },
  };
}
