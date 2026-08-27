import type { RepoRole, RepoRoleAssignment } from './types';

export interface UserRecord {
  username: string;
  passwordHash: string;
  createdAt: number;
  createdBy: string;
  active: boolean;
  lastLoginAt: number | null;
  // Global admin is a distinct, more powerful flag than any per-repo role:
  // it gates access to the Admin Web UI and the user-management API
  // (`/api/v1/auth/users*`). A per-repo `admin` role (see `RepoRole`) only
  // controls one repo and must never be treated as equivalent to this.
  isGlobalAdmin: boolean;
}

export interface LegacyUserRecord {
  username: string;
  passwordHash: string;
}

export interface UserStore {
  init(): Promise<void>;
  count(): Promise<number>;
  list(): Promise<UserRecord[]>;
  getByUsername(username: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
  setActive(username: string, active: boolean): Promise<boolean>;
  delete(username: string): Promise<boolean>;
  updateLastLogin(username: string, lastLoginAt: number): Promise<boolean>;
  tryCreateFirstUser(user: UserRecord): Promise<boolean>;
  legacyUsers(): Promise<LegacyUserRecord[]>;
  getRepoRole(username: string, repoId: string): Promise<RepoRole | null>;
  listRepoRoles(repoId: string): Promise<RepoRoleAssignment[]>;
  upsertRepoRole(assignment: RepoRoleAssignment): Promise<void>;
  deleteRepoRole(username: string, repoId: string): Promise<boolean>;
  setGlobalAdmin(username: string, isGlobalAdmin: boolean): Promise<boolean>;
}
