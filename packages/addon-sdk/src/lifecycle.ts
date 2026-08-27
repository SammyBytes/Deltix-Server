/**
 * Runtime lifecycle contract an addon entrypoint module must implement.
 * Which methods actually get called depends on the capabilities declared
 * in `addon.manifest.json` (e.g. `registerRoutes` is only invoked if the
 * addon declared `http:route`).
 */
import type { AddonCapability } from './capabilities';

export type AddonRouteHandler = (request: Request) => Promise<Response>;

export interface AddonHttpRegistrar {
  register(path: string, handler: AddonRouteHandler): void;
}

export interface AddonDbReader {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface AddonDbWriter {
  execute(sql: string, params?: unknown[]): Promise<void>;
}

export interface AddonNasReader {
  readFile(path: string): Promise<Uint8Array>;
}

/** Host-provided facilities, scoped to only the capabilities the addon was granted. */
export interface AddonContext {
  addonName: string;
  grantedCapabilities: readonly AddonCapability[];
  http?: AddonHttpRegistrar;
  dbRead?: AddonDbReader;
  dbWrite?: AddonDbWriter;
  nasRead?: AddonNasReader;
}

/** Contract every addon entrypoint's default export must satisfy. */
export interface AddonModule {
  activate(context: AddonContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
