-- ==============================================================================
-- Migration 007: Admin Staff Invitations, Transactional Outbox Notifications,
--                and Contact Inquiry Proof-of-Contact Logs.
-- ==============================================================================

-- 1. Admin Staff Invitations Table
CREATE TABLE IF NOT EXISTS staff_invitations (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN', 'LOGISTICS')),
    sub_role VARCHAR(50) NOT NULL CHECK (sub_role IN ('SUPER_ADMIN', 'LOGISTICS_OFFICER')),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    invited_by VARCHAR(64) NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staff_invitations_email ON staff_invitations(email);
CREATE INDEX IF NOT EXISTS idx_staff_invitations_status ON staff_invitations(status);
CREATE INDEX IF NOT EXISTS idx_staff_invitations_token_hash ON staff_invitations(token_hash);

-- 2. In-App Notifications & Transactional Outbox Table
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    recipient_type VARCHAR(50) NOT NULL CHECK (recipient_type IN ('USER', 'MANUFACTURER', 'BUYER', 'ADMIN', 'LOGISTICS')),
    recipient_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    title_ar TEXT NOT NULL,
    title_en TEXT NOT NULL,
    body_ar TEXT NOT NULL,
    body_en TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    reference_type VARCHAR(50),
    reference_id VARCHAR(64),
    is_read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    idempotency_key VARCHAR(128) UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER')),
    retry_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_type, recipient_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_outbox_queue ON notifications(status, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_idempotency ON notifications(idempotency_key);

-- 2.1 Central Platform & Admin Governance Audit Logs Table
CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    actor_id VARCHAR(64) NOT NULL,
    actor_type VARCHAR(50) NOT NULL DEFAULT 'SUPER_ADMIN',
    action VARCHAR(100) NOT NULL,
    target_id VARCHAR(64),
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_actor ON platform_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_action ON platform_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(created_at);

-- 3. Contact Inquiry Proof-of-Contact & Audit Logs Table
CREATE TABLE IF NOT EXISTS contact_inquiry_logs (
    id VARCHAR(64) PRIMARY KEY,
    inquiry_id VARCHAR(64) NOT NULL REFERENCES contact_inquiries(id) ON DELETE CASCADE,
    officer_id VARCHAR(64) NOT NULL REFERENCES users(id),
    officer_name VARCHAR(255) NOT NULL,
    contact_method VARCHAR(50) NOT NULL CHECK (contact_method IN ('PHONE', 'EMAIL', 'WHATSAPP', 'IN_PERSON', 'OFFICIAL_LETTER')),
    contact_date TIMESTAMPTZ NOT NULL,
    notes TEXT NOT NULL,
    from_status VARCHAR(20) NOT NULL,
    to_status VARCHAR(20) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inquiry_logs_inquiry_id ON contact_inquiry_logs(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_logs_officer_id ON contact_inquiry_logs(officer_id);

-- 4. Update contact_inquiries status check constraint to support 6 full lifecycle states
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'contact_inquiries_status_check'
    ) THEN
        ALTER TABLE contact_inquiries DROP CONSTRAINT contact_inquiries_status_check;
    END IF;
    ALTER TABLE contact_inquiries ADD CONSTRAINT contact_inquiries_status_check 
        CHECK (status IN ('NEW', 'IN_REVIEW', 'CONTACTED', 'RESOLVED', 'CLOSED', 'SPAM'));
EXCEPTION
    WHEN OTHERS THEN
        NULL;
END $$;
