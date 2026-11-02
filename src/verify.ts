// src/verify.ts: cross-check stored numbers against data the pipeline did NOT use to produce them.
//
// Run:  npm run verify
//
// Check 1, STAKING: for sample epochs, re-read the reward straight from the block it was paid in
//   (getBlock at the effective slot, reward type "Voting") and compare with staking_rewards.
//   Same chain, different RPC method: catches bugs in how we fetched or stored rewards.
//
// Check 2, FEES: for each fee epoch, ask getBlockProduction how many slots the validator led and how
//   many blocks it produced. Solana answers that from its SlotHistory record (which slots got a block),
//   not from the block archive the pipeline read, so it independently confirms our SKIPPED vs produced
//   split. The node only keeps about 1M slots of history (~2.4 epochs), so older epochs can't be checked;
//   when the node refuses, the table shows its exact error.
//
// Check 3, EXPLORER (manual): prints Solscan links for sample blocks to compare by eye.

import { pool } from "./db";
import { callRpc, RpcError } from "./rpc";
import { firstSlotOfEpoch, getBlock, getEpochSchedule } from "./solana";

const DEFAULT_VOTE_ACCOUNT = "FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX";
const STAKING_SAMPLE_EPOCHS = [1000, 1019, 1020, 1053, 1064, 1065, 1066]; // plus the latest, added below

interface BlockProduction {
  value: { byIdentity: Record<string, [number, number]> }; // identity -> [leader slots, blocks produced]
}

async function checkStaking(vote: string): Promise<number> {
  console.log("\n=== Check 1: staking rewards vs. the payout block ===");
  const latest = await pool.query<{ max: number }>(`SELECT max(epoch) AS max FROM staking_rewards WHERE vote_account = $1`, [vote]);
  const epochs = [...STAKING_SAMPLE_EPOCHS, latest.rows[0].max];

  const rows = await pool.query<{ epoch: number; amount_lamports: string; effective_slot: string; post_balance_lamports: string }>(
    `SELECT epoch, amount_lamports, effective_slot, post_balance_lamports
     FROM staking_rewards
     WHERE vote_account = $1 AND epoch = ANY($2::int[])
     ORDER BY epoch`,
    [vote, epochs]
  );

  const results = [];
  let mismatches = 0;
  for (const row of rows.rows) {
    const block = await getBlock(Number(row.effective_slot), "none");
    const reward = block?.rewards?.find((r) => r.pubkey === vote && r.rewardType?.toLowerCase() === "voting");
    const fromBlock = reward ? String(reward.lamports) : "not found";
    const match = fromBlock === row.amount_lamports && String(reward?.postBalance) === row.post_balance_lamports;
    if (!match) mismatches++;
    results.push({ epoch: row.epoch, paid_in_slot: Number(row.effective_slot), stored_lamports: row.amount_lamports, block_lamports: fromBlock, match: match ? "YES" : "NO" });
  }
  console.table(results);
  return mismatches;
}

async function checkFees(vote: string, identity: string): Promise<number> {
  console.log("\n=== Check 2: block production vs. Solana's own slot history ===");
  const schedule = await getEpochSchedule();
  const ours = await pool.query<{ epoch: number; assigned: number; produced: number; skipped: number; unfinished: number }>(
    `SELECT epoch,
            count(*)::int                                                              AS assigned,
            (count(*) FILTER (WHERE status IN ('PRODUCED', 'EMPTY')))::int             AS produced,
            (count(*) FILTER (WHERE status = 'SKIPPED'))::int                          AS skipped,
            (count(*) FILTER (WHERE status IN ('PENDING', 'FAILED', 'ANOMALY')))::int  AS unfinished
     FROM leader_slots
     WHERE vote_account = $1
     GROUP BY epoch
     ORDER BY epoch DESC`,
    [vote]
  );

  const results = [];
  let mismatches = 0;
  for (const row of ours.rows) {
    const firstSlot = firstSlotOfEpoch(schedule, row.epoch);
    const lastSlot = firstSlot + schedule.slotsPerEpoch - 1;
    try {
      const production = await callRpc<BlockProduction>("getBlockProduction", [
        { identity, range: { firstSlot, lastSlot }, commitment: "finalized" },
      ]);
      const [leaderSlots, blocksProduced] = production.value.byIdentity[identity] ?? [0, 0];
      const scheduleMatches = leaderSlots === row.assigned;
      const finished = row.unfinished === 0;
      const productionMatches = blocksProduced === row.produced && leaderSlots - blocksProduced === row.skipped;
      let verdict: string;
      if (!scheduleMatches) verdict = "MISMATCH (leader slots)";
      else if (!finished) verdict = "schedule OK; fees still being indexed";
      else verdict = productionMatches ? "MATCH" : "MISMATCH (produced/skipped)";
      if (verdict.startsWith("MISMATCH")) mismatches++;
      results.push({ epoch: row.epoch, our_slots: row.assigned, chain_slots: leaderSlots, our_produced: row.produced, chain_produced: blocksProduced, our_skipped: row.skipped, chain_skipped: leaderSlots - blocksProduced, verdict });
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      // Show the node's actual answer instead of guessing why it refused.
      results.push({ epoch: row.epoch, our_slots: row.assigned, chain_slots: null, our_produced: row.produced, chain_produced: null, our_skipped: row.skipped, chain_skipped: null, verdict: `can't check: RPC error ${error.code ?? error.httpStatus}: ${error.message}` });
    }
  }
  console.table(results);
  return mismatches;
}

async function printExplorerSamples(vote: string): Promise<void> {
  console.log("\n=== Check 3 (manual): compare these blocks on Solscan ===");
  console.log("Open each link. PRODUCED/EMPTY: the block's Rewards tab should show the same Fee amount to the identity account. SKIPPED: Solscan should say the slot was skipped.\n");
  // A few of each outcome, picked at random from all indexed slots, so each run shows fresh examples.
  const sample = await pool.query<{ epoch: number; slot: string; status: string; fee_lamports: string | null }>(
    `(SELECT epoch, slot, status, fee_lamports FROM leader_slots WHERE vote_account = $1 AND status = 'PRODUCED' ORDER BY random() LIMIT 4)
     UNION ALL
     (SELECT epoch, slot, status, fee_lamports FROM leader_slots WHERE vote_account = $1 AND status = 'EMPTY'    ORDER BY random() LIMIT 1)
     UNION ALL
     (SELECT epoch, slot, status, fee_lamports FROM leader_slots WHERE vote_account = $1 AND status = 'SKIPPED'  ORDER BY random() LIMIT 1)`,
    [vote]
  );
  console.table(
    sample.rows.map((r) => ({
      epoch: r.epoch,
      slot: Number(r.slot),
      status: r.status,
      our_fee_lamports: r.fee_lamports,
      solscan: `https://solscan.io/block/${r.slot}`,
    }))
  );
}

async function main(): Promise<void> {
  const vote = process.argv[2] ?? DEFAULT_VOTE_ACCOUNT;
  const validator = await pool.query<{ identity_account: string }>(`SELECT identity_account FROM validators WHERE vote_account = $1`, [vote]);
  if (validator.rows.length === 0) throw new Error(`Validator ${vote} not in the database. Run the pipeline first.`);
  const identity = validator.rows[0].identity_account;

  const stakingMismatches = await checkStaking(vote);
  const feeMismatches = await checkFees(vote, identity);
  await printExplorerSamples(vote);

  console.log(`\nResult: ${stakingMismatches} staking mismatch(es), ${feeMismatches} block-production mismatch(es).`);
}

main()
  .catch((error) => {
    console.error("Verification stopped:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
