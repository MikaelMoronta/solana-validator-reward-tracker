// src/pipeline.ts: the entry point. Runs the whole indexing job for one validator.
//
// Run:  npm run pipeline
//   or: npm run pipeline -- --vote <vote account address> --from 1000 --to 1073
//   (all three are optional: default validator, from 1000, to the latest completed epoch)
//
// Safe to run again at any time (e.g. on a schedule): it only does unfinished work.

import { parseArgs } from "node:util";
import { pool } from "./db";
import { indexBlockFees } from "./fees";
import { getEpochInfo, getEpochSchedule, getVoteAccount } from "./solana";
import { indexStakingRewards } from "./staking";

const DEFAULT_VOTE_ACCOUNT = "FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX";
const DEFAULT_FROM_EPOCH = "1000";

async function main(): Promise<void> {
  // Read command-line options --vote, --from and --to (all optional).
  const { values } = parseArgs({
    options: {
      vote: { type: "string", default: DEFAULT_VOTE_ACCOUNT },
      from: { type: "string", default: DEFAULT_FROM_EPOCH },
      to: { type: "string" }, // no default: means "the latest completed epoch", which we only know once we ask the chain
    },
  });
  const voteAccount = values.vote;
  const fromEpoch = Number(values.from);
  if (!Number.isInteger(fromEpoch) || fromEpoch < 0) {
    throw new Error(`--from must be an epoch number, got "${values.from}"`);
  }
  const toEpoch = values.to === undefined ? undefined : Number(values.to);
  if (toEpoch !== undefined && (!Number.isInteger(toEpoch) || toEpoch < fromEpoch)) {
    throw new Error(`--to must be an epoch number >= --from, got "${values.to}"`);
  }

  // 0. Only one run per validator at a time. If a scheduled run starts while a long fee run is
  //    still going, two runs would fetch the same slots twice. Harmless (upserts), but wasteful.
  //    A Postgres "advisory lock" is a named lock held by one database connection. If this
  //    process dies, the connection closes and the lock is released automatically.
  const lockClient = await pool.connect(); // a dedicated connection that holds the lock for the whole run
  const lockName = `solana-tracker:${voteAccount}`;
  const lock = await lockClient.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockName]);
  if (!lock.rows[0].locked) {
    console.log("Another pipeline run for this validator is already in progress. Exiting.");
    lockClient.release();
    return;
  }

  try {
    await runPipeline(voteAccount, fromEpoch, toEpoch);
  } finally {
    // Release the lock even if the run failed.
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
    lockClient.release();
  }
}

async function runPipeline(voteAccount: string, fromEpoch: number, requestedTo: number | undefined): Promise<void> {
  // 1. Look up the validator on chain to get its identity account (used for block fees).
  const voteInfo = await getVoteAccount(voteAccount);
  if (voteInfo === null) {
    throw new Error(`Vote account ${voteAccount} not found on chain`);
  }
  await pool.query(
    `INSERT INTO validators (vote_account, identity_account)
     VALUES ($1, $2)
     ON CONFLICT (vote_account) DO UPDATE SET identity_account = EXCLUDED.identity_account`,
    [voteAccount, voteInfo.nodePubkey]
  );

  // 2. Only index COMPLETED epochs. The current one is still running, so its numbers would be partial.
  const epochInfo = await getEpochInfo();
  const latestCompleted = epochInfo.epoch - 1;
  // Never go past the latest completed epoch, even if --to asks for more.
  const toEpoch = Math.min(requestedTo ?? latestCompleted, latestCompleted);
  console.log(`Validator ${voteAccount}`);
  console.log(`Identity  ${voteInfo.nodePubkey}`);
  console.log(`Epochs    ${fromEpoch} to ${toEpoch} (current epoch ${epochInfo.epoch} is still in progress)`);
  if (requestedTo !== undefined && requestedTo > latestCompleted) {
    console.log(`          (--to ${requestedTo} isn't completed yet, so stopping at ${latestCompleted})`);
  }
  console.log("");
  if (fromEpoch > toEpoch) {
    console.log("Nothing to do: --from is after the latest completed epoch.");
    return;
  }

  // 3. Staking rewards.
  await indexStakingRewards(voteAccount, fromEpoch, toEpoch);

  // 4. Block fees. Needs the epoch schedule to turn "epoch N" into slot numbers.
  console.log("");
  const schedule = await getEpochSchedule();
  await indexBlockFees(schedule, voteAccount, voteInfo.nodePubkey, fromEpoch, toEpoch);
}

main()
  .catch((error) => {
    console.error("Pipeline stopped:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end()); // close database connections so the process can exit
