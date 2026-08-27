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

export interface UserSummary {
  username: string;
  passwordHash: string;
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
