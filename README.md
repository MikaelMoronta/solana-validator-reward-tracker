# Solana Validator Reward Tracker

A TypeScript pipeline that tracks what one Solana validator earns each epoch, in **staking rewards** and **block fees**, stores it in **PostgreSQL**, and serves it through a small **REST API**.

It is safe to re-run at any time (for example on a schedule), recovers from interruptions, and records everything it could *not* index, and why, in the database.

Default validator (from the assignment):

| | |
|---|---|
| Vote account | `FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX` |
| Identity account | `AEHqTB2RtJjegsR2ePjvoJSm6AA5pnYKWVbcsn6kqTBD` |

## Results at a glance (as of 2026-11-02)

| | Coverage | Result |
|---|---|---|
| Staking rewards | Epochs 1000–1074, **75 of 75**, 0 gaps | **32,988.26 SOL** total, avg 439.84 SOL/epoch, commission 100% (see [finding 5](#what-i-found-surprises-and-how-i-handled-them)) |
| Block fees | Epochs **1066–1074** (18,808 leader slots). 1000–1065 are `UNAVAILABLE`: the RPC no longer serves their leader schedules | **Complete for all 9 epochs: 156.16 SOL**, 0 gaps. 18,772 blocks produced, 9 empty, 27 skipped (skip rate 0.14%) |
| Verification | 8 of 8 sampled staking epochs match the payout blocks; 5 of 5 block-fee spot checks match Solscan | See [How I checked the numbers](#how-i-checked-the-numbers) |

---

## Setup and running

### Prerequisites

- **Node.js 20+** (uses built-in `fetch`, `AbortSignal.timeout`, `util.parseArgs`)
- **PostgreSQL 14+** (developed on PostgreSQL 18)
- Git

### 1. Install

```bash
git clone <this repo>
cd solana-validator-reward-tracker
npm install
```

### 2. Create the database

```bash
createdb -U postgres solana_tracker
psql -U postgres -d solana_tracker -f sql/schema.sql
```

Or in **pgAdmin**: create a database named `solana_tracker`, open the **Query Tool** on it, open `sql/schema.sql`, and press **F5**. The schema file is safe to run more than once.

### 3. Configure

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env` and set `PGPASSWORD` (and the other `PG*` values if your Postgres isn't the default `localhost:5432` / `postgres`). `.env` is git-ignored.

Optional settings in `.env`:

| Setting | Default | Notes |
|---|---|---|
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | The free public endpoint is heavily rate-limited (see [What I found](#what-i-found-surprises-and-how-i-handled-them)). A provider URL with an API key, e.g. `https://mainnet.helius-rpc.com/?api-key=...`, should be much faster (not tested). |
| `RPC_GAP_MS` | `2000` | Minimum milliseconds between requests. 2 seconds suits the public endpoint (measured). With a provider, set it to whatever its rate limit allows. |
| `API_PORT` | `3000` | |

### 4. Run the pipeline

```bash
npm run pipeline        # default validator, epoch 1000 -> latest completed
npm run pipeline -- --vote FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX --from 1070 --to 1073
```

All options are optional; the bare `--` passes them through npm to the script. `--to` is capped at the latest **completed** epoch, since the current epoch's numbers would be partial.

What to expect:

- **Staking rewards:** about a minute (one request per epoch).
- **Block fees, phase A:** about a minute; saves the leader schedule (the validator's assigned slots) for every epoch where the RPC still has it.
- **Block fees, phase B:** one request per assigned slot, about 2,000 per epoch. On the public endpoint this is roughly **1–1.5 hours per epoch**; a provider with a higher rate limit should be much faster (not tested). Progress and an estimate are printed every 50 slots. Newest epochs go first.

**It is safe to stop at any time** (Ctrl+C, crash, the PC going to sleep). Run the same command again and it continues where it left off. Re-running when everything is done does nothing.

### 5. Run the API

```bash
npm run api          # http://localhost:3000
```

Open an endpoint in your browser by adding its path to that address, e.g. http://localhost:3000/health (the bare address has no page). All endpoints are listed under [API](#api).

The API only reads from the database, so it can run while the pipeline is still working.

### 6. Verify the numbers

```bash
npm run verify
```

See [How I checked the numbers](#how-i-checked-the-numbers).

### 7. Type-check

```bash
npm run typecheck    # tsx runs TypeScript without checking types; this is the real check
```

### Running on a schedule

The pipeline is designed to run repeatedly. Each run only does unfinished work: new epochs, `FAILED` epochs and slots, and any slots not yet fetched. This matters most for block fees: leader schedules disappear after about a week, so fee history can only be built by running regularly. An epoch now lasts about a day, so a daily run is enough.

Example cron entry, daily at 06:00 (an example only, not set up or tested here; cron may need the full path to `npm`):

```cron
0 6 * * * cd /path/to/solana-validator-reward-tracker && npm run pipeline >> pipeline.log 2>&1
```

If a run starts while another is still working on the same validator, it prints *"Another pipeline run for this validator is already in progress. Exiting."* (decision 9, the run lock).

---

## API

| Endpoint | What it returns |
|---|---|
| `GET /health` | API is up and can reach the database |
| `GET /validators` | Validators that have been indexed |
| `GET /validators/:vote/epochs?from=&to=` | Rewards **per epoch** over a range: staking reward, fee totals, block production counts, status of each |
| `GET /validators/:vote/summary?from=&to=` | **Summary** over a range: totals, average, best/worst epoch, fee coverage, skip rate |
| `GET /validators/:vote/gaps?from=&to=&limit=` | Everything that couldn't be indexed, and why |

`from` / `to` are optional; the default is every epoch that has been indexed.

Example: `http://localhost:3000/validators/FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX/epochs?from=1072&to=1073`

```json
{
  "voteAccount": "FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX",
  "from": 1072, "to": 1073,
  "epochs": [
    {
      "epoch": 1072,
      "staking": { "status": "COMPLETE", "lamports": "291993266572", "sol": 291.993266572, "commission": null },
      "fees": {
        "status": "COMPLETE", "lamports": "15034624956", "sol": 15.034624956,
        "leaderSlots": 1984, "produced": 1980, "empty": 1, "skipped": 3, "gaps": 0, "pending": 0
      },
      "total": { "lamports": "307027891528", "sol": 307.027891528 }
    },
    {
      "epoch": 1073,
      "staking": { "status": "COMPLETE", "lamports": "300325777915", "sol": 300.325777915, "commission": null },
      "fees": {
        "status": "COMPLETE", "lamports": "14486297794", "sol": 14.486297794,
        "leaderSlots": 2088, "produced": 2084, "empty": 1, "skipped": 3, "gaps": 0, "pending": 0
      },
      "total": { "lamports": "314812075709", "sol": 314.812075709 }
    }
  ]
}
```

`fees.status` can also be `IN_PROGRESS`, `PARTIAL`, `UNAVAILABLE`, `FAILED` or `NOT_INDEXED`. `commission` is `null` because the RPC no longer returns it ([finding 5](#what-i-found-surprises-and-how-i-handled-them)).

Conventions:

- **Lamports are strings** (`"300325777915"`), so they're exact, with no precision loss. A `sol` number is included for reading convenience. Sums are done with JavaScript `BigInt`.
- **Unknown is `null`, never `0`.** An epoch's `total` only appears when both staking and fees are complete. Fee totals in `/summary` only include epochs whose fee data is `COMPLETE`.
- Errors return JSON with a status code: `400` for bad parameters (e.g. `to < from`, invalid address), `404` for a validator that hasn't been indexed.

---

## How Solana staking rewards work

Solana is a decentralized network. Since it's decentralized, it depends on many independent servers to run the network and validate transactions. These servers are called validators. On the Solana network, time is measured in epochs and slots. A slot lasts about 200ms (it used to be 400ms), and an epoch is exactly 432,000 slots, which now works out to about a day. So instead of using regular date and time, the network goes by epoch and slot numbers.

Staking is when you delegate your SOL to a validator's vote account. People stake their SOL because they earn a yield, and validators profit by keeping a percentage of that yield, called the commission. The yield comes from inflation: every epoch the network creates new SOL and splits it between validators based on how much stake they have and how many votes they cast. This validator's commission is 100%, so it keeps the full reward. The reward for epoch N gets paid at the first block of epoch N+1. Because inflation is set per year, when Solana shortened its slot time in 2026 each epoch got shorter, and so did the reward per epoch (see the slot-time table in [How I checked the numbers](#how-i-checked-the-numbers)).

Validators also depend on that SOL being staked so that they have more voting power. The more stake a validator has, the more slots it gets assigned as the leader. When a validator is the leader of a slot, it gets the opportunity to produce a block, which is a mix of transactions. If the block is successfully produced, the validator keeps half of the base fees plus any priority fees paid (the other half of the base fees is burned). Unlike the staking reward, block fees are paid right away in the block itself, to the validator's identity account instead of its vote account.

---

## How it works

```
npm run pipeline
   pipeline.ts ── looks up the validator on chain, takes the run lock, decides the epoch range
     ├── staking.ts ── for each unfinished epoch: getInflationReward -> staking_rewards + epoch_status
     └── fees.ts
           ├── phase A: getLeaderSchedule per epoch -> one PENDING row per assigned slot (leader_slots)
           └── phase B: getBlock per PENDING/FAILED slot -> PRODUCED / EMPTY / SKIPPED / ANOMALY / FAILED
   solana.ts       ── typed wrappers: WHAT we ask the RPC
   rpc.ts          ── transport: HOW we ask (pacing, retries, error classification)
   epoch-status.ts ── writes epoch-level progress and gaps
   db.ts           ── shared PostgreSQL connection pool

npm run api
   api.ts     ── routes, validation, response shapes
   queries.ts ── every SQL query the API runs

npm run verify
   verify.ts  ── the cross-checks in "How I checked the numbers"
```

`sql/schema.sql` holds the tables, constraints, index and the `index_gaps` view. `src/recon.ts` and `src/recon-fees.ts` are exploration scripts I ran **before** designing the schema; `docs/recon-2026-11-01.txt` is the output of `recon-fees.ts`, the evidence behind several decisions.

### Database schema

| Table | One row per | Holds |
|---|---|---|
| `validators` | validator | vote account, identity account |
| `staking_rewards` | validator × epoch | amount, commission, effective slot, post-balance |
| `leader_slots` | validator × assigned slot | status, fee, tx count (when re-checked), error code/message, attempts |
| `epoch_status` | validator × epoch × stream (`STAKING` / `FEES`) | progress and whole-epoch gaps, with reason |
| `index_gaps` (view) | gap | everything not indexed, and why: `SELECT * FROM index_gaps;` |

Slot statuses in `leader_slots`:

| Status | Meaning | Counts as fee |
|---|---|---|
| `PENDING` | Saved from the schedule, not fetched yet | |
| `PRODUCED` | Block exists, `Fee` reward paid to our identity | the fee |
| `EMPTY` | Block exists, no `Fee` reward, **re-checked: 0 transactions** | 0 |
| `SKIPPED` | No block was produced in this slot (RPC `-32007` / `-32009`) | 0 |
| `ANOMALY` | Block has transactions but no `Fee` reward, or the fee went to another account | gap |
| `FAILED` | Couldn't fetch after retries; retried on the next run | gap |

Fee totals per epoch are always calculated with `SUM` over `leader_slots`. They are never stored a second time, so there is one source of truth.

---

## Assumptions

The assignment leaves some details open; these are the assumptions I made.

- **What "the validator earns" means.** Two streams: the staking reward paid to the vote account each epoch (`getInflationReward` on the vote account; with this validator's 100% commission, that is the full reward its stake earned), and the block fees paid to the identity account (the `Fee` reward in each block it produced). MEV/Jito tips are not protocol fees and are not included.
- **Epoch range** is inclusive: `--from 1000 --to 1073` includes both ends. "Latest completed epoch" means current epoch − 1, because the current epoch's numbers are still changing.
- **Fee per block** is the leader's share as the chain records it (half of the base fees plus all priority fees), read from the block's `Fee` reward rather than recalculated from transactions.
- **Skipped slots.** RPC errors -32007 and -32009 are treated as "no block was produced" (fee 0). Their messages also allow "missing data", which the public endpoint can't tell apart; the error code is kept on the row so these can be re-checked later.
- **Commission** is stored exactly as `getInflationReward` returns it, which is `null` for most epochs ([finding 5](#what-i-found-surprises-and-how-i-handled-them)). The 100% figure comes from the validator's vote account on Solscan, not from the pipeline, and is assumed unchanged across the range (the RPC still reported 100 for epochs 1000–1001).
- **Identity account** is the current one from `getVoteAccounts`, assumed unchanged across the epoch range.
- **Endpoint.** The free public endpoint is the default; a faster provider URL can be set in `.env`.

---

## Design decisions

**1. Raw SQL with `pg`, no ORM.** The data model is small and the interesting logic (resume, upserts, gap reporting) is SQL. Writing it directly keeps every query visible and reviewable (the API's are all in `queries.ts`). An ORM would hide exactly the parts I want to show.

**2. A small custom JSON-RPC client on `fetch`, no Solana SDK.** I wanted to see and control each failure layer myself: the HTTP status (429 rate limit, 403 forbidden), the JSON-RPC error code inside a `200` response, timeouts and retries. The SDK can do much of this too (it exposes error codes and retries 429s on its own), but writing it directly keeps every layer visible in one place, and it's under 300 lines including comments (`rpc.ts` + `solana.ts`).

**3. Progress lives in the database, not in memory.** Every epoch and every slot has a status. "What's left to do" is a SQL query (`generate_series` of the epoch range, minus what's `COMPLETE`), so a crash or Ctrl+C loses at most the request in flight, and a re-run naturally picks up `FAILED` items. All writes are upserts (`INSERT ... ON CONFLICT`), so redoing anything never creates duplicates.

**4. One row per assigned leader slot (not one total per epoch).** Recon showed the RPC only keeps leader schedules for about the last week of epochs, while the blocks stay available much longer. So the pipeline **saves every schedule first** (phase A) and then fetches blocks (phase B). The slot rows *are* the saved schedule, resume works per block (an epoch is 1–1.5 hours of fetching on the public endpoint), and completeness is provable: assigned slots = slots with a final status.

**5. Never record a zero I haven't verified.** A block with no `Fee` reward is re-fetched with its transaction list. Only 0 transactions becomes `EMPTY` with fee 0; transactions without a fee becomes an `ANOMALY` gap. Likewise `getInflationReward` returning `null` is recorded as `NO_REWARD` in `epoch_status`, not as a fake 0 reward, and the API returns `null` for anything not fully known.

**6. Two kinds of failure: temporary vs. permanent.** Temporary (HTTP 429/5xx, timeouts, "node not ready" codes like `-32004`, `-32017`) are retried with exponential backoff (1s, 2s, 4s, 8s, 16s + jitter). Permanent answers (skipped slot `-32007`/`-32009`, pruned block `-32001`, bad request) return immediately so the pipeline can record the right status. After all retries a temporary failure is recorded as `FAILED` and retried on the next run.

**7. One request at a time, at a fixed pace.** At most one request every 2 seconds (`RPC_GAP_MS`), which is what the public endpoint allows for `getBlock` (measured). The limit is the endpoint's rate cap, not response time, so parallel requests didn't help ([What I found](#what-i-found-surprises-and-how-i-handled-them), item 3). A fixed gap also beat an adaptive one that sped up and slowed down on its own: about 2.0 s per block with no 429s, versus about 2.6 s. Occasional 429s are still handled by the retry/backoff in decision 6.

**8. Store lamports as `BIGINT`, return them as strings.** Integer math only, no floating point. `INTEGER` would overflow at ~2.15 SOL.

**9. One run per validator at a time.** A Postgres advisory lock, held by a dedicated connection for the whole run. If a scheduled run starts while a long fee run is still going, it exits instead of fetching the same slots twice. If the process dies, its connection closes and the lock is released automatically.

---

## How I checked the numbers

`npm run verify` runs three checks, from least to most independent:

**1. Staking rewards vs. the payout block (consistency check).** For sample epochs, re-read the reward straight from the block where it was paid (`getBlock` at the effective slot, reward type `Voting`) and compare amount and post-balance. Same chain, different method: it catches bugs in how I fetched or stored rewards. I picked epochs around the interesting events (slot-time changes, Alpenglow):

| Epoch | Paid in slot | Stored (lamports) | From block | Match |
|---|---|---|---|---|
| 1000 | 432,432,000 | 629,571,079,630 | 629,571,079,630 | ✅ |
| 1019 | 440,640,000 | 611,722,831,635 | 611,722,831,635 | ✅ |
| 1020 | 441,072,000 | 536,448,915,898 | 536,448,915,898 | ✅ |
| 1053 | 455,328,000 | 298,828,099,358 | 298,828,099,358 | ✅ |
| 1064 | 460,080,004 | 297,753,761,561 | 297,753,761,561 | ✅ |
| 1065 | 460,512,000 | 282,893,404,063 | 282,893,404,063 | ✅ |
| 1066 | 460,944,000 | 311,101,764,794 | 311,101,764,794 | ✅ |
| 1073 | 463,968,000 | 300,325,777,915 | 300,325,777,915 | ✅ |

**2. Block production vs. Solana's own slot history (independent on-chain record).** `getBlockProduction` reports how many slots a validator led and how many blocks it produced, from Solana's SlotHistory record rather than the block archive the pipeline reads. That would independently confirm the `SKIPPED` vs. produced split. **Result: the public endpoint refuses this method (HTTP 403).** The script shows the node's exact error instead of guessing.
Running `npm run verify` against a provider that allows this method would fill in this comparison; it's listed in next steps.

**3. Block fees vs. a block explorer (third party).** `verify` prints Solscan links for random `PRODUCED`, `EMPTY` and `SKIPPED` slots. I compared each one by hand:

| Slot | Status | Our fee (lamports) | Solscan | Match |
|---|---|---|---|---|
| 463600937 | PRODUCED | 2,010,803 | Reward 0.002010803 SOL, leader AEHq…TBD | ✅ |
| 463587823 | PRODUCED | 1,512,638 | Reward 0.001512638 SOL, leader AEHq…TBD | ✅ |
| 463650414 | PRODUCED | 1,350,267 | Reward 0.001350267 SOL, leader AEHq…TBD | ✅ |
| 463536936 | EMPTY | 0 | 0 transactions, reward 0 | ✅ |
| 463536937 | SKIPPED | 0 | "Unable to locate this block" | ✅ |

Our side of the comparison, straight from the database:

```sql
SELECT slot, epoch, status, fee_lamports
FROM leader_slots
WHERE slot IN (463600937, 463587823, 463650414, 463536936, 463536937)
ORDER BY slot;
```

Screenshot of the first block: [`docs/solscan-463600937.png`](docs/solscan-463600937.png).

All three produced blocks match to the lamport, and Solscan names our identity account as the leader, which also confirms the leader-schedule slot math. Solscan's "Total Fees" is higher than its "Reward" (0.00309 vs 0.00201 SOL for the first block); the difference is the half of the base fees that is burned, which is why the pipeline stores the leader's share and not the total. This is a small sample (five slots covering all three outcomes), so it shows the method is right rather than proving every row.

A third-party check of the staking rewards is not included: check 1 compares them against the payout blocks on chain instead. Comparing against an explorer that publishes per-epoch vote-account rewards is in next steps.

**Sanity check: the numbers behave the way the protocol says they should.** Per-epoch rewards dropped in four sharp steps, at exactly the epochs where Solana shortened its slot time. Inflation is paid per *year*, so shorter slots mean shorter epochs and a proportionally smaller share per epoch. The ratios match almost exactly:

| Epoch | Reward before → after | Ratio | Slot time change | Ratio |
|---|---|---|---|---|
| 1020 | 611.72 → 536.45 SOL | 0.877 | 400 → 350 ms | 0.875 |
| 1024 | 532.59 → 456.14 SOL | 0.856 | 350 → 300 ms | 0.857 |
| 1037 | 449.77 → 374.69 SOL | 0.833 | 300 → 250 ms | 0.833 |
| 1053 | 372.70 → 298.83 SOL | 0.802 | 250 → 200 ms | 0.800 |

Slot-time change epochs: [Solana's reduced slot times upgrade page](https://solana.com/upgrades/reduced-slot-times).

---

## What I found (surprises and how I handled them)

1. **Empty blocks.** The first block I fetched had `rewards: []`. Before trusting it I re-fetched it with transactions: **0 transactions**, so zero fees is correct. Since Alpenglow (epoch 1064) vote transactions are no longer stored in blocks; a sample of blocks went from ~860–1,500 transactions before to ~110–470 after, which makes truly empty blocks possible. The empty blocks follow a clear pattern (item 9). **Handled:** decision 5 (re-check before recording zero).

2. **Leader schedules expire, blocks don't.** On 2026-11-01 the RPC still had leader schedules for epochs 1066–1073 only, but served blocks all the way back (first available block: slot 0). Without the schedule you can't tell which blocks were this validator's. **Handled:** save every available schedule immediately (phase A); older epochs are recorded as `UNAVAILABLE` with the reason. Running the pipeline on a schedule going forward captures each epoch's schedule while it's still available; the second run on 2026-11-02 did exactly that for epoch 1074.

3. **The public endpoint caps `getBlock` hard.** About one request every 2–2.5 seconds, so ~2,000 blocks per epoch is 1–1.5 hours, and the full week of available epochs 9–12 hours. I first assumed the bottleneck was response time (each `getBlock` takes ~1.5 s) and added parallel workers. Against a mock server (not in the repo) that was 3.5× faster; **on the real endpoint it was slower**, with many more 429s. The mock modeled the wrong bottleneck. **Handled:** removed the parallel workers, paced requests at a fixed 2 seconds, and made `RPC_URL` and `RPC_GAP_MS` configurable for a faster provider.

4. **"Skipped" is ambiguous.** Error `-32007` means *"skipped, or missing due to ledger jump to recent snapshot"* and `-32009` *"skipped, or missing in long-term storage"*. The code alone can't separate "no block was produced" (a real 0) from "the data is missing" (a gap), and `getBlockProduction`, which would settle it from Solana's slot history, is refused by the public endpoint (HTTP 403). **Handled:** recorded as `SKIPPED` with the original error code kept on the row, so it can be re-classified later; confirming it is in [next steps](#what-id-do-next-with-more-time).

5. **2026 changes to RPC responses.** `getInflationReward` returned `commission: 100` for epochs 1000–1001 and `null` for every epoch from 1002 on. Solana's docs list the field as `u8 | null` without saying when it's empty, and I haven't confirmed why it changed. The pipeline stores the `null` as-is instead of filling in a guess (the same rule as decision 5); the validator's current commission, 100%, is shown on its vote account page on Solscan. Newer nodes also have a new error code `-32022` ("leader schedule identity not found"), which the client treats as "no slots".

6. **Reward timing isn't always the first slot.** Epoch 1064's reward was paid at slot 460,080,004, not 460,080,000, because the first four slots of epoch 1065 were skipped. The pipeline stores the actual `effective_slot` instead of assuming it.

7. **Epoch 1065 low, 1066 high.** 282.89 SOL then 311.10 SOL, around a steady ~298, right after Alpenglow activated. Both match the chain (check 1); I haven't investigated why.

8. **`getBlock` sometimes returns nothing.** For a few slots the public node returned `null` with no error, for blocks that did exist. They were recorded as `FAILED` (never as zero), and a retry on the next run succeeded. **Handled:** by the normal `FAILED` → retry path; retrying a few times within the same run would be a small improvement.

9. **One missed leader window per epoch.** Across all 9 complete epochs, the 36 slots that didn't produce a normal block follow one pattern: in each epoch, exactly one 4-slot leader window, early in the epoch (between slot 492 and 2,208), produced an empty block (0 transactions) and then skipped its next 3 slots. In 8 of the 9 epochs (1067–1074) this was the validator's **first** leader window of the epoch; in 1066 its first window (slot 28) produced normally and the missed window came at slot 1,048. Every other leader slot produced a block with fees. This is what the chain shows, not a pipeline error: Solscan confirms the epoch-1073 instance (slot 463536936 empty, 463536937 skipped, in check 3), and the produced blocks around it name this validator as leader. I haven't found the cause. The query that shows it:

   ```sql
   SELECT epoch, slot, slot - epoch * 432000 AS slot_in_epoch, status
   FROM leader_slots
   WHERE status IN ('EMPTY', 'SKIPPED')
   ORDER BY epoch, slot;
   ```

---

## What I'd do next with more time

- **Run it on a schedule from now on.** Leader schedules disappear after about a week, so fee history can only be built going forward. A daily run never misses an epoch.
- **Find out why one leader window per epoch is missed** ([What I found](#what-i-found-surprises-and-how-i-handled-them), item 9), e.g. by checking whether other validators show the same pattern.
- **Resolve "skipped vs. missing"** with `getBlockProduction` on a provider that allows it, or a second RPC provider, and re-classify `SKIPPED` rows that don't match.
- **Check staking rewards against a third party** (an explorer or data provider that publishes per-epoch vote-account rewards), the way block fees were checked against Solscan.
- **Older fee history** would need an archival source that knows historical leader schedules (e.g. a data warehouse or a provider's indexed API).
- **MEV / Jito tips** aren't included; they're a large part of real validator revenue but aren't protocol fees.
- **Block revenue sharing (SIMD-0123).** When this proposal activates, validators can share part of their block fees with their stakers, so the fee a validator keeps would no longer equal the block's `Fee` reward and fee attribution would need to change.
- **Commission per epoch.** `getInflationReward` no longer returns it, so it would need to be read from the vote account each epoch going forward, or from a data provider for history.
- **Automated tests.** There are none. During development the RPC client was tested against throwaway mock servers (rate limits, skipped slots, bad JSON, interruptions) that aren't in the repo; a proper test suite is the first thing I'd add.
- Track identity-account changes over time, multiple validators, API pagination, Docker Compose for one-command setup, and alerting when `index_gaps` grows.

---

## How I used AI

I used two AI assistants: **Gemini** for a roadmap, Solana concepts and reviewing options, and **Claude** for writing and testing the code. I'm new to TypeScript and to Solana. Nearly all of the code, and many of the design proposals, came from AI, and I didn't fully understand all of it while it was being built. The calls I made myself came from evidence: I ran a recon script against the live chain before designing the schema, then chose one row per leader slot and to verify empty blocks before ever recording a zero. I also cut back features that weren't needed (parallel workers, adaptive pacing). After building it, I studied each part until I could explain how it works and where it's weak. If I did it again, I'd build a small core first and understand each piece before adding the next.

Places where an AI was wrong, and how it was caught:

| Claim | From | What was actually true | How it was caught |
|---|---|---|---|
| Error `-32007` means the block was pruned | Gemini | It means *skipped, or missing after a snapshot jump*; "pruned" is `-32001` | Checked Solana's error-code source |
| Parallel workers would speed up fetching (latency-bound) | Claude | The public endpoint is rate-capped; workers made it slower | The real run's time estimate went up instead of down; measured it, then removed the feature |
| `verify` labeled every `getBlockProduction` failure "older than slot history" | Claude | The real error was HTTP 403, method forbidden | Changed the script to print the node's actual error |

