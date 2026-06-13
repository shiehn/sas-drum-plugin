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

import { scorePromptMatch, pickTopKWeighted } from '@signalsandsorcery/plugin-sdk';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

/**
 * Source of the library root(s) for createKitResolver.
 *
 *   - string                                 — single root, used directly
 *   - string[]                               — multiple roots, scanned in order
 *   - () => Promise<string | string[] | null> — resolved lazily on first scan;
 *                                              null / [] means "no library
 *                                              installed" (resolver returns
 *                                              empty/null cleanly, panel
 *                                              should show CTA)
 *
 * The drum panel passes a function combining `host.getSamplePackRoot('sas-drum-pack')`
 * (the distributed pack — null when not installed or stale) with
 * `host.getUserSampleRoots?.('drums')` (one root per user-imported pack).
 * Distributed root first, user roots after; samples from every root merge
 * into one role pool, so generate/shuffle draw from the union. Roots are
 * independent: a missing/unreadable root is skipped with a warning rather
 * than failing the whole scan.
 */
export type SampleRootSource =
  | string
  | string[]
  | (() => Promise<string | string[] | null>);

/**
 * Options for a query-aware pick. Passing a bare `ReadonlySet<string>` (the
 * historical second argument) is still accepted and treated as `excludePaths`,
 * so existing callers keep working unchanged.
 */
export interface PickOptions {
  /** Shuffle history — paths to skip. */
  excludePaths?: ReadonlySet<string>;
  /**
   * Free-text intent ("vintage dusty boom bap kick"). When supplied AND the
   * role's samples have StableAudio prompt sidecars, the pick is biased
   * toward the closest-matching sample (top-k weighted) instead of uniform
   * random. With no query, no sidecars, or no token overlap, selection
   * stays uniform random over the pool — identical to the historical
   * behavior.
   */
  query?: string;
}

export interface KitResolverOptions {
  /** Injectable RNG in [0, 1) for deterministic tests (default Math.random). */
  rng?: () => number;
}

export interface KitResolver {
  /**
   * Pick a WAV path for the given role (= folder name).
   *
   * Second argument is either a `ReadonlySet<string>` of paths to exclude
   * (the historical shape — shuffle history) or a {@link PickOptions} object
   * that can additionally carry a `query` to bias the pick semantically.
   *
   * Returns `null` if the filtered pool is empty — caller treats null as a
   * signal to reset its shuffle history and call again with an empty Set —
   * or if the role is unknown.
   */
  pick(role: string, options?: ReadonlySet<string> | PickOptions): Promise<string | null>;

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

export function createKitResolver(
  host: PluginHost,
  root: SampleRootSource,
  options?: KitResolverOptions,
): KitResolver {
  const rng = options?.rng ?? Math.random;

  /** Lazily-populated map: folder name → list of absolute WAV paths. */
  let cache: Map<string, string[]> | null = null;
  let listingPromise: Promise<Map<string, string[]>> | null = null;

  /**
   * Lazily-populated map: WAV path → its StableAudio prompt (the sibling
   * `<name>.txt` sidecar, trimmed; '' when missing/unreadable). Filled per
   * role on the first query-aware pick for that role, then cached for the
   * resolver lifetime. Roles that are only ever picked randomly never pay
   * the sidecar-read cost.
   */
  const promptCache = new Map<string, string>();
  const promptsLoadedRoles = new Set<string>();

  /** Read every sidecar for a role's pool once, in parallel. */
  async function ensurePromptsForRole(role: string, pool: readonly string[]): Promise<void> {
    if (promptsLoadedRoles.has(role)) return;
    await Promise.all(
      pool.map(async (wavPath) => {
        if (promptCache.has(wavPath)) return;
        const sidecar = wavPath.replace(/\.wav$/iu, '.txt');
        try {
          const text = await host.readTextFile(sidecar);
          promptCache.set(wavPath, text ? text.trim() : '');
        } catch {
          promptCache.set(wavPath, '');
        }
      }),
    );
    promptsLoadedRoles.add(role);
  }

  /**
   * Normalize whatever the root source yields into an ordered, de-duplicated
   * list of root paths. Distributed root(s) first, user roots after (the
   * panel builds the array in that order). Empty when nothing is installed.
   */
  async function resolveRoots(): Promise<string[]> {
    const raw = typeof root === 'function' ? await root() : root;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const r of list) {
      if (typeof r === 'string' && r.length > 0 && !seen.has(r)) {
        seen.add(r);
        roots.push(r);
      }
    }
    return roots;
  }

  async function getCache(): Promise<Map<string, string[]>> {
    if (cache) return cache;
    if (listingPromise) return listingPromise;

    listingPromise = (async () => {
      try {
        const roots = await resolveRoots();
        if (roots.length === 0) {
          cache = new Map();
          return cache;
        }
        const byFolder = new Map<string, string[]>();
        // Scan every root independently and merge into one role→paths map, so
        // a role pool can draw from the distributed pack AND user packs at
        // once. One root failing (missing dir, disk hiccup) is skipped — the
        // others still populate.
        for (const rootPath of roots) {
          let paths: string[];
          try {
            paths = await host.listAudioFiles(rootPath, { extensions: ['.wav'], recursive: true });
          } catch (err: unknown) {
            console.warn(`[kit-resolver] Failed to list samples under ${rootPath}:`, err);
            continue;
          }
          for (const p of paths) {
            // The folder we care about is the immediate parent dir name —
            // e.g. ".../processed/kick/kick-12345.wav" → "kick".
            const parts = p.split('/');
            const folder = parts[parts.length - 2] ?? '';
            if (!folder) continue;
            const existing = byFolder.get(folder);
            if (existing) {
              existing.push(p);
            } else {
              byFolder.set(folder, [p]);
            }
          }
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

  async function pick(
    role: string,
    options?: ReadonlySet<string> | PickOptions,
  ): Promise<string | null> {
    if (!role) return null;

    // Historical second arg was a bare Set (excludePaths); accept both shapes.
    const { excludePaths, query } =
      options instanceof Set
        ? { excludePaths: options as ReadonlySet<string>, query: undefined }
        : ((options as PickOptions) ?? {});

    let byFolder: Map<string, string[]>;
    try {
      byFolder = await getCache();
    } catch (err: unknown) {
      console.warn('[kit-resolver] Failed to list samples:', err);
      return null;
    }

    const pool = byFolder.get(role);
    if (!pool || pool.length === 0) return null;

    const filtered = excludePaths && excludePaths.size > 0
      ? pool.filter(p => !excludePaths.has(p))
      : pool;
    if (filtered.length === 0) return null;

    // Semantic pick: bias toward the sample whose prompt best matches the
    // query. Any failure (no sidecars, no token overlap, read error) falls
    // through to the uniform-random pick below — never a hard failure.
    const trimmedQuery = query?.trim();
    if (trimmedQuery) {
      try {
        await ensurePromptsForRole(role, pool);
        const prompts = filtered.map((p) => promptCache.get(p) ?? '');
        const scores = scorePromptMatch(trimmedQuery, prompts);
        const maxScore = scores.reduce((m, s) => Math.max(m, s), 0);
        if (maxScore > 0) {
          const picked = pickTopKWeighted(
            filtered.map((p, i) => ({ item: p, score: scores[i], key: p })),
            { rng },
          );
          if (picked) return picked;
        }
      } catch (err) {
        console.warn('[kit-resolver] Semantic pick failed, using random:', err);
      }
    }

    const idx = Math.floor(rng() * filtered.length);
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
      promptCache.clear();
      promptsLoadedRoles.clear();
    },
  };
}
