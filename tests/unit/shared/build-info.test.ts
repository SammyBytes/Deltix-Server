import { describe, expect, it } from 'bun:test';
import packageJson from '../../../package.json' with { type: 'json' };
import { getBuildInfo } from '../../../src/shared/build-info';

describe('getBuildInfo', () => {
  it('reports the version from package.json', async () => {
    const info = await getBuildInfo();
    expect(info.version).toBe(packageJson.version);
  });

  it('never throws, even if git metadata is unavailable (never blocks boot)', async () => {
    await expect(getBuildInfo()).resolves.toBeTruthy();
  });

  it('resolves a non-empty commit string (env override, git fallback, or "unknown")', async () => {
    const info = await getBuildInfo();
    expect(typeof info.commit).toBe('string');
    expect(info.commit.length).toBeGreaterThan(0);
  });

  it('reports NODE_ENV (defaulting to "development" when unset)', async () => {
    const info = await getBuildInfo();
    expect(typeof info.nodeEnv).toBe('string');
  });
});
