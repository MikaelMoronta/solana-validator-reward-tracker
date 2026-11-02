// src/epoch-status.ts: record progress and whole-epoch gaps in the epoch_status table.
// Shared by the staking and fee pipelines.

import { pool } from "./db";

// These mirror the CHECK constraints in schema.sql, so TypeScript catches a typo
// like "COMPLETED" before the database ever sees it.
export type Stream = "STAKING" | "FEES";
export type EpochStatus = "COMPLETE" | "NO_REWARD" | "SCHEDULE_SAVED" | "UNAVAILABLE" | "FAILED";

export interface EpochStatusUpdate {
  voteAccount: string;
  epoch: number;
  stream: Stream;
  status: EpochStatus;
  detail?: string | null;
  errorCode?: number | null;
  leaderSlotCount?: number | null;
}

// Upsert: first time, insert the row. After that, update it in place and count the attempt.
export async function setEpochStatus(update: EpochStatusUpdate): Promise<void> {
  await pool.query(
    `INSERT INTO epoch_status (vote_account, epoch, stream, status, detail, error_code, leader_slot_count, attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now())
     ON CONFLICT (vote_account, epoch, stream) DO UPDATE SET
       status            = EXCLUDED.status,
       detail            = EXCLUDED.detail,
       error_code        = EXCLUDED.error_code,
       leader_slot_count = COALESCE(EXCLUDED.leader_slot_count, epoch_status.leader_slot_count),
       attempts          = epoch_status.attempts + 1,
       updated_at        = now()`,
    [
      update.voteAccount,
      update.epoch,
      update.stream,
      update.status,
      update.detail ?? null,
      update.errorCode ?? null,
      update.leaderSlotCount ?? null,
    ]
  );
}
