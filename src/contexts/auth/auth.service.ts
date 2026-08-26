/**
 * Orchestrates the full Fase 2 auth flow: credential check → rate limiting
 * → access token issuance → sliding-window session creation, and the
 * inverse operations (keep-alive, logout). This is the context's core
 * service; `contexts/auth/index.ts` is the only file allowed to export it.
 */
import { issueAccessToken, verifyAccessToken } from './jwt-issuer';
import { LoginRateLimiter } from './login-rate-limiter';
import { verifyCredentials } from './password-authenticator';
import { SlidingWindowSessionManager } from './session-manager';
import type { SessionStore } from './session-store';
import type { AccessTokenClaims, LocalUser, LoginResult } from './types';

export interface AuthServiceConfig {
  users: LocalUser[];
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  maxLoginAttempts: number;
  loginAttemptWindowMs: number;
}

export class AuthService {
  private readonly rateLimiter: LoginRateLimiter;
  private readonly sessionManager: SlidingWindowSessionManager;

  constructor(
    private readonly config: AuthServiceConfig,
    sessionStore: SessionStore,
    now: () => number = () => Date.now(),
  ) {
    this.rateLimiter = new LoginRateLimiter(
      config.maxLoginAttempts,
      config.loginAttemptWindowMs,
      now,
    );
    this.sessionManager = new SlidingWindowSessionManager(
      sessionStore,
      config.sessionTtlSeconds,
      now,
    );
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.rateLimiter.assertAllowed(username);
    this.rateLimiter.recordAttempt(username);

    const authenticatedUsername = await verifyCredentials(username, password, this.config.users);

    const accessToken = await issueAccessToken(
      authenticatedUsername,
      this.config.jwtPrivateKeyPem,
      this.config.accessTokenTtlSeconds,
    );
    const refreshToken = await this.sessionManager.createSession(authenticatedUsername);

    return {
      username: authenticatedUsername,
      accessToken,
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlSeconds,
    };
  }

  async keepAlive(refreshToken: string): Promise<void> {
    await this.sessionManager.keepAlive(refreshToken);
  }

  /**
   * Re-issues a fresh access token for an existing, still-active session —
   * used by the Admin Web UI on page load/refresh to restore a session from
   * its httpOnly refresh-token cookie without asking the user to log in
   * again, while never exposing the refresh token itself to JavaScript.
   */
  async refresh(refreshToken: string): Promise<LoginResult> {
    const username = await this.sessionManager.usernameFor(refreshToken);
    await this.sessionManager.keepAlive(refreshToken);

    const accessToken = await issueAccessToken(
      username,
      this.config.jwtPrivateKeyPem,
      this.config.accessTokenTtlSeconds,
    );

    return {
      username,
      accessToken,
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlSeconds,
    };
  }

  async assertSessionActive(refreshToken: string): Promise<void> {
    await this.sessionManager.assertActive(refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessionManager.revoke(refreshToken);
  }

  async verifyAccessToken(accessToken: string): Promise<AccessTokenClaims> {
    return verifyAccessToken(accessToken, this.config.jwtPublicKeyPem);
  }
}
