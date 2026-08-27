export interface LocalUser {
  username: string;
  passwordHash: string;
}

export interface AccessTokenClaims {
  sub: string;
  iat: number;
  exp: number;
}

export interface LoginResult {
  username: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface SessionRecord {
  refreshToken: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreateUserInput {
  username: string;
  password: string;
  createdBy: string;
}

// Deliberately excludes `passwordHash` — this type is returned directly to
// HTTP clients via GET /api/v1/auth/users, and a password hash (even a
// salted argon2id one) must never be exposed over the network (OWASP ASVS
// V2/credential exposure). See `AuthService.listUsers()`, which strips the
// hash before returning this shape.
export interface UserSummary {
  username: string;
  createdAt: number;
  createdBy: string;
  active: boolean;
  lastLoginAt: number | null;
  activeSessions: number;
}

export interface SetupStatus {
  eligible: boolean;
  reason: 'not_configured' | 'users_exist' | 'bootstrap_env_configured';
}
