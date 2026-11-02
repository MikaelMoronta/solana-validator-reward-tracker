// src/solana.ts: WHAT we ask Solana. Typed wrappers around the RPC methods the pipeline uses.
// rpc.ts handles the transport (pacing, retries); this file knows what each method returns.
//
// Note on numbers: JSON numbers become JavaScript numbers, which are exact up to
// 9,007,199,254,740,991. In lamports that's ~9 million SOL, far above any single
// reward or balance we read, so plain `number` is safe here.

import { callRpc, RpcCode, RpcError } from "./rpc";

// ---------- Shapes of the responses we use (only the fields we need) ----------

export interface EpochInfo {
  epoch: number;        // the CURRENT epoch (still in progress)
  slotIndex: number;    // how far into the current epoch we are
  slotsInEpoch: number;
  absoluteSlot: number;
}

export interface EpochSchedule {
  slotsPerEpoch: number;     // 432,000 on mainnet
  firstNormalEpoch: number;  // 0 on mainnet
  firstNormalSlot: number;   // 0 on mainnet
}

export interface InflationReward {
  epoch: number;
  effectiveSlot: number;      // slot where it was paid (first slot of the next epoch)
  amount: number;             // lamports
  postBalance: number;        // lamports, vote account balance after the payout
  commission: number | null;  // percent; may be missing
}

export interface BlockReward {
  pubkey: string;             // account that received it
  lamports: number;
  postBalance: number;
  rewardType: string | null;  // "Fee", "Rent", "Staking", "Voting"
}

export interface Block {
  blockHeight: number | null;
  blockTime: number | null;   // Unix timestamp (seconds)
  rewards?: BlockReward[];    // present because we ask for rewards: true
  signatures?: string[];      // present only with transactionDetails: "signatures"
}

export interface VoteAccountInfo {
  votePubkey: string;      // the vote account
  nodePubkey: string;      // its identity account (the one that produces blocks)
  commission: number;
  activatedStake: number;  // lamports
}

// ---------- The calls ----------

// Look up a vote account on chain. Gives us its identity account, so we don't hard-code it.
// null = no such vote account.
export async function getVoteAccount(voteAccount: string): Promise<VoteAccountInfo | null> {
  const result = await callRpc<{ current: VoteAccountInfo[]; delinquent: VoteAccountInfo[] }>("getVoteAccounts", [
    { votePubkey: voteAccount, commitment: "finalized" },
  ]);
  // "current" = voting normally; "delinquent" = has fallen behind. Either way, it's our validator.
  return [...result.current, ...result.delinquent][0] ?? null;
}

export function getEpochInfo(): Promise<EpochInfo> {
  return callRpc<EpochInfo>("getEpochInfo", [{ commitment: "finalized" }]);
}

// Read slots-per-epoch from the chain instead of hard-coding 432,000.
export function getEpochSchedule(): Promise<EpochSchedule> {
  return callRpc<EpochSchedule>("getEpochSchedule");
}

// The first slot of an epoch, e.g. epoch 1073 -> 463,536,000 on mainnet.
export function firstSlotOfEpoch(schedule: EpochSchedule, epoch: number): number {
  return schedule.firstNormalSlot + (epoch - schedule.firstNormalEpoch) * schedule.slotsPerEpoch;
}

// The reward paid to one vote account for one epoch.
// null = no reward for that epoch. That's an answer, not an error.
export async function getInflationReward(voteAccount: string, epoch: number): Promise<InflationReward | null> {
  const results = await callRpc<(InflationReward | null)[]>("getInflationReward", [
    [voteAccount], // the method takes a LIST of addresses; we send one
    { epoch, commitment: "finalized" },
  ]);
  return results[0] ?? null;
}

// The absolute slot numbers `identity` was scheduled to lead in `epoch`.
//   []   = the validator had no slots that epoch
//   null = the node no longer has that epoch's schedule (a gap: fee data unavailable)
export async function getLeaderSlots(schedule: EpochSchedule, identity: string, epoch: number): Promise<number[] | null> {
  const epochStart = firstSlotOfEpoch(schedule, epoch);
  try {
    const result = await callRpc<Record<string, number[]> | null>("getLeaderSchedule", [
      epochStart,
      { identity, commitment: "finalized" },
    ]);
    if (result === null) return null;
    // The node returns offsets from the start of the epoch; convert to absolute slots.
    const offsets = result[identity] ?? [];
    return offsets.map((offset) => epochStart + offset);
  } catch (error) {
    // Handled defensively: newer node versions define error -32022 ("leader schedule identity not found").
    // Not observed in this run; if it ever appears, it means this validator had no slots that epoch.
    if (error instanceof RpcError && error.code === RpcCode.LEADER_SCHEDULE_IDENTITY_NOT_FOUND) return [];
    throw error;
  }
}

// One block. "none" = lightweight (rewards only, ~300 bytes); "signatures" = also lists the
// transactions, which we use to double-check blocks that came back with no Fee reward (see
// classifyBlock in fees.ts).
export function getBlock(slot: number, details: "none" | "signatures"): Promise<Block | null> {
  return callRpc<Block | null>("getBlock", [
    slot,
    {
      encoding: "json",
      transactionDetails: details,
      rewards: true,
      maxSupportedTransactionVersion: 0,
      commitment: "finalized",
    },
  ]);
}

// Did this error mean "no block was produced in this slot"? (fee = 0, not a gap)
export function isSkippedSlot(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    (error.code === RpcCode.SLOT_SKIPPED || error.code === RpcCode.LONG_TERM_STORAGE_SLOT_SKIPPED)
  );
}
