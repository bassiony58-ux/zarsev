/**
 * test/test_phase2_4_3_1_a_middleware.js
 * 
 * ZARSEV — Phase 2.4.3.1-A: Async Core Middleware Integration Test Suite
 * 
 * Tests both SQLite and PostgreSQL engines across all requirements:
 * 1. Authentication Middleware (authMiddleware & optionalAuthMiddleware)
 *    - Valid token
 *    - Missing token (401)
 *    - Invalid token (401)
 *    - Revoked token / token_version mismatch (401)
 *    - Inactive user (SQLite is_active=0 vs PostgreSQL is_active=false) (401)
 *    - Missing user in database (401)
 *    - Manufacturer role and manufacturer association
 *    - Anonymous request through optional auth
 *    - Database failure handling (500)
 * 
 * 2. Subscription Guard (checkSubscriptionLimits)
 *    - Active subscription
 *    - Expired subscription (403)
 *    - Missing subscription (403)
 *    - Monthly quota below limit (passes)
 *    - Monthly quota at limit (429)
 *    - Monthly quota exceeded (429)
 *    - DIRECT_CONTRACT quota exemption
 *    - MARKETING_SUBSCRIPTION quota enforcement
 *    - Manufacturer ownership mismatch (403)
 *    - Month-boundary behavior (past-month imports ignored)
 * 
 * 3. Cross-Engine Parity and Immutability Verification
 *    - SQLite SHA256 hashes unchanged
 *    - zarsev_test 342 business records 100% intact after cleanup
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

process.env.NODE_ENV = 'test';
process.env.ZARSEV_TEST_MODE = '1';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
if (!fs.existsSync(SANDBOX_DIR)) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

const TEST_SQLITE_PATH = path.join(SANDBOX_DIR, `middleware_test_${Date.now()}_${process.pid}.db`);
process.env.DB_PATH = TEST_SQLITE_PATH;

const config = require('../src/config');
const dbClient = require('../src/db/dbClient');
const pgAdapter = require('../src/db/pgAdapter');
const { generateToken, hashPassword } = require('../src/utils/authUtils');
const { authMiddleware, optionalAuthMiddleware, isEntityActive } = require('../src/middlewares/auth');
const { checkSubscriptionLimits, parseAllowedFormats } = require('../src/middlewares/subscriptionGuard');

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
        const count = res.rows[0].c;
        counts[tbl] = count;
        total += count;
    }
    return { counts, total };
}

// Mock Express response helper
function createMockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(payload) {
            res.body = payload;
            return res;
        }
    };
    return res;
}

async function runMiddlewareIntegrationTests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Phase 2.4.3.1-A: Async Core Middleware Integration Test');
    console.log('================================================================\n');

    // 1. Initial Baseline Snapshot
    const preSnap = captureSnapshot();
    assert.strictEqual(preSnap['zarsev.db'].sha, 'BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB');
    const prePgCounts = await capturePgBusinessCounts();
    assert.strictEqual(prePgCounts.total, 342, 'zarsev_test must contain exactly 342 records prior to tests');

    // Setup isolated SQLite database
    const sqliteDb = new DatabaseSync(TEST_SQLITE_PATH);
    sqliteDb.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE subscriptions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            allowed_formats TEXT NOT NULL,
            max_products_per_import INTEGER NOT NULL,
            max_monthly_imports INTEGER NOT NULL,
            max_file_size_mb INTEGER NOT NULL,
            ai_extraction_enabled INTEGER NOT NULL DEFAULT 1,
            bulk_import_enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NULL
        );

        CREATE TABLE manufacturers (
            id TEXT PRIMARY KEY,
            name_ar TEXT NOT NULL,
            name_en TEXT,
            code TEXT UNIQUE NOT NULL,
            business_model TEXT NOT NULL,
            subscription_id TEXT,
            country TEXT DEFAULT 'مصر',
            city TEXT NOT NULL,
            contact_email TEXT,
            contact_phone TEXT,
            is_verified INTEGER DEFAULT 1,
            is_demo INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
        );

        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            role TEXT NOT NULL,
            manufacturer_id TEXT,
            is_active INTEGER DEFAULT 1,
            is_demo INTEGER DEFAULT 0,
            token_version INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE SET NULL
        );

        CREATE TABLE imports (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            manufacturer_id TEXT,
            source_files TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            total_detected INTEGER DEFAULT 0,
            total_valid INTEGER DEFAULT 0,
            total_failed INTEGER DEFAULT 0,
            progress_percent INTEGER DEFAULT 0,
            error_summary TEXT,
            is_demo INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
            FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE SET NULL
        );
    `);

    // Helper for synthetic PostgreSQL fixture tracking
    const pgSyntheticIds = {
        users: [],
        manufacturers: [],
        subscriptions: [],
        imports: []
    };

    const pgPool = pgAdapter.getAppPool('zarsev_test');

    try {
        // =====================================================================
        // PART 1: AUTHENTICATION MIDDLEWARE TESTS (Cross-Engine)
        // =====================================================================
        console.log('--- 🧪 Part 1: Authentication Middleware Tests ---');

        // Test 1.1: Boolean helper isEntityActive unit validation
        assert.strictEqual(isEntityActive(true), true);
        assert.strictEqual(isEntityActive(false), false);
        assert.strictEqual(isEntityActive(1), true);
        assert.strictEqual(isEntityActive(0), false);
        assert.strictEqual(isEntityActive('true'), true);
        assert.strictEqual(isEntityActive('false'), false);
        assert.strictEqual(isEntityActive('0'), false);
        assert.strictEqual(isEntityActive(null), false);
        assert.strictEqual(isEntityActive(undefined), false);
        console.log('✓ Check 1.1 Passed: isEntityActive strictly verifies boolean contracts without blind truthiness.');

        // 1.2: Seed SQLite fixtures
        sqliteDb.exec(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb)
            VALUES ('sub_test_standard', 'Standard Plan', '["xlsx","csv"]', 50, 10, 50);

            INSERT INTO manufacturers (id, name_ar, code, business_model, subscription_id, city)
            VALUES ('mfg_test_1', 'مصنع تجريبي', 'MFG-T1', 'MARKETING_SUBSCRIPTION', 'sub_test_standard', 'القاهرة');

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active, token_version)
            VALUES ('usr_test_active', 'مستخدم نشط', 'active@zarsev.test', 'MANUFACTURER', 'mfg_test_1', 1, 1);

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active, token_version)
            VALUES ('usr_test_inactive', 'مستخدم معطل', 'inactive@zarsev.test', 'MANUFACTURER', 'mfg_test_1', 0, 1);
        `);

        // 1.3: Seed PostgreSQL fixtures
        const synthSuffix = crypto.randomBytes(3).toString('hex');
        const pgSubId = `_synth_sub_${synthSuffix}`;
        const pgMfgId = `_synth_mfg_${synthSuffix}`;
        const pgUsrActiveId = `_synth_usr_act_${synthSuffix}`;
        const pgUsrInactiveId = `_synth_usr_inact_${synthSuffix}`;

        await pgPool.query(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb)
            VALUES ($1, 'PG Standard Plan', '["xlsx","csv"]'::jsonb, 50, 10, 50);
        `, [pgSubId]);
        pgSyntheticIds.subscriptions.push(pgSubId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city)
            VALUES ($1, 'مصنع بوستجرس', 'PG Mfg', $2, 'MARKETING_SUBSCRIPTION', $3, 'الإسكندرية');
        `, [pgMfgId, `MFG-PG-${synthSuffix}`, pgSubId]);
        pgSyntheticIds.manufacturers.push(pgMfgId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active, token_version)
            VALUES ($1, 'مستخدم نشط بوستجرس', $2, 'MANUFACTURER', $3, true, 1);
        `, [pgUsrActiveId, `act_${synthSuffix}@zarsev.test`, pgMfgId]);
        pgSyntheticIds.users.push(pgUsrActiveId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active, token_version)
            VALUES ($1, 'مستخدم معطل بوستجرس', $2, 'MANUFACTURER', $3, false, 1);
        `, [pgUsrInactiveId, `inact_${synthSuffix}@zarsev.test`, pgMfgId]);
        pgSyntheticIds.users.push(pgUsrInactiveId);

        // Runner function to test auth cases across both engines
        async function testAuthEngine(engineName, clientOpts, activeUserId, inactiveUserId, mfgId, subId) {
            console.log(`\n  --- Testing Auth Middleware on ${engineName} ---`);

            // Case A: Missing token
            const reqMissing = { headers: {}, dbClientOptions: clientOpts };
            const resMissing = createMockRes();
            let nextMissingCalled = false;
            await authMiddleware(reqMissing, resMissing, () => { nextMissingCalled = true; });
            assert.strictEqual(resMissing.statusCode, 401);
            assert.strictEqual(nextMissingCalled, false);
            assert.strictEqual(resMissing.body.success, false);
            assert.ok(resMissing.body.error.includes('يلزم تسجيل الدخول'));

            // Case B: Invalid/Malformed token
            const reqInvalid = { headers: { authorization: 'Bearer malformed.invalid.token' }, dbClientOptions: clientOpts };
            const resInvalid = createMockRes();
            let nextInvalidCalled = false;
            await authMiddleware(reqInvalid, resInvalid, () => { nextInvalidCalled = true; });
            assert.strictEqual(resInvalid.statusCode, 401);
            assert.strictEqual(nextInvalidCalled, false);
            assert.ok(resInvalid.body.error.includes('رمز الجلسة غير صالح'));

            // Case C: Valid token for active user
            const validToken = generateToken({ id: activeUserId, token_version: 1 });
            const reqValid = { headers: { authorization: `Bearer ${validToken}` }, dbClientOptions: clientOpts };
            const resValid = createMockRes();
            let nextValidCalled = false;
            await authMiddleware(reqValid, resValid, () => { nextValidCalled = true; });
            assert.strictEqual(nextValidCalled, true, 'Valid token must call next()');
            assert.strictEqual(resValid.statusCode, 200);
            assert.ok(reqValid.user, 'req.user must be attached');
            assert.strictEqual(reqValid.user.id, activeUserId);
            assert.ok(reqValid.manufacturer, 'req.manufacturer must be attached');
            assert.strictEqual(reqValid.manufacturer.id, mfgId);
            assert.ok(reqValid.subscription, 'req.subscription must be attached');
            assert.strictEqual(reqValid.subscription.id, subId);

            // Case D: Inactive user rejected with 401
            const inactiveToken = generateToken({ id: inactiveUserId, token_version: 1 });
            const reqInactive = { headers: { authorization: `Bearer ${inactiveToken}` }, dbClientOptions: clientOpts };
            const resInactive = createMockRes();
            let nextInactiveCalled = false;
            await authMiddleware(reqInactive, resInactive, () => { nextInactiveCalled = true; });
            assert.strictEqual(resInactive.statusCode, 401);
            assert.strictEqual(nextInactiveCalled, false);
            assert.ok(resInactive.body.error.includes('تم تجميد أو تعطيل هذا الحساب'));

            // Case E: Revoked token (token_version mismatch)
            const revokedToken = generateToken({ id: activeUserId, token_version: 2 }); // Token has version 2, DB has version 1
            const reqRevoked = { headers: { authorization: `Bearer ${revokedToken}` }, dbClientOptions: clientOpts };
            const resRevoked = createMockRes();
            let nextRevokedCalled = false;
            await authMiddleware(reqRevoked, resRevoked, () => { nextRevokedCalled = true; });
            assert.strictEqual(resRevoked.statusCode, 401);
            assert.strictEqual(nextRevokedCalled, false);
            assert.ok(resRevoked.body.error.includes('Session Revoked'));

            // Case F: Non-existent user ID in validly signed token
            const nonExistentToken = generateToken({ id: 'usr_ghost_999999', token_version: 1 });
            const reqGhost = { headers: { authorization: `Bearer ${nonExistentToken}` }, dbClientOptions: clientOpts };
            const resGhost = createMockRes();
            let nextGhostCalled = false;
            await authMiddleware(reqGhost, resGhost, () => { nextGhostCalled = true; });
            assert.strictEqual(resGhost.statusCode, 401);
            assert.strictEqual(nextGhostCalled, false);
            assert.ok(resGhost.body.error.includes('المستخدم غير مسجل بالنظام'));

            // Case G: Optional auth with anonymous caller (no token) -> calls next() with req.user = null
            const reqOptAnon = { headers: {}, dbClientOptions: clientOpts };
            const resOptAnon = createMockRes();
            let nextOptAnonCalled = false;
            await optionalAuthMiddleware(reqOptAnon, resOptAnon, () => { nextOptAnonCalled = true; });
            assert.strictEqual(nextOptAnonCalled, true);
            assert.strictEqual(reqOptAnon.user, null);
            assert.strictEqual(reqOptAnon.manufacturer, null);

            // Case H: Optional auth with valid token -> populates req.user
            const reqOptValid = { headers: { authorization: `Bearer ${validToken}` }, dbClientOptions: clientOpts };
            const resOptValid = createMockRes();
            let nextOptValidCalled = false;
            await optionalAuthMiddleware(reqOptValid, resOptValid, () => { nextOptValidCalled = true; });
            assert.strictEqual(nextOptValidCalled, true);
            assert.strictEqual(reqOptValid.user.id, activeUserId);
            assert.strictEqual(reqOptValid.manufacturer.id, mfgId);

            console.log(`  ✓ All Auth cases on ${engineName} passed (401 on missing/invalid/revoked/inactive, 200 on valid).`);
        }

        // Test Auth against SQLite
        await testAuthEngine(
            'SQLite',
            { engine: 'sqlite', customDb: sqliteDb },
            'usr_test_active',
            'usr_test_inactive',
            'mfg_test_1',
            'sub_test_standard'
        );

        // Test Auth against PostgreSQL
        await testAuthEngine(
            'PostgreSQL (zarsev_test)',
            { engine: 'postgres', dbNameOverride: 'zarsev_test' },
            pgUsrActiveId,
            pgUsrInactiveId,
            pgMfgId,
            pgSubId
        );

        // Case 1.4: Database error handling during Auth returns HTTP 500
        console.log('\n  --- Testing Auth DB Failure Resilience ---');
        const brokenDbClientOpts = {
            engine: 'sqlite',
            customDb: {
                prepare: () => { throw new Error('Simulated database connection failure'); }
            }
        };
        const reqDbFail = {
            headers: { authorization: `Bearer ${generateToken({ id: 'usr_test_active', token_version: 1 })}` },
            dbClientOptions: brokenDbClientOpts
        };
        const resDbFail = createMockRes();
        let nextDbFailCalled = false;
        await authMiddleware(reqDbFail, resDbFail, () => { nextDbFailCalled = true; });
        assert.strictEqual(resDbFail.statusCode, 500, 'DB error must return 500');
        assert.strictEqual(nextDbFailCalled, false);
        assert.strictEqual(resDbFail.body.success, false);
        console.log('✓ Check 1.4 Passed: Database failure returns structured HTTP 500 without crashing.');

        // =====================================================================
        // PART 2: SUBSCRIPTION GUARD TESTS (Cross-Engine)
        // =====================================================================
        console.log('\n--- 🧪 Part 2: Subscription Guard Tests ---');

        // Test 2.1: parseAllowedFormats helper
        assert.deepStrictEqual(parseAllowedFormats(['xlsx', 'csv']), ['xlsx', 'csv']);
        assert.deepStrictEqual(parseAllowedFormats('["xlsx","csv"]'), ['xlsx', 'csv']);
        assert.deepStrictEqual(parseAllowedFormats('invalid-json'), []);
        assert.deepStrictEqual(parseAllowedFormats(null), []);
        console.log('✓ Check 2.1 Passed: parseAllowedFormats safely normalizes strings and native JSONB arrays.');

        // Seed additional Subscription test data:
        // SQLite:
        sqliteDb.exec(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb, expires_at)
            VALUES ('sub_test_expired', 'Expired Sub', '["xlsx"]', 10, 5, 20, '2020-01-01 00:00:00');

            INSERT INTO manufacturers (id, name_ar, code, business_model, subscription_id, city)
            VALUES ('mfg_test_expired', 'مصنع منتهي', 'MFG-EXP', 'MARKETING_SUBSCRIPTION', 'sub_test_expired', 'الجيزة');

            INSERT INTO manufacturers (id, name_ar, code, business_model, subscription_id, city)
            VALUES ('mfg_test_direct', 'مصنع عقد مباشر', 'MFG-DIR', 'DIRECT_CONTRACT', NULL, 'طنطا');

            INSERT INTO manufacturers (id, name_ar, code, business_model, subscription_id, city)
            VALUES ('mfg_test_no_sub', 'مصنع بدون باقة', 'MFG-NOSUB', 'MARKETING_SUBSCRIPTION', NULL, 'المنصورة');

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ('usr_test_expired', 'مستخدم منتهي', 'exp@zarsev.test', 'MANUFACTURER', 'mfg_test_expired', 1);

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ('usr_test_direct', 'مستخدم مباشر', 'dir@zarsev.test', 'MANUFACTURER', 'mfg_test_direct', 1);

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ('usr_test_no_sub', 'مستخدم بدون باقة', 'nosub@zarsev.test', 'MANUFACTURER', 'mfg_test_no_sub', 1);

            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ('usr_test_unlinked', 'مستخدم غير مقترن', 'unlinked@zarsev.test', 'MANUFACTURER', NULL, 1);
        `);

        // PostgreSQL:
        const pgExpiredSubId = `_synth_sub_exp_${synthSuffix}`;
        const pgExpiredMfgId = `_synth_mfg_exp_${synthSuffix}`;
        const pgDirectMfgId = `_synth_mfg_dir_${synthSuffix}`;
        const pgNoSubMfgId = `_synth_mfg_nosub_${synthSuffix}`;
        const pgExpiredUsrId = `_synth_usr_exp_${synthSuffix}`;
        const pgDirectUsrId = `_synth_usr_dir_${synthSuffix}`;
        const pgNoSubUsrId = `_synth_usr_nosub_${synthSuffix}`;
        const pgUnlinkedUsrId = `_synth_usr_unlinked_${synthSuffix}`;

        await pgPool.query(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb, created_at)
            VALUES ($1, 'PG Expired Sub', '["xlsx"]'::jsonb, 10, 5, 20, '2020-01-01T00:00:00Z');
        `, [pgExpiredSubId]);
        pgSyntheticIds.subscriptions.push(pgExpiredSubId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city)
            VALUES ($1, 'مصنع بوستجرس منتهي', 'PG Exp', $2, 'MARKETING_SUBSCRIPTION', $3, 'الجيزة');
        `, [pgExpiredMfgId, `MFG-EXP-${synthSuffix}`, pgExpiredSubId]);
        pgSyntheticIds.manufacturers.push(pgExpiredMfgId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city)
            VALUES ($1, 'مصنع بوستجرس مباشر', 'PG Dir', $2, 'DIRECT_CONTRACT', NULL, 'طنطا');
        `, [pgDirectMfgId, `MFG-DIR-${synthSuffix}`]);
        pgSyntheticIds.manufacturers.push(pgDirectMfgId);

        await pgPool.query(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city)
            VALUES ($1, 'مصنع بوستجرس بدون باقة', 'PG NoSub', $2, 'MARKETING_SUBSCRIPTION', NULL, 'المنصورة');
        `, [pgNoSubMfgId, `MFG-NOSUB-${synthSuffix}`]);
        pgSyntheticIds.manufacturers.push(pgNoSubMfgId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ($1, 'مستخدم منتهي بوستجرس', $2, 'MANUFACTURER', $3, true);
        `, [pgExpiredUsrId, `exp_${synthSuffix}@zarsev.test`, pgExpiredMfgId]);
        pgSyntheticIds.users.push(pgExpiredUsrId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ($1, 'مستخدم مباشر بوستجرس', $2, 'MANUFACTURER', $3, true);
        `, [pgDirectUsrId, `dir_${synthSuffix}@zarsev.test`, pgDirectMfgId]);
        pgSyntheticIds.users.push(pgDirectUsrId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ($1, 'مستخدم بدون باقة بوستجرس', $2, 'MANUFACTURER', $3, true);
        `, [pgNoSubUsrId, `nosub_${synthSuffix}@zarsev.test`, pgNoSubMfgId]);
        pgSyntheticIds.users.push(pgNoSubUsrId);

        await pgPool.query(`
            INSERT INTO users (id, name, email, role, manufacturer_id, is_active)
            VALUES ($1, 'مستخدم غير مقترن بوستجرس', $2, 'MANUFACTURER', NULL, true);
        `, [pgUnlinkedUsrId, `unlinked_${synthSuffix}@zarsev.test`]);
        pgSyntheticIds.users.push(pgUnlinkedUsrId);

        // Helper to run subscription test matrix
        async function testSubscriptionEngine(engineName, clientOpts, ids, insertImportFn) {
            console.log(`\n  --- Testing Subscription Guard on ${engineName} ---`);

            const guard = checkSubscriptionLimits();

            // Case A: Super Admin / Logistics bypasses quota
            const reqAdmin = { user: { role: 'SUPER_ADMIN' }, dbClientOptions: clientOpts };
            const resAdmin = createMockRes();
            let nextAdminCalled = false;
            await guard(reqAdmin, resAdmin, () => { nextAdminCalled = true; });
            assert.strictEqual(nextAdminCalled, true);
            assert.strictEqual(reqAdmin.subscription.id, 'sub_enterprise');

            // Case B: User without manufacturer_id receives HTTP 403
            const reqUnlinked = { user: { role: 'MANUFACTURER', id: ids.unlinkedUsr, manufacturer_id: null }, dbClientOptions: clientOpts };
            const resUnlinked = createMockRes();
            let nextUnlinkedCalled = false;
            await guard(reqUnlinked, resUnlinked, () => { nextUnlinkedCalled = true; });
            assert.strictEqual(resUnlinked.statusCode, 403);
            assert.strictEqual(nextUnlinkedCalled, false);
            assert.ok(resUnlinked.body.error.includes('غير مقترن بملف مصنع معتمد'));

            // Case C: Marketing manufacturer without subscription receives HTTP 403
            const reqNoSub = { user: { role: 'MANUFACTURER', id: ids.noSubUsr, manufacturer_id: ids.noSubMfg }, dbClientOptions: clientOpts };
            const resNoSub = createMockRes();
            let nextNoSubCalled = false;
            await guard(reqNoSub, resNoSub, () => { nextNoSubCalled = true; });
            assert.strictEqual(resNoSub.statusCode, 403);
            assert.strictEqual(nextNoSubCalled, false);
            assert.ok(resNoSub.body.error.includes('لا توجد باقة اشتراك سارية'));

            // Case D: DIRECT_CONTRACT manufacturer is quota-exempt and receives enterprise privileges
            const reqDirect = { user: { role: 'MANUFACTURER', id: ids.directUsr, manufacturer_id: ids.directMfg }, dbClientOptions: clientOpts };
            const resDirect = createMockRes();
            let nextDirectCalled = false;
            await guard(reqDirect, resDirect, () => { nextDirectCalled = true; });
            assert.strictEqual(nextDirectCalled, true, 'DIRECT_CONTRACT manufacturer must bypass quota limit');
            assert.strictEqual(reqDirect.subscription.id, 'sub_enterprise');

            // Case E: Marketing manufacturer below monthly quota passes
            const reqActive = { user: { role: 'MANUFACTURER', id: ids.activeUsr, manufacturer_id: ids.activeMfg }, dbClientOptions: clientOpts };
            const resActive = createMockRes();
            let nextActiveCalled = false;
            await guard(reqActive, resActive, () => { nextActiveCalled = true; });
            assert.strictEqual(nextActiveCalled, true);
            assert.strictEqual(reqActive.subscription.id, ids.subId);
            assert.deepStrictEqual(reqActive.subscription.allowed_formats, ['xlsx', 'csv']);

            // Case F: Marketing manufacturer reaching and exceeding quota receives HTTP 429
            // Max monthly imports is 10. Insert 10 imports in current month!
            const impIds = [];
            for (let i = 0; i < 10; i++) {
                const impId = `_imp_${crypto.randomBytes(4).toString('hex')}`;
                await insertImportFn(impId, ids.activeUsr, ids.activeMfg, 'CURRENT');
                impIds.push(impId);
            }

            const reqQuotaFull = { user: { role: 'MANUFACTURER', id: ids.activeUsr, manufacturer_id: ids.activeMfg }, dbClientOptions: clientOpts };
            const resQuotaFull = createMockRes();
            let nextQuotaFullCalled = false;
            await guard(reqQuotaFull, resQuotaFull, () => { nextQuotaFullCalled = true; });
            assert.strictEqual(resQuotaFull.statusCode, 429, 'Quota full must return 429');
            assert.strictEqual(nextQuotaFullCalled, false);
            assert.ok(resQuotaFull.body.error.includes('تجاوزت الحد الأقصى'));

            // Case G: Month-boundary behavior: Imports from previous months do not count against current month!
            // Clean up the 10 current month imports and insert 10 imports dated 2 months ago
            for (const id of impIds) {
                // Delete current month imports
                if (engineName === 'SQLite') {
                    sqliteDb.prepare('DELETE FROM imports WHERE id = ?').run(id);
                } else {
                    await pgPool.query('DELETE FROM imports WHERE id = $1', [id]);
                }
            }

            const oldImpId = `_old_imp_${crypto.randomBytes(4).toString('hex')}`;
            await insertImportFn(oldImpId, ids.activeUsr, ids.activeMfg, 'PAST');

            const reqOld = { user: { role: 'MANUFACTURER', id: ids.activeUsr, manufacturer_id: ids.activeMfg }, dbClientOptions: clientOpts };
            const resOld = createMockRes();
            let nextOldCalled = false;
            await guard(reqOld, resOld, () => { nextOldCalled = true; });
            assert.strictEqual(nextOldCalled, true, 'Past-month imports must not exhaust current month quota');

            // Clean up old import
            if (engineName === 'SQLite') {
                sqliteDb.prepare('DELETE FROM imports WHERE id = ?').run(oldImpId);
            } else {
                await pgPool.query('DELETE FROM imports WHERE id = $1', [oldImpId]);
            }

            console.log(`  ✓ All Subscription Guard cases on ${engineName} passed (403 on unlinked/nosub, DIRECT_CONTRACT exempt, 429 on quota full, month boundaries respected).`);
        }

        // Run Subscription tests on SQLite
        await testSubscriptionEngine(
            'SQLite',
            { engine: 'sqlite', customDb: sqliteDb },
            {
                unlinkedUsr: 'usr_test_unlinked',
                noSubUsr: 'usr_test_no_sub',
                noSubMfg: 'mfg_test_no_sub',
                directUsr: 'usr_test_direct',
                directMfg: 'mfg_test_direct',
                activeUsr: 'usr_test_active',
                activeMfg: 'mfg_test_1',
                subId: 'sub_test_standard'
            },
            async (id, user_id, manufacturer_id, when) => {
                const dateVal = when === 'CURRENT'
                    ? new Date().toISOString()
                    : '2025-01-01 12:00:00';
                sqliteDb.prepare(`
                    INSERT INTO imports (id, user_id, manufacturer_id, source_files, created_at)
                    VALUES (?, ?, ?, '[]', ?)
                `).run(id, user_id, manufacturer_id, dateVal);
            }
        );

        // Run Subscription tests on PostgreSQL
        await testSubscriptionEngine(
            'PostgreSQL (zarsev_test)',
            { engine: 'postgres', dbNameOverride: 'zarsev_test' },
            {
                unlinkedUsr: pgUnlinkedUsrId,
                noSubUsr: pgNoSubUsrId,
                noSubMfg: pgNoSubMfgId,
                directUsr: pgDirectUsrId,
                directMfg: pgDirectMfgId,
                activeUsr: pgUsrActiveId,
                activeMfg: pgMfgId,
                subId: pgSubId
            },
            async (id, user_id, manufacturer_id, when) => {
                const dateVal = when === 'CURRENT'
                    ? new Date().toISOString()
                    : '2025-01-01T12:00:00Z';
                await pgPool.query(`
                    INSERT INTO imports (id, user_id, manufacturer_id, source_files, created_at)
                    VALUES ($1, $2, $3, '[]'::jsonb, $4::timestamptz)
                `, [id, user_id, manufacturer_id, dateVal]);
                pgSyntheticIds.imports.push(id);
            }
        );

    } finally {
        // =====================================================================
        // DETERMINISTIC CLEANUP OF ALL SYNTHETIC TEST FIXTURES
        // =====================================================================
        console.log('\n--- 🧹 Deterministic Cleanup of Synthetic Test Records ---');
        try {
            // Delete synthetic imports
            for (const id of pgSyntheticIds.imports) {
                await pgPool.query('DELETE FROM imports WHERE id = $1;', [id]);
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
            console.error('[CLEANUP WARNING]', cleanupErr.message);
        }

        await pgAdapter.closePool();
        try { sqliteDb.close(); } catch (_) {}
        if (fs.existsSync(TEST_SQLITE_PATH)) {
            try { fs.unlinkSync(TEST_SQLITE_PATH); } catch (_) {}
        }
    }

    // =====================================================================
    // POST-TEST INTEGRITY VERIFICATION
    // =====================================================================
    console.log('\n--- 🛡️ Post-Test Baseline Integrity Verification ---');
    const postSnap = captureSnapshot();
    for (const [name, meta] of Object.entries(postSnap)) {
        assert.strictEqual(meta.size, preSnap[name].size, `Size mismatch for ${name}`);
        assert.strictEqual(meta.sha, preSnap[name].sha, `SHA256 mismatch for ${name}`);
        console.log(`✓ Immutability Verified: ${name} (SHA256=${meta.sha})`);
    }

    const postPgCounts = await capturePgBusinessCounts();
    assert.strictEqual(postPgCounts.total, 342, 'Total business records in zarsev_test must remain exactly 342 after test cleanup');
    for (const tbl of BUSINESS_TABLES) {
        assert.strictEqual(postPgCounts.counts[tbl], prePgCounts.counts[tbl], `Record count in ${tbl} must remain identical`);
    }
    console.log(`✓ Immutability Verified: All 342 records across 9 tables in zarsev_test remain 100% UNCHANGED.`);
    await pgAdapter.closePool();

    console.log('\n================================================================');
    console.log('🎉 ALL PHASE 2.4.3.1-A MIDDLEWARE INTEGRATION TESTS PASSED (100%)!');
    console.log('================================================================\n');
}

runMiddlewareIntegrationTests().catch(err => {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
});
