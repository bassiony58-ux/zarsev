/**
 * test/test_p0_security_and_banking.js
 * 
 * Automated Verification Suite for ZARSEV P0 Remediation:
 * 1. SEC-IDOR-01 — Ocean Shipment Access Control & Multi-Tenant IDOR Prevention:
 *    - TC-SEC-SHP-01: Unauthenticated request -> HTTP 401 Unauthorized
 *    - TC-SEC-SHP-02: Cross-tenant Manufacturer B -> HTTP 403 Forbidden (FORBIDDEN_TENANT_ACCESS)
 *    - TC-SEC-SHP-03: Cross-buyer Buyer Y -> HTTP 403 Forbidden (FORBIDDEN_BUYER_ACCESS)
 *    - TC-SEC-SHP-04: Authorized Manufacturer A -> HTTP 200 with operational data & factory notes
 *    - TC-SEC-SHP-05: Authorized Buyer X (JWT & x-buyer-token) -> HTTP 200 with notes strictly REDACTED
 *    - TC-SEC-SHP-06: Logistics Officer & Super Admin -> HTTP 200 with full unredacted data
 *    - TC-SEC-SHP-07: Non-existent shipment with valid auth -> HTTP 404 Not Found (SHIPMENT_NOT_FOUND)
 * 
 * 2. FIN-BANK-02 — Proforma Invoice Bank Details Safety & Zero-Leakage:
 *    - TC-FIN-BANK-01: Unapproved proforma invoice defaults to official PENDING notice
 *    - TC-FIN-BANK-02: Zero-leakage verification (0 IBAN / 0 SWIFT in JSON, HTTP, and DB)
 *    - TC-FIN-BANK-03: Controlled owner authorization gate verification
 * 
 * Strictly operates against an isolated SQLite test database in test/sandbox/.
 * ZERO connection/writes to zarsev.db or PostgreSQL 5432.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setupTestEnvironment, cleanupTestDatabase, REAL_DB_PATH } = require('./test_helper');
const { generateToken } = require('../src/utils/authUtils');
const settlementService = require('../src/services/settlementService');
const app = require('../src/app');

function getDbHash() {
    if (!fs.existsSync(REAL_DB_PATH)) return null;
    const buf = fs.readFileSync(REAL_DB_PATH);
    return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

async function runP0TestSuite() {
    console.log('================================================================');
    console.log('🛡️  ZARSEV P0 SECURITY & BANKING REMEDIATION TEST SUITE');
    console.log('================================================================\n');

    // 1. Snapshot Real DB Hash before tests
    const preTestHash = getDbHash();
    console.log(`[PRE-TEST INTEGRITY] zarsev.db SHA256: ${preTestHash}`);

    // 2. Setup isolated sandbox environment
    const { db, isolatedDbPath } = setupTestEnvironment('p0_security_banking');
    console.log(`[SANDBOX INITIALIZED] DB: ${path.basename(isolatedDbPath)}`);

    const TEST_PORT = 3399;
    let server = null;
    const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

    let passCount = 0;
    let failCount = 0;

    function recordPass(testCode, description) {
        console.log(`  ✅ [PASS] ${testCode}: ${description}`);
        passCount++;
    }

    function recordFail(testCode, description, err) {
        console.error(`  ❌ [FAIL] ${testCode}: ${description}`);
        console.error(`     Error: ${err.message || err}`);
        failCount++;
    }

    try {
        // Start test HTTP server
        await new Promise((resolve) => {
            server = app.listen(TEST_PORT, () => resolve());
        });

        // =====================================================================
        // FIXTURE SETUP (Using Seeded Core Entities)
        // =====================================================================
        console.log('\n--- Seeding Isolated Test Fixtures ---');

        // Configure roles and sub-roles on seeded users
        db.prepare("UPDATE users SET sub_role = 'SUPER_ADMIN', role = 'ADMIN', is_demo = 0 WHERE id = 'usr_super_admin'").run();
        db.prepare("UPDATE users SET sub_role = 'LOGISTICS_OFFICER', role = 'LOGISTICS', is_demo = 0 WHERE id = 'usr_logistics_officer'").run();
        db.prepare("UPDATE users SET manufacturer_id = 'mfg_delta_iqf', sub_role = 'OWNER', role = 'MANUFACTURER', is_demo = 0 WHERE id = 'usr_mfg_delta_iqf'").run();
        db.prepare("UPDATE users SET manufacturer_id = 'mfg_nile_fruits', sub_role = 'OWNER', role = 'MANUFACTURER', is_demo = 0 WHERE id = 'usr_mfg_nile_fruits'").run();

        // Insert Buyer Users
        const dummyPasswordHash = crypto.createHash('sha256').update('TestPassword123!').digest('hex');
        db.prepare(`
            INSERT OR REPLACE INTO users (id, name, email, password_hash, role, sub_role, manufacturer_id, is_active, token_version, is_demo)
            VALUES
            ('usr_buyer_x', 'Alice Importer', 'buyer_x@importer.test', ?, 'BUYER', NULL, NULL, 1, 1, 0),
            ('usr_buyer_y', 'Bob Overseas', 'buyer_y@overseas.test', ?, 'BUYER', NULL, NULL, 1, 1, 0)
        `).run(dummyPasswordHash, dummyPasswordHash);

        // Buyer Tokens for x-buyer-token access
        const buyerXRawToken = 'buyer_x_secret_access_token_xyz_123';
        const buyerXTokenHash = crypto.createHash('sha256').update(buyerXRawToken).digest('hex');

        const buyerYRawToken = 'buyer_y_secret_access_token_uvw_456';
        const buyerYTokenHash = crypto.createHash('sha256').update(buyerYRawToken).digest('hex');

        // Insert RFQs
        db.prepare(`
            INSERT OR REPLACE INTO rfqs (
                id, reference_no, buyer_name, company_name, business_email, phone, country,
                product_id, manufacturer_id, requested_quantity, unit_of_measurement,
                destination_country, required_specifications, status, buyer_access_token, buyer_access_token_hash
            ) VALUES 
            ('rfq_p0_x', 'RFQ-P0-X', 'Alice Importer', 'Alice Global Ltd', 'buyer_x@importer.test',
             '+44 20 7946 0912', 'United Kingdom', 'prod_iqf_straw_02', 'mfg_delta_iqf', 25, 'MT',
             'United Kingdom', '{}', 'ACCEPTED', ?, ?),
            ('rfq_p0_y', 'RFQ-P0-Y', 'Bob Overseas', 'Bob Overseas Ltd', 'buyer_y@overseas.test',
             '+31 20 794 0912', 'Netherlands', 'prod_iqf_straw_02', 'mfg_nile_fruits', 25, 'MT',
             'Netherlands', '{}', 'ACCEPTED', ?, ?)
        `).run(buyerXRawToken, buyerXTokenHash, buyerYRawToken, buyerYTokenHash);

        // Insert Quotation
        db.prepare(`
            INSERT OR REPLACE INTO quotations (
                id, reference_no, rfq_id, manufacturer_id, product_id,
                price_per_unit, currency, incoterm, min_order_quantity,
                lead_time_days, validity_date, status
            ) VALUES (
                'quote_p0_delta', 'Q-P0-DELTA', 'rfq_p0_x', 'mfg_delta_iqf', 'prod_iqf_straw_02',
                1800, 'USD', 'FOB', 20, 14, '2026-12-31', 'ACCEPTED'
            )
        `).run();

        // Insert Commercial Contract (Manufacturer Delta IQF <--> Buyer X)
        db.prepare(`
            INSERT OR REPLACE INTO commercial_contracts (
                id, contract_no, rfq_id, quotation_id, manufacturer_id,
                buyer_name, buyer_email, buyer_company,
                total_amount, currency, incoterm, port_of_loading, port_of_discharge,
                payment_terms, delivery_deadline, buyer_decision_at, quotation_validity_date,
                status
            ) VALUES (
                'contract_p0_delta_x', 'CTR-P0-2026-001', 'rfq_p0_x', 'quote_p0_delta', 'mfg_delta_iqf',
                'Alice Importer', 'buyer_x@importer.test', 'Alice Global Ltd',
                45000, 'USD', 'FOB', 'Alexandria Port', 'Rotterdam Port',
                '30% Advance Deposit, 70% against Ocean B/L', '2026-12-31', CURRENT_TIMESTAMP, '2026-11-30',
                'CONFIRMED'
            )
        `).run();

        // Insert Shipment for Manufacturer Delta IQF
        const internalFactoryNotes = 'CONFIDENTIAL_FACTORY_NOTE: Target temperature -18C verified. Seal #98234 applied.';
        db.prepare(`
            INSERT OR REPLACE INTO shipments (
                id, shipment_no, contract_id, manufacturer_id, carrier_name, vessel_name, voyage_no,
                booking_reference, container_no, container_type, pol, pod, booking_date,
                etd, eta, status, notes
            ) VALUES (
                'shipment_p0_delta_01', 'SHP-P0-DELTA-01', 'contract_p0_delta_x', 'mfg_delta_iqf', 'Maersk Line', 'Maersk McKinney', '2601W',
                'BKG-DELTA-991', 'MSKU1234567', '40FT_REEFER', 'Alexandria Port', 'Rotterdam Port', '2026-11-01',
                '2026-11-15', '2026-11-28', 'BOOKED', ?
            )
        `).run(internalFactoryNotes);

        // Insert Telemetry
        db.prepare(`
            INSERT OR REPLACE INTO reefer_telemetry (
                id, shipment_id, container_no, recorded_at_utc, setpoint_temp,
                supply_temp, return_temp, ambient_temp, humidity_pct, power_status, sensor_source
            ) VALUES (
                'telem_p0_01', 'shipment_p0_delta_01', 'MSKU1234567', CURRENT_TIMESTAMP, -18.0,
                -18.1, -17.8, 22.5, 88.0, 'ON', 'CARRIER_IOT_TELEMETRY'
            )
        `).run();

        // Generate JWT Tokens
        const tokenSuperAdmin = generateToken({ id: 'usr_super_admin', email: 'admin@zarsev.com' });
        const tokenLogistics = generateToken({ id: 'usr_logistics_officer', email: 'logistics@zarsev.com' });
        const tokenMfgDelta = generateToken({ id: 'usr_mfg_delta_iqf', email: 'delta_sales@company.com' });
        const tokenMfgNile = generateToken({ id: 'usr_mfg_nile_fruits', email: 'nile_export@company.com' });
        const tokenBuyerX = generateToken({ id: 'usr_buyer_x', email: 'buyer_x@importer.test' });
        const tokenBuyerY = generateToken({ id: 'usr_buyer_y', email: 'buyer_y@overseas.test' });

        console.log('✅ Fixtures successfully initialized in sandbox.');

        // =====================================================================
        // PART 1: SEC-IDOR-01 — SHIPMENT ACCESS CONTROL & MULTI-TENANT ISOLATION
        // =====================================================================
        console.log('\n--- Part 1: SEC-IDOR-01 Shipment Access Control Verification ---');

        // TC-SEC-SHP-01: Unauthenticated request -> HTTP 401 Unauthorized
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`);
            const body = await res.json();
            assert.strictEqual(res.status, 401, 'Unauthenticated request must return HTTP 401');
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.code, 'UNAUTHORIZED');
            recordPass('TC-SEC-SHP-01', 'Unauthenticated request strictly returns HTTP 401 Unauthorized');
        } catch (e) { recordFail('TC-SEC-SHP-01', 'Unauthenticated request rejection', e); }

        // TC-SEC-SHP-02: Cross-tenant Manufacturer B (Nile Fruits) -> HTTP 403 Forbidden
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'Authorization': `Bearer ${tokenMfgNile}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 403, 'Cross-tenant manufacturer must receive HTTP 403');
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.code, 'FORBIDDEN_TENANT_ACCESS');
            recordPass('TC-SEC-SHP-02', 'Cross-tenant Manufacturer B strictly forbidden from accessing Manufacturer A shipment (403)');
        } catch (e) { recordFail('TC-SEC-SHP-02', 'Cross-tenant manufacturer rejection', e); }

        // TC-SEC-SHP-03: Cross-buyer Buyer Y -> HTTP 403 Forbidden
        // Sub-test A: via JWT
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'Authorization': `Bearer ${tokenBuyerY}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 403, 'Cross-buyer must receive HTTP 403');
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.code, 'FORBIDDEN_BUYER_ACCESS');
            recordPass('TC-SEC-SHP-03-A', 'Cross-buyer Buyer Y (JWT) strictly forbidden from accessing Buyer X shipment (403)');
        } catch (e) { recordFail('TC-SEC-SHP-03-A', 'Cross-buyer JWT rejection', e); }

        // Sub-test B: via x-buyer-token header
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'x-buyer-token': buyerYRawToken }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 403, 'Cross-buyer via x-buyer-token must receive HTTP 403');
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.code, 'FORBIDDEN_BUYER_ACCESS');
            recordPass('TC-SEC-SHP-03-B', 'Cross-buyer Buyer Y (x-buyer-token) strictly forbidden from accessing Buyer X shipment (403)');
        } catch (e) { recordFail('TC-SEC-SHP-03-B', 'Cross-buyer token header rejection', e); }

        // TC-SEC-SHP-04: Authorized Manufacturer A (Delta IQF) -> HTTP 200 with operational data & factory notes
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'Authorization': `Bearer ${tokenMfgDelta}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 200, 'Authorized manufacturer must receive HTTP 200');
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.shipment.id, 'shipment_p0_delta_01');
            assert.strictEqual(body.shipment.container_no, 'MSKU1234567');
            assert.strictEqual(body.shipment.notes, internalFactoryNotes, 'Manufacturer must see internal factory notes');
            assert.ok(Array.isArray(body.telemetry) && body.telemetry.length >= 1, 'Telemetry records must be present');
            recordPass('TC-SEC-SHP-04', 'Authorized Manufacturer A accesses full operational shipment data with factory notes (200)');
        } catch (e) { recordFail('TC-SEC-SHP-04', 'Authorized manufacturer access', e); }

        // TC-SEC-SHP-05: Authorized Buyer X -> HTTP 200 with notes strictly REDACTED
        // Sub-test A: Authorized Buyer X via JWT
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'Authorization': `Bearer ${tokenBuyerX}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 200, 'Authorized buyer must receive HTTP 200');
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.shipment.id, 'shipment_p0_delta_01');
            assert.strictEqual(body.shipment.container_no, 'MSKU1234567');
            assert.strictEqual(body.shipment.notes, undefined, 'Internal factory notes must be strictly REDACTED from buyer view');
            assert.ok(!JSON.stringify(body.shipment).includes('CONFIDENTIAL_FACTORY_NOTE'), 'Zero leakage of factory notes in buyer JSON');
            recordPass('TC-SEC-SHP-05-A', 'Authorized Buyer X (JWT) accesses shipment with internal factory notes strictly REDACTED (200)');
        } catch (e) { recordFail('TC-SEC-SHP-05-A', 'Authorized buyer JWT access with redaction', e); }

        // Sub-test B: Authorized Buyer X via x-buyer-token header
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'x-buyer-token': buyerXRawToken }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 200, 'Authorized buyer via x-buyer-token must receive HTTP 200');
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.shipment.id, 'shipment_p0_delta_01');
            assert.strictEqual(body.shipment.notes, undefined, 'Internal factory notes must be strictly REDACTED from buyer view');
            assert.ok(!JSON.stringify(body.shipment).includes('CONFIDENTIAL_FACTORY_NOTE'), 'Zero leakage of factory notes in buyer JSON');
            recordPass('TC-SEC-SHP-05-B', 'Authorized Buyer X (x-buyer-token) accesses shipment with internal notes strictly REDACTED (200)');
        } catch (e) { recordFail('TC-SEC-SHP-05-B', 'Authorized buyer token access with redaction', e); }

        // TC-SEC-SHP-06: Administrative & Logistics Roles -> HTTP 200 with full unredacted data
        // Sub-test A: Super Admin
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'Authorization': `Bearer ${tokenSuperAdmin}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.shipment.notes, internalFactoryNotes, 'Super Admin must see full notes');
            recordPass('TC-SEC-SHP-06-A', 'Super Admin accesses shipment with full unredacted audit details (200)');
        } catch (e) { recordFail('TC-SEC-SHP-06-A', 'Super admin shipment access', e); }

        // Sub-test B: Logistics Officer
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/shipment_p0_delta_01`, {
                headers: { 'Authorization': `Bearer ${tokenLogistics}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.shipment.notes, internalFactoryNotes, 'Logistics Officer must see full notes');
            recordPass('TC-SEC-SHP-06-B', 'Logistics Officer accesses shipment with full unredacted details (200)');
        } catch (e) { recordFail('TC-SEC-SHP-06-B', 'Logistics officer shipment access', e); }

        // TC-SEC-SHP-07: Non-existent shipment with valid auth -> HTTP 404
        try {
            const res = await fetch(`${BASE_URL}/api/shipping/shipments/non_existent_shipment_id_999`, {
                headers: { 'Authorization': `Bearer ${tokenSuperAdmin}` }
            });
            const body = await res.json();
            assert.strictEqual(res.status, 404);
            assert.strictEqual(body.success, false);
            assert.strictEqual(body.code, 'SHIPMENT_NOT_FOUND');
            recordPass('TC-SEC-SHP-07', 'Non-existent shipment ID returns HTTP 404 SHIPMENT_NOT_FOUND');
        } catch (e) { recordFail('TC-SEC-SHP-07', 'Non-existent shipment handling', e); }

        // =====================================================================
        // PART 2: FIN-BANK-02 — PROFORMA INVOICE BANK DETAILS SAFETY & ZERO LEAKAGE
        // =====================================================================
        console.log('\n--- Part 2: FIN-BANK-02 Bank Details Safety & Zero-Leakage Verification ---');

        // Clear any lingering environment variables
        delete process.env.BANK_DETAILS_APPROVED;
        delete process.env.SETTLEMENT_IBAN;
        delete process.env.SETTLEMENT_SWIFT;
        delete process.env.SETTLEMENT_BANK_NAME;
        delete process.env.SETTLEMENT_BENEFICIARY;

        // TC-FIN-BANK-01: Proforma Invoice Generation with Unapproved Defaults
        let generatedPi = null;
        try {
            generatedPi = await settlementService.generateProformaInvoice({
                contractId: 'contract_p0_delta_x'
            });

            assert.ok(generatedPi.invoice_no.startsWith('PI-'), 'Invoice number must be prefixed with PI-');
            assert.strictEqual(generatedPi.bank_approval_status, 'PENDING_OWNER_AUTHORIZATION');
            assert.ok(
                generatedPi.bank_details.includes('PAYMENT INSTRUCTIONS PENDING FORMAL COMMERCIAL BOARD DESIGNATION'),
                'Must strictly include official pending notice'
            );
            assert.ok(
                generatedPi.bank_details.includes('تعليمات السداد المصرفي قيد الاعتماد من مجلس إدارة المشروع'),
                'Must include official Arabic notice'
            );

            // Assert absolute absence of old hardcoded fallback credentials
            assert.ok(!generatedPi.bank_details.includes('EG450002000100000002938472910'), 'ZERO legacy IBAN permitted');
            assert.ok(!generatedPi.bank_details.includes('NBEGEGCX001'), 'ZERO legacy SWIFT permitted');
            assert.ok(!generatedPi.bank_details.includes('National Bank of Egypt'), 'ZERO unverified bank name permitted');

            recordPass('TC-FIN-BANK-01', 'Proforma invoice generation outputs strictly official PENDING notice with zero fake credentials');
        } catch (e) { recordFail('TC-FIN-BANK-01', 'Proforma invoice generation with safe defaults', e); }

        // TC-FIN-BANK-02: Zero-Leakage Across HTTP API, Database & Logs
        try {
            // Check HTTP GET endpoint
            const res = await fetch(`${BASE_URL}/api/settlement/proforma/contract_p0_delta_x`);
            const body = await res.json();
            assert.strictEqual(res.status, 200, 'GET /proforma/:contractId must return 200');
            assert.strictEqual(body.success, true);
            assert.ok(body.invoice, 'Invoice object must be returned');

            const invoiceJson = JSON.stringify(body.invoice);

            // Regex for any Egyptian IBAN pattern: EG + 2 digits + 25 alphanumeric chars
            const ibanRegex = /\bEG\d{2}[A-Z0-9]{25}\b/gi;
            const ibanMatches = invoiceJson.match(ibanRegex);
            assert.strictEqual(ibanMatches, null, `Found unexpected IBAN pattern in API response: ${ibanMatches}`);

            // Regex for SWIFT code pattern
            const swiftRegex = /\b[A-Z]{4}EG[A-Z0-9]{2,5}\b/g;
            const swiftMatches = invoiceJson.match(swiftRegex);
            assert.strictEqual(swiftMatches, null, `Found unexpected SWIFT pattern in API response: ${swiftMatches}`);

            // Inspect DB row in sandbox SQLite
            const dbRow = db.prepare('SELECT * FROM proforma_invoices WHERE contract_id = ?').get('contract_p0_delta_x');
            assert.ok(dbRow, 'Proforma invoice record must exist in DB');
            assert.ok(dbRow.exporter_bank_details.includes('PAYMENT INSTRUCTIONS PENDING FORMAL COMMERCIAL BOARD DESIGNATION'));
            assert.ok(!dbRow.exporter_bank_details.includes('EG45'));
            assert.ok(!dbRow.exporter_bank_details.includes('NBEGEGCX'));

            recordPass('TC-FIN-BANK-02', 'Zero leakage of IBAN/SWIFT verified across HTTP JSON payload and database columns');
        } catch (e) { recordFail('TC-FIN-BANK-02', 'Zero-leakage verification', e); }

        // TC-FIN-BANK-03: Controlled Authorization Gate Verification
        try {
            // Sub-test A: Flag true but missing IBAN/SWIFT -> remains PENDING
            process.env.BANK_DETAILS_APPROVED = 'true';
            delete process.env.SETTLEMENT_IBAN;
            delete process.env.SETTLEMENT_SWIFT;

            const piMissingEnv = await settlementService.generateProformaInvoice({
                contractId: 'contract_p0_delta_x'
            });
            assert.strictEqual(piMissingEnv.bank_approval_status, 'PENDING_OWNER_AUTHORIZATION');
            assert.ok(piMissingEnv.bank_details.includes('PAYMENT INSTRUCTIONS PENDING FORMAL COMMERCIAL BOARD DESIGNATION'));

            // Sub-test B: Explicit authorized configuration
            process.env.BANK_DETAILS_APPROVED = 'true';
            process.env.SETTLEMENT_BANK_NAME = 'Commercial International Bank (CIB)';
            process.env.SETTLEMENT_IBAN = 'EG8800100000000000000000000';
            process.env.SETTLEMENT_SWIFT = 'CIBEEGCX';
            process.env.SETTLEMENT_BENEFICIARY = 'ZARSEV Sovereign Export Consortium Board';

            const piAuthorized = await settlementService.generateProformaInvoice({
                contractId: 'contract_p0_delta_x'
            });
            assert.strictEqual(piAuthorized.bank_approval_status, 'AUTHORIZED');
            assert.ok(piAuthorized.bank_details.includes('EG8800100000000000000000000'));
            assert.ok(piAuthorized.bank_details.includes('CIBEEGCX'));
            assert.ok(piAuthorized.bank_details.includes('Commercial International Bank (CIB)'));
            assert.ok(piAuthorized.bank_details.includes('Status: AUTHORIZED'));

            // Reset environment
            delete process.env.BANK_DETAILS_APPROVED;
            delete process.env.SETTLEMENT_IBAN;
            delete process.env.SETTLEMENT_SWIFT;
            delete process.env.SETTLEMENT_BANK_NAME;
            delete process.env.SETTLEMENT_BENEFICIARY;

            recordPass('TC-FIN-BANK-03', 'Owner authorization gate functions strictly: requires explicit flag AND credentials');
        } catch (e) { recordFail('TC-FIN-BANK-03', 'Owner authorization gate verification', e); }

    } finally {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }

        // Cleanup test sandbox DB
        cleanupTestDatabase(isolatedDbPath);
    }

    // Post-Test Inviolable Integrity Check
    const postTestHash = getDbHash();
    console.log(`\n[POST-TEST INTEGRITY] zarsev.db SHA256: ${postTestHash}`);
    assert.strictEqual(
        postTestHash,
        preTestHash,
        `[CRITICAL INVIOLABLE VIOLATION] zarsev.db was altered! Pre: ${preTestHash}, Post: ${postTestHash}`
    );
    console.log('🔒 INVIOLABLE GUARD VERIFIED: zarsev.db bit-perfect hash maintained 100%.');

    console.log('\n================================================================');
    console.log(`P0 SUITE EXECUTION SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('================================================================\n');

    if (failCount > 0) {
        process.exit(1);
    }
}

runP0TestSuite().catch((err) => {
    console.error('Fatal unhandled error in P0 test suite:', err);
    process.exit(1);
});
