-- ZARSEV Global Trade Platform - Database Schema (SQLite)

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NULL,
    role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN', 'LOGISTICS_OFFICER', 'MANUFACTURER', 'ADMIN', 'LOGISTICS', 'BUYER')),
    sub_role TEXT NULL,
    manufacturer_id TEXT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_demo INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 1,
    invited_by TEXT NULL,
    invitation_accepted_at DATETIME NULL,
    is_legacy_exempt INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    allowed_formats TEXT NOT NULL, -- JSON array
    max_products_per_import INTEGER NOT NULL,
    max_monthly_imports INTEGER NOT NULL,
    max_file_size_mb INTEGER NOT NULL,
    ai_extraction_enabled INTEGER NOT NULL DEFAULT 1, -- 0 or 1
    bulk_import_enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manufacturers (
    id TEXT PRIMARY KEY,
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    business_model TEXT NOT NULL CHECK(business_model IN ('DIRECT_CONTRACT', 'MARKETING_SUBSCRIPTION')),
    subscription_id TEXT NULL,
    country TEXT NOT NULL DEFAULT 'مصر',
    city TEXT NOT NULL,
    contact_email TEXT NULL,
    contact_phone TEXT NULL,
    is_verified INTEGER NOT NULL DEFAULT 1,
    is_demo INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    max_team_seats INTEGER DEFAULT 2,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    parent_id TEXT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    icon TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(parent_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL,
    category_id TEXT NULL,
    subcategory_id TEXT NULL,
    sku TEXT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT NULL,
    description_ar TEXT NULL,
    description_en TEXT NULL,
    specifications TEXT NULL, -- JSON object
    packaging_info TEXT NULL,
    country_of_origin TEXT NOT NULL DEFAULT 'مصر',
    price REAL NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    price_unit TEXT NOT NULL DEFAULT 'MT',
    moq TEXT NULL,
    available_quantity TEXT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED')),
    rejection_reason TEXT NULL,
    source_import_id TEXT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    url TEXT NOT NULL,
    thumbnail_url TEXT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    dhash TEXT NULL,
    file_size INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    manufacturer_id TEXT NULL,
    manifest_hash TEXT NOT NULL,
    canonical_manifest TEXT NOT NULL, -- JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id)
);

CREATE TABLE IF NOT EXISTS batch_source_files (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    storage_object_uuid TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    deletion_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(deletion_status IN ('ACTIVE', 'DELETING', 'PURGED')),
    deletion_operation_id TEXT NULL,
    deletion_started_at DATETIME NULL,
    purged_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    manufacturer_id TEXT NULL,
    batch_id TEXT NULL,
    source_files TEXT NOT NULL, -- JSON array of file metadata
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PARSING', 'EXTRACTING', 'REVIEW_READY', 'SAVED_DRAFT', 'SUBMITTED', 'FAILED')),
    active_fencing_token TEXT NULL,
    legal_hold INTEGER NOT NULL DEFAULT 0,
    total_detected INTEGER NOT NULL DEFAULT 0,
    total_valid INTEGER NOT NULL DEFAULT 0,
    total_failed INTEGER NOT NULL DEFAULT 0,
    progress_percent INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS import_idempotency_keys (
    key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    manufacturer_id TEXT NULL,
    reservation_token TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    import_id TEXT NULL,
    status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED', 'COMMITTED', 'FAILED_QUOTA', 'RELEASED')),
    response_code INTEGER NULL,
    response_payload TEXT NULL, -- JSON
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key, user_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id) ON DELETE SET NULL,
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS import_attempts (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    fencing_token TEXT NOT NULL,
    attempt_token TEXT NOT NULL,
    final_status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(final_status IN ('RUNNING', 'COMMITTED', 'TERMINATED_ABORTED', 'OUTCOME_UNKNOWN')),
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    committed_at DATETIME NULL,
    terminated_at DATETIME NULL,
    UNIQUE(import_id, attempt_number),
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_items (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    suggested_manufacturer_id TEXT NULL,
    suggested_category_id TEXT NULL,
    raw_data TEXT NULL, -- JSON
    extracted_data TEXT NOT NULL, -- JSON product fields
    suggested_updates TEXT NULL, -- JSON
    modified_fields TEXT NULL, -- JSON array
    confidence_score REAL NOT NULL DEFAULT 1.0,
    validation_warnings TEXT NULL, -- JSON array of warnings
    is_duplicate INTEGER NOT NULL DEFAULT 0,
    duplicate_matched_id TEXT NULL,
    duplicate_reason TEXT NULL,
    assigned_images TEXT NULL, -- JSON array: [{url, is_primary, thumbnail}]
    status TEXT NOT NULL DEFAULT 'AWAITING_REVIEW' CHECK(status IN ('AWAITING_REVIEW', 'READY', 'SKIPPED', 'SAVED', 'FAILED')),
    lock_version INTEGER NOT NULL DEFAULT 1,
    has_conflict INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_item_revisions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    editor_user_id TEXT NOT NULL,
    previous_data TEXT NOT NULL, -- JSON
    applied_updates TEXT NOT NULL, -- JSON
    lock_version INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(item_id) REFERENCES import_items(id) ON DELETE CASCADE,
    FOREIGN KEY(editor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS import_logs (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    step TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'INFO' CHECK(severity IN ('INFO', 'WARNING', 'ERROR')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
);


-- ==============================================================================


-- ==============================================================================
-- RFQ, Quotations & Manufacturer Lifecycle Tables (SQLite Parity)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS rfqs (
    id TEXT PRIMARY KEY,
    reference_no TEXT NOT NULL UNIQUE,
    buyer_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    business_email TEXT NOT NULL,
    phone TEXT NOT NULL,
    country TEXT NOT NULL,
    product_id TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    assigned_manufacturer_id TEXT NULL,
    requested_quantity REAL NOT NULL CHECK (requested_quantity > 0),
    unit_of_measurement TEXT NOT NULL DEFAULT 'MT',
    destination_country TEXT NOT NULL,
    destination_port TEXT NULL,
    required_specifications TEXT NOT NULL DEFAULT '{}',
    target_price REAL NULL,
    target_currency TEXT NOT NULL DEFAULT 'USD',
    incoterm TEXT NULL,
    expected_delivery_date TEXT NULL,
    packaging_requirements TEXT NULL,
    buyer_notes TEXT NULL,
    status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'UNDER_REVIEW', 'SENT_TO_MANUFACTURER', 'QUOTED', 'ACCEPTED', 'REJECTED', 'CLOSED')),
    action_note TEXT NULL,
    buyer_access_token TEXT NULL,
    buyer_access_token_hash TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(assigned_manufacturer_id) REFERENCES manufacturers(id)
);

CREATE TABLE IF NOT EXISTS rfq_audit_logs (
    id TEXT PRIMARY KEY,
    rfq_id TEXT NOT NULL,
    action TEXT NOT NULL,
    from_status TEXT NULL,
    to_status TEXT NULL,
    notes TEXT NULL,
    metadata TEXT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(rfq_id) REFERENCES rfqs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contact_inquiries (
    id TEXT PRIMARY KEY,
    reference_no TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    country TEXT NOT NULL,
    product_id TEXT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'NEW',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS quotations (
    id TEXT PRIMARY KEY,
    reference_no TEXT NOT NULL UNIQUE,
    rfq_id TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    created_by_user_id TEXT NULL,
    price_per_unit REAL NOT NULL CHECK (price_per_unit > 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    incoterm TEXT NOT NULL,
    port_of_loading TEXT NULL,
    port_of_discharge TEXT NULL,
    min_order_quantity REAL NOT NULL,
    min_order_unit TEXT NOT NULL DEFAULT 'MT',
    lead_time_days INTEGER NOT NULL,
    validity_date TEXT NOT NULL,
    payment_terms TEXT NULL,
    packaging_details TEXT NULL,
    notes TEXT NULL,
    status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
    buyer_decision_at DATETIME NULL,
    buyer_decision_notes TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(rfq_id) REFERENCES rfqs(id) ON DELETE CASCADE,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS quotation_audit_logs (
    id TEXT PRIMARY KEY,
    quotation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    notes TEXT NULL,
    metadata TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS manufacturer_invitations (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL,
    email TEXT NOT NULL,
    sub_role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(invited_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS manufacturer_documents (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL,
    document_type TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    sha256_hash TEXT NOT NULL,
    is_confidential INTEGER NOT NULL DEFAULT 1,
    uploaded_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS manufacturer_audit_logs (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NULL,
    details TEXT NULL,
    ip_address TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id)
);


-- ZARSEV Extended Business Workflow Tables (SQLite Test Parity)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS staff_invitations (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'ADMIN',
    sub_role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(invited_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_type TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title_ar TEXT NOT NULL,
    title_en TEXT NOT NULL,
    body_ar TEXT NOT NULL,
    body_en TEXT NOT NULL,
    payload TEXT DEFAULT '{}',
    reference_type TEXT,
    reference_id TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    read_at DATETIME,
    idempotency_key TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    processed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_inquiry_logs (
    id TEXT PRIMARY KEY,
    inquiry_id TEXT NOT NULL,
    officer_id TEXT NOT NULL,
    officer_name TEXT NOT NULL,
    contact_method TEXT NOT NULL,
    contact_date DATETIME NOT NULL,
    notes TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(inquiry_id) REFERENCES contact_inquiries(id) ON DELETE CASCADE,
    FOREIGN KEY(officer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS commercial_contracts (
    id TEXT PRIMARY KEY,
    contract_no TEXT UNIQUE NOT NULL,
    rfq_id TEXT NOT NULL,
    quotation_id TEXT NOT NULL UNIQUE,
    manufacturer_id TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_email TEXT NOT NULL,
    buyer_company TEXT NOT NULL,
    total_amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    incoterm TEXT NOT NULL,
    port_of_loading TEXT,
    port_of_discharge TEXT,
    payment_terms TEXT NOT NULL,
    delivery_deadline TEXT NOT NULL,
    buyer_decision_at DATETIME NOT NULL,
    quotation_validity_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(rfq_id) REFERENCES rfqs(id),
    FOREIGN KEY(quotation_id) REFERENCES quotations(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id)
);

CREATE TABLE IF NOT EXISTS contract_audit_logs (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    notes TEXT,
    metadata TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS production_batches (
    id TEXT PRIMARY KEY,
    batch_no TEXT UNIQUE NOT NULL,
    contract_id TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    lot_number TEXT NOT NULL,
    target_quantity REAL NOT NULL,
    produced_quantity REAL NOT NULL DEFAULT 0,
    rejected_quantity REAL NOT NULL DEFAULT 0,
    uom TEXT NOT NULL DEFAULT 'KG',
    start_date TEXT,
    end_date TEXT,
    stage TEXT NOT NULL DEFAULT 'RAW_MATERIAL_INTAKE',
    readiness_pct INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS production_stage_logs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    quantity_in REAL NOT NULL DEFAULT 0,
    quantity_out REAL NOT NULL DEFAULT 0,
    rejected_qty REAL NOT NULL DEFAULT 0,
    operator_name TEXT NOT NULL,
    notes TEXT,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(batch_id) REFERENCES production_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qc_inspections (
    id TEXT PRIMARY KEY,
    inspection_no TEXT UNIQUE NOT NULL,
    batch_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    inspection_type TEXT NOT NULL,
    sample_size REAL NOT NULL,
    inspected_quantity REAL NOT NULL,
    defect_count INTEGER NOT NULL DEFAULT 0,
    rejection_rate REAL NOT NULL DEFAULT 0,
    verdict TEXT NOT NULL,
    defect_details TEXT DEFAULT '[]',
    inspector_id TEXT NOT NULL,
    inspector_name TEXT NOT NULL,
    inspected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(batch_id) REFERENCES production_batches(id),
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id)
);

CREATE TABLE IF NOT EXISTS qa_reviews (
    id TEXT PRIMARY KEY,
    inspection_id TEXT NOT NULL,
    qa_officer_id TEXT NOT NULL,
    qa_officer_name TEXT NOT NULL,
    review_verdict TEXT NOT NULL,
    coa_verified INTEGER NOT NULL DEFAULT 0,
    lab_accreditation TEXT,
    capa_notes TEXT,
    signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(inspection_id) REFERENCES qc_inspections(id) ON DELETE CASCADE,
    FOREIGN KEY(qa_officer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS mrl_limits (
    id TEXT PRIMARY KEY,
    market_country TEXT NOT NULL,
    commodity TEXT NOT NULL,
    active_substance TEXT NOT NULL,
    limit_mg_kg REAL NOT NULL,
    statutory_source TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    review_date TEXT,
    verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
    toxicological_adi_note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(market_country, commodity, active_substance)
);

CREATE TABLE IF NOT EXISTS conditional_releases (
    id TEXT PRIMARY KEY,
    inspection_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    permitted_conditions TEXT NOT NULL,
    remedial_actions TEXT NOT NULL,
    target_market TEXT NOT NULL,
    lead_qc_signoff TEXT NOT NULL,
    ops_director_signoff TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    deadline DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(inspection_id) REFERENCES qc_inspections(id),
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id)
);

CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    shipment_no TEXT UNIQUE NOT NULL,
    contract_id TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    carrier_name TEXT NOT NULL,
    vessel_name TEXT NOT NULL,
    voyage_no TEXT NOT NULL,
    booking_reference TEXT NOT NULL,
    container_no TEXT NOT NULL,
    container_type TEXT NOT NULL DEFAULT '40FT_REEFER',
    pol TEXT NOT NULL,
    pod TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    loading_date TEXT,
    etd TEXT NOT NULL,
    eta TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'BOOKED',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id)
);

CREATE TABLE IF NOT EXISTS reefer_telemetry (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL,
    container_no TEXT NOT NULL,
    recorded_at_utc DATETIME NOT NULL,
    setpoint_temp REAL NOT NULL,
    supply_temp REAL NOT NULL,
    return_temp REAL NOT NULL,
    ambient_temp REAL,
    humidity_pct REAL,
    power_status TEXT NOT NULL DEFAULT 'ON',
    sensor_source TEXT NOT NULL DEFAULT 'CARRIER_IOT_TELEMETRY',
    breach_flag INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reefer_breach_events (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL,
    container_no TEXT NOT NULL,
    breach_type TEXT NOT NULL,
    max_deviation_c REAL NOT NULL,
    duration_minutes INTEGER NOT NULL,
    detected_at DATETIME NOT NULL,
    resolved_at DATETIME,
    severity TEXT NOT NULL DEFAULT 'CRITICAL',
    notes TEXT,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shipping_documents (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    doc_number TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_hash_sha256 TEXT NOT NULL,
    bl_status TEXT NOT NULL DEFAULT 'DRAFT',
    version INTEGER NOT NULL DEFAULT 1,
    uploaded_by TEXT NOT NULL,
    verified_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id)
);

CREATE TABLE IF NOT EXISTS quotation_negotiations (
    id TEXT PRIMARY KEY,
    quotation_id TEXT NOT NULL,
    rfq_id TEXT NOT NULL,
    round_number INTEGER NOT NULL DEFAULT 1,
    proposed_by TEXT NOT NULL,
    proposed_price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    proposed_quantity REAL,
    incoterm TEXT NOT NULL,
    proposed_moq REAL,
    proposed_lead_time_days INTEGER,
    buyer_notes TEXT,
    manufacturer_response TEXT,
    response_deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME,
    FOREIGN KEY(quotation_id) REFERENCES quotations(id) ON DELETE CASCADE,
    FOREIGN KEY(rfq_id) REFERENCES rfqs(id)
);

CREATE TABLE IF NOT EXISTS proforma_invoices (
    id TEXT PRIMARY KEY,
    invoice_no TEXT UNIQUE NOT NULL,
    contract_id TEXT NOT NULL,
    quotation_id TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_company TEXT NOT NULL,
    buyer_address TEXT,
    exporter_name TEXT NOT NULL DEFAULT 'ZARSEV Sovereign Export Consortium',
    exporter_tax_no TEXT NOT NULL DEFAULT 'EG-TAX-9823410',
    exporter_bank_details TEXT NOT NULL,
    incoterm TEXT NOT NULL,
    pol TEXT NOT NULL,
    pod TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    subtotal REAL NOT NULL,
    freight_cost REAL NOT NULL DEFAULT 0,
    insurance_cost REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL,
    payment_terms TEXT NOT NULL,
    issuance_date TEXT NOT NULL,
    validity_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ISSUED',
    pdf_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id),
    FOREIGN KEY(quotation_id) REFERENCES quotations(id)
);

CREATE TABLE IF NOT EXISTS commercial_settlements (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    shipment_id TEXT,
    milestone TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    due_date TEXT NOT NULL,
    paid_date TEXT,
    payment_reference TEXT,
    proof_file_path TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    verified_by TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id),
    FOREIGN KEY(shipment_id) REFERENCES shipments(id),
    FOREIGN KEY(verified_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS commercial_closures (
    id TEXT PRIMARY KEY,
    contract_id TEXT UNIQUE NOT NULL,
    closed_by TEXT NOT NULL,
    closed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    all_milestones_cleared INTEGER NOT NULL DEFAULT 1,
    quality_signoff_complete INTEGER NOT NULL DEFAULT 1,
    customs_clearance_confirmed INTEGER NOT NULL DEFAULT 1,
    final_commercial_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(contract_id) REFERENCES commercial_contracts(id),
    FOREIGN KEY(closed_by) REFERENCES users(id)
);


CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
    action TEXT NOT NULL,
    target_id TEXT NULL,
    details TEXT NULL,
    ip_address TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
