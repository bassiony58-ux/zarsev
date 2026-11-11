-- ==============================================================================
-- Migration 009: Logistics Shipments, Reefer Telemetry & Deviation Tracking,
--                and Commercial Shipping Documents & B/L Lifecycle.
-- ==============================================================================

-- 1. Shipments Table
CREATE TABLE IF NOT EXISTS shipments (
    id VARCHAR(64) PRIMARY KEY,
    shipment_no VARCHAR(50) UNIQUE NOT NULL,
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    manufacturer_id VARCHAR(64) NOT NULL REFERENCES manufacturers(id),
    carrier_name VARCHAR(255) NOT NULL,
    vessel_name VARCHAR(255) NOT NULL,
    voyage_no VARCHAR(50) NOT NULL,
    booking_reference VARCHAR(100) NOT NULL,
    container_no VARCHAR(50) NOT NULL,
    container_type VARCHAR(50) NOT NULL DEFAULT '40FT_REEFER',
    pol VARCHAR(255) NOT NULL,
    pod VARCHAR(255) NOT NULL,
    booking_date DATE NOT NULL,
    loading_date DATE,
    etd DATE NOT NULL,
    eta DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED', 'LOADING', 'IN_TRANSIT', 'ARRIVED', 'CUSTOMS_CLEARED', 'DELIVERED', 'CANCELLED')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shipments_contract ON shipments(contract_id);
CREATE INDEX IF NOT EXISTS idx_shipments_mfg ON shipments(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_shipments_container ON shipments(container_no);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);

-- 2. Reefer Temperature Telemetry Table
CREATE TABLE IF NOT EXISTS reefer_telemetry (
    id VARCHAR(64) PRIMARY KEY,
    shipment_id VARCHAR(64) NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    container_no VARCHAR(50) NOT NULL,
    recorded_at_utc TIMESTAMPTZ NOT NULL,
    setpoint_temp NUMERIC(4,2) NOT NULL,
    supply_temp NUMERIC(4,2) NOT NULL,
    return_temp NUMERIC(4,2) NOT NULL,
    ambient_temp NUMERIC(4,2),
    humidity_pct NUMERIC(4,1),
    power_status VARCHAR(20) NOT NULL DEFAULT 'ON' CHECK (power_status IN ('ON', 'OFF', 'STANDBY', 'DEFROST')),
    sensor_source VARCHAR(100) NOT NULL DEFAULT 'CARRIER_IOT_TELEMETRY',
    breach_flag BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reefer_shipment_time ON reefer_telemetry(shipment_id, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_reefer_container_time ON reefer_telemetry(container_no, recorded_at_utc DESC);

-- 3. Reefer Temperature Breach Events Table
CREATE TABLE IF NOT EXISTS reefer_breach_events (
    id VARCHAR(64) PRIMARY KEY,
    shipment_id VARCHAR(64) NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    container_no VARCHAR(50) NOT NULL,
    breach_type VARCHAR(50) NOT NULL CHECK (breach_type IN ('CONTINUOUS_OVER_120MIN', 'CUMULATIVE_OVER_360MIN_24H', 'TELEMETRY_DROPOUT_OVER_180MIN')),
    max_deviation_c NUMERIC(4,2) NOT NULL,
    duration_minutes INT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    severity VARCHAR(20) NOT NULL DEFAULT 'CRITICAL' CHECK (severity IN ('WARNING', 'CRITICAL', 'FATAL')),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_reefer_breach_shipment ON reefer_breach_events(shipment_id);

-- 4. Commercial Shipping Documents & Bill of Lading (B/L) Table
CREATE TABLE IF NOT EXISTS shipping_documents (
    id VARCHAR(64) PRIMARY KEY,
    shipment_id VARCHAR(64) NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    contract_id VARCHAR(64) NOT NULL REFERENCES commercial_contracts(id),
    doc_type VARCHAR(50) NOT NULL CHECK (doc_type IN ('COMMERCIAL_INVOICE', 'PACKING_LIST', 'CERTIFICATE_OF_ORIGIN', 'PHYTOSANITARY', 'COA', 'BILL_OF_LADING', 'INSURANCE')),
    doc_number VARCHAR(100) NOT NULL,
    file_path TEXT NOT NULL,
    file_hash_sha256 VARCHAR(64) NOT NULL,
    bl_status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (bl_status IN ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'ORIGINAL_ISSUED', 'TELEX_RELEASE')),
    version INT NOT NULL DEFAULT 1,
    uploaded_by VARCHAR(64) NOT NULL,
    verified_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shipping_docs_shipment ON shipping_documents(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipping_docs_contract ON shipping_documents(contract_id);
