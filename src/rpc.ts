// src/rpc.ts: HOW we talk to Solana. The one place that sends JSON-RPC requests.
//
// Three jobs:
//   1. PACE requests: at most one every RPC_GAP_MS (default 2 seconds), so we rarely hit
//      the public endpoint's rate limit at all.
//   2. RETRY problems that are temporary (rate limits, timeouts, node hiccups),
//      waiting longer after each failure: 1s, 2s, 4s, 8s, 16s ("exponential backoff").
//   3. GIVE UP IMMEDIATELY on answers that are permanent (a skipped slot, a pruned
//      block) and hand them back as an RpcError with the code, so the pipeline can
//      record the right status in the database.

import dotenv from "dotenv";

dotenv.config({ quiet: true });

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
// Pacing: wait at least this long between requests. 2 seconds is what the free public
// endpoint allows for getBlock (measured: about one request every 2 seconds).
// With a provider key you can set RPC_GAP_MS lower in .env, e.g. 150.
const GAP_MS = Number(process.env.RPC_GAP_MS ?? 2000);
const MAX_ATTEMPTS = 6;      // 1 try + up to 5 retries
const BASE_DELAY_MS = 1000;  // first retry waits ~1s, then doubles each time
const MAX_DELAY_MS = 30000;  // never wait more than 30s between tries
const TIMEOUT_MS = 30000;    // give up on a single request after 30s

// The Solana error codes the pipeline cares about.
// Full list: https://docs.rs/solana-rpc-client-api/latest/src/solana_rpc_client_api/custom_error.rs.html
export const RpcCode = {
  BLOCK_CLEANED_UP: -32001,               // older than this node keeps (permanent)
  BLOCK_NOT_AVAILABLE: -32004,            // node doesn't have it yet (temporary)
  NODE_UNHEALTHY: -32005,                 // node is behind (temporary)
  SLOT_SKIPPED: -32007,                   // no block, or missing after a snapshot jump (permanent)
  LONG_TERM_STORAGE_SLOT_SKIPPED: -32009, // no block in the archive (permanent)
  BLOCK_STATUS_NOT_AVAILABLE_YET: -32014, // too new (temporary)
  UNSUPPORTED_TRANSACTION_VERSION: -32015,
  MIN_CONTEXT_SLOT_NOT_REACHED: -32016,   // node is behind (temporary)
  EPOCH_REWARDS_PERIOD_ACTIVE: -32017,    // rewards still being paid out (temporary)
  LONG_TERM_STORAGE_UNREACHABLE: -32019,  // archive hiccup (temporary)
  LEADER_SCHEDULE_IDENTITY_NOT_FOUND: -32022,
} as const;

// Codes that mean "the data exists, the node just can't serve it right now".
const RETRYABLE_CODES = new Set<number>([
  RpcCode.BLOCK_NOT_AVAILABLE,
  RpcCode.NODE_UNHEALTHY,
  RpcCode.BLOCK_STATUS_NOT_AVAILABLE_YET,
  RpcCode.MIN_CONTEXT_SLOT_NOT_REACHED,
  RpcCode.EPOCH_REWARDS_PERIOD_ACTIVE,
  RpcCode.LONG_TERM_STORAGE_UNREACHABLE,
]);

// A failed call, carrying everything the pipeline needs to write a gap row in the database.
export class RpcError extends Error {
  code: number | null;        // Solana JSON-RPC error code, e.g. -32007 (null if it never got that far)
  httpStatus: number | null;  // HTTP status, e.g. 429 (null if there was no response at all)
  retryable: boolean;         // true = temporary, worth trying again

  constructor(message: string, code: number | null, httpStatus: number | null, retryable: boolean) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

// The shape of every JSON-RPC response: either `result` or `error` is filled in.
interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Job 1, PACING: make sure at least GAP_MS has passed since the previous request.
// (Works because the pipeline sends one request at a time, never several at once.)
let lastRequestAt = 0;

async function waitForTurn(): Promise<void> {
  const waitMs = lastRequestAt + GAP_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

// Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at 30s), plus a little randomness
// ("jitter") so retries don't all land at the exact same moment.
function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.25 * exponential;
  return exponential + jitter;
}

// One attempt: send the request, and turn every possible failure into an RpcError.
async function sendOnce(method: string, params: unknown[]): Promise<unknown> {
  await waitForTurn();

  let response: Response;
  try {
    response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS), // cancel if no answer in 30s
    });
  } catch (error) {
    // No response at all (network down, DNS, timeout). Always worth retrying.
    throw new RpcError(`${method}: network error or timeout (${(error as Error).message})`, null, null, true);
  }

  // Failure layer 1: HTTP refused. 429 = rate limited; 5xx = server trouble. Both temporary.
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new RpcError(`${method}: HTTP ${response.status}`, null, response.status, retryable);
  }

  // The body should be JSON. If it isn't (e.g. a proxy error page), treat it as temporary.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new RpcError(`${method}: response was not valid JSON`, null, response.status, true);
  }

  // A valid reply is an object with either "result" or "error". Anything else (e.g. "null" or {})
  // is a broken reply: treat it as temporary instead of crashing on it later.
  if (typeof parsed !== "object" || parsed === null || !("result" in parsed || "error" in parsed)) {
    throw new RpcError(`${method}: reply had neither a result nor an error`, null, response.status, true);
  }
  const body = parsed as JsonRpcResponse;

  // Failure layer 2: HTTP was fine, but Solana put an error inside the JSON.
  if (body.error) {
    const code = body.error.code;
    throw new RpcError(`${method}: ${body.error.message}`, code, response.status, RETRYABLE_CODES.has(code));
  }

  return body.result;
}

// Job 2 and 3: try, and on a TEMPORARY failure wait and try again; on a PERMANENT one
// (or after MAX_ATTEMPTS), throw the RpcError to the caller.
export async function callRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await sendOnce(method, params)) as T;
    } catch (error) {
      const rpcError = error as RpcError;
      if (!rpcError.retryable || attempt >= MAX_ATTEMPTS) {
        throw rpcError; // permanent, or out of retries: let the pipeline record it
      }
      const delayMs = backoffDelay(attempt);
      console.warn(`  retry ${attempt}/${MAX_ATTEMPTS - 1} for ${method} in ${(delayMs / 1000).toFixed(1)}s (${rpcError.message})`);
      await sleep(delayMs);
    }
  }
}
