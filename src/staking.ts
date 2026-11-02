// src/staking.ts: index staking rewards for every completed epoch in a range.
//
// Resumable: it asks the database which epochs are still unfinished and only does those.
// Idempotent: every write is an upsert, so redoing an epoch updates rows instead of duplicating them.
// Gap tracking: an RPC failure is written to epoch_status as FAILED (with the error code) and the
// run moves on to the next epoch. FAILED epochs are picked up again on the next run.

import { pool } from "./db";
import { setEpochStatus } from "./epoch-status";
import { RpcError } from "./rpc";
import { getInflationReward, InflationReward } from "./solana";

// Which epochs in [fromEpoch, toEpoch] still need work? Every epoch that isn't already
// COMPLETE or NO_REWARD. That includes FAILED ones, so each run retries them.
async function epochsToIndex(voteAccount: string, fromEpoch: number, toEpoch: number): Promise<number[]> {
  const result = await pool.query<{ epoch: number }>(
    `SELECT e.epoch
     FROM generate_series($2::int, $3::int) AS e(epoch)
     WHERE NOT EXISTS (
       SELECT 1
       FROM epoch_status s
       WHERE s.vote_account = $1
         AND s.epoch = e.epoch
         AND s.stream = 'STAKING'
         AND s.status IN ('COMPLETE', 'NO_REWARD')
     )
     ORDER BY e.epoch`,
    [voteAccount, fromEpoch, toEpoch]
  );
  return result.rows.map((row) => row.epoch);
}

// Upsert one reward row. ON CONFLICT targets the primary key (vote_account, epoch).
async function saveReward(voteAccount: string, reward: InflationReward): Promise<void> {
  await pool.query(
    `INSERT INTO staking_rewards
       (vote_account, epoch, amount_lamports, commission, effective_slot, post_balance_lamports, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (vote_account, epoch) DO UPDATE SET
       amount_lamports       = EXCLUDED.amount_lamports,
       commission            = EXCLUDED.commission,
       effective_slot        = EXCLUDED.effective_slot,
       post_balance_lamports = EXCLUDED.post_balance_lamports,
       fetched_at            = now()`,
    [voteAccount, reward.epoch, reward.amount, reward.commission, reward.effectiveSlot, reward.postBalance]
  );
}

export async function indexStakingRewards(voteAccount: string, fromEpoch: number, toEpoch: number): Promise<void> {
  const epochs = await epochsToIndex(voteAccount, fromEpoch, toEpoch);
  console.log(`Staking rewards: ${epochs.length} epoch(s) to index in ${fromEpoch}-${toEpoch}`);

  for (const epoch of epochs) {
    try {
      const reward = await getInflationReward(voteAccount, epoch);

      if (reward === null) {
        // No reward this epoch. A real answer, so record it, but never as a fake 0 reward.
        await setEpochStatus({ voteAccount, epoch, stream: "STAKING", status: "NO_REWARD", detail: "RPC returned no reward for this epoch" });
        console.log(`  epoch ${epoch}: no reward`);
      } else if (reward.epoch !== epoch) {
        // Don't trust data that doesn't match what we asked for.
        await setEpochStatus({ voteAccount, epoch, stream: "STAKING", status: "FAILED", detail: `asked for epoch ${epoch}, RPC answered for epoch ${reward.epoch}` });
        console.log(`  epoch ${epoch}: FAILED (epoch mismatch)`);
      } else {
        // Reward first, then status. If we crash in between, the epoch isn't marked COMPLETE,
        // so the next run simply redoes it, and the upsert overwrites the same row. No duplicates.
        await saveReward(voteAccount, reward);
        await setEpochStatus({ voteAccount, epoch, stream: "STAKING", status: "COMPLETE" });
        console.log(`  epoch ${epoch}: ${reward.amount} lamports (${(reward.amount / 1e9).toFixed(2)} SOL)`);
      }
    } catch (error) {
      // Only RPC failures become gap rows. Anything else (a bug, the database is down) should stop the run loudly.
      if (!(error instanceof RpcError)) throw error;
      await setEpochStatus({ voteAccount, epoch, stream: "STAKING", status: "FAILED", detail: error.message, errorCode: error.code ?? error.httpStatus });
      console.log(`  epoch ${epoch}: FAILED (${error.message}), will retry next run`);
    }
  }
}
