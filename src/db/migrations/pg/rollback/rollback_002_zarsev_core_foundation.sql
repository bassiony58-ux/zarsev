-- rollback_002_zarsev_core_foundation.sql
-- Non-destructive rollback for Migration 002 (PostgreSQL)

-- 1. Drop Child / Dependent Tables First
DROP TABLE IF EXISTS import_item_revisions;
DROP TABLE IF EXISTS import_attempts;
DROP TABLE IF EXISTS batch_source_files;

-- 2. Drop Foreign Keys and Columns added to Existing Tables
ALTER TABLE imports DROP CONSTRAINT IF EXISTS fk_imports_batch_id;
DROP INDEX IF EXISTS idx_imports_batch_id;
ALTER TABLE imports DROP COLUMN IF EXISTS batch_id;
ALTER TABLE imports DROP COLUMN IF EXISTS legal_hold;
ALTER TABLE imports DROP COLUMN IF EXISTS active_fencing_token;

DROP INDEX IF EXISTS idx_import_items_version;
ALTER TABLE import_items DROP COLUMN IF EXISTS modified_fields;
ALTER TABLE import_items DROP COLUMN IF EXISTS suggested_updates;
ALTER TABLE import_items DROP COLUMN IF EXISTS has_conflict;
ALTER TABLE import_items DROP COLUMN IF EXISTS lock_version;

-- 3. Drop Remaining Standalone / Parent Tables
DROP TABLE IF EXISTS import_batches;
DROP TABLE IF EXISTS import_idempotency_keys;

-- 4. Clean Migration Registry Record
DELETE FROM _pg_migrations WHERE name = '002_zarsev_core_foundation.sql';
