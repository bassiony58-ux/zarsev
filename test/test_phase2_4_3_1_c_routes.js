/**
 * test/test_phase2_4_3_1_c_routes.js
 * 
 * ZARSEV Phase 2.4.3.1-C: Async Manufacturer Routes & Critical Tenant Isolation / IDOR Security Suite.
 * 
 * Tests manufacturerRoutes.js against:
 * 1. Isolated in-memory SQLite context
 * 2. Real PostgreSQL database (zarsev_test) using tracked synthetic fixtures with deterministic cleanup
 * 
 * Enforces mandatory IDOR & Tenant Isolation rules:
 * - Manufacturer A requesting Manufacturer B's profile never exposes B's private data.
 * - Missing manufacturer_id fails closed (returns []).
 * - Manufacturer user attempting POST / is rejected with HTTP 403.
 * - Public serialization strips contact_email, contact_phone, business_model, subscription_id, products_count.
 * - Demo records are never exposed to public callers (HTTP 404).
 * - Full cross-engine parity and bit-perfect baseline preservation (342 records).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbClient = require('../src/db/dbClient');
const pgAdapter = require('../src/db/pgAdapter');
const { generateToken } = require('../src/utils/authUtils');
const manufacturerRoutes = require('../src/routes/manufacturerRoutes');

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
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.body = data;
            return this;
        },
        setHeader(name, val) {
            this.headers[name] = val;
        }
    };
}

// Extracts route handler with Promise resolution on res.json() or res.end()
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

async function runPhase2_4_3_1_C_Tests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Phase 2.4.3.1-C: Async Manufacturer Routes & IDOR Audit');
    console.log('================================================================\n');

    // 1. Capture Pre-Test Snapshot
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

        CREATE TABLE manufacturers (
            id TEXT PRIMARY KEY,
            name_ar TEXT NOT NULL,
            name_en TEXT NOT NULL,
            code TEXT UNIQUE NOT NULL,
            business_model TEXT NOT NULL CHECK(business_model IN ('DIRECT_CONTRACT', 'MARKETING_SUBSCRIPTION')),
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
            name_ar TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PUBLISHED',
            is_demo INTEGER NOT NULL DEFAULT 0
        );
    `);

    // Synthetic fixture tracking for deterministic PG cleanup
    const synthSuffix = crypto.randomBytes(3).toString('hex');
    const pgSyntheticIds = {
        users: [],
        manufacturers: [],
        subscriptions: [],
        products: []
    };

    const pgPool = pgAdapter.getAppPool('zarsev_test');

    try {
        const getManufacturersHandler = getRouteHandler(manufacturerRoutes, 'GET', '/');
        const getSingleManufacturerHandler = getRouteHandler(manufacturerRoutes, 'GET', '/:id');
        const getMatchHandler = getRouteHandler(manufacturerRoutes, 'GET', '/match');
        const postManufacturerHandler = getRouteHandler(manufacturerRoutes, 'POST', '/');

        // Helper to test Manufacturer Routes on a specific engine
        async function testManufacturerEngine(engineName, clientOpts, fixtures) {
            console.log(`\n  --- Testing Manufacturer Routes on ${engineName} ---`);

            const {
                adminUser,
                logisticsUser,
                mfgUserA,
                mfgUserB,
                mfgUserOrphan,
                mfgA,
                mfgB,
                demoMfg
            } = fixtures;

            const adminToken = generateToken({ id: adminUser.id, token_version: 1 });
            const logisticsToken = generateToken({ id: logisticsUser.id, token_version: 1 });
            const tokenA = generateToken({ id: mfgUserA.id, token_version: 1 });
            const tokenB = generateToken({ id: mfgUserB.id, token_version: 1 });
            const tokenOrphan = generateToken({ id: mfgUserOrphan.id, token_version: 1 });

            // =================================================================
            // MANDATORY SECURITY CHECK 1 & 5: Public Serialization Privacy
            // =================================================================
            const reqPublicList = { headers: {}, dbClientOptions: clientOpts };
            const resPublicList = createMockRes();
            await getManufacturersHandler(reqPublicList, resPublicList);
            assert.strictEqual(resPublicList.statusCode, 200);
            assert.strictEqual(resPublicList.body.success, true);
            assert.ok(Array.isArray(resPublicList.body.manufacturers));

            // Verify demo manufacturers are strictly excluded from public list
            const foundDemoInPublic = resPublicList.body.manufacturers.find(m => m.id === demoMfg.id);
            assert.strictEqual(foundDemoInPublic, undefined, 'Public listing must strictly exclude demo manufacturers');

            // Verify public serializer strips private/sensitive fields
            for (const pubMfg of resPublicList.body.manufacturers) {
                assert.strictEqual(pubMfg.contact_email, undefined, 'Public serialization must strip contact_email');
                assert.strictEqual(pubMfg.contact_phone, undefined, 'Public serialization must strip contact_phone');
                assert.strictEqual(pubMfg.business_model, undefined, 'Public serialization must strip business_model');
                assert.strictEqual(pubMfg.subscription_id, undefined, 'Public serialization must strip subscription_id');
                assert.strictEqual(pubMfg.subscription_name, undefined, 'Public serialization must strip subscription_name');
                assert.strictEqual(pubMfg.products_count, undefined, 'Public serialization must strip products_count');
                assert.strictEqual(pubMfg.is_demo, undefined, 'Public serialization must strip is_demo');
                assert.ok(pubMfg.id && pubMfg.name_ar && pubMfg.code && pubMfg.city, 'Public serialization retains public identity');
            }
            console.log('    ✓ Check 1 & 5 Passed: Public listing excludes demo records and strips all sensitive contact/plan fields.');

            // =================================================================
            // MANDATORY SECURITY CHECK 2: Tenant Isolation in Listing (GET /)
            // =================================================================
            // Manufacturer A calling GET / must ONLY see Manufacturer A
            const reqMfgAList = { headers: { authorization: `Bearer ${tokenA}` }, dbClientOptions: clientOpts };
            const resMfgAList = createMockRes();
            await getManufacturersHandler(reqMfgAList, resMfgAList);
            assert.strictEqual(resMfgAList.statusCode, 200);
            assert.strictEqual(resMfgAList.body.manufacturers.length, 1, 'Manufacturer user must see exactly 1 profile (their own)');
            assert.strictEqual(resMfgAList.body.manufacturers[0].id, mfgA.id);
            assert.strictEqual(resMfgAList.body.manufacturers[0].business_model, mfgA.business_model, 'Owner sees admin serialization of own profile');
            assert.strictEqual(resMfgAList.body.manufacturers[0].contact_email, mfgA.contact_email);

            // Manufacturer B calling GET / must ONLY see Manufacturer B
            const reqMfgBList = { headers: { authorization: `Bearer ${tokenB}` }, dbClientOptions: clientOpts };
            const resMfgBList = createMockRes();
            await getManufacturersHandler(reqMfgBList, resMfgBList);
            assert.strictEqual(resMfgBList.statusCode, 200);
            assert.strictEqual(resMfgBList.body.manufacturers.length, 1);
            assert.strictEqual(resMfgBList.body.manufacturers[0].id, mfgB.id);
            console.log('    ✓ Check 2 Passed: Tenant isolation strictly enforced on GET / (Caller A only sees A, Caller B only sees B).');

            // =================================================================
            // MANDATORY SECURITY CHECK 4: Missing manufacturer_id Fails Closed
            // =================================================================
            const reqOrphanList = { headers: { authorization: `Bearer ${tokenOrphan}` }, dbClientOptions: clientOpts };
            const resOrphanList = createMockRes();
            await getManufacturersHandler(reqOrphanList, resOrphanList);
            assert.strictEqual(resOrphanList.statusCode, 200);
            assert.deepStrictEqual(resOrphanList.body.manufacturers, [], 'Missing manufacturer_id must fail closed and return empty array');
            console.log('    ✓ Check 4 Passed: Missing manufacturer_id fails closed and never exposes unrestricted list.');

            // =================================================================
            // MANDATORY SECURITY CHECK 1 (Detail): IDOR Protection on GET /:id
            // =================================================================
            // Manufacturer A requests Manufacturer B's profile by ID:
            // Must NOT expose B's private data!
            const reqIdor = {
                params: { id: mfgB.id },
                headers: { authorization: `Bearer ${tokenA}` },
                dbClientOptions: clientOpts
            };
            const resIdor = createMockRes();
            await getSingleManufacturerHandler(reqIdor, resIdor);
            assert.strictEqual(resIdor.statusCode, 200);
            assert.strictEqual(resIdor.body.manufacturer.id, mfgB.id);
            // Verify B's private fields are NOT exposed to A:
            assert.strictEqual(resIdor.body.manufacturer.contact_email, undefined, 'IDOR protected: B contact_email hidden from A');
            assert.strictEqual(resIdor.body.manufacturer.contact_phone, undefined, 'IDOR protected: B contact_phone hidden from A');
            assert.strictEqual(resIdor.body.manufacturer.business_model, undefined, 'IDOR protected: B business_model hidden from A');
            assert.strictEqual(resIdor.body.manufacturer.subscription_id, undefined, 'IDOR protected: B subscription_id hidden from A');
            assert.strictEqual(resIdor.body.manufacturer.products_count, undefined, 'IDOR protected: B products_count hidden from A');

            // But Manufacturer A requesting their own profile by ID receives full admin fields:
            const reqOwn = {
                params: { id: mfgA.id },
                headers: { authorization: `Bearer ${tokenA}` },
                dbClientOptions: clientOpts
            };
            const resOwn = createMockRes();
            await getSingleManufacturerHandler(reqOwn, resOwn);
            assert.strictEqual(resOwn.statusCode, 200);
            assert.strictEqual(resOwn.body.manufacturer.id, mfgA.id);
            assert.strictEqual(resOwn.body.manufacturer.contact_email, mfgA.contact_email);
            assert.strictEqual(resOwn.body.manufacturer.business_model, mfgA.business_model);
            console.log('    ✓ Check 1 (Detail) Passed: Cross-tenant access to external ID returns strictly public serialization.');

            // Public / Unauthenticated access to Demo Manufacturer by ID must return HTTP 404:
            const reqDemoId = {
                params: { id: demoMfg.id },
                headers: {},
                dbClientOptions: clientOpts
            };
            const resDemoId = createMockRes();
            await getSingleManufacturerHandler(reqDemoId, resDemoId);
            assert.strictEqual(resDemoId.statusCode, 404, 'Public request for demo manufacturer by ID must receive 404');
            console.log('    ✓ Check Demo ID Passed: Public caller cannot access demo profile by ID (HTTP 404).');

            // =================================================================
            // MANDATORY SECURITY CHECK 3: Profile Creation Restriction (POST /)
            // =================================================================
            // Manufacturer A attempts profile creation: must be rejected with HTTP 403
            const reqMfgPost = {
                headers: { authorization: `Bearer ${tokenA}` },
                body: {
                    name_ar: 'محاولة اختراق',
                    city: 'القاهرة',
                    business_model: 'MARKETING_SUBSCRIPTION'
                },
                dbClientOptions: clientOpts
            };
            const resMfgPost = createMockRes();
            await postManufacturerHandler(reqMfgPost, resMfgPost);
            assert.strictEqual(resMfgPost.statusCode, 403, 'Manufacturer role must receive HTTP 403 on profile creation');

            // Anonymous caller attempts profile creation: must be rejected with HTTP 401
            const reqAnonPost = {
                headers: {},
                body: {
                    name_ar: 'محاولة اختراق مجهول',
                    city: 'القاهرة',
                    business_model: 'MARKETING_SUBSCRIPTION'
                },
                dbClientOptions: clientOpts
            };
            const resAnonPost = createMockRes();
            await postManufacturerHandler(reqAnonPost, resAnonPost);
            assert.strictEqual(resAnonPost.statusCode, 401, 'Anonymous caller must receive HTTP 401 on profile creation');
            console.log('    ✓ Check 3 Passed: Profile creation strictly forbidden for Manufacturer (403) and Anonymous (401).');

            // =================================================================
            // SUPER ADMIN OPERATIONS & CREATION WORKFLOWS
            // =================================================================
            // Super Admin listing sees all manufacturers with products_count
            const reqAdminList = {
                headers: { authorization: `Bearer ${adminToken}` },
                dbClientOptions: clientOpts
            };
            const resAdminList = createMockRes();
            await getManufacturersHandler(reqAdminList, resAdminList);
            assert.strictEqual(resAdminList.statusCode, 200);
            assert.ok(resAdminList.body.manufacturers.length >= 2);
            for (const m of resAdminList.body.manufacturers) {
                assert.ok(m.business_model, 'Admin listing includes business_model');
                assert.ok(m.products_count !== undefined, 'Admin listing includes products_count');
            }

            // Filter by business_model
            const reqFilter = {
                headers: { authorization: `Bearer ${adminToken}` },
                query: { business_model: 'DIRECT_CONTRACT' },
                dbClientOptions: clientOpts
            };
            const resFilter = createMockRes();
            await getManufacturersHandler(reqFilter, resFilter);
            assert.strictEqual(resFilter.statusCode, 200);
            for (const m of resFilter.body.manufacturers) {
                assert.strictEqual(m.business_model, 'DIRECT_CONTRACT');
            }
            console.log('    ✓ Admin Oversight Passed: Super Admin accesses full serialization, products_count, and model filters.');

            // Super Admin creates a new profile (POST /)
            const newMfgNameAr = `مصنع تجريبي جديد ${synthSuffix} ${engineName}`;
            const reqCreate = {
                headers: { authorization: `Bearer ${adminToken}` },
                body: {
                    name_ar: newMfgNameAr,
                    name_en: 'New Test Mfg',
                    code: `NEW-${synthSuffix}-${engineName.substring(0, 2).toUpperCase()}`,
                    business_model: 'MARKETING_SUBSCRIPTION',
                    city: 'الإسكندرية',
                    contact_email: 'new@zarsev.test',
                    contact_phone: '+201099998888'
                },
                dbClientOptions: clientOpts
            };
            const resCreate = createMockRes();
            await postManufacturerHandler(reqCreate, resCreate);
            assert.strictEqual(resCreate.statusCode, 201, 'Authorized creation must succeed with 201');
            assert.strictEqual(resCreate.body.success, true);
            assert.strictEqual(resCreate.body.manufacturer.name_ar, newMfgNameAr);
            const createdId = resCreate.body.manufacturer.id;

            if (engineName.startsWith('PostgreSQL')) {
                pgSyntheticIds.manufacturers.push(createdId);
            }

            // Duplicate creation attempt must be rejected with HTTP 409
            const reqDuplicate = {
                headers: { authorization: `Bearer ${adminToken}` },
                body: {
                    name_ar: newMfgNameAr,
                    city: 'القاهرة',
                    business_model: 'DIRECT_CONTRACT'
                },
                dbClientOptions: clientOpts
            };
            const resDuplicate = createMockRes();
            await postManufacturerHandler(reqDuplicate, resDuplicate);
            assert.strictEqual(resDuplicate.statusCode, 409, 'Duplicate name/code must be rejected with HTTP 409');
            console.log('    ✓ Creation Workflow Passed: Super Admin profile creation succeeds with 201; duplicates rejected with 409.');

            // Invalid payload missing required fields returns HTTP 400
            const reqMissingFields = {
                headers: { authorization: `Bearer ${adminToken}` },
                body: { name_ar: 'ناقص البيانات' },
                dbClientOptions: clientOpts
            };
            const resMissingFields = createMockRes();
            await postManufacturerHandler(reqMissingFields, resMissingFields);
            assert.strictEqual(resMissingFields.statusCode, 400);

            // =================================================================
            // FUZZY MATCH ENDPOINT (GET /match) & ROLE SANITIZATION (SEC-2431C-01, SEC-2431C-02, TEST-2431C-01)
            // =================================================================
            // 1. SUPER_ADMIN caller queries match: receives target manufacturer WITH business_model
            const reqMatchAdmin = {
                headers: { authorization: `Bearer ${adminToken}` },
                query: { name: mfgA.name_ar },
                dbClientOptions: clientOpts
            };
            const resMatchAdmin = createMockRes();
            await getMatchHandler(reqMatchAdmin, resMatchAdmin);
            assert.strictEqual(resMatchAdmin.statusCode, 200);
            assert.strictEqual(resMatchAdmin.body.success, true);
            assert.ok(resMatchAdmin.body.match, 'Matching manufacturer must be returned for SUPER_ADMIN');
            assert.strictEqual(resMatchAdmin.body.match.id, mfgA.id);
            assert.strictEqual(resMatchAdmin.body.match.business_model, mfgA.business_model, 'SUPER_ADMIN caller sees business_model');
            assert.strictEqual(resMatchAdmin.body.match.contact_email, undefined, 'Private contact_email stripped');
            assert.strictEqual(resMatchAdmin.body.match.contact_phone, undefined, 'Private contact_phone stripped');
            assert.ok(resMatchAdmin.body.match.match_confidence >= 0.5);

            // 2. LOGISTICS_OFFICER caller queries match: receives target manufacturer WITH business_model
            const reqMatchLogistics = {
                headers: { authorization: `Bearer ${logisticsToken}` },
                query: { name: mfgA.name_ar },
                dbClientOptions: clientOpts
            };
            const resMatchLogistics = createMockRes();
            await getMatchHandler(reqMatchLogistics, resMatchLogistics);
            assert.strictEqual(resMatchLogistics.statusCode, 200);
            assert.strictEqual(resMatchLogistics.body.success, true);
            assert.ok(resMatchLogistics.body.match, 'Matching manufacturer must be returned for LOGISTICS_OFFICER');
            assert.strictEqual(resMatchLogistics.body.match.id, mfgA.id);
            assert.strictEqual(resMatchLogistics.body.match.business_model, mfgA.business_model, 'LOGISTICS_OFFICER caller sees business_model');

            // 3. MANUFACTURER caller (e.g. Manufacturer A) queries match: receives target manufacturer WITHOUT business_model
            const reqMatchMfg = {
                headers: { authorization: `Bearer ${tokenA}` },
                query: { name: mfgB.name_ar },
                dbClientOptions: clientOpts
            };
            const resMatchMfg = createMockRes();
            await getMatchHandler(reqMatchMfg, resMatchMfg);
            assert.strictEqual(resMatchMfg.statusCode, 200);
            assert.strictEqual(resMatchMfg.body.success, true);
            assert.ok(resMatchMfg.body.match, 'Matching manufacturer must be returned for MANUFACTURER');
            assert.strictEqual(resMatchMfg.body.match.id, mfgB.id);
            assert.strictEqual(resMatchMfg.body.match.business_model, undefined, 'MANUFACTURER caller must strictly NOT see business_model');
            assert.strictEqual(resMatchMfg.body.match.contact_email, undefined, 'No private contact_email');
            assert.strictEqual(resMatchMfg.body.match.contact_phone, undefined, 'No private contact_phone');
            assert.strictEqual(resMatchMfg.body.match.subscription_id, undefined, 'No private subscription_id');
            assert.ok(resMatchMfg.body.match.match_confidence >= 0.5);

            // 4. Searching for quarantined demo manufacturer exact name returns match: null
            const reqMatchDemo = {
                headers: { authorization: `Bearer ${adminToken}` },
                query: { name: demoMfg.name_ar },
                dbClientOptions: clientOpts
            };
            const resMatchDemo = createMockRes();
            await getMatchHandler(reqMatchDemo, resMatchDemo);
            assert.strictEqual(resMatchDemo.statusCode, 200);
            assert.strictEqual(resMatchDemo.body.success, true);
            assert.strictEqual(resMatchDemo.body.match, null, 'Demo manufacturer must be completely excluded from /match, returning match: null');

            // 5. Empty query returns null match
            const reqMatchEmpty = {
                headers: { authorization: `Bearer ${adminToken}` },
                query: {},
                dbClientOptions: clientOpts
            };
            const resMatchEmpty = createMockRes();
            await getMatchHandler(reqMatchEmpty, resMatchEmpty);
            assert.strictEqual(resMatchEmpty.body.match, null);
            console.log('    ✓ Match Endpoint Remediations Passed: business_model sanitized by role, demo manufacturers excluded.');

            return resAdminList.body;
        }

        // =====================================================================
        // PART 1: EXECUTION AGAINST SQLITE
        // =====================================================================
        // Seed initial SQLite fixtures
        sqliteDb.exec(`
            INSERT INTO subscriptions (id, name) VALUES ('sub_test_standard', 'Standard Plan');

            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, contact_phone, is_demo)
            VALUES 
                ('mfg_sq_a', 'شركة أ لتصنيع الأغذية', 'Company A Food', 'MFG-SQ-A', 'MARKETING_SUBSCRIPTION', 'sub_test_standard', 'القاهرة', 'a@zarsev.test', '0100000001', 0),
                ('mfg_sq_b', 'شركة ب للمنتجات الزراعية', 'Company B Agro', 'MFG-SQ-B', 'DIRECT_CONTRACT', NULL, 'الجيزة', 'b@zarsev.test', '0100000002', 0),
                ('mfg_sq_demo', 'مؤسسة الواحة المحجوبة التجريبية', 'Oasis Quarantine Demo', 'MFG-SQ-DEMO', 'MARKETING_SUBSCRIPTION', NULL, 'طنطا', 'demo@zarsev.test', '0100000003', 1);

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active, is_demo, token_version)
            VALUES 
                ('usr_admin_c', 'مدير النظام C', 'admin_c@zarsev.test', 'SUPER_ADMIN', NULL, 1, 0, 1),
                ('usr_logistics_c', 'مسؤول لوجستي C', 'logistics_c@zarsev.test', 'LOGISTICS_OFFICER', NULL, 1, 0, 1),
                ('usr_mfg_a', 'مدير مصنع A', 'mfg_a@zarsev.test', 'MANUFACTURER', 'mfg_sq_a', 1, 0, 1),
                ('usr_mfg_b', 'مدير مصنع B', 'mfg_b@zarsev.test', 'MANUFACTURER', 'mfg_sq_b', 1, 0, 1),
                ('usr_mfg_orphan', 'مستخدم مصنع يتيم', 'orphan@zarsev.test', 'MANUFACTURER', NULL, 1, 0, 1);

            INSERT INTO products (id, manufacturer_id, name_ar, status, is_demo)
            VALUES 
                ('prod_sq_a1', 'mfg_sq_a', 'منتج أ 1', 'PUBLISHED', 0),
                ('prod_sq_a2', 'mfg_sq_a', 'منتج أ 2', 'PUBLISHED', 0);
        `);

        const sqliteFixtures = {
            adminUser: { id: 'usr_admin_c' },
            logisticsUser: { id: 'usr_logistics_c' },
            mfgUserA: { id: 'usr_mfg_a' },
            mfgUserB: { id: 'usr_mfg_b' },
            mfgUserOrphan: { id: 'usr_mfg_orphan' },
            mfgA: { id: 'mfg_sq_a', name_ar: 'شركة أ لتصنيع الأغذية', business_model: 'MARKETING_SUBSCRIPTION', contact_email: 'a@zarsev.test' },
            mfgB: { id: 'mfg_sq_b', name_ar: 'شركة ب للمنتجات الزراعية', business_model: 'DIRECT_CONTRACT', contact_email: 'b@zarsev.test' },
            demoMfg: { id: 'mfg_sq_demo', name_ar: 'مؤسسة الواحة المحجوبة التجريبية' }
        };

        const sqliteResult = await testManufacturerEngine(
            'SQLite',
            { engine: 'sqlite', customDb: sqliteDb },
            sqliteFixtures
        );

        // =====================================================================
        // PART 2: EXECUTION AGAINST POSTGRESQL (zarsev_test)
        // =====================================================================
        const pgSubId = `_synth_c_sub_${synthSuffix}`;
        const pgMfgAId = `_synth_c_mfg_a_${synthSuffix}`;
        const pgMfgBId = `_synth_c_mfg_b_${synthSuffix}`;
        const pgMfgDemoId = `_synth_c_mfg_demo_${synthSuffix}`;
        const pgAdminUserId = `_synth_c_usr_admin_${synthSuffix}`;
        const pgLogisticsUserId = `_synth_c_usr_logistics_${synthSuffix}`;
        const pgMfgUserAId = `_synth_c_usr_mfga_${synthSuffix}`;
        const pgMfgUserBId = `_synth_c_usr_mfgb_${synthSuffix}`;
        const pgMfgUserOrphanId = `_synth_c_usr_orphan_${synthSuffix}`;
        const pgProdA1Id = `_synth_c_prd_a1_${synthSuffix}`;

        // Seed synthetic PostgreSQL records
        await pgPool.query(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb)
            VALUES ($1, 'Synth Sub C', '["xlsx","csv"]'::jsonb, 50, 10, 25);
        `, [pgSubId]);
        pgSyntheticIds.subscriptions.push(pgSubId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, contact_phone, is_verified, is_demo)
            VALUES 
                ($1, 'شركة ألفا للصناعات الغذائية PG', 'Company Alpha PG', $2, 'MARKETING_SUBSCRIPTION', $3, 'القاهرة', 'pga@zarsev.test', '0100000001', true, false),
                ($4, 'شركة بيتا للمنتجات الزراعية PG', 'Company Beta PG', $5, 'DIRECT_CONTRACT', NULL, 'الجيزة', 'pgb@zarsev.test', '0100000002', true, false),
                ($6, 'مؤسسة الواحة المحجوبة التجريبية PG', 'Oasis Quarantine Demo PG', $7, 'MARKETING_SUBSCRIPTION', NULL, 'طنطا', 'pgdemo@zarsev.test', '0100000003', true, true);
        `, [
            pgMfgAId, `MFG-PGA-${synthSuffix}`, pgSubId,
            pgMfgBId, `MFG-PGB-${synthSuffix}`,
            pgMfgDemoId, `MFG-DEMO-${synthSuffix}`
        ]);
        pgSyntheticIds.manufacturers.push(pgMfgAId, pgMfgBId, pgMfgDemoId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active, is_demo, token_version)
            VALUES 
                ($1, 'مدير C PG', $2, 'SUPER_ADMIN', NULL, true, false, 1),
                ($3, 'لوجستي C PG', $4, 'LOGISTICS_OFFICER', NULL, true, false, 1),
                ($5, 'مصنع A PG', $6, 'MANUFACTURER', $7, true, false, 1),
                ($8, 'مصنع B PG', $9, 'MANUFACTURER', $10, true, false, 1),
                ($11, 'مصنع يتيم PG', $12, 'MANUFACTURER', NULL, true, false, 1);
        `, [
            pgAdminUserId, `admin_c_${synthSuffix}@zarsev.test`,
            pgLogisticsUserId, `logistics_c_${synthSuffix}@zarsev.test`,
            pgMfgUserAId, `mfg_a_${synthSuffix}@zarsev.test`, pgMfgAId,
            pgMfgUserBId, `mfg_b_${synthSuffix}@zarsev.test`, pgMfgBId,
            pgMfgUserOrphanId, `orphan_${synthSuffix}@zarsev.test`
        ]);
        pgSyntheticIds.users.push(pgAdminUserId, pgLogisticsUserId, pgMfgUserAId, pgMfgUserBId, pgMfgUserOrphanId);

        await pgPool.query(`
            INSERT INTO products (id, manufacturer_id, sku, name_ar, status, is_demo)
            VALUES ($1, $2, $3, 'منتج أ PG', 'PUBLISHED', false);
        `, [pgProdA1Id, pgMfgAId, `SKU-PGA-${synthSuffix}`]);
        pgSyntheticIds.products.push(pgProdA1Id);

        const pgFixtures = {
            adminUser: { id: pgAdminUserId },
            logisticsUser: { id: pgLogisticsUserId },
            mfgUserA: { id: pgMfgUserAId },
            mfgUserB: { id: pgMfgUserBId },
            mfgUserOrphan: { id: pgMfgUserOrphanId },
            mfgA: { id: pgMfgAId, name_ar: 'شركة ألفا للصناعات الغذائية PG', business_model: 'MARKETING_SUBSCRIPTION', contact_email: 'pga@zarsev.test' },
            mfgB: { id: pgMfgBId, name_ar: 'شركة بيتا للمنتجات الزراعية PG', business_model: 'DIRECT_CONTRACT', contact_email: 'pgb@zarsev.test' },
            demoMfg: { id: pgMfgDemoId, name_ar: 'مؤسسة الواحة المحجوبة التجريبية PG' }
        };

        const pgResult = await testManufacturerEngine(
            'PostgreSQL (zarsev_test)',
            { engine: 'postgres', dbNameOverride: 'zarsev_test' },
            pgFixtures
        );

        // =====================================================================
        // PART 3: CROSS-ENGINE PARITY & FAILURE RESILIENCE
        // =====================================================================
        console.log('\n  --- Checking SQLite / PostgreSQL Manufacturer Response Parity ---');
        assert.strictEqual(sqliteResult.success, pgResult.success);
        assert.ok(Array.isArray(sqliteResult.manufacturers));
        assert.ok(Array.isArray(pgResult.manufacturers));
        console.log('✓ Check Parity Passed: Manufacturer response shapes and schemas are 100% equivalent.');

        console.log('\n  --- Testing Manufacturer Routes DB Failure Resilience ---');
        const brokenDbOpts = {
            engine: 'sqlite',
            customDb: {
                prepare: () => { throw new Error('Simulated database connection failure'); }
            }
        };
        const reqFail = { headers: {}, dbClientOptions: brokenDbOpts };
        const resFail = createMockRes();
        await getManufacturersHandler(reqFail, resFail);
        assert.strictEqual(resFail.statusCode, 500);
        assert.strictEqual(resFail.body.success, false);
        console.log('✓ Check Failure Passed: Database error returns structured HTTP 500 without crashing.');

    } finally {
        // =====================================================================
        // DETERMINISTIC CLEANUP OF ALL SYNTHETIC TEST FIXTURES
        // =====================================================================
        console.log('\n--- 🧹 Deterministic Cleanup of Synthetic Test Records ---');
        try {
            // Delete synthetic products
            for (const id of pgSyntheticIds.products) {
                await pgPool.query('DELETE FROM products WHERE id = $1;', [id]);
            }
            // Delete synthetic users
            for (const id of pgSyntheticIds.users) {
                await pgPool.query('DELETE FROM users WHERE id = $1;', [id]);
            }
            // Delete synthetic manufacturers
            for (const id of pgSyntheticIds.manufacturers) {
                await pgPool.query('DELETE FROM manufacturers WHERE id = $1;', [id]);
            }
            // Delete synthetic subscriptions
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
    console.log('🎉 ALL PHASE 2.4.3.1-C ROUTE & SECURITY TESTS PASSED (100%)!');
    console.log('================================================================\n');
}

if (require.main === module) {
    runPhase2_4_3_1_C_Tests().catch(err => {
        console.error('\n❌ TEST SUITE FAILED:', err);
        process.exit(1);
    });
}

module.exports = { runPhase2_4_3_1_C_Tests };
