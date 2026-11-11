-- 002_zarsev_core_foundation.sql
-- ZARSEV Concurrency Foundation, Idempotency & Revision Schema (PostgreSQL)

-- 1. Idempotency Keys Table
CREATE TABLE IF NOT EXISTS import_idempotency_keys (
    key VARCHAR(255) NOT NULL,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manufacturer_id VARCHAR(64) NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    reservation_token VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    import_id VARCHAR(64) NULL REFERENCES imports(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED', 'COMMITTED', 'FAILED_QUOTA', 'RELEASED')),
    response_code INTEGER NULL,
    response_payload JSONB NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_status_expires ON import_idempotency_keys(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_import_id ON import_idempotency_keys(import_id);

-- 2. Import Batches Table (Durable Canonical Manifest)
CREATE TABLE IF NOT EXISTS import_batches (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    manufacturer_id VARCHAR(64) NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    manifest_hash VARCHAR(64) NOT NULL,
    canonical_manifest JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batches_manifest_hash ON import_batches(manifest_hash);

-- 3. Batch Source Files Table (Physical Object Identity & Decoupled Retention)
CREATE TABLE IF NOT EXISTS batch_source_files (
    id VARCHAR(64) PRIMARY KEY,
    batch_id VARCHAR(64) NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    file_sha256 VARCHAR(64) NOT NULL,
    storage_object_uuid VARCHAR(64) NOT NULL,
    storage_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    deletion_status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK(deletion_status IN ('ACTIVE', 'DELETING', 'PURGED')),
    deletion_operation_id VARCHAR(64) NULL,
    deletion_started_at TIMESTAMPTZ NULL,
    purged_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batch_files_sha256_status ON batch_source_files(file_sha256, deletion_status);
CREATE INDEX IF NOT EXISTS idx_batch_files_op_id ON batch_source_files(deletion_operation_id);

-- 4. Import Attempts Table (Worker Fencing, Attempt Witness & Atomic Sealing)
CREATE TABLE IF NOT EXISTS import_attempts (
    id VARCHAR(64) PRIMARY KEY,
    import_id VARCHAR(64) NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    fencing_token VARCHAR(64) NOT NULL,
    attempt_token VARCHAR(64) NOT NULL,
    final_status VARCHAR(50) NOT NULL DEFAULT 'RUNNING' CHECK(final_status IN ('RUNNING', 'COMMITTED', 'TERMINATED_ABORTED', 'OUTCOME_UNKNOWN')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    committed_at TIMESTAMPTZ NULL,
    terminated_at TIMESTAMPTZ NULL,
    CONSTRAINT uq_import_attempt_num UNIQUE(import_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_import_fencing ON import_attempts(import_id, fencing_token);

-- 5. Expand Imports Table with Governance Columns
ALTER TABLE imports ADD COLUMN IF NOT EXISTS active_fencing_token VARCHAR(64) NULL;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS batch_id VARCHAR(64) NULL REFERENCES import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_imports_batch_id ON imports(batch_id);

-- 6. Expand Import Items Table with Concurrency & Human Edits Columns
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS lock_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS has_conflict BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS suggested_updates JSONB NULL;
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS modified_fields JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_import_items_version ON import_items(id, lock_version);

-- 7. Import Item Revisions Table (Immutable Audit Trail for Human Edits)
CREATE TABLE IF NOT EXISTS import_item_revisions (
    id VARCHAR(64) PRIMARY KEY,
    item_id VARCHAR(64) NOT NULL REFERENCES import_items(id) ON DELETE CASCADE,
    editor_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    previous_data JSONB NOT NULL,
    applied_updates JSONB NOT NULL,
    lock_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_item_revisions_item_id ON import_item_revisions(item_id, lock_version);
