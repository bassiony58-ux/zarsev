-- ==============================================================================
-- Migration 010: Commercial Negotiations (Counter-Offers), Proforma Invoices,
--                Milestone Settlements, and Commercial Deal Closure.
-- ==============================================================================

-- 1. Commercial Negotiations & Counter-Offers Table
CREATE TABLE IF NOT EXISTS quotation_negotiations (
    id VARCHAR(64) PRIMARY KEY,
    quotation_id VARCHAR(64) NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
    rfq_id VARCHAR(64) NOT NULL REFERENCES rfqs(id),
    round_number INT NOT NULL DEFAULT 1,
    proposed_by VARCHAR(20) NOT NULL CHECK (proposed_by IN ('BUYER', 'MANUFACTURER')),
    proposed_price NUMERIC(15,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    proposed_quantity NUMERIC(12,2),
    incoterm VARCHAR(10) NOT NULL,
    proposed_moq NUMERIC(12,2),
    proposed_lead_time_days INT,
    buyer_notes TEXT,
    manufacturer_response TEXT,
    response_deadline DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_negotiations_quote ON quotation_negotiations(quotation_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_rfq ON quotation_negotiations(rfq_id);

-- 2. Structured Commercial Proforma Invoices Table
CREATE TABLE IF NOT EXISTS proforma_invoices (
    id VARCHAR(64) PRIMARY KEY,
    invoice_no VARCHAR(50) UNIQUE NOT NULL,
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    quotation_id VARCHAR(64) NOT NULL REFERENCES quotations(id),
    buyer_name VARCHAR(255) NOT NULL,
    buyer_company VARCHAR(255) NOT NULL,
    buyer_address TEXT,
    exporter_name VARCHAR(255) NOT NULL DEFAULT 'ZARSEV Sovereign Export Consortium',
    exporter_tax_no VARCHAR(50) NOT NULL DEFAULT 'EG-TAX-9823410',
    exporter_bank_details TEXT NOT NULL,
    incoterm VARCHAR(10) NOT NULL,
    pol VARCHAR(255) NOT NULL,
    pod VARCHAR(255) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    subtotal NUMERIC(15,2) NOT NULL,
    freight_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
    insurance_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(15,2) NOT NULL,
    payment_terms TEXT NOT NULL,
    issuance_date DATE NOT NULL,
    validity_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'ACCEPTED', 'SUPERSEDED', 'CANCELLED')),
    pdf_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proforma_contract ON proforma_invoices(contract_id);

-- 3. Commercial Settlement Milestones Table
CREATE TABLE IF NOT EXISTS commercial_settlements (
    id VARCHAR(64) PRIMARY KEY,
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    shipment_id VARCHAR(64) REFERENCES shipments(id),
    milestone VARCHAR(50) NOT NULL CHECK (milestone IN ('ADVANCE_DEPOSIT', 'AGAINST_BL_COPY', 'FINAL_BALANCE')),
    amount NUMERIC(15,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    due_date DATE NOT NULL,
    paid_date DATE,
    payment_reference VARCHAR(100),
    proof_file_path TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAYMENT_SUBMITTED', 'VERIFIED', 'OVERDUE')),
    verified_by VARCHAR(64) REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_settlement_contract ON commercial_settlements(contract_id);

-- 4. Commercial Deal Closure Table
CREATE TABLE IF NOT EXISTS commercial_closures (
    id VARCHAR(64) PRIMARY KEY,
    contract_id VARCHAR(64) UNIQUE NOT NULL REFERENCES commercial_contracts(id),
    closed_by VARCHAR(64) NOT NULL REFERENCES users(id),
    closed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    all_milestones_cleared BOOLEAN NOT NULL DEFAULT true,
    quality_signoff_complete BOOLEAN NOT NULL DEFAULT true,
    customs_clearance_confirmed BOOLEAN NOT NULL DEFAULT true,
    final_commercial_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
