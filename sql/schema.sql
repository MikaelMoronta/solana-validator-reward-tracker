-- =====================================================================
-- schema.sql: database tables for the Solana validator reward tracker
--
-- How to run: pgAdmin -> solana_tracker database -> Query Tool ->
-- open this file (folder icon) or paste it in -> press F5.
-- Safe to re-run: IF NOT EXISTS / OR REPLACE skip anything that already exists.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. validators: one row per validator we track.
-- A validator has two accounts:
--   vote account     -> receives staking rewards (once per epoch)
--   identity account -> produces blocks and receives block fees
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS validators (
    vote_account      TEXT        PRIMARY KEY,
    identity_account  TEXT        NOT NULL,
    added_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 2. staking_rewards: one row per validator per epoch.
-- Filled from getInflationReward. The reward EARNED in epoch N is PAID at
-- the first slot of epoch N+1 (that's effective_slot).
--
-- Primary key (vote_account, epoch): there can only be one reward per
-- validator per epoch. It's also what the upsert's ON CONFLICT checks, so
-- re-running the pipeline updates the row instead of duplicating it.
--
-- If the RPC says "no reward" (null) for an epoch, we do NOT insert a fake 0
-- here. That fact goes in epoch_status (status = 'NO_REWARD').
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staking_rewards (
    vote_account          TEXT        NOT NULL REFERENCES validators (vote_account),
    epoch                 INTEGER     NOT NULL,
    amount_lamports       BIGINT      NOT NULL CHECK (amount_lamports >= 0),  -- 1 SOL = 1,000,000,000 lamports
    commission            SMALLINT,                -- percent (0-100) as reported by RPC; can be missing
    effective_slot        BIGINT      NOT NULL,    -- slot where the reward was paid
    post_balance_lamports BIGINT      NOT NULL,    -- vote account balance right after the payout
    fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vote_account, epoch)
);


-- ---------------------------------------------------------------------
-- 3. leader_slots: one row per validator per assigned slot.
-- Step 1: getLeaderSchedule says which slots the validator was assigned.
--         We save them right away as 'PENDING'. The RPC forgets schedules
--         after about a week, so this table IS our saved copy.
-- Step 2: getBlock fetches each slot, and the row gets its final status:
--
--   PENDING   saved from the schedule, not fetched yet
--   PRODUCED  block exists and has a Fee reward to our identity account
--   EMPTY     block exists, no Fee reward, re-checked: 0 transactions -> fee is truly 0
--   SKIPPED   validator didn't produce a block in this slot -> fee is 0 (not a gap)
--   ANOMALY   transactions but no Fee reward, or the fee went to another account -> a gap to investigate
--   FAILED    couldn't fetch after retries (rate limits, missing data) -> a gap, retried next run
--
-- Fee totals per epoch are calculated with SUM over this table, never
-- stored separately, so there is one source of truth.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leader_slots (
    vote_account     TEXT        NOT NULL REFERENCES validators (vote_account),
    slot             BIGINT      NOT NULL,
    epoch            INTEGER     NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'PRODUCED', 'EMPTY', 'SKIPPED', 'ANOMALY', 'FAILED')),
    fee_lamports     BIGINT      CHECK (fee_lamports >= 0),  -- NULL until known; 0 for EMPTY and SKIPPED
    tx_count         INTEGER,                    -- only filled when we re-check an empty block
    error_code       INTEGER,                    -- JSON-RPC error code (e.g. -32007) or HTTP status (e.g. 429)
    error_message    TEXT,
    attempts         INTEGER     NOT NULL DEFAULT 0,
    last_attempt_at  TIMESTAMPTZ,
    PRIMARY KEY (vote_account, slot),

    -- Statuses that mean "we know the fee" must actually have a fee amount (0 counts).
    CONSTRAINT fee_known_when_final
        CHECK (status NOT IN ('PRODUCED', 'EMPTY', 'SKIPPED') OR fee_lamports IS NOT NULL)
);

-- Speeds up "all slots for this validator in epoch X" (fee totals, progress checks).
CREATE INDEX IF NOT EXISTS leader_slots_epoch_idx ON leader_slots (vote_account, epoch);


-- ---------------------------------------------------------------------
-- 4. epoch_status: one row per validator per epoch per stream.
-- Tracks progress, and records whole-epoch gaps with the reason.
--
--   stream = 'STAKING'
--     COMPLETE        reward stored in staking_rewards
--     NO_REWARD       RPC returned null: no reward this epoch (an answer, not an error)
--     FAILED          couldn't fetch after retries -> retried next run
--
--   stream = 'FEES'
--     SCHEDULE_SAVED  leader slots saved to leader_slots (per-slot progress lives there)
--     UNAVAILABLE     RPC no longer has this epoch's leader schedule -> permanent gap
--     FAILED          couldn't fetch the schedule after retries -> retried next run
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epoch_status (
    vote_account       TEXT        NOT NULL REFERENCES validators (vote_account),
    epoch              INTEGER     NOT NULL,
    stream             TEXT        NOT NULL CHECK (stream IN ('STAKING', 'FEES')),
    status             TEXT        NOT NULL
                       CHECK (status IN ('COMPLETE', 'NO_REWARD', 'SCHEDULE_SAVED', 'UNAVAILABLE', 'FAILED')),
    leader_slot_count  INTEGER,                  -- FEES only: how many slots the schedule assigned
    detail             TEXT,                     -- plain-English reason, e.g. 'leader schedule not available from RPC'
    error_code         INTEGER,
    attempts           INTEGER     NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vote_account, epoch, stream)
);


-- ---------------------------------------------------------------------
-- 5. index_gaps (a view): everything we couldn't index, and why, in one place.
-- Usage: SELECT * FROM index_gaps;
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW index_gaps AS
SELECT vote_account, epoch, NULL::BIGINT AS slot, stream, status, error_code, detail AS reason, attempts
FROM epoch_status
WHERE status IN ('UNAVAILABLE', 'FAILED')
UNION ALL
SELECT vote_account, epoch, slot, 'FEES' AS stream, status, error_code, error_message AS reason, attempts
FROM leader_slots
WHERE status IN ('ANOMALY', 'FAILED');
