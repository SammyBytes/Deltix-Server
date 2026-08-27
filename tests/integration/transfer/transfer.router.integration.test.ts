import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AuthService } from '../../../src/contexts/auth/auth.service';
import { LibsqlSessionStore } from '../../../src/contexts/auth/libsql-session-store';
import { LibsqlUserStore } from '../../../src/contexts/auth/libsql-user-store';
import { hashPassword } from '../../../src/contexts/auth/password-authenticator';
import { LibsqlTicketStore } from '../../../src/contexts/transfer/libsql-ticket-store';
import { TicketService } from '../../../src/contexts/transfer/ticket.service';
import { createTransferRouter } from '../../../src/contexts/transfer/transfer.router';

function generateTestEd25519KeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('transfer/transfer.router (integration, real HTTP requests via Hono.fetch)', () => {
  const sessionDbPath = `/tmp/deltix-transfer-router-sessions-${Date.now()}.db`;
  const ticketDbPath = `/tmp/deltix-transfer-router-tickets-${Date.now()}.db`;
  let app: ReturnType<typeof createTransferRouter>;
  let authService: AuthService;

  beforeEach(async () => {
    await rm(sessionDbPath, { force: true });
    await rm(sessionDbPath.replace('sessions', 'users'), { force: true });
    await rm(ticketDbPath, { force: true });

    const sessionStore = new LibsqlSessionStore(sessionDbPath);
    await sessionStore.init();
    const userStore = new LibsqlUserStore(sessionDbPath.replace('sessions', 'users'));
    await userStore.init();
    await userStore.create({
      username: 'alice',
      passwordHash: await hashPassword('s3cret-pass'),
      createdAt: Date.now(),
      createdBy: 'seed',
      active: true,
      lastLoginAt: null,
    });
    const { privateKeyPem, publicKeyPem } = generateTestEd25519KeyPairPem();

    authService = new AuthService(
      {
        jwtPrivateKeyPem: privateKeyPem,
        jwtPublicKeyPem: publicKeyPem,
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 120,
        maxLoginAttempts: 5,
        loginAttemptWindowMs: 60_000,
        bootstrapAdminConfigured: false,
      },
      userStore,
      sessionStore,
    );

    const ticketStore = new LibsqlTicketStore(ticketDbPath);
    await ticketStore.init();
    const ticketService = new TicketService(ticketStore, 120);

    app = createTransferRouter(authService, ticketService);
  });

  async function loginAndGetAccessToken(): Promise<string> {
    const { accessToken } = await authService.login('alice', 's3cret-pass');
    return accessToken;
  }

  describe('POST /push/ticket', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/push/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects requests with an invalid bearer token', async () => {
      const res = await app.request('/push/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer garbage' },
        body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed body (missing operation/repo)', async () => {
      const accessToken = await loginAndGetAccessToken();
      const res = await app.request('/push/ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid operation value (fuzz-style payload rejection)', async () => {
      const accessToken = await loginAndGetAccessToken();
      const res = await app.request('/push/ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ operation: 'DROP TABLE tickets', repo: 'org/repo' }),
      });
      expect(res.status).toBe(400);
    });

    it('issues a ticket for a valid authenticated request', async () => {
      const accessToken = await loginAndGetAccessToken();
      const res = await app.request('/push/ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { ticketId: string; operation: string; repo: string };
      expect(body.ticketId).toBeString();
      expect(body.operation).toBe('push');
      expect(body.repo).toBe('org/repo');
    });
  });

  describe('POST /session-close', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await app.request('/auth/session-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'anything' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 when closing a ticket that was never activated', async () => {
      const accessToken = await loginAndGetAccessToken();
      const issueRes = await app.request('/push/ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
      });
      const { ticketId } = (await issueRes.json()) as { ticketId: string };

      const closeRes = await app.request('/auth/session-close', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ ticketId }),
      });
      // Ticket is still only 'issued' (never activated by a gRPC handshake) -> not closable.
      expect(closeRes.status).toBe(404);
    });
  });

  it('full lifecycle: issue -> (simulated gRPC activation) -> close via REST', async () => {
    const accessToken = await loginAndGetAccessToken();

    const issueRes = await app.request('/push/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
    });
    const { ticketId } = (await issueRes.json()) as { ticketId: string };

    // Simulates what the (future) gRPC interceptor does on connect: consume
    // the ticket directly against the same underlying TicketService.
    const ticketStore = new LibsqlTicketStore(ticketDbPath);
    const ticketService = new TicketService(ticketStore, 120);
    await ticketService.consumeTicket(ticketId, 'push', 'org/repo');

    const closeRes = await app.request('/auth/session-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ticketId }),
    });
    expect(closeRes.status).toBe(200);
  });

  it('concurrency: only one of many parallel gRPC-activation attempts on the same ticket wins, even racing against real HTTP-issued tickets', async () => {
    const accessToken = await loginAndGetAccessToken();

    const issueRes = await app.request('/push/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ operation: 'push', repo: 'org/repo' }),
    });
    const { ticketId } = (await issueRes.json()) as { ticketId: string };

    // Simulate 25 concurrent gRPC connections racing to activate the SAME
    // ticket, each backed by its own TicketService/store instance pointed
    // at the same underlying libSQL file — this is the realistic topology
    // (multiple gRPC handler invocations, one shared DB file), not just
    // multiple calls against a single in-process object.
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, async () => {
        const store = new LibsqlTicketStore(ticketDbPath);
        const service = new TicketService(store, 120);
        return service.consumeTicket(ticketId, 'push', 'org/repo');
      }),
    );

    const winners = attempts.filter((r) => r.status === 'fulfilled');
    expect(winners.length).toBe(1);
  });
});
