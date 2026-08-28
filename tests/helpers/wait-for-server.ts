const DEFAULT_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 100;

/**
 * Polls an HTTP endpoint until the server under test responds 200, so smoke
 * tests no longer depend on fixed boot sleeps (flaky under load; see HANDOFF
 * §11.3). Because Hono's router freezes its matcher on the first request,
 * `src/index.ts` now registers addon HTTP routes BEFORE Bun.serve listens, so
 * probing an early `/status` can never break addon activation.
 */
export async function waitForServerReady(
  httpPort: number,
  deadlineMs: number = DEFAULT_DEADLINE_MS,
  probePath: string = '/status',
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}${probePath}`);
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw lastError instanceof Error
    ? new Error(`Server did not become ready within ${deadlineMs}ms: ${lastError.message}`)
    : new Error(`Server did not become ready within ${deadlineMs}ms`);
}
