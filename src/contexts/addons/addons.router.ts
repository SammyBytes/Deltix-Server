/**
 * HonoJS presentation layer for the addon trust-management API: lets an
 * authenticated admin list, register (TOFU: Trust-On-First-Use) and revoke
 * community addon author public keys, ahead of an Admin Web UI panel wired
 * to these same endpoints. Same auth discipline as every other management
 * endpoint in this project: requires a valid Fase 2 JWT access token.
 *
 * This does NOT load or execute any addon — it only manages the trust
 * store consulted by `loadAddon()` at boot time (`contexts/addons/addon-loader.ts`).
 * Trusting/revoking a key here takes effect on the NEXT server restart,
 * consistent with the rest of the addon system being boot-time-only in
 * Fase 4 (no live reload).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../shared/logger';
import type { AuthService } from '../auth';
import type { AddonTrustStore } from './addon-trust-store';

const logger = createLogger('http:addons');

// Raw 32-byte Ed25519 public key, base64-encoded, decodes to exactly 32
// bytes — same format `generate-addon-author-keypair.ts` prints and the
// same convention as DELTIX_LICENSE_PUBLIC_KEY. Reject anything else before
// it ever reaches the trust store (defense in depth; the signature
// verifier would also reject a malformed key, but failing fast here gives
// the admin a clear 400 instead of a cryptic verification error later).
const trustRequestSchema = z.object({
  addonName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'addonName must be lowercase kebab-case'),
  authorPublicKey: z.string().refine(isValidRawEd25519PublicKeyBase64, {
    message: 'authorPublicKey must be a base64-encoded raw 32-byte Ed25519 public key',
  }),
});

function isValidRawEd25519PublicKeyBase64(value: string): boolean {
  try {
    const decoded = Buffer.from(value, 'base64');
    // Re-encoding must round-trip exactly — rejects non-base64 garbage that
    // Buffer.from() would otherwise silently truncate/ignore.
    return decoded.length === 32 && decoded.toString('base64') === value;
  } catch {
    return false;
  }
}

async function authenticate(
  authHeader: string | undefined,
  authService: AuthService,
): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }
  try {
    const claims = await authService.verifyAccessToken(token);
    return claims.sub;
  } catch {
    return null;
  }
}

export function createAddonsRouter(authService: AuthService, trustStore: AddonTrustStore): Hono {
  const app = new Hono();

  app.get('/trust', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!(await authService.isGlobalAdmin(username))) {
      return c.json({ error: 'Global admin access required' }, 403);
    }

    const trusted = await trustStore.listTrusted();
    return c.json({ trusted }, 200);
  });

  app.post('/trust', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!(await authService.isGlobalAdmin(username))) {
      return c.json({ error: 'Global admin access required' }, 403);
    }

    const parsed = trustRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }

    await trustStore.trust({
      addonName: parsed.data.addonName,
      authorPublicKey: parsed.data.authorPublicKey,
      trustedAt: Date.now(),
      trustedBy: username,
    });

    logger.info(
      { username, addonName: parsed.data.addonName },
      'Community addon author key trusted (effective on next server restart)',
    );
    return c.json({ ok: true }, 200);
  });

  app.post('/revoke', async (c) => {
    const username = await authenticate(c.req.header('authorization'), authService);
    if (!username) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!(await authService.isGlobalAdmin(username))) {
      return c.json({ error: 'Global admin access required' }, 403);
    }

    const parsed = z
      .object({ addonName: z.string().min(1).max(128) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    await trustStore.revokeTrust(parsed.data.addonName);

    logger.info(
      { username, addonName: parsed.data.addonName },
      'Community addon author key trust revoked (effective on next server restart)',
    );
    return c.json({ ok: true }, 200);
  });

  return app;
}
