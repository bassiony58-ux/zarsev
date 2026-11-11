-- Migration 004: Structured Commercial Quotations Subsystem
-- Target Database: zarsev_test (Isolated Verification Environment)
-- Architecture: Compliant with International Commercial Terms (Incoterms 2020)

-- 1. Add buyer_access_token to rfqs for secure, credentialed buyer tracking
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS buyer_access_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfqs_buyer_token ON rfqs(buyer_access_token);

-- 2. Create structured quotations table
CREATE TABLE IF NOT EXISTS quotations (
    id VARCHAR(64) PRIMARY KEY,
    reference_no VARCHAR(32) NOT NULL UNIQUE,
    rfq_id VARCHAR(64) NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    manufacturer_id VARCHAR(64) NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    created_by_user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price > 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    incoterm VARCHAR(20) NOT NULL,
    loading_port VARCHAR(100) NOT NULL,
    destination_port VARCHAR(100),
    min_order_quantity NUMERIC(14,2) NOT NULL DEFAULT 1 CHECK (min_order_quantity > 0),
    min_order_unit VARCHAR(32) NOT NULL DEFAULT 'MT',
    lead_time_days INTEGER NOT NULL CHECK (lead_time_days > 0),
    packaging_details TEXT NOT NULL,
    payment_terms VARCHAR(255) NOT NULL,
    validity_date DATE NOT NULL,
    additional_terms TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
    buyer_decision_at TIMESTAMPTZ,
    buyer_decision_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quotations_rfq_id ON quotations(rfq_id);
CREATE INDEX IF NOT EXISTS idx_quotations_mfg_id ON quotations(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);

-- 3. Create quotation audit logs
CREATE TABLE IF NOT EXISTS quotation_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    quotation_id VARCHAR(64) NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
    action VARCHAR(64) NOT NULL,
    actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN ('MANUFACTURER', 'SUPER_ADMIN', 'BUYER')),
    actor_id VARCHAR(64),
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quotation_audit_quot_id ON quotation_audit_logs(quotation_id);

-- 4. Least-Privilege Runtime Grants for zarsev_app
GRANT SELECT, INSERT, UPDATE, DELETE ON quotations TO zarsev_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON quotation_audit_logs TO zarsev_app;
GRANT USAGE, SELECT ON SEQUENCE quotation_audit_logs_id_seq TO zarsev_app;
