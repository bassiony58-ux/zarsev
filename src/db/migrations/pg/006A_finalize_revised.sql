-- ============================================================================
-- ZARSEV — Migration 006A: PART 2 — FINALIZE (REVISED)
-- File: 006A_finalize_revised.sql
-- Status: PREPARED SPECIFICATION FOR CONTROLLED EXECUTION
-- Execution Role: zarsev_migrator
-- Pre-requisites: 
--   1. 006A_provisioning_revised.sql must be already applied and verified.
--   2. Project owner must have explicitly executed decisions DEC-01, DEC-02, DEC-03.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. بوابة التحقق من القرارات DEC-01 و DEC-02 (حسم أدوار المصانع القائمة)
-- يفشل السكريبت فوراً ويجهض الـ Transaction إذا وُجد أي مستخدم مصنع نشط بدون دور
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_unassigned_count INT;
BEGIN
    SELECT COUNT(*) INTO v_unassigned_count
    FROM users 
    WHERE role = 'MANUFACTURER' AND is_active = true AND sub_role IS NULL;

    IF v_unassigned_count > 0 THEN
        RAISE EXCEPTION 'CANNOT_FINALIZE [DEC-01/DEC-02]: Found % active MANUFACTURER user(s) with sub_role IS NULL. Project owner must decide and set roles for existing accounts before running Finalize!', v_unassigned_count;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. بوابة التحقق من القرار DEC-03 (الحساب التاريخي اليتيم)
-- يتأكد من أن أي حساب مصنع بلا منشأة تنطبق عليه شروط الاستثناء الصارم بالضبط:
-- أن يكون الحساب التاريخي المحدد حصراً، وأن يكون معطلاً، وأن يحمل الاستثناء.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_invalid_orphan_count INT;
BEGIN
    SELECT COUNT(*) INTO v_invalid_orphan_count
    FROM users 
    WHERE role = 'MANUFACTURER' AND manufacturer_id IS NULL 
      AND NOT (id = 'usr_legacy_test_01' AND is_legacy_exempt = true AND is_active = false);

    IF v_invalid_orphan_count > 0 THEN
        RAISE EXCEPTION 'CANNOT_FINALIZE [DEC-03]: Found % orphan MANUFACTURER user(s) violating strict legacy exemption invariants! Aborting.', v_invalid_orphan_count;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. إزالة قيد السماح المؤقت بـ NULL واستبداله بقيد الإلزام القطعي الصارم
-- أثر القيد على المستخدمين المعطلين (Inactive Users):
-- - يُسمح للمستخدم المعطل (is_active = false) بالبقاء بـ sub_role = NULL.
-- - شرط إعادة التفعيل: لا يمكن تحويل أي مستخدم معطل إلى نشط إلا مع تعيين صريح لدور صالح.
-- ----------------------------------------------------------------------------
ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS chk_users_sub_role_values;

ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS chk_users_sub_role_strict;

ALTER TABLE users 
    ADD CONSTRAINT chk_users_sub_role_strict 
    CHECK (
        role != 'MANUFACTURER' 
        OR (is_active = false AND sub_role IS NULL)
        OR (sub_role IS NOT NULL AND sub_role IN ('OWNER', 'SALES', 'PRODUCTION', 'EXPORT'))
    );

COMMIT;
