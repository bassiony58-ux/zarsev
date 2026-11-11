-- ============================================================================
-- ZARSEV — Migration 006A: PART 1 — PROVISIONING (REVISED)
-- File: 006A_provisioning_revised.sql
-- Status: PREPARED SPECIFICATION FOR CONTROLLED EXECUTION
-- Execution Role: zarsev_migrator
-- Features:
--   - Non-breaking schema additions (is_active, sub_role, max_team_seats, etc.)
--   - Strict legacy exemption condition for DEC-03 (chk_mfg_user_has_id)
--   - Strict exclusion of non-legacy accounts from exemption (chk_users_legacy_exempt_integrity)
--   - Single active owner partial unique index (uq_one_active_owner_per_mfg)
--   - Team Invitations table (manufacturer_invitations)
--   - Secure Documents table (manufacturer_documents)
--   - Immutable Audit Logs table with trigger (manufacturer_audit_logs)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. إضافة حقل النشاط والمقاعد للمنشآت الصناعية
-- ----------------------------------------------------------------------------
ALTER TABLE manufacturers 
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS max_team_seats INT DEFAULT 2;

-- ----------------------------------------------------------------------------
-- 2. إضافة أعمدة الأدوار الفرعية والدعوات وحقل الاستثناء لجدول المستخدمين
-- ----------------------------------------------------------------------------
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS sub_role VARCHAR(20) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS invited_by VARCHAR(50) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS invitation_accepted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS is_legacy_exempt BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
-- 3. بوابة التحقق من حسم القرار DEC-03 (DEC-03 Pre-condition Gate)
-- تمنع الترقية من الفشل الصامت إذا وُجد حساب مصنع يتيم غير مسموح له بالاستثناء
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_orphan_count INT;
BEGIN
    SELECT COUNT(*) INTO v_orphan_count
    FROM users 
    WHERE role = 'MANUFACTURER' 
      AND manufacturer_id IS NULL 
      AND is_legacy_exempt = false;

    IF v_orphan_count > 0 THEN
        RAISE EXCEPTION 'CANNOT_PROVISION [DEC-03]: Found % orphan MANUFACTURER user(s) with is_legacy_exempt = false. Project owner must resolve DEC-03 before running Provisioning!', v_orphan_count;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. قيد سلامة الاستثناء التاريخي الصارم (Enforced by PostgreSQL Engine)
-- يمنع منعاً باتاً أن يحمل أي مستخدم آخر في المنظومة قيمة is_legacy_exempt = true
-- ----------------------------------------------------------------------------
ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS chk_users_legacy_exempt_integrity;

ALTER TABLE users 
    ADD CONSTRAINT chk_users_legacy_exempt_integrity
    CHECK (
        (is_legacy_exempt = false) OR 
        (is_legacy_exempt = true AND id = 'usr_legacy_test_01')
    );

-- ----------------------------------------------------------------------------
-- 5. قيد الأدوار الفرعية المصرح بها (مرحلة التجهيز: يسمح بـ NULL مؤقتاً للحسابات القائمة)
-- ----------------------------------------------------------------------------
ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS chk_users_sub_role_values;

ALTER TABLE users 
    ADD CONSTRAINT chk_users_sub_role_values 
    CHECK (sub_role IS NULL OR sub_role IN ('OWNER', 'SALES', 'PRODUCTION', 'EXPORT'));

-- ----------------------------------------------------------------------------
-- 6. قيد إلزام تبعية مستخدم المصنع لمنشأة صناعية معتمدة (النسخة المصححة)
-- الاستثناء الوحيد والمحصور: usr_legacy_test_01 فقط، وبشرطين متلازمين:
-- أن يكون is_legacy_exempt = true AND is_active = false.
-- ----------------------------------------------------------------------------
ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS chk_mfg_user_has_id;

ALTER TABLE users 
    ADD CONSTRAINT chk_mfg_user_has_id 
    CHECK (
        role != 'MANUFACTURER' 
        OR manufacturer_id IS NOT NULL 
        OR (id = 'usr_legacy_test_01' AND is_legacy_exempt = true AND is_active = false)
    );

-- ----------------------------------------------------------------------------
-- 7. فهرس تفرد البريد الإلكتروني غير الحساس لحالة الأحرف
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_lower_email 
    ON users (LOWER(email));

-- ----------------------------------------------------------------------------
-- 8. فهرس منع تعدد المالكين النشطين للمنشأة الواحدة
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_owner_per_mfg 
    ON users (manufacturer_id) 
    WHERE role = 'MANUFACTURER' AND sub_role = 'OWNER' AND is_active = true;

-- ----------------------------------------------------------------------------
-- 9. إنشاء جدول دعوات أعضاء فريق المصنع
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturer_invitations (
    id VARCHAR(50) PRIMARY KEY,
    manufacturer_id VARCHAR(50) NOT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS idx_mfg_invitations_lookup 
    ON manufacturer_invitations (manufacturer_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_invitations_lower_pending 
    ON manufacturer_invitations (manufacturer_id, LOWER(email)) 
    WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_owner_invite_per_mfg 
    ON manufacturer_invitations (manufacturer_id) 
    WHERE sub_role = 'OWNER' AND status = 'PENDING';

-- ----------------------------------------------------------------------------
-- 10. إنشاء جدول مستندات المصانع الآمنة
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturer_documents (
    id VARCHAR(50) PRIMARY KEY,
    manufacturer_id VARCHAR(50) NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    doc_type VARCHAR(20) NOT NULL CONSTRAINT chk_mfg_doc_type CHECK (doc_type IN ('LEGAL', 'EXPORT')),
    title VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_size INT NOT NULL,
    uploaded_by_user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mfg_docs_mfg_type 
    ON manufacturer_documents (manufacturer_id, doc_type);

-- ----------------------------------------------------------------------------
-- 11. إنشاء جدول وسجلات التدقيق المحصنة للمصانع
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturer_audit_logs (
    id VARCHAR(50) PRIMARY KEY,
    manufacturer_id VARCHAR(50) NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    actor_id VARCHAR(50) NOT NULL,
    actor_type VARCHAR(20) NOT NULL DEFAULT 'USER',
    action VARCHAR(50) NOT NULL,
    target_id VARCHAR(50),
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mfg_audit_mfg_created 
    ON manufacturer_audit_logs (manufacturer_id, created_at DESC);

-- Trigger to prevent UPDATE and DELETE on audit logs (Immutable rows)
CREATE OR REPLACE FUNCTION trg_mfg_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_VIOLATION: Audit log records in manufacturer_audit_logs cannot be modified, deleted, or truncated!';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_mfg_audit_mutation ON manufacturer_audit_logs;
CREATE TRIGGER trg_prevent_mfg_audit_mutation
    BEFORE UPDATE OR DELETE ON manufacturer_audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION trg_mfg_audit_logs_immutable();

-- Trigger to prevent TRUNCATE on audit logs (Immutable statement-level)
DROP TRIGGER IF EXISTS trg_prevent_mfg_audit_truncate ON manufacturer_audit_logs;
CREATE TRIGGER trg_prevent_mfg_audit_truncate
    BEFORE TRUNCATE ON manufacturer_audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION trg_mfg_audit_logs_immutable();

-- ----------------------------------------------------------------------------
-- 12. تشديد صلاحيات دور التطبيق (Role Privilege Hardening)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_app') THEN
        REVOKE TRUNCATE, UPDATE, DELETE ON manufacturer_audit_logs FROM zarsev_app;
        GRANT SELECT, INSERT ON manufacturer_audit_logs TO zarsev_app;
    END IF;
END $$;

COMMIT;
