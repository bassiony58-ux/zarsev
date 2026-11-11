# ZARSEV — Migration 006A Rollback, Archive & Restore Runbook
## Standard Operating Procedure (SOP) for Database Recovery & Constraint Reconstruction

**Document ID:** `RUNBOOK-ZARSEV-MIG-006A-RESTORE`  
**Classification:** `INTERNAL ENGINEERING SPECIFICATION`  
**Applicability:** Migration 006A (Manufacturer Account Lifecycle & Multi-Tenant RBAC)  
**Target RDBMS:** PostgreSQL 16+  
**Execution Roles:** `zarsev_migrator` (DDL/Admin), `zarsev_app` (Runtime Verification)

---

## 1. Architectural Scope & Critical Warning (DEF-05)

> [!CAUTION]
> **CTAS SNAPSHOT LIMITATION — DO NOT ASSUME FULL SCHEMA PARITY**
> The rollback script `rollback_006A_revised.sql` creates archival snapshots using PostgreSQL `CREATE TABLE ... AS SELECT` (CTAS):
> - `_archive_006a_users_<timestamp>`
> - `_archive_006a_mfg_<timestamp>`
> - `_archive_006a_invitations_<timestamp>`
> 
> **PostgreSQL CTAS preserves column data only.** It **STRIPS** all:
> 1. Primary Key constraints (`PRIMARY KEY`).
> 2. Foreign Key constraints (`FOREIGN KEY ... REFERENCES ...`).
> 3. Unique constraints and Partial Indexes (`UNIQUE`, `CREATE UNIQUE INDEX ... WHERE ...`).
> 4. Check constraints (`CHECK (...)`).
> 5. Column Default values (`DEFAULT ...`) and Sequences.
> 
> Rolling back Migration 006A removes the new tables and columns. **Restoring data from the archival tables does NOT automatically restore database constraints.** A full relational reconstruction protocol must be followed as detailed below.

---

## 2. Emergency Rollback Evaluation Checklist

Before executing `rollback_006A_revised.sql`, the lead database administrator must verify:

1. **Stop Condition Verification**:
   ```sql
   SELECT count(*) AS accepted_invitations 
   FROM manufacturer_invitations 
   WHERE status = 'ACCEPTED';
   ```
   * If `accepted_invitations > 0`: **ROLLBACK IS HARD-BLOCKED.** New tenant users have already accepted invitations and established identities. Dropping tables would orphan user data. Manual export/migration is required.
   * If `accepted_invitations = 0`: Rollback may proceed safely under a maintenance lock.

2. **Pre-Rollback Physical Dump**:
   Always execute a physical `pg_dump` before invoking any DDL rollback:
   ```bash
   pg_dump -h localhost -p 5432 -U zarsev_migrator -d zarsev_dev -F c -b -v -f "zarsev_dev_pre_rollback_006a.dump"
   ```

---

## 3. Post-Rollback Archival Verification

When `rollback_006A_revised.sql` executes, it records the exact archive table names into `_migration_archive_log`:

```sql
SELECT id, migration_tag, users_archive_table, mfg_archive_table, invitations_archive_table, archived_at
FROM _migration_archive_log
ORDER BY id DESC
LIMIT 1;
```

**Verification Queries**:
```sql
-- 1. Verify archived row counts match pre-rollback counts
EXECUTE format('SELECT count(*) FROM %I', '<users_archive_table>');
EXECUTE format('SELECT count(*) FROM %I', '<mfg_archive_table>');
EXECUTE format('SELECT count(*) FROM %I', '<invitations_archive_table>');

-- 2. Verify new tables are dropped from active schema
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('manufacturer_invitations', 'manufacturer_documents', 'manufacturer_audit_logs');
-- Expected: 0 rows returned
```

---

## 4. Manual Schema & Constraint Reconstruction Protocol

If the engineering team decides to **restore** data from the `_archive_*` tables back into an active relational state, the following DDL must be applied sequentially.

### Phase 1: Reconstruct Primary & Foreign Keys on Restored Tables

```sql
-- If restoring invitations from _archive_006a_invitations_<ts>:
CREATE TABLE manufacturer_invitations (
    id VARCHAR(50) PRIMARY KEY,
    manufacturer_id VARCHAR(50) NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    sub_role VARCHAR(20) NOT NULL CONSTRAINT chk_mfg_inv_sub_role CHECK (sub_role IN ('OWNER', 'SALES', 'PRODUCTION', 'EXPORT')),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    invited_by VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CONSTRAINT chk_mfg_inv_status CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Copy data from archive into freshly constrained table
INSERT INTO manufacturer_invitations (
    id, manufacturer_id, email, sub_role, token_hash, invited_by, status, expires_at, accepted_at, created_at, updated_at
)
SELECT id, manufacturer_id, email, sub_role, token_hash, invited_by, status, expires_at, accepted_at, created_at, updated_at
FROM <invitations_archive_table>;
```

### Phase 2: Reconstruct Partial Unique Indexes

```sql
-- Partial unique index: Exactly 1 active OWNER per manufacturer
CREATE UNIQUE INDEX uq_one_active_owner_per_mfg 
    ON users (manufacturer_id) 
    WHERE role = 'MANUFACTURER' AND sub_role = 'OWNER' AND is_active = true;

-- Partial unique index: Only 1 pending invitation per email per manufacturer
CREATE UNIQUE INDEX uq_pending_invitation_per_mfg_email 
    ON manufacturer_invitations (manufacturer_id, LOWER(email)) 
    WHERE status = 'PENDING';
```

### Phase 3: Reconstruct Check Constraints

```sql
-- Sub-role domain restriction
ALTER TABLE users 
    ADD CONSTRAINT chk_users_sub_role 
    CHECK (sub_role IS NULL OR sub_role IN ('OWNER', 'SALES', 'PRODUCTION', 'EXPORT'));

-- Legacy exemption lock: Only usr_legacy_test_01 can ever have is_legacy_exempt = true
ALTER TABLE users 
    ADD CONSTRAINT chk_users_legacy_exempt 
    CHECK ((is_legacy_exempt = false) OR (id = 'usr_legacy_test_01' AND is_legacy_exempt = true));

-- Mandatory manufacturer_id constraint for all MANUFACTURER users (except DEC-03 legacy exempt)
ALTER TABLE users 
    ADD CONSTRAINT chk_mfg_user_has_id 
    CHECK (role != 'MANUFACTURER' OR manufacturer_id IS NOT NULL OR (id = 'usr_legacy_test_01' AND is_legacy_exempt = true));
```

### Phase 4: Reconstruct Immutable Audit Triggers & Permissions

```sql
-- Trigger function
CREATE OR REPLACE FUNCTION trg_mfg_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_VIOLATION: Audit log records in manufacturer_audit_logs cannot be modified, deleted, or truncated!';
END;
$$ LANGUAGE plpgsql;

-- Row-level trigger: blocks UPDATE and DELETE
DROP TRIGGER IF EXISTS trg_prevent_mfg_audit_mutation ON manufacturer_audit_logs;
CREATE TRIGGER trg_prevent_mfg_audit_mutation
    BEFORE UPDATE OR DELETE ON manufacturer_audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION trg_mfg_audit_logs_immutable();

-- Statement-level trigger: blocks TRUNCATE
DROP TRIGGER IF EXISTS trg_prevent_mfg_audit_truncate ON manufacturer_audit_logs;
CREATE TRIGGER trg_prevent_mfg_audit_truncate
    BEFORE TRUNCATE ON manufacturer_audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION trg_mfg_audit_logs_immutable();

-- Restrict application role
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_app') THEN
        REVOKE TRUNCATE, UPDATE, DELETE ON manufacturer_audit_logs FROM zarsev_app;
        GRANT SELECT, INSERT ON manufacturer_audit_logs TO zarsev_app;
    END IF;
END $$;
```

---

## 5. Post-Restoration Verification Checklist

After manual restoration, execute the following forensic integrity checks:

| Check | Expected Result | Verification Query |
| :--- | :--- | :--- |
| **Active Owner Invariant** | Exactly 1 active owner per active mfg | `SELECT manufacturer_id, count(*) FROM users WHERE role='MANUFACTURER' AND sub_role='OWNER' AND is_active=true GROUP BY manufacturer_id HAVING count(*) > 1;` (Expected: 0 rows) |
| **Unlinked Manufacturers** | 0 unlinked accounts (except DEC-03) | `SELECT count(*) FROM users WHERE role='MANUFACTURER' AND manufacturer_id IS NULL AND is_legacy_exempt=false;` (Expected: 0) |
| **Audit Log Mutation Block**| Rejected with `IMMUTABLE_VIOLATION` | Attempt `UPDATE manufacturer_audit_logs SET action='TEST'` (Must fail) |
| **Audit Log Truncate Block**| Rejected with `IMMUTABLE_VIOLATION` | Attempt `TRUNCATE manufacturer_audit_logs` (Must fail) |
| **Pending Invitations Count**| Accurately calculated against seats | Compare `SELECT count(*) FROM manufacturer_invitations WHERE status='PENDING'` with API response `/api/manufacturer/team` |

---
*Runbook maintained by ZARSEV Platform Security Team.*
