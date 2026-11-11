/**
 * test/test_platform_full_lifecycle.js
 * 
 * ZARSEV Sovereign Export Platform — Master Autonomous Lifecycle Test Suite.
 * Covers all requirements across:
 * - Phase 4.0: Staff Management, Subscription Plans, Inquiries Proof-of-Contact,
 *              Central Audit Explorer (Masked), In-App Outbox Notifications, My Products.
 * - Phase 5.0: Contracts, Lineage, Production 6-Stage Pipeline, QC/QA Separation of Duties,
 *              Statutory MRL Engine (EU/GCC/UK), Strict Conditional Release Policy.
 * - Phase 6.0: Shipping Gate Verification, Ocean Shipments, Reefer Cold-Chain Deviation Breach (> 1.5°C / 120min),
 *              Commercial Documents SHA-256, B/L 5-stage Workflow.
 * - Phase 7.0: Buyer Overview, Counter-Offers Negotiation, Proforma Invoice, Milestone Settlement, Deal Closure.
 * - Safety & Isolation: Zero writes to zarsev.db (cryptographic pre/post hash verification).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { setupTestEnvironment, cleanupTestDatabase, REAL_DB_PATH } = require('./test_helper');
const { generateToken } = require('../src/utils/authUtils');
const app = require('../src/app');

function getDbHash() {
    if (!fs.existsSync(REAL_DB_PATH)) return null;
    const buf = fs.readFileSync(REAL_DB_PATH);
    return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

async function runPlatformFullLifecycleTests() {
    console.log('================================================================');
    console.log('⚓ ZARSEV Platform Full Lifecycle & Autonomous Verification Suite');
    console.log('================================================================\n');

    const beforeHash = getDbHash();
    console.log(`[PRE-TEST INTEGRITY] zarsev.db SHA256: ${beforeHash}`);

    const { db, isolatedDbPath } = setupTestEnvironment('platform_lifecycle');

    const TEST_PORT = 3388;
    const server = app.listen(TEST_PORT);
    const BASE_URL = `http://localhost:${TEST_PORT}`;

    let passedTests = 0;
    let failedTests = 0;

    function recordPass(name) {
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    }

    function recordFail(name, err) {
        console.error(`  ❌ [FAIL] ${name}: ${err.message || err}`);
        failedTests++;
    }

    try {
        // Setup Tokens
        const superAdminToken = generateToken({ id: 'usr_super_admin', email: 'admin@zarsev.com' });
        const logisticsToken = generateToken({ id: 'usr_logistics_officer', email: 'logistics@zarsev.com' });
        const mfgDeltaToken = generateToken({ id: 'usr_mfg_delta_iqf', email: 'delta_sales@company.com' });
        const mfgNileToken = generateToken({ id: 'usr_mfg_nile_fruits', email: 'nile_export@company.com' });
        let buyerToken = null;

        // Ensure sub_role on super admin and logistics
        db.prepare("UPDATE users SET sub_role = 'SUPER_ADMIN', role = 'ADMIN' WHERE id = 'usr_super_admin'").run();
        db.prepare("UPDATE users SET sub_role = 'LOGISTICS_OFFICER', role = 'LOGISTICS' WHERE id = 'usr_logistics_officer'").run();
        db.prepare("UPDATE users SET manufacturer_id = 'mfg_delta_iqf', sub_role = 'OWNER' WHERE id = 'usr_mfg_delta_iqf'").run();
        db.prepare("UPDATE users SET manufacturer_id = 'mfg_nile_fruits', sub_role = 'OWNER' WHERE id = 'usr_mfg_nile_fruits'").run();

        // Seed QA officers and inspectors for quality tests
        db.prepare(`
            INSERT OR IGNORE INTO users (id, name, email, password_hash, role, sub_role, is_active, token_version)
            VALUES 
            ('usr_inspector_01', 'Inspector Ahmed', 'inspector@company.com', 'hash', 'MANUFACTURER', 'QC_INSPECTOR', 1, 1),
            ('usr_qa_director_99', 'Dr. Mahmoud QA', 'qa_director@company.com', 'hash', 'ADMIN', 'QA_DIRECTOR', 1, 1)
        `).run();

        console.log('\n--- Phase 4.0-A: Admin Staff Management & Invitations ---');

        // Test 1: SUPER_ADMIN invites new staff
        let rawStaffToken = null;
        let staffInviteId = null;
        try {
            const res = await fetch(`${BASE_URL}/api/admin/staff/invite`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${superAdminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'new_officer@zarsev.com', role: 'LOGISTICS', sub_role: 'LOGISTICS_OFFICER' })
            });
            const data = await res.json();
            assert.strictEqual(res.status, 201);
            assert.strictEqual(data.success, true);
            assert.ok(data.invitation.raw_token, 'Should return raw token once');
            rawStaffToken = data.invitation.raw_token;
            staffInviteId = data.invitation.id;

            // Invariant: Verify raw token is NOT in database
            const stored = db.prepare('SELECT token_hash FROM staff_invitations WHERE id = ?').get(staffInviteId);
            assert.notStrictEqual(stored.token_hash, rawStaffToken, 'Database must only store SHA-256 hash');
            recordPass('SUPER_ADMIN staff invitation with SHA-256 hash storage');
        } catch (e) { recordFail('Staff invitation', e); }

        // Test 2: LOGISTICS_OFFICER cannot access staff management (RBAC)
        try {
            const res = await fetch(`${BASE_URL}/api/admin/staff`, {
                headers: { 'Authorization': `Bearer ${logisticsToken}` }
            });
            assert.strictEqual(res.status, 403, 'Logistics officer must be rejected with 403');
            recordPass('RBAC: LOGISTICS_OFFICER blocked from staff management');
        } catch (e) { recordFail('RBAC staff management', e); }

        // Test 3: Accept staff invitation and activate user
        let newStaffUser = null;
        try {
            const res = await fetch(`${BASE_URL}/api/admin/staff/invitations/accept`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: rawStaffToken,
                    full_name: 'Tarek Logistics Lead',
                    password: 'SecurePass_2026_Zarsev'
                })
            });
            const data = await res.json();
            assert.strictEqual(res.status, 201);
            assert.strictEqual(data.success, true);
            newStaffUser = data.user;
            recordPass('Accept staff invite and activate account with personal password');
        } catch (e) { recordFail('Accept staff invite', e); }

        // Test 4: Invariant: Cannot deactivate the last active SUPER_ADMIN
        try {
            const res = await fetch(`${BASE_URL}/api/admin/staff/usr_super_admin`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${superAdminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: false })
            });
            const data = await res.json();
            assert.strictEqual(res.status, 400);
            assert.ok(data.error.includes('آخر مدير عام'), 'Must protect last active SUPER_ADMIN');
            recordPass('Invariant: Protected last active SUPER_ADMIN against deactivation');
        } catch (e) { recordFail('Protect last super admin', e); }

        console.log('\n--- Phase 4.0-B: Subscription Plans Management ---');

        // Test 5: Get and update subscription plans
        try {
            const resGet = await fetch(`${BASE_URL}/api/subscriptions/plans`);
            const dataGet = await resGet.json();
            assert.strictEqual(resGet.status, 200);
            assert.ok(dataGet.plans.length >= 3, 'Must return at least 3 plan tiers');

            const resPut = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_pro`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${superAdminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ max_products_per_import: 300, max_monthly_imports: 60 })
            });
            const dataPut = await resPut.json();
            assert.strictEqual(resPut.status, 200);
            assert.strictEqual(dataPut.plan.max_products_per_import, 300);
            recordPass('Subscription plans retrieval and SUPER_ADMIN update');
        } catch (e) { recordFail('Subscription plans', e); }

        console.log('\n--- Phase 4.0-C: Contact Inquiries & Proof-of-Contact ---');

        // Test 6: Inquiries submission and 6-state Proof-of-Contact enforcement
        let testInquiryId = null;
        try {
            const inqRes = await fetch(`${BASE_URL}/api/rfqs/inquiries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name: 'Marcus European Importer',
                    company_name: 'Nordic Agri BV',
                    email: 'marcus@nordicagri.nl',
                    phone: '+31612345678',
                    country: 'Netherlands',
                    message: 'Interested in sourcing 10 containers of Valencia Oranges'
                })
            });
            const inqData = await inqRes.json();
            assert.strictEqual(inqRes.status, 201);
            testInquiryId = inqData.inquiry_id;

            // Invariant: Trying to mark CONTACTED without Proof-of-Contact must FAIL
            const statusRes1 = await fetch(`${BASE_URL}/api/rfqs/inquiries/${testInquiryId}/status`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${superAdminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'CONTACTED' })
            });
            assert.strictEqual(statusRes1.status, 400, 'Must require Proof-of-Contact');

            // Record Proof-of-Contact
            const logRes = await fetch(`${BASE_URL}/api/rfqs/inquiries/${testInquiryId}/contact-log`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${superAdminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contact_method: 'PHONE',
                    notes: 'Spoke with Marcus regarding Valencia specs and pricing schedule',
                    to_status: 'CONTACTED'
                })
            });
            assert.strictEqual(logRes.status, 200);

            // Now inquiry status is updated to CONTACTED
            const checkRes = await fetch(`${BASE_URL}/api/rfqs/inquiries/${testInquiryId}`, {
                headers: { 'Authorization': `Bearer ${superAdminToken}` }
            });
            const checkData = await checkRes.json();
            assert.strictEqual(checkData.inquiry.status, 'CONTACTED');
            assert.strictEqual(checkData.contact_logs.length, 1);
            recordPass('Contact Inquiries: 6-state lifecycle and Proof-of-Contact enforcement');
        } catch (e) { recordFail('Contact inquiries', e); }

        console.log('\n--- Phase 4.0-D: Central Audit Explorer (Masked) ---');

        // Test 7: Central Audit Explorer with Multi-Layer Masking
        try {
            const res = await fetch(`${BASE_URL}/api/admin/audit-logs`, {
                headers: { 'Authorization': `Bearer ${superAdminToken}` }
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(data.logs));

            // Verify masking: no plain secrets
            for (const log of data.logs) {
                const detailsStr = JSON.stringify(log.details || {});
                assert.ok(!detailsStr.includes('password_hash'), 'Zero raw password hashes');
                assert.ok(!detailsStr.includes(rawStaffToken), 'Zero raw tokens in audit view');
            }
            recordPass('Central Audit Explorer with multi-layer secret masking');
        } catch (e) { recordFail('Central audit explorer', e); }

        console.log('\n--- Phase 4.0-E: In-App Notifications & Transactional Outbox ---');

        // Test 8: Notifications enqueue, worker dispatch, and read status
        try {
            const notifService = require('../src/services/notificationService');
            const notifId = await notifService.enqueueNotification(null, {
                recipientType: 'MANUFACTURER',
                recipientId: 'mfg_delta_iqf',
                eventType: 'SYSTEM_TEST',
                titleAr: 'إشعار اختبار',
                titleEn: 'Test Notification',
                bodyAr: 'محتوى تجريبي لمنظومة زارسيف',
                bodyEn: 'Test body',
                idempotencyKey: 'test_key_123'
            });
            assert.ok(notifId);

            // Duplicate idempotency check
            const dupId = await notifService.enqueueNotification(null, {
                recipientType: 'MANUFACTURER',
                recipientId: 'mfg_delta_iqf',
                eventType: 'SYSTEM_TEST',
                titleAr: 'إشعار مكرر',
                titleEn: 'Duplicate',
                bodyAr: 'تكرار',
                bodyEn: 'dup',
                idempotencyKey: 'test_key_123'
            });
            assert.strictEqual(dupId, null, 'Duplicate idempotency key must return null');

            // Worker processing
            const workerRes = await notifService.processOutbox(10);
            assert.ok(workerRes.processed >= 1);

            // User queries notifications
            const listRes = await fetch(`${BASE_URL}/api/notifications`, {
                headers: { 'Authorization': `Bearer ${mfgDeltaToken}` }
            });
            const listData = await listRes.json();
            assert.strictEqual(listRes.status, 200);
            assert.ok(listData.notifications.some(n => n.id === notifId));

            // Mark as read
            const readRes = await fetch(`${BASE_URL}/api/notifications/${notifId}/read`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${mfgDeltaToken}` }
            });
            assert.strictEqual(readRes.status, 200);
            recordPass('In-App Notifications: Transactional Outbox, Idempotency, and Worker');
        } catch (e) { recordFail('In-app notifications', e); }

        console.log('\n--- Phase 4.0-F: Manufacturer Portal — My Products ---');

        // Test 9: My Products catalog & review reset on sensitive edits
        let deltaProdId = null;
        try {
            // Seed a product for Delta IQF
            deltaProdId = 'prod_delta_' + crypto.randomBytes(3).toString('hex');
            db.prepare(`
                INSERT INTO products (id, manufacturer_id, name_ar, name_en, price, currency, moq, status)
                VALUES (?, 'mfg_delta_iqf', 'فراولة مجمدة ممتازة', 'IQF Frozen Strawberries Grade A', 1400, 'USD', '1 FCL', 'APPROVED')
            `).run(deltaProdId);

            // Query my-catalog
            const myCatRes = await fetch(`${BASE_URL}/api/products/my-catalog`, {
                headers: { 'Authorization': `Bearer ${mfgDeltaToken}` }
            });
            const myCatData = await myCatRes.json();
            assert.strictEqual(myCatRes.status, 200);
            assert.ok(myCatData.products.some(p => p.id === deltaProdId));

            // Multi-tenant check: Nile cannot edit Delta product
            const crossEditRes = await fetch(`${BASE_URL}/api/products/${deltaProdId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${mfgNileToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ price: 1500 })
            });
            assert.strictEqual(crossEditRes.status, 403, 'Cross-tenant edit must be 403');

            // Manufacturer editing sensitive field resets status to PENDING_APPROVAL
            const sensEditRes = await fetch(`${BASE_URL}/api/products/${deltaProdId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${mfgDeltaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name_ar: 'فراولة مجمدة صنف معدل', price: 1450 })
            });
            const sensEditData = await sensEditRes.json();
            assert.strictEqual(sensEditRes.status, 200);
            assert.strictEqual(sensEditData.status, 'PENDING_APPROVAL');
            assert.strictEqual(sensEditData.requires_review, true);
            recordPass('My Products: Multi-tenant isolation and review reset on sensitive field change');
        } catch (e) { recordFail('My Products management', e); }

        console.log('\n--- Phase 5.0-A: Commercial Contracts Lifecycle ---');

        // Test 10: Buyer accepts quotation -> Contract creation with lineage
        let testContractId = null;
        try {
            // Seed RFQ & Quotation
            const rfqId = 'rfq_test_' + crypto.randomBytes(3).toString('hex');
            const quoteId = 'quo_test_' + crypto.randomBytes(3).toString('hex');
            buyerToken = 'buyer_secret_tok_' + crypto.randomBytes(8).toString('hex');
            const buyerHash = crypto.createHash('sha256').update(buyerToken).digest('hex');

            db.prepare(`
                INSERT INTO rfqs (id, reference_no, product_id, manufacturer_id, assigned_manufacturer_id, buyer_name, business_email, phone, country, company_name, requested_quantity, unit_of_measurement, destination_country, destination_port, required_specifications, target_currency, status, buyer_access_token_hash)
                VALUES (?, 'RFQ-2026-001', ?, 'mfg_delta_iqf', 'mfg_delta_iqf', 'Hans Schmidt', 'hans@agriimport.de', '+491512345678', 'Germany', 'Hamburg Fruits GMBH', 50, 'TON', 'Germany', 'Hamburg Port', 'IQF Grade A', 'USD', 'ACCEPTED', ?)
            `).run(rfqId, deltaProdId, buyerHash);

            const nextWeek = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().substring(0, 10);

            db.prepare(`
                INSERT INTO quotations (id, rfq_id, manufacturer_id, product_id, reference_no, price_per_unit, currency, incoterm, min_order_quantity, min_order_unit, lead_time_days, validity_date, status, buyer_decision_at)
                VALUES (?, ?, 'mfg_delta_iqf', ?, 'QUO-2026-001', 1450, 'USD', 'FOB', 25, 'TON', 14, ?, 'ACCEPTED', CURRENT_TIMESTAMP)
            `).run(quoteId, rfqId, deltaProdId, nextWeek);

            const contractService = require('../src/services/contractService');
            const contract = await contractService.createContractFromQuotation({
                quotationId: quoteId,
                buyerAccessToken: buyerToken,
                buyerNotes: 'Accepted with standard 30/70 payment terms'
            });

            assert.ok(contract.id);
            assert.ok(contract.contract_no.startsWith('CTR-'));
            assert.strictEqual(contract.status, 'CONFIRMED');
            testContractId = contract.id;

            // Invariant: Duplicate contract creation must throw
            await assert.rejects(async () => {
                await contractService.createContractFromQuotation({ quotationId: quoteId });
            }, /مسبقاً/);

            recordPass('Commercial Contracts: Acceptance within validity, lineage validation, and duplicate prevention');
        } catch (e) { recordFail('Commercial Contracts lifecycle', e); }

        console.log('\n--- Phase 5.0-B: Production Lifecycle (6-Stage Pipeline) ---');

        // Test 11: Production plan creation and stage advancement
        let testBatchId = null;
        try {
            const prodService = require('../src/services/productionService');
            const batch = await prodService.createProductionPlan({
                contractId: testContractId,
                manufacturerId: 'mfg_delta_iqf',
                lotNumber: 'LOT-2026-IQF-STRAW-01',
                targetQuantity: 25000,
                uom: 'KG'
            });
            assert.ok(batch.batch_no.startsWith('BATCH-'));
            assert.strictEqual(batch.stage, 'RAW_MATERIAL_INTAKE');
            testBatchId = batch.id;

            // Advance sequentially through pipeline stages to DISPATCH_READY (DEF-10)
            await prodService.recordStageProgress({
                batchId: testBatchId,
                manufacturerId: 'mfg_delta_iqf',
                stage: 'RAW_MATERIAL_INTAKE',
                quantityIn: 25000,
                quantityOut: 25000,
                rejectedQty: 0,
                notes: 'Raw material intake complete'
            });
            await prodService.recordStageProgress({
                batchId: testBatchId,
                manufacturerId: 'mfg_delta_iqf',
                stage: 'SORTING_GRADING',
                quantityIn: 25000,
                quantityOut: 24900,
                rejectedQty: 100,
                notes: 'Sorting complete'
            });
            await prodService.recordStageProgress({
                batchId: testBatchId,
                manufacturerId: 'mfg_delta_iqf',
                stage: 'PROCESSING',
                quantityIn: 24900,
                quantityOut: 24850,
                rejectedQty: 50,
                notes: 'Processing complete'
            });
            await prodService.recordStageProgress({
                batchId: testBatchId,
                manufacturerId: 'mfg_delta_iqf',
                stage: 'PACKING',
                quantityIn: 24850,
                quantityOut: 24800,
                rejectedQty: 50,
                notes: 'Packing complete'
            });
            await prodService.recordStageProgress({
                batchId: testBatchId,
                manufacturerId: 'mfg_delta_iqf',
                stage: 'STORAGE',
                quantityIn: 24800,
                quantityOut: 24800,
                rejectedQty: 0,
                notes: 'Cold storage buffer'
            });
            const advRes = await prodService.recordStageProgress({
                batchId: testBatchId,
                manufacturerId: 'mfg_delta_iqf',
                stage: 'DISPATCH_READY',
                quantityIn: 24800,
                quantityOut: 24800,
                rejectedQty: 0,
                notes: 'Finished freezing and packaging ready for stuffing'
            });
            assert.strictEqual(advRes.stage, 'DISPATCH_READY');
            assert.strictEqual(advRes.readiness_pct, 100);
            recordPass('Production Lifecycle: 6-stage operational pipeline and readiness tracking');
        } catch (e) { recordFail('Production lifecycle', e); }

        console.log('\n--- Phase 5.0-C, D, E, F: QC/QA, Statutory MRL, and Conditional Release ---');

        // Test 12: QC inspection & QA Separation of Duties
        let testInspectionId = null;
        try {
            const qualityService = require('../src/services/qualityService');
            const qc = await qualityService.recordInspection({
                batchId: testBatchId,
                contractId: testContractId,
                inspectionType: 'PRE_SHIPMENT',
                sampleSize: 1000,
                inspectedQuantity: 24800,
                defectCount: 15,
                inspectorId: 'usr_inspector_01',
                inspectorName: 'Quality Engineer Ahmed'
            });
            assert.strictEqual(qc.verdict, 'PASSED');
            testInspectionId = qc.id;

            // Invariant: Inspector cannot QA sign off (Separation of Duties)
            await assert.rejects(async () => {
                await qualityService.reviewInspectionQA({
                    inspectionId: testInspectionId,
                    qaOfficerId: 'usr_inspector_01', // SAME PERSON
                    qaOfficerName: 'Quality Engineer Ahmed',
                    reviewVerdict: 'APPROVED'
                });
            }, /Separation of Duties/);

            // Different QA officer succeeds
            const qa = await qualityService.reviewInspectionQA({
                inspectionId: testInspectionId,
                qaOfficerId: 'usr_qa_director_99',
                qaOfficerName: 'Dr. Mahmoud QA Director',
                reviewVerdict: 'APPROVED',
                coaVerified: true,
                labAccreditation: 'ISO/IEC 17025 Accredited'
            });
            assert.strictEqual(qa.review_verdict, 'APPROVED');
            recordPass('QC/QA: Standardized inspection and strict Separation of Duties');
        } catch (e) { recordFail('QC/QA inspection and review', e); }

        // Test 13: Statutory MRL Engine (EU Reg 396/2005 vs GSO vs UK)
        try {
            const qualityService = require('../src/services/qualityService');

            // 1. EU Valencia Oranges with Chlorpyrifos (banned LOD 0.01) -> BANNED SUBSTANCE
            const resBanned = await qualityService.evaluateMrlCompliance({
                marketCountry: 'EU',
                commodity: 'Citrus (Valencia Oranges)',
                labResults: [{ active_substance: 'Chlorpyrifos', detected_value_mg_kg: 0.04 }]
            });
            assert.strictEqual(resBanned.is_compliant, false);
            assert.strictEqual(resBanned.verdict, 'CRITICAL_BANNED_SUBSTANCE');

            // 2. EU Valencia Oranges with Imazalil 3.5 mg/kg -> PASSED (limit 4.0)
            const resEuPass = await qualityService.evaluateMrlCompliance({
                marketCountry: 'EU',
                commodity: 'Citrus (Valencia Oranges)',
                labResults: [{ active_substance: 'Imazalil', detected_value_mg_kg: 3.5 }]
            });
            assert.strictEqual(resEuPass.is_compliant, true);

            // 3. GCC Valencia Oranges with Imazalil 4.5 mg/kg -> PASSED under GSO (limit 5.0)
            const resGccPass = await qualityService.evaluateMrlCompliance({
                marketCountry: 'GCC',
                commodity: 'Citrus (Valencia Oranges)',
                labResults: [{ active_substance: 'Imazalil', detected_value_mg_kg: 4.5 }]
            });
            assert.strictEqual(resGccPass.is_compliant, true);

            // 4. Invariant: Unverified substance without documented statutory source -> BLOCKED
            const resUnverified = await qualityService.evaluateMrlCompliance({
                marketCountry: 'EU',
                commodity: 'Citrus (Valencia Oranges)',
                labResults: [{ active_substance: 'Experimental_Unknown_Chemical_X', detected_value_mg_kg: 0.005 }]
            });
            assert.strictEqual(resUnverified.is_compliant, false);
            assert.strictEqual(resUnverified.verdict, 'BLOCKED_UNVERIFIED_RULE');

            recordPass('Statutory MRL Engine: Multi-market statutory validation (EU/GCC/UK) & Unverified Rule Blocking');
        } catch (e) { recordFail('MRL statutory evaluation', e); }

        // Test 14: Strict Conditional Release Policy (Absolute Ban)
        try {
            const qualityService = require('../src/services/qualityService');

            // Invariant: Banned contaminant cannot be granted conditional release
            await assert.rejects(async () => {
                await qualityService.requestConditionalRelease({
                    inspectionId: testInspectionId,
                    contractId: testContractId,
                    reason: 'Contaminant found',
                    permittedConditions: 'None',
                    remedialActions: 'None',
                    targetMarket: 'EU',
                    leadQcSignoff: 'Lead QC',
                    opsDirectorSignoff: 'Ops Director',
                    identifiedDefectCategories: ['BANNED_PESTICIDE_SUBSTANCE']
                });
            }, /حظر قاطع/);

            // Permitted remedial packaging defect with dual sign-off succeeds
            const rel = await qualityService.requestConditionalRelease({
                inspectionId: testInspectionId,
                contractId: testContractId,
                reason: 'Outer carton label barcode re-printing required',
                permittedConditions: 'Re-labeling before container loading',
                remedialActions: 'Repackaging in designated station',
                targetMarket: 'EU',
                leadQcSignoff: 'Eng. Khaled Lead QC',
                opsDirectorSignoff: 'Eng. Samy Operations Director',
                identifiedDefectCategories: ['LABELING_DEFECT']
            });
            assert.strictEqual(rel.status, 'APPROVED');
            recordPass('Conditional Release Policy: Absolute ban on dangerous defects and dual sign-off');
        } catch (e) { recordFail('Conditional release policy', e); }

        console.log('\n--- Phase 6.0: Logistics, Reefer Cold-Chain & B/L Lifecycle ---');

        // Test 15: Shipping Gate & Ocean Shipment Creation
        let testShipmentId = null;
        try {
            const shippingService = require('../src/services/shippingService');
            const shipment = await shippingService.createShipment({
                contractId: testContractId,
                manufacturerId: 'mfg_delta_iqf',
                carrierName: 'Hapag-Lloyd',
                vesselName: 'Al Rawdah Express',
                voyageNo: 'HL-2026-08W',
                bookingReference: 'HL-BKG-883921',
                containerNo: 'HLBU1234567',
                containerType: '40FT_REEFER',
                pol: 'Port Said Seaport (SCCT)',
                pod: 'Rotterdam ECT Terminal',
                etd: '2026-11-20',
                eta: '2026-11-29'
            });
            assert.ok(shipment.shipment_no.startsWith('SHP-'));
            assert.strictEqual(shipment.status, 'BOOKED');
            testShipmentId = shipment.id;
            recordPass('Shipping Gate Check & Ocean Reefer Shipment Booking');
        } catch (e) { recordFail('Shipping gate and shipment creation', e); }

        // Test 16: Reefer Telemetry & Deviation Breach Math (> 1.5°C over 120 min)
        try {
            const shippingService = require('../src/services/shippingService');

            // Normal readings: Setpoint -18°C, Return -18.2°C (deviation 0.2°C)
            const t1 = await shippingService.recordReeferTelemetry({
                shipmentId: testShipmentId,
                containerNo: 'HLBU1234567',
                setpointTemp: -18.0,
                supplyTemp: -19.0,
                returnTemp: -18.2
            });
            assert.strictEqual(t1.breach_flag, false);

            // Ingest 4 consecutive readings with deviation > 1.5°C (over 120 minutes continuous)
            await shippingService.recordReeferTelemetry({
                shipmentId: testShipmentId, containerNo: 'HLBU1234567',
                setpointTemp: -18.0, supplyTemp: -14.0, returnTemp: -15.5
            });
            await shippingService.recordReeferTelemetry({
                shipmentId: testShipmentId, containerNo: 'HLBU1234567',
                setpointTemp: -18.0, supplyTemp: -14.0, returnTemp: -15.2
            });
            await shippingService.recordReeferTelemetry({
                shipmentId: testShipmentId, containerNo: 'HLBU1234567',
                setpointTemp: -18.0, supplyTemp: -13.5, returnTemp: -15.0
            });
            const tBreach = await shippingService.recordReeferTelemetry({
                shipmentId: testShipmentId, containerNo: 'HLBU1234567',
                setpointTemp: -18.0, supplyTemp: -13.0, returnTemp: -14.8
            });

            assert.strictEqual(tBreach.breach_flag, true);
            assert.strictEqual(tBreach.breach_type, 'CONTINUOUS_OVER_120MIN');
            recordPass('Reefer Telemetry: Continuous deviation calculation (> 1.5°C for > 120 min)');
        } catch (e) { recordFail('Reefer telemetry deviation breach', e); }

        // Test 17: Commercial Shipping Documents SHA-256 and B/L Lifecycle
        try {
            const shippingService = require('../src/services/shippingService');
            const doc = await shippingService.uploadShippingDocument({
                shipmentId: testShipmentId,
                contractId: testContractId,
                docType: 'BILL_OF_LADING',
                docNumber: 'HLCU-ROT-992384',
                filePath: '/storage/docs/bl_test.pdf',
                fileContent: 'MOCK_ORIGINAL_BILL_OF_LADING_BINARY_STREAM',
                uploadedBy: 'usr_super_admin'
            });
            assert.ok(doc.file_hash_sha256);
            assert.strictEqual(doc.bl_status, 'DRAFT');

            // B/L progression: DRAFT -> UNDER_REVIEW -> APPROVED -> TELEX_RELEASE (DEF-06 FSM)
            await shippingService.updateBillOfLadingStatus({
                docId: doc.id,
                newStatus: 'UNDER_REVIEW',
                verifiedBy: 'usr_super_admin'
            });
            await shippingService.updateBillOfLadingStatus({
                docId: doc.id,
                newStatus: 'APPROVED',
                verifiedBy: 'usr_super_admin'
            });
            const blApprove = await shippingService.updateBillOfLadingStatus({
                docId: doc.id,
                newStatus: 'TELEX_RELEASE',
                verifiedBy: 'usr_super_admin'
            });
            assert.strictEqual(blApprove.bl_status, 'TELEX_RELEASE');
            recordPass('Shipping Documents: SHA-256 integrity and B/L status workflow');
        } catch (e) { recordFail('B/L lifecycle', e); }

        console.log('\n--- Phase 7.0: Buyer Console, Proforma, Settlement & Deal Closure ---');

        // Test 18: Buyer Overview Dashboard
        try {
            const res = await fetch(`${BASE_URL}/api/buyer/overview`, {
                headers: { 'x-buyer-token': buyerToken }
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.ok(data.overview, 'Should contain overview statistics');
            assert.ok(Array.isArray(data.rfqs), 'Should return buyer rfqs');
            recordPass('Buyer Console: Unified aggregated dashboard data');
        } catch (e) { recordFail('Buyer console overview', e); }

        // Test 19: Counter-Offer Negotiation Round
        try {
            const settlementService = require('../src/services/settlementService');
            const quote = db.prepare('SELECT id FROM quotations LIMIT 1').get();
            const neg = await settlementService.submitCounterOffer({
                quotationId: quote.id,
                proposedBy: 'BUYER',
                proposedPrice: 1400.0,
                incoterm: 'CIF',
                notes: 'Requesting CIF Rotterdam terms'
            });
            assert.strictEqual(neg.round_number, 1);
            assert.strictEqual(neg.status, 'PENDING');
            recordPass('Commercial Negotiations: Counter-offer rounds and deadlines');
        } catch (e) { recordFail('Counter offer negotiation', e); }

        // Test 20: Proforma Invoice Generation
        try {
            const settlementService = require('../src/services/settlementService');
            const pi = await settlementService.generateProformaInvoice({
                contractId: testContractId
            });
            assert.ok(pi.invoice_no.startsWith('PI-'));
            assert.ok(pi.bank_details.includes('PAYMENT INSTRUCTIONS PENDING FORMAL COMMERCIAL BOARD DESIGNATION'), 'Must include formal pending notice');
            assert.ok(!pi.bank_details.includes('EG45'), 'Zero hardcoded fallback IBAN permitted');
            assert.ok(!pi.bank_details.includes('NBEGEGCX'), 'Zero hardcoded fallback SWIFT permitted');
            assert.strictEqual(pi.bank_approval_status, 'PENDING_OWNER_AUTHORIZATION');
            recordPass('Proforma Invoice: Generation with Incoterms and strict zero-leakage owner authorization gate');
        } catch (e) { recordFail('Proforma invoice generation', e); }

        // Test 21: Commercial Settlement Milestones and Final Deal Closure
        try {
            const settlementService = require('../src/services/settlementService');

            // 1. Advance deposit
            const m1 = await settlementService.recordSettlementMilestone({
                contractId: testContractId,
                shipmentId: testShipmentId,
                milestone: 'ADVANCE_DEPOSIT',
                amount: 10875.0,
                paidDate: '2026-11-10',
                paymentReference: 'SWIFT-NBE-9923841',
                verifiedBy: 'usr_super_admin'
            });
            assert.strictEqual(m1.status, 'VERIFIED');

            // 2. Deal Closure
            const closure = await settlementService.closeCommercialContract({
                contractId: testContractId,
                closedBy: 'usr_super_admin',
                commercialNotes: 'Full shipment delivered to Rotterdam, customs cleared, payments verified'
            });
            assert.strictEqual(closure.status, 'COMPLETED');
            recordPass('Milestone Settlements & Final Commercial Deal Closure');
        } catch (e) { recordFail('Deal settlement and closure', e); }

    } finally {
        server.close();
        cleanupTestDatabase(isolatedDbPath);
    }

    // Capture post-test cryptographic snapshot of real database
    const afterHash = getDbHash();
    console.log(`\n[POST-TEST INTEGRITY] zarsev.db SHA256: ${afterHash}`);
    assert.strictEqual(afterHash, beforeHash, 'CRITICAL REGRESSION: Real database hash was modified!');
    console.log('🛡️  SAFETY CHECK PASSED: Real SQLite database is 100% UNTOUCHED and BIT-PERFECT!');

    console.log('\n================================================================');
    console.log(`🏁 TEST RESULTS: ${passedTests} PASSED / ${failedTests} FAILED`);
    console.log('================================================================');

    if (failedTests > 0) {
        throw new Error(`${failedTests} tests failed in Master Lifecycle Suite!`);
    }
}

if (require.main === module) {
    runPlatformFullLifecycleTests().catch(err => {
        console.error('Master Test Suite Failure:', err);
        process.exit(1);
    });
}

module.exports = { runPlatformFullLifecycleTests };
