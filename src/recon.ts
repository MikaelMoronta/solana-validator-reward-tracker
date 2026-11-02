// 1. Constants for our Solana RPC endpoint and the assignment's suggested validator
const RPC_URL = "https://api.mainnet-beta.solana.com";
const VOTE_ACCOUNT = "FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX";
const IDENTITY_ACCOUNT = "AEHqTB2RtJjegsR2ePjvoJSm6AA5pnYKWVbcsn6kqTBD";

// 2. A simple helper function that sends a JSON-RPC POST request to Solana
async function callRpc(method: string, params: unknown[]) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: method,
      params: params,
    }),
  });

  // Convert the raw HTTP response into a JavaScript object
  const data = await response.json();
  return data;
}

// 3. Main function to test the 5 RPC methods from the assignment PDF
async function runRecon() {
  console.log("--- 1. Checking Current Epoch Info (getEpochInfo) ---");
  const epochInfo = await callRpc("getEpochInfo", []);
  console.log(JSON.stringify(epochInfo, null, 2));

  console.log("\n--- 2. Checking Staking Reward for Epoch 1000 (getInflationReward) ---");
  // Notice: getInflationReward takes an array of Vote Accounts, plus a config object with the epoch
  const stakingReward1000 = await callRpc("getInflationReward", [
    [VOTE_ACCOUNT],
    { epoch: 1000 },
  ]);
  console.log(JSON.stringify(stakingReward1000, null, 2));

  // Grab the latest COMPLETED epoch (current epoch minus 1)
  const currentEpoch: number = epochInfo.result.epoch;
  const latestCompletedEpoch = currentEpoch - 1;

  console.log(`\n--- 3. Checking Leader Schedule for Latest Completed Epoch ${latestCompletedEpoch} (getLeaderSchedule) ---`);
  // First slot of an epoch is always epoch * 432,000
  const epochStartSlot = latestCompletedEpoch * 432000;
  // Notice: getLeaderSchedule filters by the IDENTITY_ACCOUNT, not the Vote Account!
  const leaderSchedule = await callRpc("getLeaderSchedule", [
    epochStartSlot,
    { identity: IDENTITY_ACCOUNT },
  ]);

  const relativeSlots: number[] = leaderSchedule.result?.[IDENTITY_ACCOUNT] || [];
  console.log(`Validator was scheduled for ${relativeSlots.length} slots in epoch ${latestCompletedEpoch}.`);
  console.log("First 5 relative slot offsets:", relativeSlots.slice(0, 5));

  if (relativeSlots.length > 0) {
    // Convert the first relative slot offset into a global slot number
    const firstGlobalSlot = epochStartSlot + relativeSlots[0];
    console.log(`\n--- 4. Checking Block Rewards for Global Slot ${firstGlobalSlot} (getBlock) ---`);
    const blockData = await callRpc("getBlock", [
      firstGlobalSlot,
      {
        encoding: "json",
        transactionDetails: "none", // We only want block-level rewards, not 2,000 raw transactions!
        rewards: true,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    console.log(JSON.stringify(blockData, null, 2));
  }
}

// Execute our async function
runRecon().catch(console.error);