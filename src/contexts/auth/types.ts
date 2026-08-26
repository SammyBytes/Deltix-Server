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
