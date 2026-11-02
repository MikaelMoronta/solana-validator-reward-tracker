// src/queries.ts: every SQL query the API runs, in one place.
// The API (api.ts) only calls these functions; it never writes SQL itself.

import { pool } from "./db";

// One row per epoch, joining everything we know about it.
// BIGINT and NUMERIC columns arrive as strings (pg's precision safety), counts are cast to int.
export interface EpochRow {
  epoch: number;
  staking_status: string | null;      // COMPLETE / NO_REWARD / FAILED, or null = not indexed yet
  staking_lamports: string | null;
  commission: number | null;
  fees_status: string | null;         // SCHEDULE_SAVED / UNAVAILABLE / FAILED, or null = not indexed yet
  leader_slots: number | null;
  produced: number | null;
  empty: number | null;
  skipped: number | null;
  gaps: number | null;
  pending: number | null;
  fee_lamports: string | null;
}

export async function listValidators(): Promise<{ vote_account: string; identity_account: string; added_at: Date }[]> {
  const result = await pool.query(`SELECT vote_account, identity_account, added_at FROM validators ORDER BY added_at`);
  return result.rows;
}

export async function validatorExists(voteAccount: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM validators WHERE vote_account = $1`, [voteAccount]);
  return result.rows.length > 0;
}

// The epoch range we have any data for. Used when the caller doesn't pass ?from / ?to.
export async function indexedEpochRange(voteAccount: string): Promise<{ min: number | null; max: number | null }> {
  const result = await pool.query<{ min: number | null; max: number | null }>(
    `SELECT min(epoch) AS min, max(epoch) AS max FROM epoch_status WHERE vote_account = $1`,
    [voteAccount]
  );
  return result.rows[0];
}

export async function epochRows(voteAccount: string, fromEpoch: number, toEpoch: number): Promise<EpochRow[]> {
  const result = await pool.query<EpochRow>(
    `WITH epochs AS (
       -- every epoch in the range, even ones we haven't indexed (they show up with null statuses)
       SELECT generate_series($2::int, $3::int) AS epoch
     ),
     fees AS (
       -- per-epoch fee totals, calculated from the slot rows (never stored separately)
       SELECT epoch,
              count(*)::int                                                  AS leader_slots,
              (count(*) FILTER (WHERE status = 'PRODUCED'))::int             AS produced,
              (count(*) FILTER (WHERE status = 'EMPTY'))::int                AS empty,
              (count(*) FILTER (WHERE status = 'SKIPPED'))::int              AS skipped,
              (count(*) FILTER (WHERE status IN ('ANOMALY', 'FAILED')))::int AS gaps,
              (count(*) FILTER (WHERE status = 'PENDING'))::int              AS pending,
              sum(fee_lamports)                                              AS fee_lamports
       FROM leader_slots
       WHERE vote_account = $1 AND epoch BETWEEN $2 AND $3
       GROUP BY epoch
     )
     SELECT e.epoch,
            ss.status          AS staking_status,
            sr.amount_lamports AS staking_lamports,
            sr.commission,
            fs.status          AS fees_status,
            -- an epoch whose schedule had 0 slots has no fee rows: that's 0 slots and 0 fees, not "unknown"
            CASE WHEN fs.status = 'SCHEDULE_SAVED' THEN coalesce(f.leader_slots, 0) END AS leader_slots,
            f.produced, f.empty, f.skipped, f.gaps, f.pending,
            CASE WHEN fs.status = 'SCHEDULE_SAVED' THEN coalesce(f.fee_lamports, 0) END AS fee_lamports
     FROM epochs e
     LEFT JOIN epoch_status    ss ON ss.vote_account = $1 AND ss.epoch = e.epoch AND ss.stream = 'STAKING'
     LEFT JOIN staking_rewards sr ON sr.vote_account = $1 AND sr.epoch = e.epoch
     LEFT JOIN epoch_status    fs ON fs.vote_account = $1 AND fs.epoch = e.epoch AND fs.stream = 'FEES'
     LEFT JOIN fees            f  ON f.epoch = e.epoch
     ORDER BY e.epoch`,
    [voteAccount, fromEpoch, toEpoch]
  );
  return result.rows;
}

export async function gapRows(voteAccount: string, fromEpoch: number, toEpoch: number, limit: number) {
  const result = await pool.query(
    `SELECT epoch, slot, stream, status, error_code, reason, attempts
     FROM index_gaps
     WHERE vote_account = $1 AND epoch BETWEEN $2 AND $3
     ORDER BY epoch DESC, slot
     LIMIT $4`,
    [voteAccount, fromEpoch, toEpoch, limit]
  );
  return result.rows;
}
