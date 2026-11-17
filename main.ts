// Entry point for the forge. One process: start the HTTP server, tell the make.fun
// environment which port it picked, and stay alive until the environment says the
// trial is over.
//
// The environment gives us its base URL in MAKEFUN_ENV_URL. The protocol is small:
//   - listen on an ephemeral port (the kernel picks one; never 8080, the env owns it)
//   - POST {"port": N} to $MAKEFUN_ENV_URL/register so the env can reach the server
//   - GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then shut down
// Every request is retried with exponential backoff: the env may still be starting
// when we first reach it, and a slow or failed request is never a reason to quit.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing, so there is no environment to register with\n');
  process.exit(1);
}

// One request may take at most this long before it is abandoned and retried.
const REQUEST_LIMIT_MS = 30_000;
// Backoff between retries: starts here, doubles after each failure, never passes the cap.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function backoffAfter(failures: number): number {
  const step = Math.min(failures, 8);
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** step);
}

/**
 * POST the bound port until the environment accepts it. 200 is the normal answer;
 * 409 means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network error or any other
 * status is retried, since the environment may still be starting.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let answer: Response | null = null;
    try {
      answer = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
    } catch {
      // Unreachable or timed out: the environment may still be starting.
    }
    if (answer !== null) {
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`registration refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    }
    await pause(backoffAfter(failures));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function awaitCompletion(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffAfter(failures));
  }
}

/** Bind the port, announce it, then wait for the environment: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the environment to finish\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
