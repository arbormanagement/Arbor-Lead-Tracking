/**
 * fetch with bounded retries for transient upstream failures. Retries only on
 * 429 and 5xx responses, honoring a numeric `Retry-After` header (capped) and
 * falling back to exponential backoff. Thrown errors (timeout/abort/DNS) and the
 * final failing response pass through untouched, so every caller keeps its own
 * error-shaping (`Google Ads 500: …`, `HCP 503 …`, etc.).
 */
const BACKOFF_MS = [1_000, 4_000];
const RETRY_AFTER_CAP_MS = 30_000;

function retryDelayMs(res: Response, attempt: number): number {
  // `Number(null)` is 0, so parsing unconditionally would treat every response
  // WITHOUT a Retry-After (most 5xx, many 429s) as "retry after 0ms" and skip the
  // backoff entirely — hammering an already-failing upstream. Only trust the
  // header when it is actually present and numeric.
  const raw = res.headers.get("retry-after");
  if (raw !== null) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1_000, RETRY_AFTER_CAP_MS);
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}

export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  { retries = 2, timeoutMs }: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // A fresh deadline per attempt when `timeoutMs` is given. Passing a single
    // `AbortSignal.timeout()` through `init` instead makes ONE deadline cover
    // every attempt plus the backoff sleeps between them, so a slow first attempt
    // leaves the retry no budget and, if the signal fires mid-sleep, the caller
    // sees a bare "This operation was aborted" instead of the upstream status —
    // which is then what lands in sync_runs.error.
    const res = await fetch(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
    if ((res.status !== 429 && res.status < 500) || attempt >= retries) return res;
    // Discard the failed body so the connection can be reused across retries.
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt)));
  }
}
