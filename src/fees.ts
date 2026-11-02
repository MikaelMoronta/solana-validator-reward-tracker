// src/fees.ts: index block fees from the slots the validator was scheduled to lead.
//
// Phase A, SAVE SCHEDULES: for every epoch, fetch the leader schedule and save each assigned
//   slot as a PENDING row in leader_slots. This runs for ALL epochs first, because the RPC
//   only keeps schedules for about the last 8 epochs, so we capture them while we still can.
//   Epochs whose schedule is already gone are recorded as UNAVAILABLE (a permanent gap).
//
// Phase B, FETCH BLOCKS: for every PENDING or FAILED slot (newest epoch first), fetch the
//   block and record its final status and fee. Each slot is saved as soon as it's fetched,
//   so stopping the run (Ctrl+C, crash, PC sleeps) loses at most the one slot in flight;
//   it's still PENDING, so the next run simply fetches it.

import { pool } from "./db";
import { setEpochStatus } from "./epoch-status";
import { RpcError } from "./rpc";
import { Block, EpochSchedule, getBlock, getLeaderSlots, isSkippedSlot } from "./solana";

type SlotStatus = "PRODUCED" | "EMPTY" | "SKIPPED" | "ANOMALY" | "FAILED";

// Everything we record about one slot after trying to fetch it.
interface SlotResult {
  status: SlotStatus;
  feeLamports: number | null;
  txCount: number | null;
  errorCode: number | null;
  errorMessage: string | null;
}

// ======================= Phase A: save leader schedules =======================

// Epochs in the range that don't yet have a saved schedule (or a known-unavailable one).
// Newest first, so the latest completed epoch (the assignment's minimum) is captured first.
async function epochsNeedingSchedule(voteAccount: string, fromEpoch: number, toEpoch: number): Promise<number[]> {
  const result = await pool.query<{ epoch: number }>(
    `SELECT e.epoch
     FROM generate_series($2::int, $3::int) AS e(epoch)
     WHERE NOT EXISTS (
       SELECT 1
       FROM epoch_status s
       WHERE s.vote_account = $1
         AND s.epoch = e.epoch
         AND s.stream = 'FEES'
         AND s.status IN ('SCHEDULE_SAVED', 'UNAVAILABLE')
     )
     ORDER BY e.epoch DESC`,
    [voteAccount, fromEpoch, toEpoch]
  );
  return result.rows.map((row) => row.epoch);
}

async function saveSchedules(schedule: EpochSchedule, voteAccount: string, identity: string, fromEpoch: number, toEpoch: number): Promise<void> {
  const epochs = await epochsNeedingSchedule(voteAccount, fromEpoch, toEpoch);
  console.log(`Block fees, phase A: ${epochs.length} leader schedule(s) to fetch`);
  const unavailable: number[] = [];

  for (const epoch of epochs) {
    try {
      const slots = await getLeaderSlots(schedule, identity, epoch);

      if (slots === null) {
        await setEpochStatus({
          voteAccount, epoch, stream: "FEES", status: "UNAVAILABLE",
          detail: "RPC no longer has this epoch's leader schedule, so its blocks can't be attributed to the validator",
        });
        unavailable.push(epoch);
        continue;
      }

      // Save every assigned slot in ONE query: unnest() turns the array into rows.
      // DO NOTHING (not UPDATE): if a slot is already saved, keep it, and keep its status.
      // Re-saving a schedule must never reset slots we've already fetched back to PENDING.
      await pool.query(
        `INSERT INTO leader_slots (vote_account, slot, epoch)
         SELECT $1, slot, $3
         FROM unnest($2::bigint[]) AS slot
         ON CONFLICT (vote_account, slot) DO NOTHING`,
        [voteAccount, slots, epoch]
      );
      await setEpochStatus({ voteAccount, epoch, stream: "FEES", status: "SCHEDULE_SAVED", leaderSlotCount: slots.length });
      console.log(`  epoch ${epoch}: saved ${slots.length} leader slots`);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      await setEpochStatus({ voteAccount, epoch, stream: "FEES", status: "FAILED", detail: error.message, errorCode: error.code ?? error.httpStatus });
      console.log(`  epoch ${epoch}: FAILED to fetch schedule (${error.message}), will retry next run`);
    }
  }

  if (unavailable.length > 0) {
    console.log(`  ${unavailable.length} epoch(s) between ${Math.min(...unavailable)} and ${Math.max(...unavailable)}: schedule no longer available (recorded as UNAVAILABLE)`);
  }
}

// ======================= Phase B: fetch blocks =======================

function failed(errorCode: number | null, errorMessage: string): SlotResult {
  return { status: "FAILED", feeLamports: null, txCount: null, errorCode, errorMessage };
}

// Decide a slot's outcome from its block. This is where the "never record an unverified zero"
// rule lives (README, design decision 5).
async function classifyBlock(slot: number, block: Block | null, identity: string): Promise<SlotResult> {
  if (block === null) return failed(null, "getBlock returned no block and no error");

  const feeRewards = (block.rewards ?? []).filter((reward) => reward.rewardType?.toLowerCase() === "fee");
  const ourFeeRewards = feeRewards.filter((reward) => reward.pubkey === identity);

  // Normal case: the block paid a Fee reward to our identity account.
  if (ourFeeRewards.length > 0) {
    let fee = 0;
    for (const reward of ourFeeRewards) fee += reward.lamports; // recon showed exactly one, but add up to be safe
    return { status: "PRODUCED", feeLamports: fee, txCount: null, errorCode: null, errorMessage: null };
  }

  // A Fee reward went to someone else? Shouldn't happen for our own leader slot. Don't guess; flag it.
  if (feeRewards.length > 0) {
    return { status: "ANOMALY", feeLamports: null, txCount: null, errorCode: null, errorMessage: `Fee reward paid to ${feeRewards[0].pubkey}, not our identity` };
  }

  // No Fee reward at all. Don't assume zero: re-fetch WITH transaction signatures and count them.
  const detailed = await getBlock(slot, "signatures");
  if (detailed === null) return failed(null, "re-check getBlock returned no block");
  // No signature list means we can't count the transactions, so we can't prove the block is empty.
  const signatures = detailed.signatures;
  if (!Array.isArray(signatures)) return failed(null, "re-check returned no signature list");
  const txCount = signatures.length;

  if (txCount === 0) {
    // Truly empty block: no transactions means no fees. Zero is the correct, verified answer.
    return { status: "EMPTY", feeLamports: 0, txCount: 0, errorCode: null, errorMessage: null };
  }
  // Transactions but no fee: something we don't understand. Record it as a gap, never as a fake 0.
  return { status: "ANOMALY", feeLamports: null, txCount, errorCode: null, errorMessage: `block has ${txCount} transactions but no Fee reward` };
}

// Fetch one slot and turn whatever happens into a SlotResult.
async function fetchSlot(slot: number, identity: string): Promise<SlotResult> {
  try {
    const block = await getBlock(slot, "none"); // lightweight: rewards only
    return await classifyBlock(slot, block, identity);
  } catch (error) {
    if (isSkippedSlot(error)) {
      // No block was produced in this slot: a real outcome worth 0 fees, not a gap.
      // We keep the error code so it's visible which answer (-32007 or -32009) the node gave.
      const rpcError = error as RpcError;
      return { status: "SKIPPED", feeLamports: 0, txCount: null, errorCode: rpcError.code, errorMessage: rpcError.message };
    }
    if (error instanceof RpcError) return failed(error.code ?? error.httpStatus, error.message);
    throw error; // not an RPC problem (a bug, or the database is down): stop the run loudly
  }
}

async function saveSlotResult(voteAccount: string, slot: number, result: SlotResult): Promise<void> {
  await pool.query(
    `UPDATE leader_slots
     SET status          = $3,
         fee_lamports    = $4,
         tx_count        = $5,
         error_code      = $6,
         error_message   = $7,
         attempts        = attempts + 1,
         last_attempt_at = now()
     WHERE vote_account = $1 AND slot = $2`,
    [voteAccount, slot, result.status, result.feeLamports, result.txCount, result.errorCode, result.errorMessage]
  );
}

// Per-epoch totals, calculated from leader_slots (fees are never stored a second time).
async function printFeeSummary(voteAccount: string, fromEpoch: number, toEpoch: number): Promise<void> {
  const result = await pool.query(
    // ::int / ::float8 convert the BIGINT and NUMERIC results so pg returns numbers, not text.
    `SELECT epoch,
            count(*)::int                                                   AS assigned,
            (count(*) FILTER (WHERE status = 'PRODUCED'))::int              AS produced,
            (count(*) FILTER (WHERE status = 'EMPTY'))::int                 AS empty,
            (count(*) FILTER (WHERE status = 'SKIPPED'))::int               AS skipped,
            (count(*) FILTER (WHERE status IN ('ANOMALY', 'FAILED')))::int  AS gaps,
            (count(*) FILTER (WHERE status = 'PENDING'))::int               AS pending,
            round(coalesce(sum(fee_lamports), 0) / 1e9, 4)::float8          AS fees_sol
     FROM leader_slots
     WHERE vote_account = $1 AND epoch BETWEEN $2 AND $3
     GROUP BY epoch
     ORDER BY epoch DESC`,
    [voteAccount, fromEpoch, toEpoch]
  );
  console.log("\nBlock fee summary:");
  if (result.rows.length === 0) console.log("  (no saved leader slots in this epoch range)");
  else console.table(result.rows);
}

export async function indexBlockFees(schedule: EpochSchedule, voteAccount: string, identity: string, fromEpoch: number, toEpoch: number): Promise<void> {
  await saveSchedules(schedule, voteAccount, identity, fromEpoch, toEpoch);

  // Everything not yet finished: never fetched (PENDING) or failed last time (FAILED).
  // BIGINT columns come back from pg as text (to avoid precision loss), so slot is a string here.
  const pending = await pool.query<{ slot: string; epoch: number }>(
    `SELECT slot, epoch
     FROM leader_slots
     WHERE vote_account = $1
       AND epoch BETWEEN $2 AND $3
       AND status IN ('PENDING', 'FAILED')
     ORDER BY epoch DESC, slot`,
    [voteAccount, fromEpoch, toEpoch]
  );

  const total = pending.rows.length;
  console.log(`\nBlock fees, phase B: ${total} slot(s) to fetch (newest epoch first). Safe to stop with Ctrl+C at any time.`);
  const startedAt = Date.now();
  const counts: Record<string, number> = {};

  // One slot at a time: fetch it, save it, move on.
  for (let i = 0; i < total; i++) {
    const row = pending.rows[i];
    const slot = Number(row.slot); // text -> number (slot numbers are far below the precision limit)
    const result = await fetchSlot(slot, identity);
    await saveSlotResult(voteAccount, slot, result);
    counts[result.status] = (counts[result.status] ?? 0) + 1;

    // Progress report every 50 slots, with a rough time estimate.
    const done = i + 1;
    if (done % 50 === 0 || done === total) {
      const elapsedMin = (Date.now() - startedAt) / 60000;
      const remainingMin = (elapsedMin / done) * (total - done);
      const tally = Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(", ");
      console.log(`  ${done}/${total} | epoch ${row.epoch} | ${tally} | ${elapsedMin.toFixed(1)} min elapsed, ~${remainingMin.toFixed(0)} min left`);
    }
  }

  await printFeeSummary(voteAccount, fromEpoch, toEpoch);
}
