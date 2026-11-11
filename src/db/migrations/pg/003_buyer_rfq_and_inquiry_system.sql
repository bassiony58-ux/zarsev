-- 003_buyer_rfq_and_inquiry_system.sql
-- ZARSEV Global Trade Platform - International Buyer RFQ & Inquiry Management System

-- 1. RFQ (Request for Quote) Table
CREATE TABLE IF NOT EXISTS rfqs (
    id VARCHAR(64) PRIMARY KEY,
    reference_no VARCHAR(32) NOT NULL UNIQUE,
    buyer_name VARCHAR(150) NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    business_email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    country VARCHAR(100) NOT NULL,
    product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    manufacturer_id VARCHAR(64) NOT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
    assigned_manufacturer_id VARCHAR(64) NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    requested_quantity NUMERIC(12, 2) NOT NULL CHECK (requested_quantity > 0),
    unit_of_measurement VARCHAR(50) NOT NULL DEFAULT 'MT',
    destination_country VARCHAR(100) NOT NULL,
    destination_port VARCHAR(150) NULL,
    required_specifications JSONB NOT NULL DEFAULT '{}',
    additional_message TEXT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'NEW' CHECK (
        status IN ('NEW', 'UNDER_REVIEW', 'SENT_TO_MANUFACTURER', 'QUOTED', 'ACCEPTED', 'REJECTED', 'CLOSED')
    ),
    internal_notes TEXT NULL,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. RFQ Audit & Workflow History Table
CREATE TABLE IF NOT EXISTS rfq_audit_logs (
    id SERIAL PRIMARY KEY,
    rfq_id VARCHAR(64) NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    changed_by_user_id VARCHAR(64) NULL REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    from_status VARCHAR(50) NULL,
    to_status VARCHAR(50) NOT NULL,
    notes TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Contact Inquiries Table
CREATE TABLE IF NOT EXISTS contact_inquiries (
    id VARCHAR(64) PRIMARY KEY,
    reference_no VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    company VARCHAR(200) NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NULL,
    country VARCHAR(100) NULL,
    service_type VARCHAR(100) NOT NULL DEFAULT 'supply',
    product_id VARCHAR(64) NULL REFERENCES products(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'NEW' CHECK (
        status IN ('NEW', 'IN_REVIEW', 'RESOLVED', 'CLOSED')
    ),
    internal_notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance & Foreign Key Indexes
CREATE INDEX IF NOT EXISTS idx_rfqs_product_id ON rfqs(product_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_manufacturer_id ON rfqs(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_assigned_mfg ON rfqs(assigned_manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(status);
CREATE INDEX IF NOT EXISTS idx_rfqs_country ON rfqs(country);
CREATE INDEX IF NOT EXISTS idx_rfqs_created_at ON rfqs(created_at);
CREATE INDEX IF NOT EXISTS idx_rfqs_reference_no ON rfqs(reference_no);
CREATE INDEX IF NOT EXISTS idx_rfq_audit_rfq_id ON rfq_audit_logs(rfq_id);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_email ON contact_inquiries(email);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_status ON contact_inquiries(status);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_created_at ON contact_inquiries(created_at);

-- Security & Permissions Grant for runtime user (zarsev_app)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON rfqs TO zarsev_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON rfq_audit_logs TO zarsev_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON contact_inquiries TO zarsev_app;
        GRANT USAGE, SELECT ON SEQUENCE rfq_audit_logs_id_seq TO zarsev_app;
    END IF;
END $$;
