// src/api.ts: the REST API. Read-only: it serves what the pipeline stored.
//
// Run:  npm run api       then open http://localhost:3000/validators
//
// Endpoints:
//   GET /health                                   is the API up and can it reach the database?
//   GET /validators                               validators we track
//   GET /validators/:vote/epochs?from=&to=        rewards per epoch over a range
//   GET /validators/:vote/summary?from=&to=       totals and stats over a range
//   GET /validators/:vote/gaps?from=&to=&limit=   what we couldn't index, and why
//
// Money format: lamports are returned as strings (exact, no precision loss), plus a `sol`
// number for reading convenience.

import express, { NextFunction, Request, Response } from "express";
import { pool } from "./db";
import { EpochRow, epochRows, gapRows, indexedEpochRange, listValidators, validatorExists } from "./queries";

const app = express();
const PORT = Number(process.env.API_PORT ?? 3000);

// ---------- helpers ----------

// A 4xx error with a message for the caller. Thrown inside a route, caught by the error handler below.
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// lamports (as text from the database) -> SOL number, for display. null stays null.
function toSol(lamports: string | null): number | null {
  return lamports === null ? null : Number(lamports) / 1e9;
}

// Read an optional whole-number query parameter like ?from=1000.
const MAX_EPOCH = 2147483647; // largest value a Postgres INTEGER column can hold

function intParam(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (typeof value !== "string" || value.trim() === "" || !Number.isInteger(parsed) || parsed < 0 || parsed > MAX_EPOCH) {
    throw new HttpError(400, `${name} must be a whole number between 0 and ${MAX_EPOCH}`);
  }
  return parsed;
}

// Validate the validator and the ?from/?to range. Missing from/to = everything we've indexed.
async function resolveRange(req: Request): Promise<{ vote: string; from: number; to: number }> {
  const vote = String(req.params.vote);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(vote)) {
    throw new HttpError(400, "not a valid Solana address"); // base-58: no 0, O, I or l
  }
  if (!(await validatorExists(vote))) {
    throw new HttpError(404, "validator not tracked. Run the pipeline for it first");
  }
  const indexed = await indexedEpochRange(vote);
  const from = intParam(req.query.from, "from") ?? indexed.min ?? 0;
  const to = intParam(req.query.to, "to") ?? indexed.max ?? 0;
  if (to < from) throw new HttpError(400, `to (${to}) must be >= from (${from}); a missing from/to defaults to the indexed range`);
  if (to - from > 5000) throw new HttpError(400, "range too large (max 5000 epochs)");
  return { vote, from, to };
}

// Turn one database row into the API's shape for one epoch.
function formatEpoch(row: EpochRow) {
  // Fee status in plain words. "Complete" only when every assigned slot has a final, known answer.
  let feesStatus: string;
  if (row.fees_status === null) feesStatus = "NOT_INDEXED";
  else if (row.fees_status !== "SCHEDULE_SAVED") feesStatus = row.fees_status; // UNAVAILABLE or FAILED
  else if ((row.pending ?? 0) > 0) feesStatus = "IN_PROGRESS";
  else if ((row.gaps ?? 0) > 0) feesStatus = "PARTIAL";
  else feesStatus = "COMPLETE";

  // Total = staking + fees, but only when BOTH are fully known. Otherwise null, never a misleading number.
  const stakingKnown = row.staking_status === "COMPLETE" || row.staking_status === "NO_REWARD";
  const total =
    stakingKnown && feesStatus === "COMPLETE"
      ? (BigInt(row.staking_lamports ?? "0") + BigInt(row.fee_lamports ?? "0")).toString()
      : null;

  return {
    epoch: row.epoch,
    staking: {
      status: row.staking_status ?? "NOT_INDEXED",
      lamports: row.staking_lamports,
      sol: toSol(row.staking_lamports),
      commission: row.commission,
    },
    fees: {
      status: feesStatus,
      lamports: row.fee_lamports, // for IN_PROGRESS / PARTIAL this is the sum of the slots known so far
      sol: toSol(row.fee_lamports),
      leaderSlots: row.leader_slots,
      produced: row.produced,
      empty: row.empty,
      skipped: row.skipped,
      gaps: row.gaps,
      pending: row.pending,
    },
    total: { lamports: total, sol: toSol(total) },
  };
}

// ---------- routes ----------

app.get("/health", async (_req: Request, res: Response) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", database: "reachable" });
});

app.get("/validators", async (_req: Request, res: Response) => {
  res.json(await listValidators());
});

app.get("/validators/:vote/epochs", async (req: Request, res: Response) => {
  const { vote, from, to } = await resolveRange(req);
  const rows = await epochRows(vote, from, to);
  res.json({ voteAccount: vote, from, to, epochs: rows.map(formatEpoch) });
});

// The summary is computed from the SAME rows as /epochs, so the two can never disagree.
app.get("/validators/:vote/summary", async (req: Request, res: Response) => {
  const { vote, from, to } = await resolveRange(req);
  const epochs = (await epochRows(vote, from, to)).map(formatEpoch);

  // Staking
  const rewarded = epochs.filter((e) => e.staking.status === "COMPLETE");
  let stakingTotal = 0n;
  for (const e of rewarded) stakingTotal += BigInt(e.staking.lamports ?? "0");
  const sortedBySol = [...rewarded].sort((a, b) => (a.staking.sol ?? 0) - (b.staking.sol ?? 0));

  // Fees: only epochs where fee data is COMPLETE count toward the total
  const feesComplete = epochs.filter((e) => e.fees.status === "COMPLETE");
  let feesTotal = 0n;
  let leaderSlots = 0;
  let skipped = 0;
  for (const e of feesComplete) {
    feesTotal += BigInt(e.fees.lamports ?? "0");
    leaderSlots += e.fees.leaderSlots ?? 0;
    skipped += e.fees.skipped ?? 0;
  }
  const countFees = (status: string) => epochs.filter((e) => e.fees.status === status).length;

  res.json({
    voteAccount: vote,
    from,
    to,
    staking: {
      epochsWithReward: rewarded.length,
      epochsWithNoReward: epochs.filter((e) => e.staking.status === "NO_REWARD").length,
      epochsNotIndexedOrFailed: epochs.filter((e) => e.staking.status === "FAILED" || e.staking.status === "NOT_INDEXED").length,
      totalLamports: stakingTotal.toString(),
      totalSol: toSol(stakingTotal.toString()),
      averageSolPerEpoch: rewarded.length ? Number(stakingTotal) / 1e9 / rewarded.length : null,
      lowestEpoch: sortedBySol[0] ? { epoch: sortedBySol[0].epoch, sol: sortedBySol[0].staking.sol } : null,
      highestEpoch: sortedBySol.at(-1) ? { epoch: sortedBySol.at(-1)!.epoch, sol: sortedBySol.at(-1)!.staking.sol } : null,
    },
    fees: {
      epochsComplete: feesComplete.length,
      epochsInProgress: countFees("IN_PROGRESS"),
      epochsPartial: countFees("PARTIAL"),
      epochsUnavailable: countFees("UNAVAILABLE"),
      totalLamports: feesTotal.toString(), // from COMPLETE epochs only
      totalSol: toSol(feesTotal.toString()),
      leaderSlots,
      skipped,
      skipRate: leaderSlots ? skipped / leaderSlots : null,
      note: "Fee totals include only epochs whose fee data is COMPLETE. Older epochs are UNAVAILABLE because the RPC no longer serves their leader schedules.",
    },
    combined: {
      // staking + fees over the epochs where both are fully known
      epochs: epochs.filter((e) => e.total.lamports !== null).length,
      totalLamports: epochs.reduce((sum, e) => sum + BigInt(e.total.lamports ?? "0"), 0n).toString(),
    },
  });
});

app.get("/validators/:vote/gaps", async (req: Request, res: Response) => {
  const { vote, from, to } = await resolveRange(req);
  const limit = intParam(req.query.limit, "limit") ?? 500;
  res.json({ voteAccount: vote, from, to, gaps: await gapRows(vote, from, to, Math.min(limit, 5000)) });
});

// Unknown URL
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not found" });
});

// Error handler. Express 5 sends errors from async routes here automatically.
// Our HttpErrors become their 4xx status; anything else is a real failure (500) and gets logged.
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
