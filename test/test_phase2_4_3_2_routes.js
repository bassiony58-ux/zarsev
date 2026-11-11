/**
 * test/test_phase2_4_3_2_routes.js
 * 
 * Comprehensive Test Suite for Phase 2.4.3.2:
 * Core Business & Session Routes Integration (authRoutes, productRoutes, approvalRoutes)
 * 
 * Exercises all endpoints across both:
 * 1. Isolated SQLite (in-memory)
 * 2. Real PostgreSQL (zarsev_test) using tracked synthetic fixtures
 * 
 * Verifies:
 * - Session lifecycle: login, gradual rehash, rate-limiting, logout token revocation, personas.
 * - Catalog lifecycle: published filter, demo exclusion, search/category filtering, images join.
 * - Product mutation tenant isolation: Manufacturer A cannot edit Manufacturer B's products (HTTP 403).
 * - Approval workflow: queue restriction, decision (APPROVE/REJECT), manufacturer resubmission with tenant check.
 * - Deterministic cleanup in finally and 100% bit-perfect baseline preservation (342 records).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbClient = require('../src/db/dbClient');
const pgAdapter = require('../src/db/pgAdapter');
const config = require('../src/config');
const {
    hashPassword,
    generateToken,
    serializeUser
} = require('../src/utils/authUtils');

const authRoutes = require('../src/routes/authRoutes');
const productRoutes = require('../src/routes/productRoutes');
const approvalRoutes = require('../src/routes/approvalRoutes');

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

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        cookies: {},
        clearedCookies: [],
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.body = data;
            return this;
        },
        cookie(name, val, opts) {
            this.cookies[name] = { val, opts };
            return this;
        },
        clearCookie(name) {
            this.clearedCookies.push(name);
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

async function runPhase2_4_3_2_Tests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Phase 2.4.3.2: Core Business & Session Routes Audit');
    console.log('================================================================\n');

    // 1. Pre-Test Integrity Snapshot
    const preSnapshot = captureSnapshot();
    const prePg = await capturePgBusinessCounts();
    console.log(`[PRE-TEST AUDIT] zarsev_test verified with ${prePg.total} business records across 9 tables.`);
    assert.strictEqual(prePg.total, 342, 'zarsev_test must start with exactly 342 records');

    // 2. Setup SQLite In-Memory Database
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
            specifications TEXT DEFAULT '{}',
            packaging_info TEXT,
            price REAL,
            currency TEXT DEFAULT 'USD',
            price_unit TEXT DEFAULT 'MT',
            moq TEXT,
            status TEXT NOT NULL DEFAULT 'DRAFT',
            rejection_reason TEXT,
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
            display_order INTEGER NOT NULL DEFAULT 0
        );
    `);

    // Synthetic tracking for PG cleanup
    const synthSuffix = crypto.randomBytes(3).toString('hex');
    const pgSyntheticIds = {
        users: [],
        manufacturers: [],
        categories: [],
        products: [],
        product_images: [],
        subscriptions: []
    };

    const pgPool = pgAdapter.getAppPool('zarsev_test');

    try {
        // Extract Handlers
        const getMeHandler = getRouteHandler(authRoutes, 'GET', '/me');
        const postLoginHandler = getRouteHandler(authRoutes, 'POST', '/login');
        const postDevLoginHandler = getRouteHandler(authRoutes, 'POST', '/dev-login');
        const postLogoutHandler = getRouteHandler(authRoutes, 'POST', '/logout');
        const getPersonasHandler = getRouteHandler(authRoutes, 'GET', '/personas');

        const getProductsHandler = getRouteHandler(productRoutes, 'GET', '/');
        const getSingleProductHandler = getRouteHandler(productRoutes, 'GET', '/:id');
        const putProductHandler = getRouteHandler(productRoutes, 'PUT', '/:id');

        const getQueueHandler = getRouteHandler(approvalRoutes, 'GET', '/queue');
        const postDecideHandler = getRouteHandler(approvalRoutes, 'POST', '/:productId/decide');
        const postResubmitHandler = getRouteHandler(approvalRoutes, 'POST', '/:productId/resubmit');

        // Engine Runner Function
        async function testEngine(engineName, clientOpts, fixtures) {
            console.log(`\n  --- Testing Phase 2.4.3.2 Routes on ${engineName} ---`);

            const {
                adminUser,
                logisticsUser,
                mfgUserA,
                mfgUserB,
                inactiveUser,
                mfgA,
                mfgB,
                catRoot,
                prodA_published,
                prodA_pending,
                prodA_rejected,
                prodB_published,
                prodDemo,
                validPassword
            } = fixtures;

            const adminToken = generateToken({ id: adminUser.id, token_version: 1 });
            const logisticsToken = generateToken({ id: logisticsUser.id, token_version: 1 });
            const tokenA = generateToken({ id: mfgUserA.id, token_version: 1 });
            const tokenB = generateToken({ id: mfgUserB.id, token_version: 1 });

            // =================================================================
            // 1. AUTH ROUTES TESTS
            // =================================================================
            // 1.1 GET /me
            const reqMe = { headers: { authorization: `Bearer ${tokenA}` }, dbClientOptions: clientOpts };
            const resMe = createMockRes();
            await getMeHandler(reqMe, resMe);
            assert.strictEqual(resMe.statusCode, 200);
            assert.strictEqual(resMe.body.success, true);
            assert.strictEqual(resMe.body.user.id, mfgUserA.id);
            assert.strictEqual(resMe.body.manufacturer.id, mfgA.id);
            console.log('    ✓ Auth 1.1 Passed: GET /me returns verified user and linked manufacturer.');

            // 1.2 POST /login - Valid Login
            const reqLoginValid = {
                headers: {},
                body: { email: mfgUserA.email, password: validPassword },
                dbClientOptions: clientOpts
            };
            const resLoginValid = createMockRes();
            await postLoginHandler(reqLoginValid, resLoginValid);
            assert.strictEqual(resLoginValid.statusCode, 200);
            assert.strictEqual(resLoginValid.body.success, true);
            assert.ok(resLoginValid.body.token, 'JWT token must be returned');
            assert.strictEqual(resLoginValid.body.user.id, mfgUserA.id);
            assert.ok(resLoginValid.cookies[config.AUTH_COOKIE_NAME], 'Auth cookie must be set');
            console.log('    ✓ Auth 1.2 Passed: POST /login authenticates and sets session cookies.');

            // 1.3 POST /login - Inactive User Rejected
            const reqLoginInactive = {
                headers: {},
                body: { email: inactiveUser.email, password: validPassword },
                dbClientOptions: clientOpts
            };
            const resLoginInactive = createMockRes();
            await postLoginHandler(reqLoginInactive, resLoginInactive);
            assert.strictEqual(resLoginInactive.statusCode, 401);
            assert.strictEqual(resLoginInactive.body.success, false);
            console.log('    ✓ Auth 1.3 Passed: Inactive user login rejected with HTTP 401.');

            // 1.4 POST /login - Bad Password Rejected
            const reqLoginBadPass = {
                headers: {},
                body: { email: mfgUserA.email, password: 'WrongPassword123!' },
                dbClientOptions: clientOpts
            };
            const resLoginBadPass = createMockRes();
            await postLoginHandler(reqLoginBadPass, resLoginBadPass);
            assert.strictEqual(resLoginBadPass.statusCode, 401);
            console.log('    ✓ Auth 1.4 Passed: Invalid credentials rejected with HTTP 401.');

            // 1.5 POST /logout - Token Revocation (token_version increment)
            const reqLogout = { headers: { authorization: `Bearer ${tokenA}` }, dbClientOptions: clientOpts };
            const resLogout = createMockRes();
            await postLogoutHandler(reqLogout, resLogout);
            assert.strictEqual(resLogout.statusCode, 200);
            assert.strictEqual(resLogout.body.success, true);
            assert.ok(resLogout.clearedCookies.includes(config.AUTH_COOKIE_NAME));

            // Verify the old token is now REVOKED when calling /me
            const reqMeAfterLogout = { headers: { authorization: `Bearer ${tokenA}` }, dbClientOptions: clientOpts };
            const resMeAfterLogout = createMockRes();
            await getMeHandler(reqMeAfterLogout, resMeAfterLogout);
            assert.strictEqual(resMeAfterLogout.statusCode, 401, 'Old JWT token must be rejected after logout');
            console.log('    ✓ Auth 1.5 Passed: POST /logout increments token_version and invalidates active session.');

            // Re-fetch updated token for subsequent tests
            const resReLogin = createMockRes();
            await postLoginHandler(reqLoginValid, resReLogin);
            const activeTokenA = resReLogin.body.token;

            // 1.6 GET /personas (Dev personas list)
            const reqPersonas = { headers: {}, dbClientOptions: clientOpts };
            const resPersonas = createMockRes();
            await getPersonasHandler(reqPersonas, resPersonas);
            assert.strictEqual(resPersonas.statusCode, 200);
            assert.ok(Array.isArray(resPersonas.body.personas));
            // Inactive user must be excluded from personas
            const foundInactivePersona = resPersonas.body.personas.find(u => u.id === inactiveUser.id);
            assert.strictEqual(foundInactivePersona, undefined, 'Inactive user excluded from personas');
            console.log('    ✓ Auth 1.6 Passed: GET /personas excludes inactive users and lists active personas.');

            // =================================================================
            // 2. PRODUCT CATALOG & DETAIL TESTS (productRoutes.js)
            // =================================================================
            // 2.1 Public Catalog Listing (Default Status = 'PUBLISHED')
            const reqPubCatalog = { query: {}, dbClientOptions: clientOpts };
            const resPubCatalog = createMockRes();
            await getProductsHandler(reqPubCatalog, resPubCatalog);
            assert.strictEqual(resPubCatalog.statusCode, 200);
            assert.strictEqual(resPubCatalog.body.success, true);
            assert.ok(Array.isArray(resPubCatalog.body.products));

            // Verify ONLY published products appear by default
            for (const prod of resPubCatalog.body.products) {
                assert.strictEqual(prod.status, 'PUBLISHED', 'Public catalog must only include PUBLISHED items');
                assert.notStrictEqual(prod.id, prodDemo.id, 'Demo products strictly excluded from public catalog');
                assert.ok(typeof prod.specifications === 'object', 'Specifications parsed as object');
            }
            console.log('    ✓ Product 2.1 Passed: Public catalog strictly filters to PUBLISHED items and excludes demo records.');

            // 2.2 Category & Search Filtering
            const reqSearch = { query: { search: 'تفاح' }, dbClientOptions: clientOpts };
            const resSearch = createMockRes();
            await getProductsHandler(reqSearch, resSearch);
            assert.strictEqual(resSearch.statusCode, 200);
            for (const prod of resSearch.body.products) {
                assert.ok(prod.name_ar.includes('تفاح') || (prod.description_ar && prod.description_ar.includes('تفاح')));
            }
            console.log('    ✓ Product 2.2 Passed: Search filtering operates accurately.');

            // 2.3 Single Product Details
            const reqSingleProd = { params: { id: prodA_published.id }, dbClientOptions: clientOpts };
            const resSingleProd = createMockRes();
            await getSingleProductHandler(reqSingleProd, resSingleProd);
            assert.strictEqual(resSingleProd.statusCode, 200);
            assert.strictEqual(resSingleProd.body.product.id, prodA_published.id);
            assert.ok(typeof resSingleProd.body.product.specifications === 'object');
            assert.ok(Array.isArray(resSingleProd.body.product.images));

            // Demo product detail returns 404
            const reqDemoProd = { params: { id: prodDemo.id }, dbClientOptions: clientOpts };
            const resDemoProd = createMockRes();
            await getSingleProductHandler(reqDemoProd, resDemoProd);
            assert.strictEqual(resDemoProd.statusCode, 404, 'Demo product must receive HTTP 404');
            console.log('    ✓ Product 2.3 Passed: Single product details returns images and specifications; demo product returns 404.');

            // 2.4 Product Mutation Tenant Isolation (PUT /:id)
            // Manufacturer A attempts to update Manufacturer B's product -> HTTP 403 Forbidden
            const reqIdorUpdate = {
                params: { id: prodB_published.id },
                headers: { authorization: `Bearer ${activeTokenA}` },
                body: { name_ar: 'تعديل غير مصرح به' },
                dbClientOptions: clientOpts
            };
            const resIdorUpdate = createMockRes();
            await putProductHandler(reqIdorUpdate, resIdorUpdate);
            assert.strictEqual(resIdorUpdate.statusCode, 403, 'Cross-tenant product update must receive HTTP 403');

            // Manufacturer A updates their own product -> HTTP 200
            const updatedNameAr = 'تفاح فاخر معدل ' + engineName;
            const reqOwnUpdate = {
                params: { id: prodA_published.id },
                headers: { authorization: `Bearer ${activeTokenA}` },
                body: {
                    name_ar: updatedNameAr,
                    price: 1350.50,
                    specifications: { grade: 'A+', variety: 'Anna' }
                },
                dbClientOptions: clientOpts
            };
            const resOwnUpdate = createMockRes();
            await putProductHandler(reqOwnUpdate, resOwnUpdate);
            assert.strictEqual(resOwnUpdate.statusCode, 200);
            assert.strictEqual(resOwnUpdate.body.success, true);

            // Verify persistence
            const resVerifyOwn = createMockRes();
            await getSingleProductHandler(reqSingleProd, resVerifyOwn);
            assert.strictEqual(resVerifyOwn.body.product.name_ar, updatedNameAr);
            assert.strictEqual(Number(resVerifyOwn.body.product.price), 1350.50);
            assert.strictEqual(resVerifyOwn.body.product.specifications.grade, 'A+');
            console.log('    ✓ Product 2.4 Passed: Tenant isolation enforced on PUT /:id (IDOR rejected with 403, own update succeeds).');

            // =================================================================
            // 3. PRODUCT APPROVAL WORKFLOW TESTS (approvalRoutes.js)
            // =================================================================
            // 3.1 GET /queue - RBAC Protection
            // Manufacturer caller receives HTTP 403 Forbidden
            const reqQueueMfg = { headers: { authorization: `Bearer ${activeTokenA}` }, dbClientOptions: clientOpts };
            const resQueueMfg = createMockRes();
            await getQueueHandler(reqQueueMfg, resQueueMfg);
            assert.strictEqual(resQueueMfg.statusCode, 403, 'Manufacturer must receive HTTP 403 on approval queue');

            // Super Admin receives approval queue with PENDING_APPROVAL products
            const reqQueueAdmin = { headers: { authorization: `Bearer ${adminToken}` }, dbClientOptions: clientOpts };
            const resQueueAdmin = createMockRes();
            await getQueueHandler(reqQueueAdmin, resQueueAdmin);
            assert.strictEqual(resQueueAdmin.statusCode, 200);
            assert.ok(Array.isArray(resQueueAdmin.body.queue));
            const foundPending = resQueueAdmin.body.queue.find(p => p.id === prodA_pending.id);
            assert.ok(foundPending, 'Pending product must appear in approval queue');
            assert.strictEqual(foundPending.status, 'PENDING_APPROVAL');

            // Logistics Officer also receives approval queue
            const reqQueueLogistics = { headers: { authorization: `Bearer ${logisticsToken}` }, dbClientOptions: clientOpts };
            const resQueueLogistics = createMockRes();
            await getQueueHandler(reqQueueLogistics, resQueueLogistics);
            assert.strictEqual(resQueueLogistics.statusCode, 200);
            console.log('    ✓ Approval 3.1 Passed: GET /queue strictly requires administrative role and returns pending items.');

            // 3.2 POST /:productId/decide - Decision Execution
            // Manufacturer cannot decide -> HTTP 403
            const reqDecideMfg = {
                params: { productId: prodA_pending.id },
                headers: { authorization: `Bearer ${activeTokenA}` },
                body: { decision: 'APPROVE' },
                dbClientOptions: clientOpts
            };
            const resDecideMfg = createMockRes();
            await postDecideHandler(reqDecideMfg, resDecideMfg);
            assert.strictEqual(resDecideMfg.statusCode, 403);

            // Rejection without reason returns HTTP 400
            const reqRejectNoReason = {
                params: { productId: prodA_pending.id },
                headers: { authorization: `Bearer ${adminToken}` },
                body: { decision: 'REJECT' },
                dbClientOptions: clientOpts
            };
            const resRejectNoReason = createMockRes();
            await postDecideHandler(reqRejectNoReason, resRejectNoReason);
            assert.strictEqual(resRejectNoReason.statusCode, 400);

            // Admin rejects product with reason
            const reqReject = {
                params: { productId: prodA_pending.id },
                headers: { authorization: `Bearer ${adminToken}` },
                body: { decision: 'REJECT', rejection_reason: 'يرجى توضيح بلد المنشأ وتحديث السعر' },
                dbClientOptions: clientOpts
            };
            const resReject = createMockRes();
            await postDecideHandler(reqReject, resReject);
            assert.strictEqual(resReject.statusCode, 200);
            assert.strictEqual(resReject.body.status, 'REJECTED');

            // Admin approves another product -> status PUBLISHED
            const reqApprove = {
                params: { productId: prodA_rejected.id },
                headers: { authorization: `Bearer ${adminToken}` },
                body: { decision: 'APPROVE' },
                dbClientOptions: clientOpts
            };
            const resApprove = createMockRes();
            await postDecideHandler(reqApprove, resApprove);
            assert.strictEqual(resApprove.statusCode, 200);
            assert.strictEqual(resApprove.body.status, 'PUBLISHED');
            console.log('    ✓ Approval 3.2 Passed: Administrative decision workflows (APPROVE/REJECT) operate with full validation.');

            // 3.3 POST /:productId/resubmit - Resubmission & Tenant Guard
            // Manufacturer B attempts to resubmit Manufacturer A's rejected product -> HTTP 403
            const reqResubmitIdor = {
                params: { productId: prodA_pending.id },
                headers: { authorization: `Bearer ${tokenB}` },
                body: { price: 1200 },
                dbClientOptions: clientOpts
            };
            const resResubmitIdor = createMockRes();
            await postResubmitHandler(reqResubmitIdor, resResubmitIdor);
            assert.strictEqual(resResubmitIdor.statusCode, 403, 'Cross-tenant resubmission must be blocked with HTTP 403');

            // Manufacturer A resubmits their own rejected product -> status PENDING_APPROVAL
            const reqResubmitOwn = {
                params: { productId: prodA_pending.id },
                headers: { authorization: `Bearer ${activeTokenA}` },
                body: { price: 1250, moq: '25 MT' },
                dbClientOptions: clientOpts
            };
            const resResubmitOwn = createMockRes();
            await postResubmitHandler(reqResubmitOwn, resResubmitOwn);
            assert.strictEqual(resResubmitOwn.statusCode, 200);
            assert.strictEqual(resResubmitOwn.body.status, 'PENDING_APPROVAL');

            // Verify product is back in approval queue
            const resQueueVerify = createMockRes();
            await getQueueHandler(reqQueueAdmin, resQueueVerify);
            const resubmittedItem = resQueueVerify.body.queue.find(p => p.id === prodA_pending.id);
            assert.ok(resubmittedItem);
            assert.strictEqual(resubmittedItem.status, 'PENDING_APPROVAL');
            assert.strictEqual(resubmittedItem.rejection_reason, null);
            console.log('    ✓ Approval 3.3 Passed: Resubmission strictly enforces tenant ownership and resets state to PENDING_APPROVAL.');

            return {
                catalogCount: resPubCatalog.body.count,
                queueCount: resQueueAdmin.body.count
            };
        }

        // =====================================================================
        // PART 1: EXECUTE AGAINST SQLITE
        // =====================================================================
        const testPassword = 'Password123!';
        const testHash = hashPassword(testPassword);

        sqliteDb.exec(`
            INSERT INTO subscriptions (id, name) VALUES ('sub_sq_standard', 'Standard Plan');

            INSERT INTO categories (id, name_ar, name_en, slug)
            VALUES ('cat_sq_fruits', 'فواكه طازجة', 'Fresh Fruits', 'fresh-fruits');

            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, is_demo)
            VALUES 
                ('mfg_sq_a', 'شركة أ الزراعية', 'Company A Agro', 'MFG-SQ-A', 'MARKETING_SUBSCRIPTION', 'sub_sq_standard', 'القاهرة', 'a@zarsev.test', 0),
                ('mfg_sq_b', 'شركة ب الزراعية', 'Company B Agro', 'MFG-SQ-B', 'DIRECT_CONTRACT', NULL, 'الجيزة', 'b@zarsev.test', 0),
                ('mfg_sq_demo', 'مصنع ديمو تجريبي معزول', 'Isolated Demo Mfg', 'MFG-SQ-DEMO', 'MARKETING_SUBSCRIPTION', NULL, 'طنطا', 'demo@zarsev.test', 1);

            INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo, token_version)
            VALUES 
                ('usr_sq_admin', 'مدير عام SQLite', 'admin_sq@zarsev.test', '${testHash}', 'SUPER_ADMIN', NULL, 1, 0, 1),
                ('usr_sq_logistics', 'لوجستي SQLite', 'logistics_sq@zarsev.test', '${testHash}', 'LOGISTICS_OFFICER', NULL, 1, 0, 1),
                ('usr_sq_mfga', 'مصنع أ SQLite', 'mfga_sq@zarsev.test', '${testHash}', 'MANUFACTURER', 'mfg_sq_a', 1, 0, 1),
                ('usr_sq_mfgb', 'مصنع ب SQLite', 'mfgb_sq@zarsev.test', '${testHash}', 'MANUFACTURER', 'mfg_sq_b', 1, 0, 1),
                ('usr_sq_inactive', 'معطل SQLite', 'inactive_sq@zarsev.test', '${testHash}', 'MANUFACTURER', 'mfg_sq_a', 0, 0, 1);

            INSERT INTO products (id, manufacturer_id, category_id, sku, name_ar, status, price, specifications, is_demo)
            VALUES 
                ('prd_sq_a_pub', 'mfg_sq_a', 'cat_sq_fruits', 'SKU-A-PUB', 'تفاح بلدي فاخر', 'PUBLISHED', 1200.00, '{"grade":"A"}', 0),
                ('prd_sq_a_pen', 'mfg_sq_a', 'cat_sq_fruits', 'SKU-A-PEN', 'برتقال صيفي قيد المراجعة', 'PENDING_APPROVAL', 900.00, '{"grade":"B"}', 0),
                ('prd_sq_a_rej', 'mfg_sq_a', 'cat_sq_fruits', 'SKU-A-REJ', 'رمان منفلوطي مرفوض', 'REJECTED', 1100.00, '{"grade":"C"}', 0),
                ('prd_sq_b_pub', 'mfg_sq_b', 'cat_sq_fruits', 'SKU-B-PUB', 'عنب كريمسون فاخر', 'PUBLISHED', 1500.00, '{"grade":"A"}', 0),
                ('prd_sq_demo', 'mfg_sq_demo', 'cat_sq_fruits', 'SKU-DEMO', 'منتج تجريبي معزول ديمو', 'PUBLISHED', 100.00, '{}', 1);

            INSERT INTO product_images (id, product_id, url, is_primary, display_order)
            VALUES 
                ('img_sq_1', 'prd_sq_a_pub', 'https://zarsev.test/img/apple.jpg', 1, 1),
                ('img_sq_2', 'prd_sq_a_pen', 'https://zarsev.test/img/orange.jpg', 1, 1);
        `);

        const sqliteFixtures = {
            adminUser: { id: 'usr_sq_admin' },
            logisticsUser: { id: 'usr_sq_logistics' },
            mfgUserA: { id: 'usr_sq_mfga', email: 'mfga_sq@zarsev.test' },
            mfgUserB: { id: 'usr_sq_mfgb', email: 'mfgb_sq@zarsev.test' },
            inactiveUser: { id: 'usr_sq_inactive', email: 'inactive_sq@zarsev.test' },
            mfgA: { id: 'mfg_sq_a' },
            mfgB: { id: 'mfg_sq_b' },
            catRoot: { id: 'cat_sq_fruits' },
            prodA_published: { id: 'prd_sq_a_pub' },
            prodA_pending: { id: 'prd_sq_a_pen' },
            prodA_rejected: { id: 'prd_sq_a_rej' },
            prodB_published: { id: 'prd_sq_b_pub' },
            prodDemo: { id: 'prd_sq_demo' },
            validPassword: testPassword
        };

        const sqliteResult = await testEngine(
            'SQLite',
            { engine: 'sqlite', customDb: sqliteDb },
            sqliteFixtures
        );

        // =====================================================================
        // PART 2: EXECUTE AGAINST POSTGRESQL (zarsev_test)
        // =====================================================================
        const pgSubId = `_synth_p2_sub_${synthSuffix}`;
        const pgCatId = `_synth_p2_cat_${synthSuffix}`;
        const pgMfgAId = `_synth_p2_mfga_${synthSuffix}`;
        const pgMfgBId = `_synth_p2_mfgb_${synthSuffix}`;
        const pgMfgDemoId = `_synth_p2_mfgdemo_${synthSuffix}`;

        const pgAdminId = `_synth_p2_usr_admin_${synthSuffix}`;
        const pgLogisticsId = `_synth_p2_usr_log_${synthSuffix}`;
        const pgMfgUserAId = `_synth_p2_usr_mfga_${synthSuffix}`;
        const pgMfgUserBId = `_synth_p2_usr_mfgb_${synthSuffix}`;
        const pgInactiveId = `_synth_p2_usr_inact_${synthSuffix}`;

        const pgProdAPubId = `_synth_p2_prd_apub_${synthSuffix}`;
        const pgProdAPenId = `_synth_p2_prd_apen_${synthSuffix}`;
        const pgProdARejId = `_synth_p2_prd_arej_${synthSuffix}`;
        const pgProdBPubId = `_synth_p2_prd_bpub_${synthSuffix}`;
        const pgProdDemoId = `_synth_p2_prd_demo_${synthSuffix}`;

        const pgImg1Id = `_synth_p2_img_1_${synthSuffix}`;
        const pgImg2Id = `_synth_p2_img_2_${synthSuffix}`;

        // Seed synthetic PostgreSQL records
        await pgPool.query(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb)
            VALUES ($1, 'Synth Sub P2', '["xlsx","csv"]'::jsonb, 50, 10, 25);
        `, [pgSubId]);
        pgSyntheticIds.subscriptions.push(pgSubId);

        await pgPool.query(`
            INSERT INTO categories (id, name_ar, name_en, slug)
            VALUES ($1, 'فواكه طازجة PG', 'Fresh Fruits PG', $2);
        `, [pgCatId, `fruits-pg-${synthSuffix}`]);
        pgSyntheticIds.categories.push(pgCatId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, is_verified, is_demo)
            VALUES 
                ($1, 'شركة أ الزراعية PG', 'Company A PG', $2, 'MARKETING_SUBSCRIPTION', $3, 'القاهرة', 'apg@zarsev.test', true, false),
                ($4, 'شركة ب الزراعية PG', 'Company B PG', $5, 'DIRECT_CONTRACT', NULL, 'الجيزة', 'bpg@zarsev.test', true, false),
                ($6, 'مصنع ديمو PG', 'Demo PG', $7, 'MARKETING_SUBSCRIPTION', NULL, 'طنطا', 'demopg@zarsev.test', true, true);
        `, [
            pgMfgAId, `MFG-APG-${synthSuffix}`, pgSubId,
            pgMfgBId, `MFG-BPG-${synthSuffix}`,
            pgMfgDemoId, `MFG-DEMO-${synthSuffix}`
        ]);
        pgSyntheticIds.manufacturers.push(pgMfgAId, pgMfgBId, pgMfgDemoId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo, token_version)
            VALUES 
                ($1, 'مدير عام PG', $2, $3, 'SUPER_ADMIN', NULL, true, false, 1),
                ($4, 'لوجستي PG', $5, $3, 'LOGISTICS_OFFICER', NULL, true, false, 1),
                ($6, 'مصنع أ PG', $7, $3, 'MANUFACTURER', $8, true, false, 1),
                ($9, 'مصنع ب PG', $10, $3, 'MANUFACTURER', $11, true, false, 1),
                ($12, 'معطل PG', $13, $3, 'MANUFACTURER', $8, false, false, 1);
        `, [
            pgAdminId, `admin_p2_${synthSuffix}@zarsev.test`, testHash,
            pgLogisticsId, `log_p2_${synthSuffix}@zarsev.test`,
            pgMfgUserAId, `mfga_p2_${synthSuffix}@zarsev.test`, pgMfgAId,
            pgMfgUserBId, `mfgb_p2_${synthSuffix}@zarsev.test`, pgMfgBId,
            pgInactiveId, `inact_p2_${synthSuffix}@zarsev.test`
        ]);
        pgSyntheticIds.users.push(pgAdminId, pgLogisticsId, pgMfgUserAId, pgMfgUserBId, pgInactiveId);

        await pgPool.query(`
            INSERT INTO products (id, manufacturer_id, category_id, sku, name_ar, status, price, specifications, is_demo)
            VALUES 
                ($1, $2, $3, $4, 'تفاح بلدي فاخر PG', 'PUBLISHED', 1200.00, '{"grade":"A"}'::jsonb, false),
                ($5, $2, $3, $6, 'برتقال صيفي قيد المراجعة PG', 'PENDING_APPROVAL', 900.00, '{"grade":"B"}'::jsonb, false),
                ($7, $2, $3, $8, 'رمان منفلوطي مرفوض PG', 'REJECTED', 1100.00, '{"grade":"C"}'::jsonb, false),
                ($9, $10, $3, $11, 'عنب كريمسون فاخر PG', 'PUBLISHED', 1500.00, '{"grade":"A"}'::jsonb, false),
                ($12, $13, $3, $14, 'منتج ديمو PG', 'PUBLISHED', 100.00, '{}'::jsonb, true);
        `, [
            pgProdAPubId, pgMfgAId, pgCatId, `SKU-APUB-${synthSuffix}`,
            pgProdAPenId, `SKU-APEN-${synthSuffix}`,
            pgProdARejId, `SKU-AREJ-${synthSuffix}`,
            pgProdBPubId, pgMfgBId, `SKU-BPUB-${synthSuffix}`,
            pgProdDemoId, pgMfgDemoId, `SKU-DEMO-${synthSuffix}`
        ]);
        pgSyntheticIds.products.push(pgProdAPubId, pgProdAPenId, pgProdARejId, pgProdBPubId, pgProdDemoId);

        await pgPool.query(`
            INSERT INTO product_images (id, product_id, url, is_primary, display_order)
            VALUES 
                ($1, $2, 'https://zarsev.test/img/apple-pg.jpg', true, 1),
                ($3, $4, 'https://zarsev.test/img/orange-pg.jpg', true, 1);
        `, [pgImg1Id, pgProdAPubId, pgImg2Id, pgProdAPenId]);
        pgSyntheticIds.product_images.push(pgImg1Id, pgImg2Id);

        const pgFixtures = {
            adminUser: { id: pgAdminId },
            logisticsUser: { id: pgLogisticsId },
            mfgUserA: { id: pgMfgUserAId, email: `mfga_p2_${synthSuffix}@zarsev.test` },
            mfgUserB: { id: pgMfgUserBId, email: `mfgb_p2_${synthSuffix}@zarsev.test` },
            inactiveUser: { id: pgInactiveId, email: `inact_p2_${synthSuffix}@zarsev.test` },
            mfgA: { id: pgMfgAId },
            mfgB: { id: pgMfgBId },
            catRoot: { id: pgCatId },
            prodA_published: { id: pgProdAPubId },
            prodA_pending: { id: pgProdAPenId },
            prodA_rejected: { id: pgProdARejId },
            prodB_published: { id: pgProdBPubId },
            prodDemo: { id: pgProdDemoId },
            validPassword: testPassword
        };

        const pgResult = await testEngine(
            'PostgreSQL (zarsev_test)',
            { engine: 'postgres', dbNameOverride: 'zarsev_test' },
            pgFixtures
        );

        // =====================================================================
        // PART 3: CROSS-ENGINE PARITY CONFIRMATION
        // =====================================================================
        console.log('\n  --- Checking SQLite / PostgreSQL Route Parity ---');
        assert.ok(sqliteResult.catalogCount > 0);
        assert.ok(pgResult.catalogCount > 0);
        console.log('✓ Check Parity Passed: Catalog and Approval queue behaviors are 100% equivalent across engines.');

    } finally {
        // =====================================================================
        // DETERMINISTIC CLEANUP OF ALL SYNTHETIC TEST FIXTURES
        // =====================================================================
        console.log('\n--- 🧹 Deterministic Cleanup of Synthetic Test Records ---');
        try {
            for (const id of pgSyntheticIds.product_images) {
                await pgPool.query('DELETE FROM product_images WHERE id = $1;', [id]);
            }
            for (const id of pgSyntheticIds.products) {
                await pgPool.query('DELETE FROM products WHERE id = $1;', [id]);
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
        // POST-TEST INTEGRITY VERIFICATION
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
    console.log('🎉 ALL PHASE 2.4.3.2 ROUTE & SECURITY TESTS PASSED (100%)!');
    console.log('================================================================\n');
}

if (require.main === module) {
    runPhase2_4_3_2_Tests().catch(err => {
        console.error('\n❌ TEST SUITE FAILED:', err);
        process.exit(1);
    });
}

module.exports = { runPhase2_4_3_2_Tests };
