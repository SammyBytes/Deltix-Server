/**
 * Factory that wires the addons context's trust store together from
 * validated env vars. Boot-time composition root — nothing else should
 * construct `LibsqlAddonTrustStore` directly.
 */
import type { Env } from '../../shared/env';
import type { AddonTrustStore } from './addon-trust-store';
import { LibsqlAddonTrustStore } from './libsql-addon-trust-store';

export async function createAddonTrustStore(env: Env): Promise<AddonTrustStore> {
  const store = new LibsqlAddonTrustStore(env.DELTIX_ADDON_TRUST_DB_PATH);
  await store.init();
  return store;
}
