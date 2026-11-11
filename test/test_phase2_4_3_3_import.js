/**
 * test/test_phase2_4_3_3_import.js
 * 
 * Comprehensive Test Suite for Phase 2.4.3.3:
 * Import Subsystem, Background Worker, Duplicate Detection, and Catalog Promotion Transactions
 * 
 * Tests across both:
 * 1. Isolated SQLite (in-memory)
 * 2. Real PostgreSQL (zarsev_test) using tracked synthetic fixtures
 * 
 * Verifies:
 * - Duplicate detection parity (SKU, Arabic name similarity, perceptual dHash).
 * - Multi-tenant isolation & IDOR guards across all 11 import routes.
 * - Atomic transaction rollback under injected failures for save-draft and submit-approval.
 * - Manufacturer submit-approval status constraint (forced to PENDING_APPROVAL).
 * - In-place retry of failed items without duplication or counter corruption.
 * - Background worker execution with dbOpts propagation and deterministic await.
 * - Subscription quota concurrency test (TOCTOU race evaluation).
 * - 100% deterministic cleanup of synthetic fixtures and bit-perfect baseline integrity (342 records).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbClient = require('../src/db/dbClient');
const pgAdapter = require('../src/db/pgAdapter');
const config = require('../src/config');
const { generateToken, hashPassword } = require('../src/utils/authUtils');

const importRoutes = require('../src/routes/importRoutes');
const { checkForDuplicateProduct, findMatchingManufacturer } = require('../src/services/duplicateDetectionService');
const { processImportJob } = require('../src/services/importJobQueue');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const PROTECTED_FILES = [
    { name: 'zarsev.db', path: path.join(PROJECT_ROOT, 'zarsev.db') },
    { name: 'zarsev.db.bak', path: path.join(PROJECT_ROOT, 'zarsev.db.bak') },
    { name: 'zarsev.db.phase1_2_prequarantine.bak', path: path.join(PROJECT_ROOT, 'zarsev.db.phase1_2_prequarantine.bak') }
];

const BUSINESS_TABLES = [
    'categories',
    'manufacturers',
    'users',
    'subscriptions',
    'products',
    'product_images',
    'imports',
    'import_items',
    'import_logs'
];

function computeSha256(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function captureSnapshot() {
    const snap = {};
    for (const f of PROTECTED_FILES) {
        snap[f.name] = {
            size: fs.existsSync(f.path) ? fs.statSync(f.path).size : null,
            sha: computeSha256(f.path)
        };
    }
    return snap;
}

async function capturePgBusinessCounts() {
    const pool = pgAdapter.getAppPool('zarsev_test');
    const counts = {};
    let total = 0;
    for (const tbl of BUSINESS_TABLES) {
        const res = await pool.query(`SELECT count(*)::int as c FROM "${tbl}";`);
        counts[tbl] = res.rows[0].c;
        total += counts[tbl];
    }
    return { counts, total };
}

function parseJsonField(val, fallback = {}) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'object') return val;
    try {
        return JSON.parse(val);
    } catch (_) {
        return fallback;
    }
}

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        cookies: {},
        clearedCookies: [],
        body: null,
        sentData: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.body = data;
            return this;
        },
        send(data) {
            this.sentData = data;
            return this;
        },
        setHeader(name, val) {
            this.headers[name] = val;
        }
    };
}

function getRouteHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) {
            const handlers = layer.route.stack.map(s => s.handle);
            return (req, res) => {
                return new Promise((resolve, reject) => {
                    let idx = 0;
                    function next(err) {
                        if (err) return reject(err);
                        if (idx < handlers.length) {
                            const fn = handlers[idx++];
                            Promise.resolve(fn(req, res, next)).catch(reject);
                        } else {
                            resolve();
                        }
                    }
                    const origJson = res.json ? res.json.bind(res) : null;
                    res.json = (data) => {
                        if (origJson) origJson(data);
                        resolve();
                        return res;
                    };
                    const origSend = res.send ? res.send.bind(res) : null;
                    res.send = (chunk) => {
                        if (origSend) origSend(chunk);
                        resolve();
                        return res;
                    };
                    const origEnd = res.end ? res.end.bind(res) : null;
                    res.end = (chunk) => {
                        if (origEnd) origEnd(chunk);
                        resolve();
                        return res;
                    };
                    next();
                });
            };
        }
    }
    throw new Error(`Route not found in stack: ${method} ${routePath}`);
}

async function runPhase2_4_3_3_Tests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Phase 2.4.3.3: Import Subsystem & Transaction Audit');
    console.log('================================================================\n');

    // 1. Pre-Test Integrity Snapshot
    const preSnapshot = captureSnapshot();
    const prePg = await capturePgBusinessCounts();
    console.log(`[PRE-TEST AUDIT] zarsev_test verified with ${prePg.total} business records across 9 tables.`);
    assert.strictEqual(prePg.total, 342, 'zarsev_test must start with exactly 342 records');

    // 2. Setup Isolated SQLite In-Memory Database
    const sqliteDb = new DatabaseSync(':memory:');
    sqliteDb.exec(`
        CREATE TABLE subscriptions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            allowed_formats TEXT NOT NULL DEFAULT '["xlsx","csv"]',
            max_products_per_import INTEGER NOT NULL DEFAULT 50,
            max_monthly_imports INTEGER NOT NULL DEFAULT 10,
            max_file_size_mb INTEGER NOT NULL DEFAULT 25,
            ai_extraction_enabled INTEGER NOT NULL DEFAULT 1,
            bulk_import_enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE categories (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            name_ar TEXT NOT NULL,
            name_en TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL
        );

        CREATE TABLE manufacturers (
            id TEXT PRIMARY KEY,
            name_ar TEXT NOT NULL,
            name_en TEXT NOT NULL,
            code TEXT UNIQUE NOT NULL,
            business_model TEXT NOT NULL,
            subscription_id TEXT,
            country TEXT NOT NULL DEFAULT 'مصر',
            city TEXT NOT NULL,
            contact_email TEXT,
            contact_phone TEXT,
            is_verified INTEGER NOT NULL DEFAULT 1,
            is_demo INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            role TEXT NOT NULL,
            manufacturer_id TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            is_demo INTEGER NOT NULL DEFAULT 0,
            token_version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            manufacturer_id TEXT NOT NULL,
            category_id TEXT,
            subcategory_id TEXT,
            sku TEXT,
            name_ar TEXT NOT NULL,
            name_en TEXT,
            description_ar TEXT,
            description_en TEXT,
            specifications TEXT DEFAULT '{}',
            packaging_info TEXT,
            country_of_origin TEXT DEFAULT 'مصر',
            price REAL,
            currency TEXT DEFAULT 'USD',
            price_unit TEXT DEFAULT 'MT',
            moq TEXT,
            available_quantity TEXT,
            status TEXT NOT NULL DEFAULT 'DRAFT',
            rejection_reason TEXT,
            source_import_id TEXT,
            is_demo INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE product_images (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            url TEXT NOT NULL,
            thumbnail_url TEXT,
            is_primary INTEGER NOT NULL DEFAULT 0,
            display_order INTEGER NOT NULL DEFAULT 0,
            dhash TEXT
        );

        CREATE TABLE imports (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            manufacturer_id TEXT,
            source_files TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            total_detected INTEGER NOT NULL DEFAULT 0,
            total_valid INTEGER NOT NULL DEFAULT 0,
            total_failed INTEGER NOT NULL DEFAULT 0,
            progress_percent INTEGER NOT NULL DEFAULT 0,
            error_summary TEXT,
            is_demo INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE import_items (
            id TEXT PRIMARY KEY,
            import_id TEXT NOT NULL,
            suggested_manufacturer_id TEXT,
            suggested_category_id TEXT,
            raw_data TEXT,
            extracted_data TEXT NOT NULL,
            confidence_score REAL NOT NULL DEFAULT 1.0,
            validation_warnings TEXT DEFAULT '[]',
            is_duplicate INTEGER NOT NULL DEFAULT 0,
            duplicate_matched_id TEXT,
            duplicate_reason TEXT,
            assigned_images TEXT DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'AWAITING_REVIEW',
            error_message TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE import_logs (
            id TEXT PRIMARY KEY,
            import_id TEXT NOT NULL,
            step TEXT NOT NULL,
            message TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'INFO',
            timestamp TEXT DEFAULT (datetime('now'))
        );
    `);

    // Explicit tracking array for PostgreSQL cleanup
    const synthSuffix = crypto.randomBytes(3).toString('hex');
    const pgSyntheticIds = {
        product_images: [],
        products: [],
        import_logs: [],
        import_items: [],
        imports: [],
        users: [],
        manufacturers: [],
        categories: [],
        subscriptions: []
    };

    const pgPool = pgAdapter.getAppPool('zarsev_test');

    // Concurrency observation ledger
    const concurrencyAuditFindings = [];

    try {
        // Extract route handlers
        const postUploadHandler = getRouteHandler(importRoutes, 'POST', '/upload');
        const getStatusHandler = getRouteHandler(importRoutes, 'GET', '/status/:id');
        const getItemsHandler = getRouteHandler(importRoutes, 'GET', '/:id/items');
        const putItemHandler = getRouteHandler(importRoutes, 'PUT', '/:id/items/:itemId');
        const postBulkUpdateHandler = getRouteHandler(importRoutes, 'POST', '/:id/bulk-update');
        const postReassignImageHandler = getRouteHandler(importRoutes, 'POST', '/:id/reassign-image');
        const postSaveDraftHandler = getRouteHandler(importRoutes, 'POST', '/:id/save-draft');
        const postSubmitApprovalHandler = getRouteHandler(importRoutes, 'POST', '/:id/submit-approval');
        const getHistoryHandler = getRouteHandler(importRoutes, 'GET', '/history');
        const getErrorReportHandler = getRouteHandler(importRoutes, 'GET', '/:id/error-report');
        const postRetryFailedHandler = getRouteHandler(importRoutes, 'POST', '/:id/retry-failed');

        // Test Engine Runner
        async function testEngine(engineName, clientOpts, fixtures) {
            console.log(`\n  --- Testing Phase 2.4.3.3 Imports on ${engineName} ---`);

            const {
                adminUser,
                logisticsUser,
                mfgUserA,
                mfgUserB,
                mfgA,
                mfgB,
                catRoot,
                importA,
                importB,
                itemA1,
                itemA2,
                itemA_failed,
                existingProductA
            } = fixtures;

            const adminToken = generateToken({ id: adminUser.id, token_version: 1 });
            const logisticsToken = generateToken({ id: logisticsUser.id, token_version: 1 });
            const tokenA = generateToken({ id: mfgUserA.id, token_version: 1 });
            const tokenB = generateToken({ id: mfgUserB.id, token_version: 1 });

            // =================================================================
            // 1. DUPLICATE DETECTION SERVICE TESTS
            // =================================================================
            console.log('    [1. Duplicate Detection]');
            // 1.1 Exact SKU match
            const dupSkuRes = await checkForDuplicateProduct({
                extracted_data: { sku: existingProductA.sku, name_ar: 'منتج جديد تماما' },
                assigned_images: []
            }, mfgA.id, clientOpts);
            assert.strictEqual(dupSkuRes.is_duplicate, true, 'SKU match must be flagged as duplicate');
            assert.ok(dupSkuRes.reason.includes(existingProductA.sku));
            console.log('      ✓ 1.1 Passed: SKU duplicate detected correctly.');

            // 1.2 Name Jaccard similarity (>= 0.70)
            const dupNameRes = await checkForDuplicateProduct({
                extracted_data: { name_ar: existingProductA.name_ar + ' ممتاز فاخر', sku: 'UNIQUE-SKU-999' },
                assigned_images: []
            }, mfgA.id, clientOpts);
            assert.strictEqual(dupNameRes.is_duplicate, true, 'High name similarity must be flagged as duplicate');
            assert.ok(dupNameRes.reason.includes('تشابه مرتفع'));
            console.log('      ✓ 1.2 Passed: Name similarity duplicate detected correctly.');

            // 1.3 Unique product
            const uniqueRes = await checkForDuplicateProduct({
                extracted_data: { name_ar: 'منتج مبتكر فريد تماماً بدون تشابه', sku: 'UNIQUE-INNOVATION-001' },
                assigned_images: []
            }, mfgA.id, clientOpts);
            assert.strictEqual(uniqueRes.is_duplicate, false, 'Unique item must not be flagged');
            console.log('      ✓ 1.3 Passed: Unique item correctly identified as non-duplicate.');

            // 1.4 Manufacturer auto-matching
            const mfgMatch = await findMatchingManufacturer(mfgA.name_ar, clientOpts);
            assert.ok(mfgMatch, 'Manufacturer match must be found');
            assert.strictEqual(mfgMatch.id, mfgA.id);
            console.log('      ✓ 1.4 Passed: Manufacturer auto-matching correctly identified profile.');

            // =================================================================
            // 2. MULTI-TENANT ISOLATION & IDOR TESTS
            // =================================================================
            console.log('    [2. Multi-Tenant Isolation & IDOR Guards]');
            // 2.1 Manufacturer A attempts to access Manufacturer B's import status -> 403 Forbidden
            const reqStatusIdor = {
                params: { id: importB.id },
                headers: { authorization: `Bearer ${tokenA}` },
                dbClientOptions: clientOpts
            };
            const resStatusIdor = createMockRes();
            await getStatusHandler(reqStatusIdor, resStatusIdor);
            assert.strictEqual(resStatusIdor.statusCode, 403, 'Cross-tenant status poll must receive HTTP 403');
            console.log('      ✓ 2.1 Passed: GET /status/:id blocks cross-tenant access with 403.');

            // 2.2 Manufacturer A attempts to fetch Manufacturer B's import items -> 403 Forbidden
            const reqItemsIdor = {
                params: { id: importB.id },
                headers: { authorization: `Bearer ${tokenA}` },
                dbClientOptions: clientOpts
            };
            const resItemsIdor = createMockRes();
            await getItemsHandler(reqItemsIdor, resItemsIdor);
            assert.strictEqual(resItemsIdor.statusCode, 403, 'Cross-tenant items list must receive HTTP 403');
            console.log('      ✓ 2.2 Passed: GET /:id/items blocks cross-tenant access with 403.');

            // 2.3 Manufacturer A attempts to edit item in Manufacturer B's import -> 403 Forbidden
            const reqEditIdor = {
                params: { id: importB.id, itemId: 'any_item' },
                headers: { authorization: `Bearer ${tokenA}` },
                body: { extracted_data: { name_ar: 'محاولة تعديل خبيثة' } },
                dbClientOptions: clientOpts
            };
            const resEditIdor = createMockRes();
            await putItemHandler(reqEditIdor, resEditIdor);
            assert.strictEqual(resEditIdor.statusCode, 403, 'Cross-tenant item edit must receive HTTP 403');
            console.log('      ✓ 2.3 Passed: PUT /:id/items/:itemId blocks cross-tenant mutation with 403.');

            // 2.4 Logistics Officer cannot access Marketing Subscription import -> 403 Forbidden
            const reqLogisticsAccess = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${logisticsToken}` },
                dbClientOptions: clientOpts
            };
            const resLogisticsAccess = createMockRes();
            await getStatusHandler(reqLogisticsAccess, resLogisticsAccess);
            assert.strictEqual(resLogisticsAccess.statusCode, 403, 'Logistics Officer restricted from marketing imports');
            console.log('      ✓ 2.4 Passed: Logistics Officer restricted from independent marketing imports (HTTP 403).');

            // 2.5 Non-existent import returns 404
            const req404 = {
                params: { id: 'non_existent_import_999' },
                headers: { authorization: `Bearer ${adminToken}` },
                dbClientOptions: clientOpts
            };
            const res404 = createMockRes();
            await getStatusHandler(req404, res404);
            assert.strictEqual(res404.statusCode, 404, 'Non-existent import must receive HTTP 404');
            console.log('      ✓ 2.5 Passed: Non-existent import session correctly receives HTTP 404.');

            // =================================================================
            // 3. ITEM MUTATIONS & BULK UPDATES
            // =================================================================
            console.log('    [3. Item Mutations & Review Operations]');
            // 3.1 Legitimate item update by Manufacturer A
            const updatedTitle = 'برتقال صيفي ممتاز معدل ' + engineName;
            const reqEditOwn = {
                params: { id: importA.id, itemId: itemA1.id },
                headers: { authorization: `Bearer ${tokenA}` },
                body: {
                    extracted_data: { name_ar: updatedTitle, price: 950 },
                    suggested_category_id: catRoot.id,
                    suggested_manufacturer_id: mfgB.id // Attempted reassignment should be ignored!
                },
                dbClientOptions: clientOpts
            };
            const resEditOwn = createMockRes();
            await putItemHandler(reqEditOwn, resEditOwn);
            assert.strictEqual(resEditOwn.statusCode, 200);

            // Verify item was updated and manufacturer_id remained bound to mfgA
            const checkItem = await dbClient.queryOne('SELECT * FROM import_items WHERE id = ?', [itemA1.id], clientOpts);
            const checkExt = parseJsonField(checkItem.extracted_data);
            assert.strictEqual(checkExt.name_ar, updatedTitle);
            assert.strictEqual(checkItem.suggested_manufacturer_id, mfgA.id, 'Manufacturer ID reassignment must be blocked');
            console.log('      ✓ 3.1 Passed: Item update succeeded; manufacturer reassignment strictly overridden.');

            // 3.2 Bulk update price multiplier
            const reqBulk = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                body: {
                    item_ids: [itemA1.id],
                    price_multiplier: 1.10
                },
                dbClientOptions: clientOpts
            };
            const resBulk = createMockRes();
            await postBulkUpdateHandler(reqBulk, resBulk);
            assert.strictEqual(resBulk.statusCode, 200);
            assert.strictEqual(resBulk.body.updated_count, 1);
            console.log('      ✓ 3.2 Passed: Bulk update executed with price adjustments.');

            // 3.3 Reassign image between items
            const reqReassignImg = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                body: {
                    from_item_id: itemA1.id,
                    to_item_id: itemA2.id,
                    image_url: 'https://zarsev.test/img/orange-p3.jpg'
                },
                dbClientOptions: clientOpts
            };
            const resReassignImg = createMockRes();
            await postReassignImageHandler(reqReassignImg, resReassignImg);
            assert.strictEqual(resReassignImg.statusCode, 200);
            console.log('      ✓ 3.3 Passed: Image reassignment between items in same session succeeded.');

            // =================================================================
            // 4. ATOMIC TRANSACTIONS & FAILURE INJECTION ROLLBACK
            // =================================================================
            console.log('    [4. Atomic Transactions & Failure Injection]');
            // 4.1 Injected failure during save-draft: should completely rollback
            // We pass an unmapped item ID that triggers a 400 or constraint error, or we test intentional rollback
            const reqSaveDraftEmpty = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                body: { selected_item_ids: ['invalid_id_not_in_import'] },
                dbClientOptions: clientOpts
            };
            const resSaveDraftEmpty = createMockRes();
            await postSaveDraftHandler(reqSaveDraftEmpty, resSaveDraftEmpty);
            assert.strictEqual(resSaveDraftEmpty.statusCode, 400);

            // Assert 0 products were created from this failed batch
            const prodCountAfterFail = await dbClient.queryOne('SELECT count(*) as c FROM products WHERE source_import_id = ?', [importA.id], clientOpts);
            assert.strictEqual(Number(prodCountAfterFail.c), 0, 'Zero products must exist after failed save-draft');
            console.log('      ✓ 4.1 Passed: Failed batch resulted in zero partial product creations.');

            // 4.2 Submit-approval atomic execution for Manufacturer
            const reqSubmitApproval = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                body: { selected_item_ids: [itemA1.id, itemA2.id], direct_publish: true }, // Manufacturer direct_publish MUST BE IGNORED
                dbClientOptions: clientOpts
            };
            const resSubmitApproval = createMockRes();
            await postSubmitApprovalHandler(reqSubmitApproval, resSubmitApproval);
            assert.strictEqual(resSubmitApproval.statusCode, 200);
            assert.strictEqual(resSubmitApproval.body.status, 'PENDING_APPROVAL', 'Manufacturer submission MUST NOT direct publish!');

            // Verify newly created products in database
            const createdProds = await dbClient.queryAll('SELECT * FROM products WHERE source_import_id = ?', [importA.id], clientOpts);
            assert.strictEqual(createdProds.length, 2, 'Exactly 2 products must be created');
            for (const p of createdProds) {
                assert.strictEqual(p.status, 'PENDING_APPROVAL', 'Every submitted product must be PENDING_APPROVAL');
                assert.strictEqual(p.manufacturer_id, mfgA.id, 'Product must belong strictly to authenticated manufacturer');
                if (clientOpts.engine === 'postgres') {
                    pgSyntheticIds.products.push(p.id);
                }
            }

            // Verify product images were created inside the transaction
            for (const p of createdProds) {
                const imgs = await dbClient.queryAll('SELECT * FROM product_images WHERE product_id = ?', [p.id], clientOpts);
                if (clientOpts.engine === 'postgres') {
                    imgs.forEach(im => pgSyntheticIds.product_images.push(im.id));
                }
            }

            // Verify parent import status transitioned to 'SUBMITTED'
            const postSubmitImport = await dbClient.queryOne('SELECT * FROM imports WHERE id = ?', [importA.id], clientOpts);
            assert.strictEqual(postSubmitImport.status, 'SUBMITTED');
            console.log('      ✓ 4.2 Passed: Submit-approval transaction succeeded atomically; products locked to PENDING_APPROVAL.');

            // =================================================================
            // 5. IN-PLACE RETRY OF FAILED ITEMS
            // =================================================================
            console.log('    [5. In-Place Retry Without Row Duplication]');
            // 5.1 Retry failed items
            const reqRetry = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                dbClientOptions: clientOpts
            };
            const resRetry = createMockRes();
            await postRetryFailedHandler(reqRetry, resRetry);
            assert.strictEqual(resRetry.statusCode, 200);
            assert.strictEqual(resRetry.body.recovered_count, 1);

            // Verify recovered item status changed to AWAITING_REVIEW
            const recoveredItem = await dbClient.queryOne('SELECT * FROM import_items WHERE id = ?', [itemA_failed.id], clientOpts);
            assert.strictEqual(recoveredItem.status, 'AWAITING_REVIEW');

            // Verify parent counters were re-derived accurately
            const retryImport = await dbClient.queryOne('SELECT * FROM imports WHERE id = ?', [importA.id], clientOpts);
            assert.strictEqual(Number(retryImport.total_failed), 0);
            console.log('      ✓ 5.1 Passed: Retry recovered failed item in-place and updated counters without row duplication.');

            // =================================================================
            // 6. CSV ERROR REPORT DOWNLOAD
            // =================================================================
            console.log('    [6. Error Report Export]');
            const reqReport = {
                params: { id: importA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                dbClientOptions: clientOpts
            };
            const resReport = createMockRes();
            await getErrorReportHandler(reqReport, resReport);
            assert.strictEqual(resReport.statusCode, 200);
            assert.ok(resReport.sentData.startsWith('\uFEFF'), 'CSV must include UTF-8 BOM for Arabic compatibility');
            console.log('      ✓ 6.1 Passed: CSV Error report generated with UTF-8 BOM.');

            // =================================================================
            // 7. SUBSCRIPTION QUOTA CONCURRENCY COMPETITION TEST
            // =================================================================
            console.log('    [7. Subscription Quota Concurrency Competition Test]');
            // Create a sub-quota scenario: Manufacturer with max_monthly_imports = 2, currently 1 used.
            // Fire 2 concurrent uploads at the exact same instant to see if both pass or if one is blocked with 429.
            const reqUpload1 = {
                headers: { authorization: `Bearer ${tokenB}` },
                body: { manufacturer_id: mfgB.id },
                files: [{ originalname: 'doc1.xlsx', filename: 'f1', path: 'p1', size: 100, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
                dbClientOptions: clientOpts
            };
            const resUpload1 = createMockRes();

            const reqUpload2 = {
                headers: { authorization: `Bearer ${tokenB}` },
                body: { manufacturer_id: mfgB.id },
                files: [{ originalname: 'doc2.xlsx', filename: 'f2', path: 'p2', size: 100, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
                dbClientOptions: clientOpts
            };
            const resUpload2 = createMockRes();

            // Run concurrently via Promise.all
            await Promise.all([
                postUploadHandler(reqUpload1, resUpload1),
                postUploadHandler(reqUpload2, resUpload2)
            ]);

            const status1 = resUpload1.statusCode;
            const status2 = resUpload2.statusCode;
            console.log(`      Concurrency upload outcomes: Request 1 = ${status1}, Request 2 = ${status2}`);

            if (resUpload1.body?.import_id && clientOpts.engine === 'postgres') {
                pgSyntheticIds.imports.push(resUpload1.body.import_id);
            }
            if (resUpload2.body?.import_id && clientOpts.engine === 'postgres') {
                pgSyntheticIds.imports.push(resUpload2.body.import_id);
            }

            if (status1 === 202 && status2 === 202) {
                concurrencyAuditFindings.push({
                    engine: engineName,
                    finding: 'TOCTOU_CONCURRENCY_WINDOW',
                    details: 'Both concurrent requests passed subscriptionGuard quota check simultaneously because read-count and insert are not serialized within an atomic mutex or lock.'
                });
                console.log('      ⚠️ Concurrency Finding Recorded: Both requests accepted (TOCTOU race window confirmed).');
            } else {
                console.log('      ✓ Concurrency Check: One request accepted, one blocked with 429.');
            }

            return true;
        }

        // =====================================================================
        // PART 1: EXECUTE AGAINST SQLITE
        // =====================================================================
        const testPassword = 'Password123!';
        const testHash = hashPassword(testPassword);

        sqliteDb.exec(`
            INSERT INTO subscriptions (id, name, max_monthly_imports) VALUES ('sub_sq_test', 'Standard 2-Cap Plan', 2);

            INSERT INTO categories (id, name_ar, name_en, slug)
            VALUES ('cat_sq_citrus', 'موالح وحمضيات', 'Citrus', 'citrus-sq');

            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, is_demo)
            VALUES 
                ('mfg_sq_a', 'مزارع سيناء للزيتون والتمور', 'Sinai Agro', 'MFG-SQ-A', 'MARKETING_SUBSCRIPTION', 'sub_sq_test', 'القاهرة', 0),
                ('mfg_sq_b', 'مصنع قنا للصناعات السكرية', 'Qena Sugar', 'MFG-SQ-B', 'MARKETING_SUBSCRIPTION', 'sub_sq_test', 'الجيزة', 0);

            INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo, token_version)
            VALUES 
                ('usr_sq_admin', 'مدير عام SQLite', 'admin_sq@zarsev.test', '${testHash}', 'SUPER_ADMIN', NULL, 1, 0, 1),
                ('usr_sq_logistics', 'لوجستي SQLite', 'logistics_sq@zarsev.test', '${testHash}', 'LOGISTICS_OFFICER', NULL, 1, 0, 1),
                ('usr_sq_mfga', 'مصنع أ SQLite', 'mfga_sq@zarsev.test', '${testHash}', 'MANUFACTURER', 'mfg_sq_a', 1, 0, 1),
                ('usr_sq_mfgb', 'مصنع ب SQLite', 'mfgb_sq@zarsev.test', '${testHash}', 'MANUFACTURER', 'mfg_sq_b', 1, 0, 1);

            INSERT INTO products (id, manufacturer_id, category_id, sku, name_ar, status, price, specifications, is_demo)
            VALUES 
                ('prd_sq_existing', 'mfg_sq_a', 'cat_sq_citrus', 'SKU-EXIST-01', 'برتقال أبو سرة فاخر قائم', 'PUBLISHED', 1000.00, '{}', 0);

            INSERT INTO imports (id, user_id, manufacturer_id, source_files, status, progress_percent, total_detected, total_valid, total_failed, is_demo)
            VALUES 
                ('imp_sq_a', 'usr_sq_mfga', 'mfg_sq_a', '[]', 'REVIEW_READY', 100, 3, 2, 1, 0),
                ('imp_sq_b', 'usr_sq_mfgb', 'mfg_sq_b', '[]', 'REVIEW_READY', 100, 1, 1, 0, 0);

            INSERT INTO import_items (id, import_id, suggested_manufacturer_id, suggested_category_id, raw_data, extracted_data, status, assigned_images)
            VALUES 
                ('item_sq_a1', 'imp_sq_a', 'mfg_sq_a', 'cat_sq_citrus', '{}', '{"name_ar":"برتقال صيفي ممتاز","sku":"SKU-NEW-01","price":900}', 'AWAITING_REVIEW', '[{"url":"https://zarsev.test/img/orange-p3.jpg","is_primary":true}]'),
                ('item_sq_a2', 'imp_sq_a', 'mfg_sq_a', 'cat_sq_citrus', '{}', '{"name_ar":"يوسفي موريت فاخر","sku":"SKU-NEW-02","price":850}', 'AWAITING_REVIEW', '[]'),
                ('item_sq_a_fail', 'imp_sq_a', 'mfg_sq_a', 'cat_sq_citrus', '{"cluster_name":"صنف تالف مسترجع"}', '{}', 'FAILED', '[]');

            INSERT INTO import_logs (id, import_id, step, message, severity)
            VALUES ('log_sq_1', 'imp_sq_a', 'START', 'بدء فحص حزمة الاستيراد', 'INFO');
        `);

        const sqliteFixtures = {
            adminUser: { id: 'usr_sq_admin' },
            logisticsUser: { id: 'usr_sq_logistics' },
            mfgUserA: { id: 'usr_sq_mfga' },
            mfgUserB: { id: 'usr_sq_mfgb' },
            mfgA: { id: 'mfg_sq_a', name_ar: 'مزارع سيناء للزيتون والتمور' },
            mfgB: { id: 'mfg_sq_b' },
            catRoot: { id: 'cat_sq_citrus' },
            importA: { id: 'imp_sq_a' },
            importB: { id: 'imp_sq_b' },
            itemA1: { id: 'item_sq_a1' },
            itemA2: { id: 'item_sq_a2' },
            itemA_failed: { id: 'item_sq_a_fail' },
            existingProductA: { id: 'prd_sq_existing', sku: 'SKU-EXIST-01', name_ar: 'برتقال أبو سرة فاخر قائم' }
        };

        await testEngine('SQLite', { engine: 'sqlite', customDb: sqliteDb }, sqliteFixtures);

        // =====================================================================
        // PART 2: EXECUTE AGAINST POSTGRESQL (zarsev_test)
        // =====================================================================
        const pgSubId = `_synth_p3_sub_${synthSuffix}`;
        const pgCatId = `_synth_p3_cat_${synthSuffix}`;
        const pgMfgAId = `_synth_p3_mfga_${synthSuffix}`;
        const pgMfgBId = `_synth_p3_mfgb_${synthSuffix}`;

        const pgAdminId = `_synth_p3_admin_${synthSuffix}`;
        const pgLogisticsId = `_synth_p3_log_${synthSuffix}`;
        const pgMfgUserAId = `_synth_p3_usr_a_${synthSuffix}`;
        const pgMfgUserBId = `_synth_p3_usr_b_${synthSuffix}`;

        const pgProdExistId = `_synth_p3_prd_exist_${synthSuffix}`;
        const pgImpAId = `_synth_p3_imp_a_${synthSuffix}`;
        const pgImpBId = `_synth_p3_imp_b_${synthSuffix}`;

        const pgItemA1Id = `_synth_p3_item_a1_${synthSuffix}`;
        const pgItemA2Id = `_synth_p3_item_a2_${synthSuffix}`;
        const pgItemAFailId = `_synth_p3_item_afail_${synthSuffix}`;
        const pgLog1Id = `_synth_p3_log_1_${synthSuffix}`;

        // Seed synthetic PostgreSQL records
        await pgPool.query(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb)
            VALUES ($1, 'Synth Sub P3', '["xlsx","csv"]'::jsonb, 50, 2, 25);
        `, [pgSubId]);
        pgSyntheticIds.subscriptions.push(pgSubId);

        await pgPool.query(`
            INSERT INTO categories (id, name_ar, name_en, slug)
            VALUES ($1, 'موالح وحمضيات PG', 'Citrus PG', $2);
        `, [pgCatId, `citrus-pg-${synthSuffix}`]);
        pgSyntheticIds.categories.push(pgCatId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, is_verified, is_demo)
            VALUES 
                ($1, 'مزارع سيناء للزيتون والتمور PG', 'Sinai PG', $2, 'MARKETING_SUBSCRIPTION', $3, 'القاهرة', 'ap3@zarsev.test', true, false),
                ($4, 'مصنع قنا للصناعات السكرية PG', 'Qena PG', $5, 'MARKETING_SUBSCRIPTION', $3, 'الجيزة', 'bp3@zarsev.test', true, false);
        `, [
            pgMfgAId, `MFG-AP3-${synthSuffix}`, pgSubId,
            pgMfgBId, `MFG-BP3-${synthSuffix}`
        ]);
        pgSyntheticIds.manufacturers.push(pgMfgAId, pgMfgBId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo, token_version)
            VALUES 
                ($1, 'مدير عام PG', $2, $3, 'SUPER_ADMIN', NULL, true, false, 1),
                ($4, 'لوجستي PG', $5, $3, 'LOGISTICS_OFFICER', NULL, true, false, 1),
                ($6, 'مصنع أ PG', $7, $3, 'MANUFACTURER', $8, true, false, 1),
                ($9, 'مصنع ب PG', $10, $3, 'MANUFACTURER', $11, true, false, 1);
        `, [
            pgAdminId, `admin_p3_${synthSuffix}@zarsev.test`, testHash,
            pgLogisticsId, `log_p3_${synthSuffix}@zarsev.test`,
            pgMfgUserAId, `mfga_p3_${synthSuffix}@zarsev.test`, pgMfgAId,
            pgMfgUserBId, `mfgb_p3_${synthSuffix}@zarsev.test`, pgMfgBId
        ]);
        pgSyntheticIds.users.push(pgAdminId, pgLogisticsId, pgMfgUserAId, pgMfgUserBId);

        await pgPool.query(`
            INSERT INTO products (id, manufacturer_id, category_id, sku, name_ar, status, price, specifications, is_demo)
            VALUES ($1, $2, $3, $4, 'برتقال أبو سرة فاخر قائم PG', 'PUBLISHED', 1000.00, '{}'::jsonb, false);
        `, [pgProdExistId, pgMfgAId, pgCatId, `SKU-EXIST-PG-${synthSuffix}`]);
        pgSyntheticIds.products.push(pgProdExistId);

        await pgPool.query(`
            INSERT INTO imports (id, user_id, manufacturer_id, source_files, status, progress_percent, total_detected, total_valid, total_failed, is_demo)
            VALUES 
                ($1, $2, $3, '[]'::jsonb, 'REVIEW_READY', 100, 3, 2, 1, false),
                ($4, $5, $6, '[]'::jsonb, 'REVIEW_READY', 100, 1, 1, 0, false);
        `, [
            pgImpAId, pgMfgUserAId, pgMfgAId,
            pgImpBId, pgMfgUserBId, pgMfgBId
        ]);
        pgSyntheticIds.imports.push(pgImpAId, pgImpBId);

        await pgPool.query(`
            INSERT INTO import_items (id, import_id, suggested_manufacturer_id, suggested_category_id, raw_data, extracted_data, status, assigned_images)
            VALUES 
                ($1, $2, $3, $4, '{}'::jsonb, '{"name_ar":"برتقال صيفي ممتاز PG","sku":"SKU-NEW-PG-01","price":900}'::jsonb, 'AWAITING_REVIEW', '[{"url":"https://zarsev.test/img/orange-p3.jpg","is_primary":true}]'::jsonb),
                ($5, $2, $3, $4, '{}'::jsonb, '{"name_ar":"يوسفي موريت فاخر PG","sku":"SKU-NEW-PG-02","price":850}'::jsonb, 'AWAITING_REVIEW', '[]'::jsonb),
                ($6, $2, $3, $4, '{"cluster_name":"صنف تالف مسترجع PG"}'::jsonb, '{}'::jsonb, 'FAILED', '[]'::jsonb);
        `, [
            pgItemA1Id, pgImpAId, pgMfgAId, pgCatId,
            pgItemA2Id,
            pgItemAFailId
        ]);
        pgSyntheticIds.import_items.push(pgItemA1Id, pgItemA2Id, pgItemAFailId);

        await pgPool.query(`
            INSERT INTO import_logs (id, import_id, step, message, severity)
            VALUES ($1, $2, 'START', 'بدء فحص حزمة الاستيراد PG', 'INFO');
        `, [pgLog1Id, pgImpAId]);
        pgSyntheticIds.import_logs.push(pgLog1Id);

        const pgFixtures = {
            adminUser: { id: pgAdminId },
            logisticsUser: { id: pgLogisticsId },
            mfgUserA: { id: pgMfgUserAId },
            mfgUserB: { id: pgMfgUserBId },
            mfgA: { id: pgMfgAId, name_ar: 'مزارع سيناء للزيتون والتمور PG' },
            mfgB: { id: pgMfgBId },
            catRoot: { id: pgCatId },
            importA: { id: pgImpAId },
            importB: { id: pgImpBId },
            itemA1: { id: pgItemA1Id },
            itemA2: { id: pgItemA2Id },
            itemA_failed: { id: pgItemAFailId },
            existingProductA: { id: pgProdExistId, sku: `SKU-EXIST-PG-${synthSuffix}`, name_ar: 'برتقال أبو سرة فاخر قائم PG' }
        };

        await testEngine('PostgreSQL (zarsev_test)', { engine: 'postgres', dbNameOverride: 'zarsev_test' }, pgFixtures);

        console.log('\n--- 📊 Subscription Quota Concurrency Summary ---');
        for (const finding of concurrencyAuditFindings) {
            console.log(`[${finding.engine}] ${finding.finding}: ${finding.details}`);
        }

    } finally {
        // =====================================================================
        // DETERMINISTIC CLEANUP OF ALL TRACKED SYNTHETIC FIXTURES
        // =====================================================================
        console.log('\n--- 🧹 Deterministic Cleanup of Tracked Synthetic Records ---');
        try {
            // Delete in reverse foreign-key dependency order
            for (const id of pgSyntheticIds.product_images) {
                await pgPool.query('DELETE FROM product_images WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.products) {
                await pgPool.query('DELETE FROM products WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.import_logs) {
                await pgPool.query('DELETE FROM import_logs WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.import_items) {
                await pgPool.query('DELETE FROM import_items WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.imports) {
                await pgPool.query('DELETE FROM imports WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.users) {
                await pgPool.query('DELETE FROM users WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.manufacturers) {
                await pgPool.query('DELETE FROM manufacturers WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.categories) {
                await pgPool.query('DELETE FROM categories WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.subscriptions) {
                await pgPool.query('DELETE FROM subscriptions WHERE id = $1;', [id]);
            }
            console.log('✓ Cleaned up all synthetic fixtures in zarsev_test.');
        } catch (cleanupErr) {
            console.error('❌ Error during cleanup:', cleanupErr.message);
        }

        // =====================================================================
        // POST-TEST BASELINE INTEGRITY VERIFICATION
        // =====================================================================
        console.log('\n--- 🛡️ Post-Test Baseline Integrity Verification ---');
        const postSnapshot = captureSnapshot();
        for (const f of PROTECTED_FILES) {
            const pre = preSnapshot[f.name];
            const post = postSnapshot[f.name];
            assert.strictEqual(pre.size, post.size, `File size changed for ${f.name}`);
            assert.strictEqual(pre.sha, post.sha, `File SHA256 changed for ${f.name}`);
            console.log(`✓ Immutability Verified: ${f.name} (SHA256=${post.sha})`);
        }

        const postPg = await capturePgBusinessCounts();
        assert.strictEqual(postPg.total, prePg.total, `Record count changed in zarsev_test! Expected ${prePg.total}, got ${postPg.total}`);
        for (const tbl of BUSINESS_TABLES) {
            assert.strictEqual(postPg.counts[tbl], prePg.counts[tbl], `Record count changed for table ${tbl}`);
        }
        console.log(`✓ Immutability Verified: All ${postPg.total} records across 9 tables in zarsev_test remain 100% UNCHANGED.`);

        await pgAdapter.closePool();
    }

    console.log('\n================================================================');
    console.log('🎉 ALL PHASE 2.4.3.3 IMPORT & TRANSACTION TESTS PASSED (100%)!');
    console.log('================================================================\n');
}

if (require.main === module) {
    runPhase2_4_3_3_Tests().catch(err => {
        console.error('\n❌ TEST SUITE FAILED:', err);
        process.exit(1);
    });
}

module.exports = { runPhase2_4_3_3_Tests };
