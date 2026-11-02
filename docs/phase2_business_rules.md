# ZARSEV — Phase 2 Business Rules & Logic Specification (Revised)

**Branch:** `phase2-data-and-business-architecture`  
**Base Commit:** `eb5544a`  
**Target Environment:** Local Verified SQLite (`M:\ZZZ\zarsev.db`)  
**Specification Date:** 2026-11-02  
**Status:** Hardened Technical Specification

---

## 1. Classification Legend

- `[VERIFIED CURRENT BEHAVIOR]`: Confirmed by querying `zarsev.db` and inspecting verified source code in `M:\ZZZ\src`.
- `[PROPOSED FUTURE BEHAVIOR]`: Architectural requirement and schema design planned for Phase 2 implementation.
- `[UNVERIFIED ASSUMPTIONS]`: Existing assumption that has not yet been validated against external systems or real production workflows.
- `[OPEN BUSINESS DECISIONS]`: Strategic trade, export, or administrative choice requiring leadership sign-off.

---

## 2. Product Pricing Business Rules & Invariants

### 2.1 Authoritative Master vs Legacy Projections
`[PROPOSED FUTURE BEHAVIOR]`

1. **Authoritative Master Table (`product_prices`):**
   - The `product_prices` table is the sole authoritative source of truth for all pricing data: multiple currencies (`USD`, `EUR`, `EGP`, `SAR`, etc.), quantity tiers, maritime Incoterms (`FOB`, `CIF`, `CFR`, `EXW`, `DDP`), price validity periods (`valid_from`, `valid_to`), and quotation-only designations.
2. **Backward-Compatible Projections (`products` table):**
   - The existing columns in `products` (`price`, `currency`, `price_unit`, `moq`) remain as materialized read projections so existing catalog endpoints, search queries, and legacy frontend views continue functioning without breaking changes.
3. **Deterministic Legacy Projection Selection Policy:**
   - Because a single product can possess multiple primary prices across different currencies and Incoterms (e.g. one primary in USD FOB Alexandria, and one primary in EUR CIF Hamburg), the projected values in `products` must be selected deterministically, never arbitrarily:
     - **Priority 1 (Explicit Flag):** If a price record has `is_default_projection = 1`, it is selected as the legacy projection.
     - **Priority 2 (Deterministic Fallback Hierarchy):** In the absence of an explicit flag, the system selects the active primary price using the following strict hierarchy:
       1. **Currency Rank:** `USD` > `EUR` > `EGP` > others (alphabetical).
       2. **Incoterm Rank:** `FOB` > `CIF` > `CFR` > `EXW` > others.
       3. **Quantity Rank:** Lowest `min_quantity` (base tier).
       4. **Timestamp Rank:** Most recent `valid_from`.
4. **Explicit `QUOTATION_ONLY` Designation:**
   - A product is **ONLY** marked as quotation-only if explicitly flagged by the user or admin (`price_type = 'QUOTATION_ONLY'` or `is_quotation_only = 1`).
   - Missing price data during file extraction or drafting does **NOT** automatically convert a product to quotation-only mode. Unpriced items without the explicit flag are treated as incomplete drafts (`status = 'DRAFT'`, with validation warning `"السعر غير متوفر"`).

### 2.2 Fix for SQLite Partial Unique Index: Deterministic Primary Price Invariant
`[VERIFIED CURRENT BEHAVIOR]` vs `[PROPOSED FUTURE BEHAVIOR]`

#### Verified SQLite Limitation:
- In SQLite, partial index `WHERE` clauses **strictly prohibit non-deterministic functions**.
- Attempting to execute:
  ```sql
  CREATE UNIQUE INDEX uidx_product_prices_primary 
  ON product_prices(product_id, currency, incoterm) 
  WHERE is_primary = 1 AND (valid_to IS NULL OR valid_to > CURRENT_TIMESTAMP);
  ```
  Fails with verified SQLite error:  
  `Error: non-deterministic functions prohibited in partial index WHERE clauses`

#### Corrected Deterministic Partial Index:
- The partial unique index must be 100% deterministic:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uidx_product_prices_primary 
  ON product_prices(product_id, currency, incoterm) 
  WHERE is_primary = 1;
  ```
- This guarantees at the database engine level that **at most one record per `(product_id, currency, incoterm)`** can have `is_primary = 1`.

#### Transactional Activation & Replacement Protocol (`BEGIN IMMEDIATE`):
Whenever an active primary price is created, promoted, or replaced, the service layer executes an atomic write transaction:
```javascript
function setPrimaryPrice(db, newPriceData) {
    // 1. Acquire immediate SQLite write lock to serialize concurrent requests
    db.exec('BEGIN IMMEDIATE;');
    try {
        const { product_id, currency, incoterm } = newPriceData;

        // 2. Demote existing primary price for this context and close its validity window
        db.prepare(`
            UPDATE product_prices
            SET is_primary = 0,
                valid_to = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE product_id = ? 
              AND currency = ? 
              AND incoterm = ? 
              AND is_primary = 1
        `).run(product_id, currency, incoterm);

        // 3. Insert the new primary price
        db.prepare(`
            INSERT INTO product_prices (
                id, product_id, manufacturer_id, price_type, price, currency,
                price_unit, min_quantity, max_quantity, incoterm, port_of_origin,
                valid_from, valid_to, is_primary, is_default_projection, is_demo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, 1, ?, ?)
        `).run(...);

        // 4. Synchronize deterministic legacy projection in products table
        syncLegacyProductProjection(db, product_id);

        db.exec('COMMIT;');
    } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
    }
}
```

#### Handling Future, Expired, Historical, and Simultaneous Activation Requests:
1. **Future / Scheduled Prices:**
   - Inserted with `is_primary = 0`, `valid_from = <future_timestamp>`.
   - Ignored by active primary catalog queries until their `valid_from` arrives.
   - Promoted to `is_primary = 1` via scheduled job or lazy on-request activation within a `BEGIN IMMEDIATE` transaction.
2. **Expired Prices:**
   - When `valid_to <= CURRENT_TIMESTAMP`, the price is demoted from `is_primary = 1` (or filtered out at query time).
   - Preserved in `product_prices` for historical auditing; never deleted.
3. **Historical Price Preservation:**
   - Price updates **never overwrite** existing records. Historical records retain their original prices, timestamps, and `valid_to` markers.
4. **Simultaneous Activation Requests:**
   - Serialized by `BEGIN IMMEDIATE` at the SQLite level. The second concurrent transaction waits for the first to commit, preventing race conditions or duplicate primary entries.

### 2.3 Tiered Quantity Overlap Prevention
`[PROPOSED FUTURE BEHAVIOR]`

- For tiered pricing under the same context (`product_id`, `currency`, `incoterm`, overlapping validity window), quantity tiers must be strictly contiguous without overlaps:
  $$\text{Tier } N.\text{max\_quantity} < \text{Tier } (N+1).\text{min\_quantity}$$
- Overlapping quantity validation runs in application service logic prior to transaction commit. Any insertion violating range contiguity is rejected with `HTTP 422 Unprocessable Entity`.

### 2.4 Valid Price Type Combinations Matrix
`[PROPOSED FUTURE BEHAVIOR]`

| Price Type (`price_type`) | `price` Value | `min_quantity` (MOQ) | `max_quantity` | `incoterm` | Public Catalog Display |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `FIXED` | Numeric (`> 0`) | Required (`>= 1.0`) | `NULL` | Required (`FOB`, `CIF`, etc.) | Direct Price (e.g. `$750 / MT (FOB Damietta)`) |
| `TIERED` | Numeric (`> 0`) | Required (`>= 1.0`) | Numeric or `NULL` (for final tier) | Required | Tiered Table (e.g. `1–10 MT: $800`, `11–50 MT: $750`) |
| `QUOTATION_ONLY` | `NULL` | Optional / Minimum MOQ | `NULL` | Optional | "سعر عند الطلب (Quotation on Request)" + RFQ Button |

---

## 3. Subscription Lifecycle & Concurrency-Safe Usage Ledger

### 3.1 Separation of Subscription Status and Payment Status
`[PROPOSED FUTURE BEHAVIOR]`

To avoid coupling commercial accounting with access enforcement, `manufacturer_subscriptions` separates subscription lifecycle status from payment status:

- **Subscription Status (`status`):**  
  `PENDING` | `ACTIVE` | `EXPIRED` | `SUSPENDED` | `CANCELLED`
- **Payment Status (`payment_status`):**  
  `UNPAID` | `PENDING_VERIFICATION` | `PAID` | `WAIVED` | `REFUNDED`

#### Independent Transition Rules:
1. An administrator may activate a sovereign or trial subscription with `status = 'ACTIVE'` and `payment_status = 'WAIVED'`.
2. A commercial renewal invoice may be generated where `payment_status = 'UNPAID'` while `status = 'ACTIVE'` during a 7-day grace period, transitioning to `EXPIRED` only if payment is unverified when the grace period ends.
3. A suspended account (`status = 'SUSPENDED'`) retains its historical `payment_status = 'PAID'`.

### 3.2 Atomic Quota Consumption Protocol (`BEGIN IMMEDIATE`)
`[PROPOSED FUTURE BEHAVIOR]`

#### Why `BEGIN IMMEDIATE` Is Mandatory:
In SQLite, the default `BEGIN DEFERRED` does not acquire a write lock until an actual `INSERT` or `UPDATE` is issued. If two concurrent requests execute `SELECT SUM(quantity)` simultaneously, both will see available quota and both will insert, resulting in a race-condition quota overrun. `BEGIN IMMEDIATE` acquires a reserved write lock immediately, serializing quota consumption.

#### 7-Step Atomic Quota Consumption Transaction:
```javascript
function consumeImportQuota(db, { manufacturer_id, import_id, actor_user_id, idempotency_key }) {
    // 1. Acquire immediate SQLite write lock
    db.exec('BEGIN IMMEDIATE;');
    try {
        // Step 1: Verify manufacturer business model
        const mfg = db.prepare('SELECT business_model FROM manufacturers WHERE id = ?').get(manufacturer_id);
        if (!mfg) throw new Error('MANUFACTURER_NOT_FOUND');

        // Direct Contract manufacturers are 100% exempt from subscriptions and quotas
        if (mfg.business_model === 'DIRECT_CONTRACT') {
            db.exec('COMMIT;');
            return { allowed: true, exempt: true };
        }

        // Step 2: Verify active subscription and expiration
        const sub = db.prepare(`
            SELECT ms.*, s.max_monthly_imports, s.max_products_per_import
            FROM manufacturer_subscriptions ms
            JOIN subscriptions s ON ms.plan_id = s.id
            WHERE ms.manufacturer_id = ?
        `).get(manufacturer_id);

        if (!sub || sub.status !== 'ACTIVE') {
            throw new Error('SUBSCRIPTION_NOT_ACTIVE');
        }

        // Check expiration
        const now = new Date().toISOString();
        if (sub.expires_at <= now) {
            // Auto-transition to EXPIRED
            db.prepare("UPDATE manufacturer_subscriptions SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sub.id);
            throw new Error('SUBSCRIPTION_EXPIRED');
        }

        // Step 3: Check Idempotency (prevent duplicate consumption)
        const existingEntry = db.prepare(`
            SELECT id FROM subscription_usage 
            WHERE manufacturer_id = ? AND idempotency_key = ?
        `).get(manufacturer_id, idempotency_key);

        if (existingEntry) {
            db.exec('COMMIT;');
            return { allowed: true, idempotent_replay: true };
        }

        // Step 4: Calculate current billing period usage
        const billingPeriod = now.substring(0, 7); // Format: YYYY-MM
        const usage = db.prepare(`
            SELECT COALESCE(SUM(quantity), 0) AS used_count
            FROM subscription_usage
            WHERE manufacturer_id = ? 
              AND billing_period = ? 
              AND usage_type = 'IMPORT_SESSION'
        `).get(manufacturer_id, billingPeriod);

        // Step 5: Check remaining quota
        if (usage.used_count + 1 > sub.max_monthly_imports) {
            throw new Error('MONTHLY_IMPORT_QUOTA_EXCEEDED');
        }

        // Step 6: Insert immutable usage record with scoped idempotency key
        const usageId = 'usg_' + crypto.randomBytes(8).toString('hex');
        db.prepare(`
            INSERT INTO subscription_usage (
                id, subscription_id, manufacturer_id, usage_type, quantity,
                billing_period, related_import_id, actor_user_id, idempotency_key
            ) VALUES (?, ?, ?, 'IMPORT_SESSION', 1, ?, ?, ?, ?)
        `).run(usageId, sub.id, manufacturer_id, billingPeriod, import_id, actor_user_id, idempotency_key);

        // Step 7: Commit transaction
        db.exec('COMMIT;');
        return { allowed: true, used: usage.used_count + 1, quota: sub.max_monthly_imports };

    } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
    }
}
```

### 3.3 Idempotency Enforcement & Scoping
`[PROPOSED FUTURE BEHAVIOR]`

- The `subscription_usage` table enforces a scoped unique constraint:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uidx_subscription_usage_idempotency 
  ON subscription_usage(manufacturer_id, idempotency_key);
  ```
- Ensures that network retries or duplicated client submissions never double-charge quotas.

---

## 4. Durable Import Worker Lease Ownership & Fencing Tokens

### 4.1 Fencing Token Architecture (`lease_generation`)
`[PROPOSED FUTURE BEHAVIOR]`

To prevent a split-brain scenario where a stalled or slow worker (due to GC pause or disk delay) resumes and overwrites results produced by a newly assigned worker, the system implements **monotonically increasing fencing tokens**:

```sql
CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY,
    import_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    manufacturer_id TEXT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT NULL,
    locked_by TEXT NULL,                 -- Worker instance UUID
    locked_at DATETIME NULL,
    lease_expires_at DATETIME NULL,
    last_heartbeat_at DATETIME NULL,
    lease_generation INTEGER NOT NULL DEFAULT 0, -- Monotonically increasing fencing token
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
```

### 4.2 Atomic Job Claiming with Fencing Token Increment
`[PROPOSED FUTURE BEHAVIOR]`

```javascript
function claimNextJob(db, workerId) {
    db.exec('BEGIN IMMEDIATE;');
    try {
        // Query candidate: QUEUED, or PROCESSING with expired lease and attempts < max_attempts
        const candidate = db.prepare(`
            SELECT id, lease_generation, attempts
            FROM import_jobs
            WHERE status = 'QUEUED'
               OR (status = 'PROCESSING' AND lease_expires_at < CURRENT_TIMESTAMP AND attempts < max_attempts)
            ORDER BY priority DESC, created_at ASC
            LIMIT 1
        `).get();

        if (!candidate) {
            db.exec('COMMIT;');
            return null;
        }

        const nextGeneration = candidate.lease_generation + 1;
        const leaseDurationMs = 10 * 60 * 1000; // 10 minutes
        const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();

        const result = db.prepare(`
            UPDATE import_jobs
            SET status = 'PROCESSING',
                locked_by = ?,
                locked_at = CURRENT_TIMESTAMP,
                last_heartbeat_at = CURRENT_TIMESTAMP,
                lease_expires_at = ?,
                lease_generation = ?,
                attempts = attempts + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND lease_generation = ?
        `).run(workerId, leaseExpiresAt, nextGeneration, candidate.id, candidate.lease_generation);

        if (result.changes === 0) {
            // Another worker claimed it concurrently
            db.exec('COMMIT;');
            return null;
        }

        db.exec('COMMIT;');
        return { jobId: candidate.id, lease_generation: nextGeneration, lease_expires_at: leaseExpiresAt };
    } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
    }
}
```

### 4.3 Fencing Verification on Every Worker Write
`[PROPOSED FUTURE BEHAVIOR]`

Every progress update, intermediate item save, heartbeat, and final completion must verify:
```sql
UPDATE import_jobs
SET status = 'COMPLETED',
    completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ? 
  AND locked_by = ? 
  AND lease_generation = ? 
  AND lease_expires_at > CURRENT_TIMESTAMP;
```

#### Behavior When an Expired Worker Finishes Late:
1. If worker $A$ took 12 minutes to process an import, its 10-minute lease expired.
2. Worker $B$ claimed the job at minute 11, incrementing `lease_generation` from 1 to 2.
3. At minute 12, worker $A$ attempts to finalize the job with `lease_generation = 1`.
4. The SQLite conditional `UPDATE` matches **0 rows** because `lease_generation` is now 2 (and lease expired).
5. Worker $A$ inspects `result.changes === 0`, immediately detects it has been **fenced out**, halts, discards its results, and logs a fencing violation:
   `"Worker fenced out: lease generation 1 expired and superseded by generation 2. Halting."`
6. Worker $B$'s results are protected from corruption or overwrites.
