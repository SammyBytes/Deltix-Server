import { describe, expect, it } from 'bun:test';
import { AddonCircuitBreaker } from '../../../src/contexts/addons/addon-circuit-breaker';

describe('AddonCircuitBreaker', () => {
  it('passes through successful handler calls', async () => {
    const breaker = new AddonCircuitBreaker({ maxConsecutiveFailures: 3 });
    const wrapped = breaker.wrap('ok-addon', async () => new Response('fine'));

    const response = await wrapped(new Request('http://localhost/x'));
    expect(await response.text()).toBe('fine');
    expect(breaker.isDisabled('ok-addon')).toBe(false);
  });

  it('returns a 500 and keeps the addon enabled below the failure threshold', async () => {
    const breaker = new AddonCircuitBreaker({ maxConsecutiveFailures: 3 });
    const wrapped = breaker.wrap('flaky-addon', async () => {
      throw new Error('boom');
    });

    const response = await wrapped(new Request('http://localhost/x'));
    expect(response.status).toBe(500);
    expect(breaker.isDisabled('flaky-addon')).toBe(false);
  });

  it('disables the addon in-memory after N consecutive failures', async () => {
    let onDisabledCalledWith: string | undefined;
    const breaker = new AddonCircuitBreaker({
      maxConsecutiveFailures: 2,
      onDisabled: (name) => {
        onDisabledCalledWith = name;
      },
    });
    const wrapped = breaker.wrap('bad-addon', async () => {
      throw new Error('boom');
    });

    await wrapped(new Request('http://localhost/x'));
    await wrapped(new Request('http://localhost/x'));

    expect(breaker.isDisabled('bad-addon')).toBe(true);
    expect(onDisabledCalledWith).toBe('bad-addon');

    const response = await wrapped(new Request('http://localhost/x'));
    expect(response.status).toBe(503);
  });

  it('resets the failure count after a successful call', async () => {
    let shouldFail = true;
    const breaker = new AddonCircuitBreaker({ maxConsecutiveFailures: 2 });
    const wrapped = breaker.wrap('recovering-addon', async () => {
      if (shouldFail) throw new Error('boom');
      return new Response('ok');
    });

    await wrapped(new Request('http://localhost/x'));
    shouldFail = false;
    await wrapped(new Request('http://localhost/x'));
    shouldFail = true;
    await wrapped(new Request('http://localhost/x'));

    expect(breaker.isDisabled('recovering-addon')).toBe(false);
  });
});
