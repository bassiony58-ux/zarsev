# ZARSEV — Phase 2 Database Migration & Backup Safety Plan

**Branch:** `phase2-data-and-business-architecture`  
**Base Commit:** `eb5544a`  
**Target Environment:** Local Verified SQLite (`M:\ZZZ\zarsev.db`)  
**Specification Date:** 2026-11-02

---

## 1. Classification Legend

- `[VERIFIED CURRENT BEHAVIOR]`: Confirmed by querying `zarsev.db` and inspecting verified source code in `M:\ZZZ\src`.
- `[PROPOSED FUTURE BEHAVIOR]`: Architectural requirement and schema design planned for Phase 2 implementation.
- `[UNVERIFIED ASSUMPTIONS]`: Existing assumption that has not yet been validated against external systems or real production workflows.
- `[OPEN BUSINESS DECISIONS]`: Strategic trade, export, or administrative choice requiring leadership sign-off.

---

## 2. Current Migration Mechanism vs Target Migration Framework

### 2.1 Current Implementation Audit
`[VERIFIED CURRENT BEHAVIOR]`

- Currently, schema migrations are implemented ad-hoc in [`src/db/database.js`](file:///M:/ZZZ/src/db/database.js#L32-L43):
  ```javascript
  function runMigrations(db) {
      ensureColumn(db, 'users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'users', 'password_hash', 'TEXT NULL');
      ensureColumn(db, 'users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'manufacturers', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'products', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'imports', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
  }
  ```
- **Critical Gaps in Current System:**
  1. No history of when a change was applied.
  2. No migration rollback capability.
  3. No checksums to detect migration tampering.
  4. No pre-migration database backup trigger.
  5. Cannot perform complex schema transformations (e.g. creating tables, renaming, rebuilding with foreign keys).

---

## 3. SQLite Backup Consistency & Verification Protocol

### 3.1 Why Raw File Copy Is Inadequate
`[PROPOSED FUTURE BEHAVIOR]`

Copying an active SQLite database file using OS file copy (`copy`, `cp`, or `fs.copyFileSync`) during active writes can lead to:
- Corrupted database headers.
- Torn writes if pages are being flushed to disk.
- Out-of-sync WAL (Write-Ahead Logging) files (`.db-wal`, `.db-shm`).

### 3.2 Implemented Consistent Backup Procedure
`[PROPOSED FUTURE BEHAVIOR]`

The migration framework will execute backups using a safe three-step protocol:

1. **Step 1: WAL Checkpoint Flush:**
   ```sql
   PRAGMA wal_checkpoint(TRUNCATE);
   ```
   Ensures all pending writes in WAL are flushed to the main `.db` file.
2. **Step 2: Consistent Snapshot via VACUUM INTO:**
   ```javascript
   const backupDir = path.join(__dirname, '..', '..', 'storage', 'backups', 'migrations');
   if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

   const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
   const backupPath = path.join(backupDir, `backup_pre_migration_${migrationName}_${timestamp}.db`);

   // Consistent live SQLite backup statement
   db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`);
   ```
3. **Step 3: Backup Integrity Verification:**
   Before allowing any migration to run, open the backup in a separate connection and verify its integrity:
   ```javascript
   const backupDb = new DatabaseSync(backupPath);
   const integrity = backupDb.prepare('PRAGMA integrity_check;').get();
   backupDb.close();

   if (!integrity || integrity.integrity_check !== 'ok') {
       throw new Error(`[CRITICAL] Pre-migration backup failed integrity check: ${JSON.stringify(integrity)}. Migration aborted.`);
   }
   console.log(`✅ Pre-migration backup verified: ${backupPath} (Integrity: OK)`);
   ```

---

## 4. SQLite Transaction Behavior & DDL Limitations

### 4.1 Supported Transactional DDL in SQLite
`[PROPOSED FUTURE BEHAVIOR]`

SQLite natively supports transactional DDL for the following operations:
- `CREATE TABLE`, `CREATE INDEX`, `CREATE VIEW`, `CREATE TRIGGER`.
- `DROP TABLE`, `DROP INDEX`, `DROP VIEW`, `DROP TRIGGER`.
- `ALTER TABLE ADD COLUMN`.
- `ALTER TABLE RENAME TO`.

Every migration runs enclosed within:
```sql
BEGIN TRANSACTION;
-- Migration statements
COMMIT;
```
If an error occurs at any point, `ROLLBACK` is executed, leaving the database state untouched.

### 4.2 Handling Unsupported DDL (The 12-Step Rebuild Pattern)
`[PROPOSED FUTURE BEHAVIOR]`

SQLite does not support altering column types, adding complex constraints post-creation, or dropping columns in older SQLite engines. When a schema change requires modifying existing column types or constraints, the migration **MUST** use the official SQLite 12-step table rebuild pattern:

```sql
BEGIN TRANSACTION;
-- 1. Create temporary replacement table with target schema
CREATE TABLE products_new (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL,
    -- New / modified columns
    ...
);

-- 2. Copy data from old table to new table
INSERT INTO products_new SELECT id, manufacturer_id, ... FROM products;

-- 3. Drop old table
DROP TABLE products;

-- 4. Rename new table to original name
ALTER TABLE products_new RENAME TO products;

-- 5. Re-create indexes and triggers
CREATE INDEX idx_products_mfg ON products(manufacturer_id);

-- 6. Verify foreign key integrity
PRAGMA foreign_key_check;

COMMIT;
```

---

## 5. Checksum Verification & Anti-Tampering Protocol

### 5.1 Architecture of `_migrations` Table
`[PROPOSED FUTURE BEHAVIOR]`

```sql
CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    batch INTEGER NOT NULL,
    checksum TEXT NOT NULL, -- SHA-256 hash of migration file content
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5.2 Anti-Tampering Check
`[PROPOSED FUTURE BEHAVIOR]`

When `migrate.js` runs:
1. Fetch all records from `_migrations` ordered by `id ASC`.
2. For each applied migration, read the file from disk and compute its current SHA-256 hash.
3. Compare:
   ```javascript
   if (currentChecksum !== recordedRecord.checksum) {
       throw new Error(
           `[SECURITY VIOLATION] Migration checksum mismatch for ${record.name}!\n` +
           `Expected: ${record.checksum}\n` +
           `Found:    ${currentChecksum}\n` +
           `Historical migration files must NEVER be edited after execution. Migration aborted.`
       );
   }
   ```
4. Only if all historical migrations pass checksum verification will new pending migrations be executed.

---

## 6. Migration Concurrency Locking

`[PROPOSED FUTURE BEHAVIOR]`

To prevent two concurrent CLI processes or application startups from running migrations simultaneously:
- A dedicated lock table `_migration_lock` will be utilized:
  ```sql
  CREATE TABLE IF NOT EXISTS _migration_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_locked INTEGER NOT NULL DEFAULT 0,
      locked_by TEXT NULL,
      locked_at DATETIME NULL
  );
  INSERT OR IGNORE INTO _migration_lock (id, is_locked) VALUES (1, 0);
  ```
- Migration runner acquires the lock atomically:
  ```sql
  UPDATE _migration_lock 
  SET is_locked = 1, locked_by = ?, locked_at = CURRENT_TIMESTAMP 
  WHERE id = 1 AND is_locked = 0;
  ```
- If rows modified = 0, the migration runner exits with:
  `"Migration lock is currently held by another process. Aborting."`

---

## 7. Rollback Safety & Classification of Irreversible Migrations

### 7.1 Reversible vs Irreversible Migrations
`[PROPOSED FUTURE BEHAVIOR]`

| Migration Type | Reversibility | Rollback Strategy |
| :--- | :--- | :--- |
| **New Tables (`product_prices`, `import_jobs`, `file_assets`)** | **Fully Reversible** | `DROP TABLE <table_name>;` |
| **New Indexes** | **Fully Reversible** | `DROP INDEX <index_name>;` |
| **New Columns (`ALTER TABLE ADD COLUMN`)** | **Requires Table Rebuild** | Drop requires 12-step table rebuild or SQLite 3.35+ `DROP COLUMN`. |
| **Data Backfills / Normalization** | **Irreversible / Complex** | Must have an explicit custom `down` migration script; cannot drop data. |
| **Quarantined Test Data Preservation** | **Protected** | Under no circumstance may a rollback touch records with `is_demo = 1`. |

### 7.2 Safety Invariant: Never Auto-Rollback Production Database
`[PROPOSED FUTURE BEHAVIOR]`

- The migration runner will **NEVER** execute an automated destructive rollback against the primary database.
- If a migration fails mid-execution:
  1. The transaction automatically rolls back.
  2. The pre-migration backup remains untouched on disk.
  3. The error is logged to `console.error` and process exits with code 1.
  4. Manual intervention or a restoration script using the verified backup is documented for administrators.

---

## 8. Isolated Restoration Test Protocol

`[PROPOSED FUTURE BEHAVIOR]`

Before any migration is permitted to execute against the working `zarsev.db`, the test suite runs the migration against a synthetic copy:

```
[Original zarsev.db] 
         │ (VACUUM INTO)
         ▼
[test/isolated_migration_test.db]
         │
         ├── Step 1: Run pending migration (up)
         ├── Step 2: Verify schema & data integrity
         ├── Step 3: Run rollback (down)
         ├── Step 4: Verify pre-migration state restored
         └── Step 5: If all pass -> Permit migration on working DB
```
