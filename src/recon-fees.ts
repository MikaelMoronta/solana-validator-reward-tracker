// src/recon-fees.ts: exploration script I ran before designing the schema.
// Its output is saved in docs/recon-2026-11-01.txt.
//
// Questions it answers before we design fee extraction:
//   A) The first block I fetched (slot 462674208) had `rewards: []`. Did it have transactions at all?
//   B) Is that a pattern across our validator's blocks in the latest completed epoch?
//   C) Do OTHER validators' blocks have Fee rewards? Before Alpenglow (epoch 1063) vs. now?
//   D) How far back does getLeaderSchedule still answer? (= how far back fee indexing can go)
//
// Run:  npx tsx src/recon-fees.ts

const RPC_URL = "https://api.mainnet-beta.solana.com";
const IDENTITY = "AEHqTB2RtJjegsR2ePjvoJSm6AA5pnYKWVbcsn6kqTBD";
const VOTE = "FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX";
const SLOTS_PER_EPOCH = 432000;

// The error code from the most recent failed call (a shortcut for this script; src/rpc.ts returns errors properly).
let lastErrorCode: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One JSON-RPC call. Returns `result`, or null on failure (and prints why).
// If the public node rate-limits us (HTTP 429), wait a bit longer each time and retry.
async function callRpc(method: string, params: unknown[]): Promise<any> {
  lastErrorCode = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
    });
    await sleep(350); // stay polite to the public endpoint

    // Failure layer 1: the HTTP request itself was refused.
    if (response.status === 429) {
      console.log(`  (rate limited on ${method}, waiting ${attempt * 2}s)`);
      await sleep(attempt * 2000);
      continue;
    }
    if (!response.ok) {
      console.log(`  HTTP ${response.status} from ${method}`);
      return null;
    }

    // Failure layer 2: HTTP was fine, but Solana put an error inside the JSON.
    const data: any = await response.json();
    if (data.error) {
      lastErrorCode = data.error.code;
      console.log(`  RPC error from ${method}: ${data.error.code} ${data.error.message}`);
      return null;
    }
    return data.result;
  }
  console.log(`  gave up on ${method} after repeated 429s`);
  return null;
}

// Short label for an account, so the output is readable.
function who(pubkey: string): string {
  if (pubkey === IDENTITY) return "OUR IDENTITY";
  if (pubkey === VOTE) return "OUR VOTE ACCT";
  return pubkey.slice(0, 6) + "...";
}

// Our validator's leader slots in `epoch`, as absolute slot numbers.
// [] = it had no slots. null = the node no longer has that epoch's schedule (a gap).
async function getLeaderSlots(epoch: number): Promise<number[] | null> {
  const epochStart = epoch * SLOTS_PER_EPOCH;
  const schedule = await callRpc("getLeaderSchedule", [epochStart, { identity: IDENTITY }]);
  if (schedule === null) return null;
  const offsets: number[] = schedule[IDENTITY] ?? [];
  return offsets.map((offset) => epochStart + offset);
}

// Fetch one block WITH transaction signatures and print a one-line summary.
async function inspectBlock(slot: number): Promise<void> {
  const config = { encoding: "json", transactionDetails: "signatures", rewards: true, maxSupportedTransactionVersion: 0 };
  let block = await callRpc("getBlock", [slot, config]);

  // -32015 = block has a transaction newer than the version we said we support. Retry once with version 1.
  if (block === null && lastErrorCode === -32015) {
    console.log("  (retrying with maxSupportedTransactionVersion: 1)");
    block = await callRpc("getBlock", [slot, { ...config, maxSupportedTransactionVersion: 1 }]);
  }
  if (block === null) return; // callRpc already printed why (skipped slot, pruned, etc.)

  const txCount = block.signatures?.length ?? 0;
  const rewards: any[] = block.rewards ?? [];

  // Count rewards by type, e.g. "Fee x1, Staking x2400".
  const counts: Record<string, number> = {};
  for (const r of rewards) counts[r.rewardType] = (counts[r.rewardType] ?? 0) + 1;
  const typeSummary = Object.entries(counts).map(([type, n]) => `${type} x${n}`).join(", ") || "none";

  // Every Fee reward in the block: how much, and to whom.
  const fees = rewards.filter((r) => String(r.rewardType).toLowerCase() === "fee");
  const feeSummary = fees.map((r) => `${r.lamports} lamports -> ${who(r.pubkey)}`).join("; ") || "none";

  console.log(`  slot ${slot}: ${txCount} txs | rewards: ${typeSummary} | Fee: ${feeSummary}`);
}

// Inspect `count` of OUR blocks, spread evenly across `epoch`.
async function sampleOurBlocks(epoch: number, count: number): Promise<void> {
  const slots = await getLeaderSlots(epoch);
  if (slots === null || slots.length === 0) {
    console.log(`  No leader slots available for epoch ${epoch}, skipping.`);
    return;
  }
  const step = Math.max(1, Math.floor(slots.length / count));
  for (let i = 0; i < count && i * step < slots.length; i++) {
    await inspectBlock(slots[i * step]);
  }
}

// Inspect `count` blocks from ANY validator, spread evenly across `epoch`.
// Doesn't need the leader schedule, so it works for older epochs too.
async function sampleAnyBlocks(epoch: number, count: number): Promise<void> {
  const epochStart = epoch * SLOTS_PER_EPOCH;
  const gap = Math.floor(SLOTS_PER_EPOCH / count);
  for (let i = 0; i < count; i++) {
    const startSlot = epochStart + i * gap + 1000;
    const found = await callRpc("getBlocksWithLimit", [startSlot, 1]); // first real block at/after startSlot
    if (found === null || found.length === 0) {
      console.log(`  no block found near slot ${startSlot}`);
      continue;
    }
    await inspectBlock(found[0]);
  }
}

async function main(): Promise<void> {
  const epochInfo = await callRpc("getEpochInfo", []);
  if (epochInfo === null) return;
  const latest = epochInfo.epoch - 1;
  console.log(`Current epoch ${epochInfo.epoch} (slotsInEpoch = ${epochInfo.slotsInEpoch}); latest completed = ${latest}`);

  const firstAvailable = await callRpc("getFirstAvailableBlock", []);
  if (firstAvailable !== null) {
    console.log(`Node's first available block: ${firstAvailable} (epoch ${Math.floor(firstAvailable / SLOTS_PER_EPOCH)})`);
  }

  console.log("\n=== D) Which epochs still have a leader schedule? ===");
  const candidates = [latest, latest - 1, latest - 2, latest - 3, latest - 5, latest - 10, 1064, 1063, 1050, 1000];
  const epochsToTest = Array.from(new Set(candidates)); // drop duplicates
  for (const epoch of epochsToTest) {
    const slots = await getLeaderSlots(epoch);
    console.log(`  epoch ${epoch}: ${slots === null ? "NOT AVAILABLE" : slots.length + " leader slots"}`);
  }

  console.log("\n=== A) Friday's empty block, re-fetched with signatures ===");
  await inspectBlock(462674208);

  console.log(`\n=== B) 15 of OUR blocks from epoch ${latest} ===`);
  await sampleOurBlocks(latest, 15);

  console.log(`\n=== C1) 5 blocks from ANY validator, epoch ${latest} (after Alpenglow) ===`);
  await sampleAnyBlocks(latest, 5);

  console.log("\n=== C2) 5 blocks from ANY validator, epoch 1063 (before Alpenglow) ===");
  await sampleAnyBlocks(1063, 5);

  console.log("\nDone.");
}

main().catch(console.error);
