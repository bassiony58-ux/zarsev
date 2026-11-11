-- ============================================================================
-- ZARSEV — Migration 006A Rollback Suite (REVISED)
-- File: rollback_006A_revised.sql
-- Status: PREPARED SPECIFICATION FOR CONTROLLED EXECUTION
-- Execution Role: zarsev_migrator
--
-- CRITICAL ARCHITECTURAL NOTICE (DEF-05):
-- 1. CTAS ARCHIVE LIMITATION:
--    The snapshot tables created below using `CREATE TABLE ... AS SELECT` (CTAS)
--    preserve raw column data only. PostgreSQL CTAS DOES NOT copy:
--      - Primary Key constraints (e.g. users.id, manufacturers.id)
--      - Foreign Key constraints (e.g. users.manufacturer_id)
--      - Unique constraints & partial indexes (e.g. uq_one_active_owner_per_mfg)
--      - Check constraints (e.g. chk_users_sub_role)
--      - Column DEFAULT expressions & Sequences
-- 2. RESTORATION PROCEDURE:
--    Do NOT assume this rollback or its CTAS snapshots restore full relational
--    schema integrity. Restoring from these snapshots requires the explicit Runbook:
--    `docs/RUNBOOK_MIGRATION_006A_ROLLBACK_AND_RESTORE.md`
-- 3. STOP CONDITION:
--    If any team invitations have status='ACCEPTED', rollback is strictly aborted
--    to prevent orphaning active tenant users.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1: بوابات الأمان التشغيلية وشروط التوقف الإداري (Stop Conditions)
-- ----------------------------------------------------------------------------
DO $$ 
DECLARE
    v_accepted_count INT := 0;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'manufacturer_invitations'
    ) THEN
        SELECT COUNT(*) INTO v_accepted_count 
        FROM manufacturer_invitations 
        WHERE status = 'ACCEPTED';

        IF v_accepted_count > 0 THEN
            RAISE EXCEPTION 'ROLLBACK_ABORTED: Found % accepted invitations. Rollback blocked because tenant team members exist. Requires manual data migration and export protocol.', v_accepted_count;
        END IF;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- STEP 2: تنفيذ التراجع والأرشفة الكاملة (Full Snapshot & Dynamic Registration)
-- ----------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS _migration_archive_log (
    id SERIAL PRIMARY KEY,
    migration_tag VARCHAR(50) NOT NULL,
    users_archive_table VARCHAR(100) NOT NULL,
    mfg_archive_table VARCHAR(100) NOT NULL,
    invitations_archive_table VARCHAR(100),
    archived_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
DECLARE
    v_ts TEXT := to_char(CURRENT_TIMESTAMP, 'YYYYMMDD_HH24MISS');
    v_users_archive TEXT := '_archive_006a_users_' || v_ts;
    v_mfg_archive TEXT := '_archive_006a_mfg_' || v_ts;
    v_invites_archive TEXT := '_archive_006a_invitations_' || v_ts;
BEGIN
    -- أرشفة كاملة لكافة الأعمدة الحالية
    EXECUTE format('
        CREATE TABLE %I AS 
        SELECT *, CURRENT_TIMESTAMP AS snapshot_archived_at 
        FROM users;', v_users_archive);

    EXECUTE format('
        CREATE TABLE %I AS 
        SELECT *, CURRENT_TIMESTAMP AS snapshot_archived_at 
        FROM manufacturers;', v_mfg_archive);

    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'manufacturer_invitations'
    ) THEN
        EXECUTE format('ALTER TABLE manufacturer_invitations RENAME TO %I;', v_invites_archive);
    ELSE
        v_invites_archive := NULL;
    END IF;

    INSERT INTO _migration_archive_log (
        migration_tag, users_archive_table, mfg_archive_table, invitations_archive_table
    ) VALUES (
        '006A', v_users_archive, v_mfg_archive, v_invites_archive
    );
END $$;

-- إسقاط الفهارس المستحدثة
DROP INDEX IF EXISTS uq_one_active_owner_per_mfg;
DROP INDEX IF EXISTS uq_one_pending_owner_invite_per_mfg;
DROP INDEX IF EXISTS uq_mfg_invitations_lower_pending;
DROP INDEX IF EXISTS idx_mfg_invitations_lookup;
DROP INDEX IF EXISTS uq_users_lower_email;
DROP INDEX IF EXISTS idx_mfg_docs_mfg_type;
DROP INDEX IF EXISTS idx_mfg_audit_mfg_created;

-- إسقاط الجداول المستحدثة
DROP TABLE IF EXISTS manufacturer_documents CASCADE;
DROP TABLE IF EXISTS manufacturer_audit_logs CASCADE;
DROP TABLE IF EXISTS manufacturer_invitations CASCADE;

-- إسقاط القيود المستحدثة
ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS chk_users_sub_role_strict,
    DROP CONSTRAINT IF EXISTS chk_users_sub_role_values,
    DROP CONSTRAINT IF EXISTS chk_mfg_user_has_id,
    DROP CONSTRAINT IF EXISTS chk_users_legacy_exempt_integrity;

-- إسقاط الأعمدة المستحدثة
ALTER TABLE users 
    DROP COLUMN IF EXISTS sub_role,
    DROP COLUMN IF EXISTS invited_by,
    DROP COLUMN IF EXISTS invitation_accepted_at,
    DROP COLUMN IF EXISTS is_legacy_exempt;

ALTER TABLE manufacturers 
    DROP COLUMN IF EXISTS is_active,
    DROP COLUMN IF EXISTS max_team_seats;

COMMIT;
