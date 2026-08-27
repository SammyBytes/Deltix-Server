/**
 * Boot-time orchestrator: discovers addon directories from
 * `DELTIX_ADDON_PATHS` (comma-separated local filesystem paths — "Bring
 * Your Own File Path", no registry in Fase 4), enforces
 * `maxCommunityAddons` across the whole discovered set, then loads each
 * addon independently via `loadAddon()`. One addon failing to load never
 * aborts the others or the boot sequence — it's logged and skipped
 * (fail-closed per-addon, fail-open for the rest of the control plane).
 */
import {
  type AddonLoadDeps,
  assertWithinCommunityAddonLimit,
  type LoadedAddon,
  loadAddon,
} from './addon-loader';

export interface AddonDiscoveryResult {
  loaded: LoadedAddon[];
  failures: Array<{ addonDir: string; error: Error }>;
}

export async function discoverAndLoadAddons(
  addonPathsCsv: string,
  deps: AddonLoadDeps,
): Promise<AddonDiscoveryResult> {
  const addonDirs = addonPathsCsv
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const manifestPeeks = await Promise.all(
    addonDirs.map(async (dir) => ({ dir, tier: await peekTier(dir) })),
  );
  const communityCount = manifestPeeks.filter((m) => m.tier === 'community').length;
  assertWithinCommunityAddonLimit(communityCount, deps.addonsConfig);

  const loaded: LoadedAddon[] = [];
  const failures: AddonDiscoveryResult['failures'] = [];

  for (const addonDir of addonDirs) {
    try {
      loaded.push(await loadAddon(addonDir, deps));
    } catch (err) {
      failures.push({ addonDir, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  return { loaded, failures };
}

/** Best-effort manifest tier peek, used only to size-check the community limit up front. */
async function peekTier(addonDir: string): Promise<'official' | 'community' | 'unknown'> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(addonDir, 'addon.manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tier?: unknown };
    return parsed.tier === 'official' || parsed.tier === 'community' ? parsed.tier : 'unknown';
  } catch {
    return 'unknown';
  }
}
