-- ==============================================================================
-- Migration 008: Commercial Contracts, Production Tracking, Quality Control (QC),
--                Quality Assurance (QA), Statutory MRL Engine, and Conditional Release.
-- ==============================================================================

-- 1. Commercial Contracts Table
CREATE TABLE IF NOT EXISTS commercial_contracts (
    id VARCHAR(64) PRIMARY KEY,
    contract_no VARCHAR(50) UNIQUE NOT NULL,
    rfq_id VARCHAR(64) NOT NULL REFERENCES rfqs(id),
    quotation_id VARCHAR(64) NOT NULL REFERENCES quotations(id) CONSTRAINT uq_contract_quotation_id UNIQUE,
    manufacturer_id VARCHAR(64) NOT NULL REFERENCES manufacturers(id),
    buyer_name VARCHAR(255) NOT NULL,
    buyer_email VARCHAR(255) NOT NULL,
    buyer_company VARCHAR(255) NOT NULL,
    total_amount NUMERIC(15,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    incoterm VARCHAR(10) NOT NULL,
    port_of_loading VARCHAR(255),
    port_of_discharge VARCHAR(255),
    payment_terms TEXT NOT NULL,
    delivery_deadline DATE NOT NULL,
    buyer_decision_at TIMESTAMPTZ NOT NULL,
    quotation_validity_date DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'QUALITY_PENDING', 'SHIPPED', 'COMPLETED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contracts_mfg ON commercial_contracts(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_rfq ON commercial_contracts(rfq_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON commercial_contracts(status);

-- 2. Contract Audit Logs
CREATE TABLE IF NOT EXISTS contract_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    actor_type VARCHAR(50) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    notes TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contract_audit_contract ON contract_audit_logs(contract_id);

-- 3. Production Batches Table
CREATE TABLE IF NOT EXISTS production_batches (
    id VARCHAR(64) PRIMARY KEY,
    batch_no VARCHAR(50) UNIQUE NOT NULL,
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    manufacturer_id VARCHAR(64) NOT NULL REFERENCES manufacturers(id),
    product_id VARCHAR(64) NOT NULL REFERENCES products(id),
    lot_number VARCHAR(100) NOT NULL,
    target_quantity NUMERIC(12,2) NOT NULL,
    produced_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
    rejected_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
    uom VARCHAR(20) NOT NULL DEFAULT 'KG',
    start_date DATE,
    end_date DATE,
    stage VARCHAR(30) NOT NULL DEFAULT 'RAW_MATERIAL_INTAKE' CHECK (stage IN ('RAW_MATERIAL_INTAKE', 'SORTING_GRADING', 'PROCESSING', 'PACKING', 'STORAGE', 'DISPATCH_READY')),
    readiness_pct INT NOT NULL DEFAULT 0 CHECK (readiness_pct >= 0 AND readiness_pct <= 100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_production_batches_contract ON production_batches(contract_id);
CREATE INDEX IF NOT EXISTS idx_production_batches_mfg ON production_batches(manufacturer_id);

-- 4. Production Stage Logs
CREATE TABLE IF NOT EXISTS production_stage_logs (
    id VARCHAR(64) PRIMARY KEY,
    batch_id VARCHAR(64) NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
    stage VARCHAR(30) NOT NULL,
    quantity_in NUMERIC(12,2) NOT NULL DEFAULT 0,
    quantity_out NUMERIC(12,2) NOT NULL DEFAULT 0,
    rejected_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
    operator_name VARCHAR(255) NOT NULL,
    notes TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stage_logs_batch ON production_stage_logs(batch_id);

-- 5. Quality Control (QC) Inspections Table
CREATE TABLE IF NOT EXISTS qc_inspections (
    id VARCHAR(64) PRIMARY KEY,
    inspection_no VARCHAR(50) UNIQUE NOT NULL,
    batch_id VARCHAR(64) NOT NULL REFERENCES production_batches(id),
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    inspection_type VARCHAR(30) NOT NULL CHECK (inspection_type IN ('RAW_INTAKE', 'SORTING', 'IN_LINE', 'PACKING', 'PRE_SHIPMENT')),
    sample_size NUMERIC(12,2) NOT NULL,
    inspected_quantity NUMERIC(12,2) NOT NULL,
    defect_count INT NOT NULL DEFAULT 0,
    rejection_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    verdict VARCHAR(30) NOT NULL CHECK (verdict IN ('PASSED', 'REJECTED', 'CONDITIONAL_RELEASE')),
    defect_details JSONB DEFAULT '[]'::jsonb,
    inspector_id VARCHAR(64) NOT NULL,
    inspector_name VARCHAR(255) NOT NULL,
    inspected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_qc_inspections_batch ON qc_inspections(batch_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspections_contract ON qc_inspections(contract_id);

-- 6. Quality Assurance (QA) Reviews Table
CREATE TABLE IF NOT EXISTS qa_reviews (
    id VARCHAR(64) PRIMARY KEY,
    inspection_id VARCHAR(64) NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,
    qa_officer_id VARCHAR(64) NOT NULL REFERENCES users(id),
    qa_officer_name VARCHAR(255) NOT NULL,
    review_verdict VARCHAR(30) NOT NULL CHECK (review_verdict IN ('APPROVED', 'REVISE_REQUIRED', 'REJECTED')),
    coa_verified BOOLEAN NOT NULL DEFAULT false,
    lab_accreditation VARCHAR(255),
    capa_notes TEXT,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_qa_reviews_inspection ON qa_reviews(inspection_id);

-- 7. Statutory MRL Limits Engine Table
CREATE TABLE IF NOT EXISTS mrl_limits (
    id VARCHAR(64) PRIMARY KEY,
    market_country VARCHAR(100) NOT NULL,
    commodity VARCHAR(100) NOT NULL,
    active_substance VARCHAR(100) NOT NULL,
    limit_mg_kg NUMERIC(8,4) NOT NULL,
    statutory_source VARCHAR(255) NOT NULL,
    effective_date DATE NOT NULL,
    review_date DATE,
    verification_status VARCHAR(20) NOT NULL DEFAULT 'VERIFIED' CHECK (verification_status IN ('VERIFIED', 'UNVERIFIED')),
    toxicological_adi_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_mrl_market_commodity_substance UNIQUE (market_country, commodity, active_substance)
);

CREATE INDEX IF NOT EXISTS idx_mrl_lookup ON mrl_limits(market_country, commodity);

-- 8. Conditional Releases Table
CREATE TABLE IF NOT EXISTS conditional_releases (
    id VARCHAR(64) PRIMARY KEY,
    inspection_id VARCHAR(64) NOT NULL REFERENCES qc_inspections(id),
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    reason TEXT NOT NULL,
    permitted_conditions TEXT NOT NULL,
    remedial_actions TEXT NOT NULL,
    target_market VARCHAR(100) NOT NULL,
    lead_qc_signoff VARCHAR(255) NOT NULL,
    ops_director_signoff VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'FULFILLED', 'REVOKED')),
    deadline TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conditional_releases_contract ON conditional_releases(contract_id);
