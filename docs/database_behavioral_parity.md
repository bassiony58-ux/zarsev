# ZARSEV Database Behavioral Parity Specification
## Documented Behavioral Equivalence between PostgreSQL and SQLite

**Status:** APPROVED & IMPLEMENTED (Stage 1)  
**Engines Covered:** PostgreSQL 15+ / SQLite 3.40+ (via `node:sqlite` DatabaseSync)  
**Associated Migration:** `002_zarsev_core_foundation.sql` / SQLite `schema_migrations` (version 002)

---

### 1. Architectural Principle of Behavioral Parity

Rather than asserting impossible literal syntactic identity between PostgreSQL and SQLite, ZARSEV enforces **Documented Behavioral Parity**. This guarantees that all application code, services, routes, and workers interact with the database facade (`dbClient`) with identical semantic expectations, error outcomes, constraint enforcements, and transactional guarantees regardless of the underlying engine.

---

### 2. Type Mapping & Serialization Parity

| Abstract Domain Type | PostgreSQL Implementation | SQLite Implementation | Behavioral Parity Contract |
| :--- | :--- | :--- | :--- |
| **Primary Keys (UUID/String)** | `VARCHAR(64)` | `TEXT` | Case-sensitive string equality; uniqueness enforced via `PRIMARY KEY`. |
| **Timestamps** | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` | Formatted and normalized in ISO-8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`); comparable lexicographically. |
| **JSON Payloads** | `JSONB` | `TEXT` (JSON serialized) | Validated as valid JSON; parsed by application layer as standard JavaScript objects; preserves explicit `null` vs absent fields. |
| **Booleans** | `BOOLEAN NOT NULL DEFAULT false` | `INTEGER NOT NULL DEFAULT 0` | Mapped bidirectionally by `dbClient` and models (`true <=> 1`, `false <=> 0`); strict boolean semantics. |
| **Numeric Decimals (Prices)** | `NUMERIC(12, 2)` | `REAL` / `NUMERIC` | Precision preserved for 2 decimal places; parsed as floating-point numbers or fixed strings. |
| **Concurrency Versions** | `INTEGER NOT NULL DEFAULT 1` | `INTEGER NOT NULL DEFAULT 1` | Exact 32/64-bit integer monotonic counters; optimistic locking checks `lock_version = :expected`. |

---

### 3. Constraint Enforcements & Error Semantics

#### 3.1. Foreign Key Cascades & Restrictions
* **`PRAGMA foreign_keys = ON;`:** Enforced globally upon every SQLite connection initialization.
* **`ON DELETE CASCADE`:** 
  - Deleting an import in `imports` automatically purges related records in `import_items`, `import_attempts`, and `import_logs`.
  - Deleting an item in `import_items` automatically purges related records in `import_item_revisions`.
  - Deleting a batch in `import_batches` automatically purges related records in `batch_source_files`.
* **`ON DELETE RESTRICT`:**
  - Deleting a manufacturer in `manufacturers` is strictly blocked if active `products` or `imports` exist.
* **`ON DELETE SET NULL`:**
  - Deleting a parent category sets `parent_id` to `NULL`.
  - Deleting an import batch sets `imports.batch_id` to `NULL`.

#### 3.2. Check Constraints (Enums & State Machines)
* Both engines enforce strict enum strings in `CHECK(...)` constraints:
  - `import_idempotency_keys.status IN ('RESERVED', 'COMMITTED', 'FAILED_QUOTA', 'RELEASED')`
  - `batch_source_files.deletion_status IN ('ACTIVE', 'DELETING', 'PURGED')`
  - `import_attempts.final_status IN ('RUNNING', 'COMMITTED', 'TERMINATED_ABORTED', 'OUTCOME_UNKNOWN')`
  - `products.status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED')`
* Any attempt to insert or update an invalid status string throws an engine-level constraint violation error wrapped uniformly as `DbError` with code `ERR_CONSTRAINT_CHECK` or `SQLITE_CONSTRAINT`.

---

### 4. Transaction Boundaries & SAVEPOINT Resiliency

#### 4.1. Transaction Modes
* **PostgreSQL:** `BEGIN` with read committed isolation (or explicit `SELECT ... FOR UPDATE` row locks).
* **SQLite:** `BEGIN IMMEDIATE` managed via `AsyncMutex` in `dbClient.js` to serialize write transactions and eliminate SQLITE_BUSY deadlocks.

#### 4.2. Nested Transactions (SAVEPOINT) Contract
* When `dbClient.transaction` invokes a nested sub-transaction:
  1. An explicit SQL savepoint is created: `SAVEPOINT sp_<depth>;`.
  2. If an error occurs inside the nested block and is caught by application code, `ROLLBACK TO SAVEPOINT sp_<depth>;` is executed.
  3. **Crucial Parity Invariant:** The outer transaction remains **healthy, active, and fully capable of continuing**. Subsequent queries in the outer transaction succeed, and the outer transaction can successfully `COMMIT`.
  4. Changes made before the savepoint and after the savepoint rollback are permanently committed; changes made inside the failed savepoint block are permanently undone.

---

### 5. Migration Governance & Idempotency

#### 5.1. Dual Check (Version + Checksum)
* Both PostgreSQL (`_pg_migrations`) and SQLite (`schema_migrations`) maintain an immutable record of:
  - `version` (e.g. `'002'`)
  - `filename` (e.g. `'002_zarsev_core_foundation.sql'`)
  - `checksum` (SHA-256 of the authoritative migration file)
* If `version` exists and `checksum` matches: Migration is an idempotent no-op.
* If `version` exists and `checksum` does NOT match: Immediate fatal abort with `CRITICAL_MIGRATION_ERROR` (no automatic overwrite, tamper prevention).
* New tables in SQLite are created inside a transactional DDL boundary (`BEGIN IMMEDIATE ... COMMIT`), with active schema introspection via `PRAGMA table_info` before applying `ALTER TABLE ADD COLUMN`.
