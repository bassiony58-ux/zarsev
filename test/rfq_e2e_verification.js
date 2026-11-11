/**
 * test/rfq_e2e_verification.js
 * 
 * Comprehensive End-to-End Test Suite for Buyer RFQ & Inquiry Management System.
 * 
 * Validates:
 * 1. Public Buyer RFQ Submission (HTTP 201 + Reference 'RFQ-2026-XXXXX')
 * 2. Published Product Validation & Rejection of Unpublished Products (HTTP 400)
 * 3. PostgreSQL Database Persistence in rfqs and rfq_audit_logs tables
 * 4. Input Validation & Error Handling
 * 5. Admin RFQ Queue, Filtering, and Inspection (GET /api/rfqs)
 * 6. Admin Routing & Status Update (PATCH /api/rfqs/:id/status)
 * 7. Assigned Manufacturer Access & Quoting Workflow
 * 8. Strict Tenant Isolation (Unrelated manufacturer receives 403 Forbidden)
 * 9. Public Contact Inquiry Submission & Admin Retrieval (POST /api/inquiries, GET /api/inquiries/all)
 * 10. Truthful Notification Service (EMAIL DELIVERY NOT CONFIGURED)
 * 11. Self-cleanup of test artifacts in zarsev_test
 */

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'postgres';

const assert = require('assert');
const http = require('http');
const app = require('../src/app');
const pgAdapter = require('../src/db/pgAdapter');
const { generateToken } = require('../src/utils/authUtils');
const notificationService = require('../src/services/notificationService');

const TEST_PORT = 3399;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Tracking created records for guaranteed self-cleanup
const createdRfqIds = [];
const createdInquiryIds = [];

async function makeRequest(method, endpoint, { headers = {}, body = null } = {}) {
    const url = `${BASE_URL}${endpoint}`;
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...headers
        }
    };

    if (body) {
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    let data;
    try {
        data = await res.json();
    } catch (_) {
        data = null;
    }
    return { status: res.status, headers: res.headers, data };
}

async function runTestSuite() {
    console.log('================================================================');
    console.log('🧪 ZARSEV RFQ & INQUIRY MANAGEMENT — END-TO-END TEST SUITE');
    console.log(`🌐 Target: Isolated PostgreSQL [zarsev_test] on port ${TEST_PORT}`);
    console.log('================================================================\n');

    let server;
    let pool;

    try {
        // Start server instance
        server = await new Promise((resolve) => {
            const s = app.listen(TEST_PORT, () => resolve(s));
        });
        pool = pgAdapter.getAppPool('zarsev_test');

        // Locate published and unpublished products in zarsev_test
        const publishedProduct = (await pool.query(
            "SELECT id, name_ar, status, manufacturer_id FROM products WHERE status = 'PUBLISHED' LIMIT 1"
        )).rows[0];

        const pendingProduct = (await pool.query(
            "SELECT id, name_ar, status, manufacturer_id FROM products WHERE status != 'PUBLISHED' LIMIT 1"
        )).rows[0];

        assert.ok(publishedProduct, 'FATAL: At least one PUBLISHED product must exist in zarsev_test');
        console.log(`ℹ️ Test Target Published Product: ${publishedProduct.id} (${publishedProduct.name_ar})`);
        if (pendingProduct) {
            console.log(`ℹ️ Test Target Unpublished Product: ${pendingProduct.id} [${pendingProduct.status}]`);
        }

        // Generate Auth Tokens
        const adminToken = generateToken({ id: 'usr_super_admin', email: 'admin@zarsev.com' });
        const nileMfgToken = generateToken({ id: 'usr_mfg_nile_fruits', email: 'nile_export@company.com' });
        const deltaMfgToken = generateToken({ id: 'usr_mfg_delta_iqf', email: 'delta_sales@company.com' });

        const adminHeaders = { 'Authorization': `Bearer ${adminToken}` };
        const nileHeaders = { 'Authorization': `Bearer ${nileMfgToken}` };
        const deltaHeaders = { 'Authorization': `Bearer ${deltaMfgToken}` };

        // -------------------------------------------------------------
        // TEST 1: Rejection of Invalid Submissions
        // -------------------------------------------------------------
        console.log('\n--- 1. Testing Input Validation & Rejection of Bad Submissions ---');

        // 1a. Missing buyer name
        const badRes1 = await makeRequest('POST', '/api/rfqs', {
            body: { business_email: 'buyer@test.com', requested_quantity: 10 }
        });
        assert.strictEqual(badRes1.status, 400, 'Expected 400 on missing buyer name');
        console.log('  ✓ Correctly rejected missing buyer name (HTTP 400)');

        // 1b. Invalid email format
        const badRes2 = await makeRequest('POST', '/api/rfqs', {
            body: {
                buyer_name: 'John Doe',
                company_name: 'Test Corp',
                business_email: 'not-an-email',
                phone: '+12345678',
                country: 'UK',
                product_id: publishedProduct.id,
                requested_quantity: 10,
                destination_country: 'UK'
            }
        });
        assert.strictEqual(badRes2.status, 400, 'Expected 400 on invalid email');
        console.log('  ✓ Correctly rejected invalid email address (HTTP 400)');

        // 1c. Zero or negative quantity
        const badRes3 = await makeRequest('POST', '/api/rfqs', {
            body: {
                buyer_name: 'John Doe',
                company_name: 'Test Corp',
                business_email: 'valid@testcorp.com',
                phone: '+12345678',
                country: 'UK',
                product_id: publishedProduct.id,
                requested_quantity: 0,
                destination_country: 'UK'
            }
        });
        assert.strictEqual(badRes3.status, 400, 'Expected 400 on zero quantity');
        console.log('  ✓ Correctly rejected zero/negative quantity (HTTP 400)');

        // 1d. Non-existent product
        const badRes4 = await makeRequest('POST', '/api/rfqs', {
            body: {
                buyer_name: 'John Doe',
                company_name: 'Test Corp',
                business_email: 'valid@testcorp.com',
                phone: '+12345678',
                country: 'UK',
                product_id: 'prod_does_not_exist_9999',
                requested_quantity: 10,
                destination_country: 'UK'
            }
        });
        assert.strictEqual(badRes4.status, 404, 'Expected 404 on non-existent product');
        console.log('  ✓ Correctly returned 404 for non-existent product');

        // 1e. Unpublished / Pending Product Rejection
        if (pendingProduct) {
            const badRes5 = await makeRequest('POST', '/api/rfqs', {
                body: {
                    buyer_name: 'John Doe',
                    company_name: 'Test Corp',
                    business_email: 'valid@testcorp.com',
                    phone: '+12345678',
                    country: 'UK',
                    product_id: pendingProduct.id,
                    requested_quantity: 10,
                    destination_country: 'UK'
                }
            });
            assert.strictEqual(badRes5.status, 400, 'Expected 400 when submitting RFQ for unpublished product');
            console.log(`  ✓ Correctly rejected RFQ for unpublished product [status: ${pendingProduct.status}] (HTTP 400)`);
        }

        // -------------------------------------------------------------
        // TEST 2: Valid Public Buyer RFQ Submission
        // -------------------------------------------------------------
        console.log('\n--- 2. Testing Valid Public Buyer RFQ Submission ---');
        const buyerPayload = {
            buyer_name: 'Klaus Schneider',
            company_name: 'Bavaria Agro Importers GmbH',
            business_email: 'klaus.schneider@bavaria-agro.de',
            phone: '+49 89 76543210',
            country: 'Germany',
            product_id: publishedProduct.id,
            requested_quantity: 45.5,
            unit_of_measurement: 'MT',
            destination_country: 'Germany',
            destination_port: 'Hamburg',
            required_specifications: JSON.stringify({
                packaging: '10kg telescopic export carton',
                caliber: 'Size 4/5',
                certification: 'GlobalGAP + ISO 22000'
            }),
            additional_message: 'Requesting CIF Hamburg pricing for weekly delivery schedule starting next month.'
        };

        const rfqSubmitRes = await makeRequest('POST', '/api/rfqs', { body: buyerPayload });
        assert.strictEqual(rfqSubmitRes.status, 201, `Failed to submit RFQ: ${JSON.stringify(rfqSubmitRes.data)}`);
        assert.strictEqual(rfqSubmitRes.data.success, true);
        assert.ok(rfqSubmitRes.data.reference_no, 'Missing reference_no in response');
        assert.match(rfqSubmitRes.data.reference_no, /^RFQ-\d{4}-[A-F0-9]+$/, 'Invalid reference_no format');
        assert.strictEqual(rfqSubmitRes.data.status, 'NEW');

        const submittedRfqId = rfqSubmitRes.data.rfq_id;
        const submittedRefNo = rfqSubmitRes.data.reference_no;
        createdRfqIds.push(submittedRfqId);

        console.log(`  ✓ Buyer RFQ Submitted Successfully!`);
        console.log(`    - RFQ ID: ${submittedRfqId}`);
        console.log(`    - Confirmed Reference: ${submittedRefNo}`);
        console.log(`    - Status: ${rfqSubmitRes.data.status}`);

        // -------------------------------------------------------------
        // TEST 3: Direct PostgreSQL Persistence & Audit Log Verification
        // -------------------------------------------------------------
        console.log('\n--- 3. Verifying PostgreSQL Persistence & Audit Logs ---');
        const rfqDbRow = (await pool.query(
            'SELECT * FROM rfqs WHERE id = $1',
            [submittedRfqId]
        )).rows[0];

        assert.ok(rfqDbRow, 'RFQ record was not found in PostgreSQL rfqs table');
        assert.strictEqual(rfqDbRow.reference_no, submittedRefNo);
        assert.strictEqual(rfqDbRow.buyer_name, 'Klaus Schneider');
        assert.strictEqual(rfqDbRow.company_name, 'Bavaria Agro Importers GmbH');
        assert.strictEqual(rfqDbRow.business_email, 'klaus.schneider@bavaria-agro.de');
        assert.strictEqual(rfqDbRow.status, 'NEW');
        assert.strictEqual(rfqDbRow.product_id, publishedProduct.id);
        console.log('  ✓ PostgreSQL record verified in `rfqs` table with exact commercial details');

        const auditLogs = (await pool.query(
            'SELECT * FROM rfq_audit_logs WHERE rfq_id = $1 ORDER BY created_at ASC',
            [submittedRfqId]
        )).rows;

        assert.ok(auditLogs.length >= 1, 'Initial audit log record was not created');
        assert.strictEqual(auditLogs[0].action, 'SUBMIT');
        assert.strictEqual(auditLogs[0].to_status, 'NEW');
        console.log('  ✓ Initial audit log verified in `rfq_audit_logs` table (Action: SUBMIT, To: NEW)');

        // -------------------------------------------------------------
        // TEST 4: Admin Portal RFQ Queue & Inspection
        // -------------------------------------------------------------
        console.log('\n--- 4. Testing Admin RFQ Management Queue ---');
        const adminQueueRes = await makeRequest('GET', '/api/rfqs', { headers: adminHeaders });
        assert.strictEqual(adminQueueRes.status, 200);
        assert.strictEqual(adminQueueRes.data.success, true);
        const foundInQueue = adminQueueRes.data.rfqs.find(r => r.id === submittedRfqId);
        assert.ok(foundInQueue, 'Submitted RFQ not visible in Super Admin queue');
        console.log(`  ✓ Super Admin queue lists RFQ (Found ${adminQueueRes.data.total} total RFQs)`);

        // Admin gets single RFQ with audit history
        const adminDetailRes = await makeRequest('GET', `/api/rfqs/${submittedRfqId}`, { headers: adminHeaders });
        assert.strictEqual(adminDetailRes.status, 200);
        assert.strictEqual(adminDetailRes.data.rfq.id, submittedRfqId);
        assert.ok(Array.isArray(adminDetailRes.data.audit_logs), 'Missing audit_logs array in detail endpoint');
        console.log('  ✓ Super Admin detail endpoint returned full record and timeline');

        // -------------------------------------------------------------
        // TEST 5: Admin Routing & Status Transition
        // -------------------------------------------------------------
        console.log('\n--- 5. Testing Admin Routing to Manufacturer & Status Update ---');
        // Admin routes RFQ to Nile Fruits (mfg_nile_fruits)
        const patchRes = await makeRequest('PATCH', `/api/rfqs/${submittedRfqId}/status`, {
            headers: adminHeaders,
            body: {
                status: 'SENT_TO_MANUFACTURER',
                assigned_manufacturer_id: 'mfg_nile_fruits',
                action_note: 'تم إحالة الطلب إلى شركة ثمار النيل لتقديم عرض أسعار تصديري'
            }
        });
        assert.strictEqual(patchRes.status, 200, `Failed to patch RFQ status: ${JSON.stringify(patchRes.data)}`);
        assert.strictEqual(patchRes.data.status, 'SENT_TO_MANUFACTURER');
        assert.strictEqual(patchRes.data.assigned_manufacturer_id, 'mfg_nile_fruits');
        console.log('  ✓ RFQ routed to `mfg_nile_fruits` with status SENT_TO_MANUFACTURER');

        // Verify updated audit logs in PostgreSQL
        const auditAfterRoute = (await pool.query(
            'SELECT * FROM rfq_audit_logs WHERE rfq_id = $1 ORDER BY created_at ASC',
            [submittedRfqId]
        )).rows;
        assert.strictEqual(auditAfterRoute.length, 2, 'Audit log count should be 2 after status update');
        assert.strictEqual(auditAfterRoute[1].action, 'STATUS_UPDATE');
        assert.strictEqual(auditAfterRoute[1].from_status, 'NEW');
        assert.strictEqual(auditAfterRoute[1].to_status, 'SENT_TO_MANUFACTURER');
        console.log('  ✓ Status update logged in `rfq_audit_logs` (NEW -> SENT_TO_MANUFACTURER)');

        // -------------------------------------------------------------
        // TEST 6: Assigned Manufacturer Access & Quoting Workflow
        // -------------------------------------------------------------
        console.log('\n--- 6. Testing Assigned Manufacturer (Nile Fruits) Access & Quoting ---');
        // Nile Fruits fetches their RFQ list
        const nileListRes = await makeRequest('GET', '/api/rfqs', { headers: nileHeaders });
        assert.strictEqual(nileListRes.status, 200);
        const foundByNile = nileListRes.data.rfqs.find(r => r.id === submittedRfqId);
        assert.ok(foundByNile, 'Assigned RFQ was not visible to assigned manufacturer (Nile Fruits)');
        console.log('  ✓ Assigned RFQ successfully appeared in Nile Fruits portal queue');

        // Nile Fruits updates status to QUOTED
        const quoteRes = await makeRequest('PATCH', `/api/rfqs/${submittedRfqId}/status`, {
            headers: nileHeaders,
            body: {
                status: 'QUOTED',
                notes: 'تم اعتماد السعر: 850 دولار للطن تسليم FOB الإسكندرية مع عبوات التصدير المعتمدة'
            }
        });
        assert.strictEqual(quoteRes.status, 200, `Failed to submit quote: ${JSON.stringify(quoteRes.data)}`);
        assert.strictEqual(quoteRes.data.status, 'QUOTED');
        console.log('  ✓ Nile Fruits successfully submitted quote response (Status: QUOTED)');

        // -------------------------------------------------------------
        // TEST 7: Strict Tenant Isolation Guard
        // -------------------------------------------------------------
        console.log('\n--- 7. Testing Strict Multi-Tenant Isolation ---');
        // Unrelated manufacturer (Delta IQF) fetches their list
        const deltaListRes = await makeRequest('GET', '/api/rfqs', { headers: deltaHeaders });
        assert.strictEqual(deltaListRes.status, 200);
        const foundByDelta = deltaListRes.data.rfqs.find(r => r.id === submittedRfqId);
        assert.strictEqual(foundByDelta, undefined, 'SECURITY BREACH: Unrelated manufacturer can see assigned RFQ in list!');
        console.log('  ✓ Isolation Verified: RFQ is NOT visible in Delta IQF list');

        // Unrelated manufacturer attempts direct GET /api/rfqs/:id
        const deltaGetRes = await makeRequest('GET', `/api/rfqs/${submittedRfqId}`, { headers: deltaHeaders });
        assert.strictEqual(deltaGetRes.status, 403, 'SECURITY BREACH: Unrelated manufacturer was not blocked with 403 Forbidden!');
        console.log('  ✓ Isolation Verified: Direct access attempt returned HTTP 403 Forbidden');

        // Unrelated manufacturer attempts direct PATCH /api/rfqs/:id/status
        const deltaPatchRes = await makeRequest('PATCH', `/api/rfqs/${submittedRfqId}/status`, {
            headers: deltaHeaders,
            body: { status: 'REJECTED' }
        });
        assert.strictEqual(deltaPatchRes.status, 403, 'SECURITY BREACH: Unrelated manufacturer was able to patch status!');
        console.log('  ✓ Isolation Verified: Status mutation attempt returned HTTP 403 Forbidden');

        // -------------------------------------------------------------
        // TEST 8: Public Contact Inquiry Workflow
        // -------------------------------------------------------------
        console.log('\n--- 8. Testing Public Contact Inquiry Workflow ---');
        const inquiryPayload = {
            name: 'Elena Rostova',
            company: 'Black Sea Cold Chains Ltd',
            email: 'elena@blackseafresh.com',
            phone: '+7 495 1234567',
            country: 'Russia',
            service_type: 'logistics',
            product_id: publishedProduct.id,
            message: 'Inquiring about reefer container slot booking from Damietta to Novorossiysk.'
        };

        const inqRes = await makeRequest('POST', '/api/inquiries', { body: inquiryPayload });
        assert.strictEqual(inqRes.status, 201, `Failed to submit inquiry: ${JSON.stringify(inqRes.data)}`);
        assert.strictEqual(inqRes.data.success, true);
        assert.match(inqRes.data.reference_no, /^INQ-\d{4}-[A-F0-9]+$/, 'Invalid reference_no format for inquiry');
        const inquiryRef = inqRes.data.reference_no;
        console.log(`  ✓ Contact Inquiry submitted successfully! Reference: ${inquiryRef}`);

        // Also test alias /api/contact
        const contactAliasRes = await makeRequest('POST', '/api/contact', {
            body: {
                name: 'Marco Bellini',
                email: 'bellini@trade.it',
                message: 'Testing contact alias endpoint'
            }
        });
        assert.strictEqual(contactAliasRes.status, 201);
        console.log(`  ✓ Alias /api/contact endpoint successfully processed inquiry (Reference: ${contactAliasRes.data.reference_no})`);

        // Check persistence in PostgreSQL contact_inquiries table
        const inqDbRow = (await pool.query(
            'SELECT * FROM contact_inquiries WHERE reference_no = $1',
            [inquiryRef]
        )).rows[0];
        assert.ok(inqDbRow, 'Inquiry was not persisted to contact_inquiries table');
        assert.strictEqual(inqDbRow.email, 'elena@blackseafresh.com');
        assert.strictEqual(inqDbRow.status, 'NEW');
        createdInquiryIds.push(inqDbRow.id);

        const contactDbRow = (await pool.query(
            'SELECT * FROM contact_inquiries WHERE reference_no = $1',
            [contactAliasRes.data.reference_no]
        )).rows[0];
        if (contactDbRow) createdInquiryIds.push(contactDbRow.id);

        console.log('  ✓ PostgreSQL persistence verified in `contact_inquiries` table');

        // Admin retrieves inquiries
        const adminInqList = await makeRequest('GET', '/api/inquiries/all', { headers: adminHeaders });
        assert.strictEqual(adminInqList.status, 200);
        assert.ok(adminInqList.data.inquiries.find(i => i.reference_no === inquiryRef), 'Inquiry missing from admin list');
        console.log('  ✓ Super Admin successfully fetched all contact inquiries (GET /api/inquiries/all)');

        // -------------------------------------------------------------
        // TEST 9: Notification Service Truthful Reporting
        // -------------------------------------------------------------
        console.log('\n--- 9. Verifying Notification Service Truthful Reporting ---');
        const notifStatus = notificationService.getStatus();
        assert.strictEqual(notifStatus.configured, false, 'SMTP should not be reported as configured when credentials missing');
        assert.strictEqual(notifStatus.provider, 'NONE_LOGGING_ONLY');
        console.log(`  ✓ Notification status: provider=${notifStatus.provider}, configured=${notifStatus.configured}`);

        const notifResult = await notificationService.notifyRfqSubmitted(
            { reference_no: 'RFQ-TEST-0001', buyer_name: 'Test', business_email: 'test@example.com' },
            { id: 'prod_1', name_ar: 'منتج تجريبي' },
            { id: 'mfg_1', name_ar: 'مصنع تجريبي' }
        );
        assert.strictEqual(notifResult.delivered, false);
        assert.strictEqual(notifResult.status, 'NOT_CONFIGURED_LOG_ONLY');
        console.log('  ✓ Notification dispatch truthfully returns: EMAIL DELIVERY NOT CONFIGURED (status: NOT_CONFIGURED_LOG_ONLY)');

        console.log('\n================================================================');
        console.log('🏆 ALL 9 COMPREHENSIVE END-TO-END TEST CASES PASSED PERFECTLY!');
        console.log('================================================================\n');

    } catch (err) {
        console.error('❌ E2E TEST FAILED:', err);
        throw err;
    } finally {
        // -------------------------------------------------------------
        // TEST 10: Guaranteed Self-Cleanup
        // -------------------------------------------------------------
        console.log('--- 10. Executing Safe Test Data Self-Cleanup in zarsev_test ---');
        if (pool) {
            try {
                if (createdRfqIds.length > 0) {
                    await pool.query('DELETE FROM rfq_audit_logs WHERE rfq_id = ANY($1)', [createdRfqIds]);
                    await pool.query('DELETE FROM rfqs WHERE id = ANY($1)', [createdRfqIds]);
                    console.log(`  ✓ Cleaned up ${createdRfqIds.length} test RFQ records and associated audit logs.`);
                }
                if (createdInquiryIds.length > 0) {
                    await pool.query('DELETE FROM contact_inquiries WHERE id = ANY($1)', [createdInquiryIds]);
                    console.log(`  ✓ Cleaned up ${createdInquiryIds.length} test contact inquiries.`);
                }
            } catch (cleanupErr) {
                console.error('Warning during cleanup:', cleanupErr);
            }
            await pool.end();
        }

        if (server) {
            await new Promise((resolve) => server.close(resolve));
            console.log('  ✓ Test HTTP server closed.');
        }
    }
}

runTestSuite().then(() => {
    process.exit(0);
}).catch(() => {
    process.exit(1);
});
