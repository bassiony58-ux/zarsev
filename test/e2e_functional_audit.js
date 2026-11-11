/**
 * test/e2e_functional_audit.js
 * 
 * Comprehensive End-to-End Functional Verification Suite for ZARSEV Global Trade Platform.
 * 
 * Strict safety rules:
 * - Operates EXCLUSIVELY on PostgreSQL 'zarsev_test' database.
 * - ZERO modifications to 'zarsev_dev'.
 * - ZERO modifications to pristine SQLite 'zarsev.db'.
 * - Verifies real database persistence at each step.
 * - Cleans up only the test data created by this run.
 */

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'postgres';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const pgAdapter = require('../src/db/pgAdapter');
const app = require('../src/app');

const TEST_PORT = 3366;
const BASE_URL = `http://localhost:${TEST_PORT}`;

const auditResults = {
    timestamp: new Date().toISOString(),
    database: 'zarsev_test',
    engine: 'PostgreSQL',
    tests: [],
    summary: {
        total: 0,
        passed: 0,
        failed: 0,
        notImplemented: 0
    }
};

function recordTest({ category, name, operation, endpoint, dbTable, expected, actual, status, notes = '' }) {
    const entry = {
        id: auditResults.tests.length + 1,
        category,
        name,
        operation,
        endpoint,
        dbTable,
        expected,
        actual,
        status,
        notes
    };
    auditResults.tests.push(entry);
    auditResults.summary.total++;
    if (status === 'PASS') auditResults.summary.passed++;
    else if (status === 'FAIL') auditResults.summary.failed++;
    else if (status === 'NOT_IMPLEMENTED') auditResults.summary.notImplemented++;

    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${icon} [${status}] [${category}] ${name}: ${actual}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runE2EFunctionalAudit() {
    console.log('===============================================================');
    console.log('🛡️ ZARSEV END-TO-END BUSINESS FUNCTIONAL AUDIT');
    console.log(`🌐 Target Base URL: ${BASE_URL}`);
    console.log(`🗄️ Target Database: zarsev_test (PostgreSQL Engine)`);
    console.log('===============================================================\n');

    const pool = pgAdapter.getAppPool('zarsev_test');
    
    // Verify connection to zarsev_test
    const dbCheck = await pool.query('SELECT current_database()');
    console.log(`✓ Confirmed active connection to: ${dbCheck.rows[0].current_database}`);
    assert.strictEqual(dbCheck.rows[0].current_database, 'zarsev_test', 'Must strictly connect to zarsev_test!');

    // Baseline record counts
    const baselineProducts = await pool.query('SELECT count(*) FROM products');
    const baselineImports = await pool.query('SELECT count(*) FROM imports');
    const baselineMfgs = await pool.query('SELECT count(*) FROM manufacturers');
    console.log(`✓ Baseline counts in zarsev_test: Products=${baselineProducts.rows[0].count}, Imports=${baselineImports.rows[0].count}, Manufacturers=${baselineMfgs.rows[0].count}\n`);

    const server = app.listen(TEST_PORT);

    let createdImportId = null;
    let createdItemIds = [];
    let createdProductIds = [];
    let createdMfgId = null;

    try {
        // =========================================================================
        // 1. MANUFACTURER JOURNEY
        // =========================================================================
        console.log('--- 1. MANUFACTURER JOURNEY AUDIT ---');

        // 1.1 Login & Identity Verification
        let mfgToken = null;
        let mfgUser = null;

        const mfgLoginRes = await fetch(`${BASE_URL}/api/auth/dev-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'usr_mfg_nile_fruits' })
        });
        const mfgLoginData = await mfgLoginRes.json();

        if (mfgLoginData.success && mfgLoginData.token) {
            mfgToken = mfgLoginData.token;
            mfgUser = mfgLoginData.user;
            recordTest({
                category: '1. Manufacturer Journey',
                name: 'Authentication & Profile Binding',
                operation: 'Login as Nile Fruits Manufacturer',
                endpoint: 'POST /api/auth/dev-login',
                dbTable: 'users JOIN manufacturers',
                expected: 'Role=MANUFACTURER, linked to mfg_nile_fruits',
                actual: `Role=${mfgUser.role}, ManufacturerId=${mfgUser.manufacturer_id}`,
                status: mfgUser.role === 'MANUFACTURER' && mfgUser.manufacturer_id === 'mfg_nile_fruits' ? 'PASS' : 'FAIL'
            });
        } else {
            recordTest({
                category: '1. Manufacturer Journey',
                name: 'Authentication & Profile Binding',
                operation: 'Login as Nile Fruits Manufacturer',
                endpoint: 'POST /api/auth/dev-login',
                dbTable: 'users',
                expected: 'HTTP 200 with JWT',
                actual: `Failed: ${JSON.stringify(mfgLoginData)}`,
                status: 'FAIL'
            });
            throw new Error('Manufacturer login failed');
        }

        const mfgAuthHeaders = { 'Authorization': `Bearer ${mfgToken}` };

        // 1.2 Upload CSV Catalog
        const sampleCsvPath = path.join(__dirname, 'sample_products.csv');
        const csvContent = fs.readFileSync(sampleCsvPath);
        const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substring(2);

        const multipartBody = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="sample_products.csv"\r\nContent-Type: text/csv\r\n\r\n`),
            csvContent,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        const uploadRes = await fetch(`${BASE_URL}/api/imports/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                ...mfgAuthHeaders
            },
            body: multipartBody
        });
        const uploadData = await uploadRes.json();

        if (uploadData.success && uploadData.import_id) {
            createdImportId = uploadData.import_id;
            
            // Poll until background worker finishes extraction
            let isReady = false;
            let attempts = 0;
            while (!isReady && attempts < 25) {
                await sleep(400);
                attempts++;
                const statusRes = await fetch(`${BASE_URL}/api/imports/status/${createdImportId}`, {
                    headers: mfgAuthHeaders
                });
                const statusData = await statusRes.json();
                if (statusData.import && (statusData.import.status === 'REVIEW_READY' || statusData.import.status === 'COMPLETED')) {
                    isReady = true;
                }
            }

            // Verify in PostgreSQL imports table
            const dbImport = await pool.query('SELECT * FROM imports WHERE id = $1', [createdImportId]);
            const importRow = dbImport.rows[0];

            recordTest({
                category: '1. Manufacturer Journey',
                name: 'CSV Catalog Upload & Batch Creation',
                operation: 'Upload CSV and process background extraction',
                endpoint: 'POST /api/imports/upload',
                dbTable: 'imports',
                expected: 'Row created in imports with manufacturer_id=mfg_nile_fruits and progress_percent=100',
                actual: `Found row: id=${importRow?.id}, status=${importRow?.status}, progress=${importRow?.progress_percent}%, mfg=${importRow?.manufacturer_id}`,
                status: importRow && importRow.manufacturer_id === 'mfg_nile_fruits' && importRow.progress_percent === 100 ? 'PASS' : 'FAIL'
            });
        } else {
            recordTest({
                category: '1. Manufacturer Journey',
                name: 'CSV Catalog Upload & Batch Creation',
                operation: 'Upload CSV file',
                endpoint: 'POST /api/imports/upload',
                dbTable: 'imports',
                expected: 'HTTP 202 with import_id',
                actual: `Upload failed: ${JSON.stringify(uploadData)}`,
                status: 'FAIL'
            });
            throw new Error('Upload failed');
        }

        // 1.3 Extracted Items Persistence & Association
        const itemsRes = await fetch(`${BASE_URL}/api/imports/${createdImportId}/items`, {
            headers: mfgAuthHeaders
        });
        const itemsData = await itemsRes.json();

        const dbItems = await pool.query('SELECT * FROM import_items WHERE import_id = $1 ORDER BY id', [createdImportId]);
        createdItemIds = dbItems.rows.map(r => r.id);

        recordTest({
            category: '1. Manufacturer Journey',
            name: 'Extracted Products Database Persistence',
            operation: 'Verify extracted products saved in import_items',
            endpoint: 'GET /api/imports/:id/items',
            dbTable: 'import_items',
            expected: '2 extracted items stored in import_items table',
            actual: `Retrieved ${dbItems.rows.length} rows from PostgreSQL import_items`,
            status: dbItems.rows.length === 2 ? 'PASS' : 'FAIL'
        });

        // 1.4 Edit Extracted Product & Verify Update in PostgreSQL
        const targetItemId = createdItemIds[0];
        const editPayload = {
            extracted_data: {
                name_ar: 'تمر مجدول فاخر درجة أولى - معدل للاختبار',
                price: 3950.00,
                packaging_info: 'كرتونة 5 كجم مبردة معتمدة للتصدير',
                moq: '3 Containers',
                currency: 'USD',
                price_unit: 'MT'
            }
        };

        const editRes = await fetch(`${BASE_URL}/api/imports/${createdImportId}/items/${targetItemId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...mfgAuthHeaders },
            body: JSON.stringify(editPayload)
        });
        const editData = await editRes.json();

        // Query PostgreSQL directly to verify update
        const dbUpdatedItem = await pool.query('SELECT extracted_data FROM import_items WHERE id = $1', [targetItemId]);
        const updatedExtData = dbUpdatedItem.rows[0]?.extracted_data || {};
        const parsedExt = typeof updatedExtData === 'string' ? JSON.parse(updatedExtData) : updatedExtData;

        const isPriceUpdated = parsedExt.price == 3950;
        const isNameUpdated = parsedExt.name_ar === 'تمر مجدول فاخر درجة أولى - معدل للاختبار';

        recordTest({
            category: '1. Manufacturer Journey',
            name: 'Edit Product Details & Persistence',
            operation: 'Update product price and packaging',
            endpoint: 'PUT /api/imports/:id/items/:itemId',
            dbTable: 'import_items.extracted_data',
            expected: 'PostgreSQL record updated: price=3950, name_ar matches',
            actual: `PostgreSQL data: price=${parsedExt.price}, name_ar="${parsedExt.name_ar}"`,
            status: editData.success && isPriceUpdated && isNameUpdated ? 'PASS' : 'FAIL'
        });

        // 1.5 Submit Products for Approval & State Transition
        const submitRes = await fetch(`${BASE_URL}/api/imports/${createdImportId}/submit-approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...mfgAuthHeaders },
            body: JSON.stringify({ selected_item_ids: createdItemIds })
        });
        const submitData = await submitRes.json();

        // Verify products created in products table with status 'PENDING_APPROVAL'
        const dbCreatedProds = await pool.query(
            'SELECT id, name_ar, price, status, manufacturer_id FROM products WHERE source_import_id = $1 ORDER BY id',
            [createdImportId]
        );
        createdProductIds = dbCreatedProds.rows.map(r => r.id);

        const allPending = dbCreatedProds.rows.length === 2 && dbCreatedProds.rows.every(r => r.status === 'PENDING_APPROVAL');
        const correctMfg = dbCreatedProds.rows.every(r => r.manufacturer_id === 'mfg_nile_fruits');
        const pricePreserved = dbCreatedProds.rows.some(r => r.price == 3950);

        recordTest({
            category: '1. Manufacturer Journey',
            name: 'Submit for Approval & Products Table Population',
            operation: 'Submit extracted items to platform governance queue',
            endpoint: 'POST /api/imports/:id/submit-approval',
            dbTable: 'products',
            expected: '2 products created with status=PENDING_APPROVAL and manufacturer_id=mfg_nile_fruits',
            actual: `Created ${dbCreatedProds.rows.length} products, allPending=${allPending}, correctMfg=${correctMfg}, pricePreserved=${pricePreserved}`,
            status: submitData.success && allPending && correctMfg && pricePreserved ? 'PASS' : 'FAIL'
        });


        // =========================================================================
        // 2. SUPER ADMIN GOVERNANCE JOURNEY
        // =========================================================================
        console.log('\n--- 2. SUPER ADMIN GOVERNANCE JOURNEY AUDIT ---');

        // 2.1 Admin Authentication
        const adminLoginRes = await fetch(`${BASE_URL}/api/auth/dev-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'usr_super_admin' })
        });
        const adminLoginData = await adminLoginRes.json();
        const adminToken = adminLoginData.token;
        const adminAuthHeaders = { 'Authorization': `Bearer ${adminToken}` };

        // 2.2 View Pending Products Queue
        const queueRes = await fetch(`${BASE_URL}/api/approvals/queue`, {
            headers: adminAuthHeaders
        });
        const queueData = await queueRes.json();
        const queueList = queueData.queue || [];
        const containsCreatedProds = createdProductIds.every(id => queueList.some(q => q.id === id));

        recordTest({
            category: '2. Admin Governance Journey',
            name: 'Approvals Queue Visibility',
            operation: 'Fetch pending approval queue for Super Admin',
            endpoint: 'GET /api/approvals/queue',
            dbTable: 'products (status=PENDING_APPROVAL)',
            expected: 'Submitted products appear in pending queue',
            actual: `Queue length=${queueList.length}, Contains new products=${containsCreatedProds}`,
            status: containsCreatedProds ? 'PASS' : 'FAIL'
        });

        // 2.3 Approve Product 1 -> Verify Status Changes to 'PUBLISHED'
        const prodToApprove = createdProductIds[0];
        const approveRes = await fetch(`${BASE_URL}/api/approvals/${prodToApprove}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...adminAuthHeaders },
            body: JSON.stringify({ decision: 'APPROVE' })
        });
        const approveData = await approveRes.json();

        // Verify directly in PostgreSQL
        const dbApprovedProd = await pool.query('SELECT status, rejection_reason FROM products WHERE id = $1', [prodToApprove]);
        const approvedRow = dbApprovedProd.rows[0];

        recordTest({
            category: '2. Admin Governance Journey',
            name: 'Product Approval & State Change to PUBLISHED',
            operation: 'Super Admin approves product',
            endpoint: 'POST /api/approvals/:productId/decide (APPROVE)',
            dbTable: 'products',
            expected: 'PostgreSQL status updated to PUBLISHED, rejection_reason is NULL',
            actual: `Status=${approvedRow?.status}, RejectionReason=${approvedRow?.rejection_reason}`,
            status: approveData.success && approvedRow?.status === 'PUBLISHED' && approvedRow?.rejection_reason === null ? 'PASS' : 'FAIL'
        });

        // 2.4 Reject Product 2 with Reason -> Verify Status Changes to 'REJECTED' and Reason is Stored
        const prodToReject = createdProductIds[1];
        const rejectionMsg = 'المواصفات الفنية غير مكتملة، يرجى توضيح كود التتبع ومعيار التبريد';

        const rejectRes = await fetch(`${BASE_URL}/api/approvals/${prodToReject}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...adminAuthHeaders },
            body: JSON.stringify({ decision: 'REJECT', rejection_reason: rejectionMsg })
        });
        const rejectData = await rejectRes.json();

        // Verify directly in PostgreSQL
        const dbRejectedProd = await pool.query('SELECT status, rejection_reason FROM products WHERE id = $1', [prodToReject]);
        const rejectedRow = dbRejectedProd.rows[0];

        recordTest({
            category: '2. Admin Governance Journey',
            name: 'Product Rejection with Feedback Persistence',
            operation: 'Super Admin rejects product with reason',
            endpoint: 'POST /api/approvals/:productId/decide (REJECT)',
            dbTable: 'products',
            expected: 'PostgreSQL status updated to REJECTED with stored reason',
            actual: `Status=${rejectedRow?.status}, Reason="${rejectedRow?.rejection_reason}"`,
            status: rejectData.success && rejectedRow?.status === 'REJECTED' && rejectedRow?.rejection_reason === rejectionMsg ? 'PASS' : 'FAIL'
        });

        // 2.5 Catalog Visibility Verification: PUBLISHED product visible, REJECTED product hidden
        const publicCatalogRes = await fetch(`${BASE_URL}/api/products`);
        const publicCatalogData = await publicCatalogRes.json();
        const publicProducts = publicCatalogData.products || [];

        const isApprovedInPublic = publicProducts.some(p => p.id === prodToApprove);
        const isRejectedInPublic = publicProducts.some(p => p.id === prodToReject);

        recordTest({
            category: '2. Admin Governance Journey',
            name: 'Public Catalog Selective Exposure',
            operation: 'Query unauthenticated public catalog endpoint',
            endpoint: 'GET /api/products',
            dbTable: 'products (status=PUBLISHED filter)',
            expected: 'Approved product is visible, Rejected product is strictly excluded',
            actual: `ApprovedVisible=${isApprovedInPublic}, RejectedVisible=${isRejectedInPublic}`,
            status: isApprovedInPublic && !isRejectedInPublic ? 'PASS' : 'FAIL'
        });


        // =========================================================================
        // 3. BUYER JOURNEY & RFQ AUDIT
        // =========================================================================
        console.log('\n--- 3. BUYER JOURNEY & RFQ AUDIT ---');

        // 3.1 Product Search
        const searchRes = await fetch(`${BASE_URL}/api/products?search=تمر`);
        const searchData = await searchRes.json();
        const searchResults = searchData.products || [];
        const searchFoundApproved = searchResults.some(p => p.id === prodToApprove);

        recordTest({
            category: '3. Buyer Journey',
            name: 'Public Catalog Keyword Search',
            operation: 'Search for product by keyword "تمر"',
            endpoint: 'GET /api/products?search=تمر',
            dbTable: 'products',
            expected: 'Returns published matching product',
            actual: `Results count=${searchResults.length}, Contains approved item=${searchFoundApproved}`,
            status: searchFoundApproved ? 'PASS' : 'FAIL'
        });

        // 3.2 Product Details Retrieval
        const detailsRes = await fetch(`${BASE_URL}/api/products/${prodToApprove}`);
        const detailsData = await detailsRes.json();
        const prodDetails = detailsData.product;

        recordTest({
            category: '3. Buyer Journey',
            name: 'Product Details Retrieval',
            operation: 'Fetch full product details and specifications',
            endpoint: 'GET /api/products/:id',
            dbTable: 'products JOIN manufacturers',
            expected: 'Full specifications, manufacturer name and packaging returned',
            actual: `Product name="${prodDetails?.name_ar}", Manufacturer="${prodDetails?.manufacturer_name}"`,
            status: prodDetails && prodDetails.id === prodToApprove ? 'PASS' : 'FAIL'
        });

        // 3.3 RFQ Submission & Database Persistence Check
        // Inspecting actual backend implementation of RFQ
        const rfqTablesCheck = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name IN ('rfq', 'rfqs', 'inquiries', 'quotes', 'contact_messages')
        `);
        const rfqTableExists = rfqTablesCheck.rows.length > 0;

        // Check if there is any POST route for rfq in the server
        let rfqPostExists = false;
        try {
            const rfqAttempt = await fetch(`${BASE_URL}/api/rfq`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product_id: prodToApprove, quantity: '10 MT', email: 'buyer@import-corp.de' })
            });
            if (rfqAttempt.status !== 404) rfqPostExists = true;
        } catch (_) {}

        recordTest({
            category: '3. Buyer Journey',
            name: 'RFQ / Order Inquiry Persistence',
            operation: 'Submit RFQ form from product details page',
            endpoint: 'POST /api/rfq or POST /contact (Frontend: handleRfqSubmit())',
            dbTable: 'rfq / inquiries',
            expected: 'RFQ record saved with buyer details, product ID, and quantity in PostgreSQL',
            actual: `Table exists: ${rfqTableExists}, Backend route exists: ${rfqPostExists}. Frontend uses client-side DOM mockup (handleRfqSubmit / handleFormSubmit) without API transmission.`,
            status: 'NOT_IMPLEMENTED',
            notes: 'Critical Finding: RFQ and Contact forms currently only toggle UI visibility classes and do not submit to any backend API or persist to PostgreSQL.'
        });


        // =========================================================================
        // 4. LOGISTICS JOURNEY AUDIT
        // =========================================================================
        console.log('\n--- 4. LOGISTICS JOURNEY AUDIT ---');

        // 4.1 Logistics Authentication
        const logLoginRes = await fetch(`${BASE_URL}/api/auth/dev-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'usr_logistics_officer' })
        });
        const logLoginData = await logLoginRes.json();
        const logToken = logLoginData.token;
        const logAuthHeaders = { 'Authorization': `Bearer ${logToken}` };

        // 4.2 Fuzzy Matching Engine Test
        const matchRes = await fetch(`${BASE_URL}/api/manufacturers/match?name=${encodeURIComponent('محطة البستان للتعبئة')}`, {
            headers: logAuthHeaders
        });
        const matchData = await matchRes.json();
        const match = matchData.match;

        recordTest({
            category: '4. Logistics Journey',
            name: 'Smart Fuzzy Matching Engine',
            operation: 'Query fuzzy matcher with "محطة البستان للتعبئة"',
            endpoint: 'GET /api/manufacturers/match?name=...',
            dbTable: 'manufacturers',
            expected: 'Identifies matching packhouse record with confidence score',
            actual: `Matched: "${match?.name_ar}", Code=${match?.code}, Model=${match?.business_model}, Confidence=${match?.match_confidence}%`,
            status: match && match.name_ar && match.code ? 'PASS' : 'FAIL'
        });

        // 4.3 Duplicate Prevention on Creation
        const dupRes = await fetch(`${BASE_URL}/api/manufacturers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...logAuthHeaders },
            body: JSON.stringify({
                name_ar: match.name_ar, // Identical name
                city: 'دمياط',
                business_model: 'DIRECT_CONTRACT'
            })
        });
        const dupData = await dupRes.json();

        recordTest({
            category: '4. Logistics Journey',
            name: 'Duplicate Packhouse Prevention',
            operation: 'Attempt to register a packhouse with existing name',
            endpoint: 'POST /api/manufacturers',
            dbTable: 'manufacturers',
            expected: 'HTTP 409 Conflict with duplicate warning message',
            actual: `Status=${dupRes.status}, Error="${dupData.error}"`,
            status: dupRes.status === 409 ? 'PASS' : 'FAIL'
        });

        // 4.4 Create New Valid Packhouse & Verify PostgreSQL Persistence
        const uniqueCode = 'EGY-TEST-' + Math.random().toString(16).substring(2, 6).toUpperCase();
        const createMfgRes = await fetch(`${BASE_URL}/api/manufacturers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...logAuthHeaders },
            body: JSON.stringify({
                name_ar: 'محطة الفيروز للتبريد السريع والتعبئة (تجريبي)',
                name_en: 'Al-Fayrouz Rapid Pre-Cooling Packhouse',
                code: uniqueCode,
                city: 'دمياط',
                business_model: 'DIRECT_CONTRACT',
                contact_email: 'fayrouz@test.zarsev.com',
                contact_phone: '+20572700599'
            })
        });
        const createMfgData = await createMfgRes.json();

        if (createMfgData.success && createMfgData.manufacturer) {
            createdMfgId = createMfgData.manufacturer.id;

            // Verify directly in PostgreSQL
            const dbMfg = await pool.query('SELECT * FROM manufacturers WHERE id = $1', [createdMfgId]);
            const mfgRow = dbMfg.rows[0];

            recordTest({
                category: '4. Logistics Journey',
                name: 'Create Manufacturer Record & Persistence',
                operation: 'Register new packhouse record',
                endpoint: 'POST /api/manufacturers',
                dbTable: 'manufacturers',
                expected: 'Record inserted with is_verified=true, business_model=DIRECT_CONTRACT',
                actual: `Inserted: id=${mfgRow?.id}, name_ar="${mfgRow?.name_ar}", code=${mfgRow?.code}, is_verified=${mfgRow?.is_verified}`,
                status: mfgRow && mfgRow.code === uniqueCode && mfgRow.business_model === 'DIRECT_CONTRACT' ? 'PASS' : 'FAIL'
            });
        } else {
            recordTest({
                category: '4. Logistics Journey',
                name: 'Create Manufacturer Record & Persistence',
                operation: 'Register new packhouse record',
                endpoint: 'POST /api/manufacturers',
                dbTable: 'manufacturers',
                expected: 'HTTP 201 with manufacturer object',
                actual: `Failed: ${JSON.stringify(createMfgData)}`,
                status: 'FAIL'
            });
        }

    } catch (err) {
        console.error('Fatal audit failure:', err);
    } finally {
        // =========================================================================
        // 5. TEST DATA CLEANUP (MANDATORY ISOLATION GUARD)
        // =========================================================================
        console.log('\n--- 5. CLEANING UP TEST DATA IN ZARSEV_TEST ---');

        if (createdProductIds.length > 0) {
            const delProds = await pool.query('DELETE FROM products WHERE id = ANY($1)', [createdProductIds]);
            console.log(`✓ Cleaned up ${delProds.rowCount} test products from zarsev_test`);
        }

        if (createdItemIds.length > 0) {
            const delItems = await pool.query('DELETE FROM import_items WHERE id = ANY($1)', [createdItemIds]);
            console.log(`✓ Cleaned up ${delItems.rowCount} test import items from zarsev_test`);
        }

        if (createdImportId) {
            const delImports = await pool.query('DELETE FROM imports WHERE id = $1', [createdImportId]);
            console.log(`✓ Cleaned up test import record ${createdImportId} from zarsev_test`);
        }

        if (createdMfgId) {
            const delMfg = await pool.query('DELETE FROM manufacturers WHERE id = $1', [createdMfgId]);
            console.log(`✓ Cleaned up test manufacturer ${createdMfgId} from zarsev_test`);
        }

        // Verify baseline counts remained intact
        const finalProducts = await pool.query('SELECT count(*) FROM products');
        const finalImports = await pool.query('SELECT count(*) FROM imports');
        const finalMfgs = await pool.query('SELECT count(*) FROM manufacturers');
        console.log(`✓ Final counts in zarsev_test: Products=${finalProducts.rows[0].count}, Imports=${finalImports.rows[0].count}, Manufacturers=${finalMfgs.rows[0].count}`);
        assert.strictEqual(finalProducts.rows[0].count, baselineProducts.rows[0].count, 'Baseline products count must match!');
        assert.strictEqual(finalImports.rows[0].count, baselineImports.rows[0].count, 'Baseline imports count must match!');
        assert.strictEqual(finalMfgs.rows[0].count, baselineMfgs.rows[0].count, 'Baseline manufacturers count must match!');
        console.log('🔒 Test isolation confirmed: Database returned to exact baseline state.');

        server.close();
        await pool.end();
    }

    // =========================================================================
    // 6. SUMMARY & AUDIT RESULTS
    // =========================================================================
    console.log('\n===============================================================');
    console.log('📊 FUNCTIONAL VERIFICATION AUDIT SUMMARY');
    console.log('===============================================================');
    console.log(`Total Checks: ${auditResults.summary.total}`);
    console.log(`Passed: ${auditResults.summary.passed}`);
    console.log(`Failed: ${auditResults.summary.failed}`);
    console.log(`Not Implemented (Stubs): ${auditResults.summary.notImplemented}`);
    const passPercentage = ((auditResults.summary.passed / auditResults.summary.total) * 100).toFixed(1);
    console.log(`Success Rate: ${passPercentage}%\n`);

    fs.writeFileSync(path.join(__dirname, 'functional_audit_results.json'), JSON.stringify(auditResults, null, 2), 'utf8');
}

runE2EFunctionalAudit().catch(err => {
    console.error('Audit crashed:', err);
    process.exit(1);
});
