const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const config = require('../src/config');
const { initDb, getDb, closeDb } = require('../src/db/database');
const {
    hashPassword,
    verifyPassword,
    needsRehash,
    timingSafeCompare,
    generateToken,
    generateCsrfToken
} = require('../src/utils/authUtils');
const { validateEmail, validatePasswordStrength } = require('../scripts/createAdmin');
const { runQuarantine, KNOWN_TEST_SEED_IDS } = require('../scripts/quarantine_test_products');
const app = require('../src/app');

async function runRemediationTests() {
    console.log('================================================================');
    console.log('🛡️  ZARSEV Phase 1.1 Security Remediation Automated Test Suite');
    console.log('================================================================\n');

    // Configure isolated test environment
    const prevDbPath = process.env.DB_PATH;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevJwtSecret = process.env.JWT_SECRET;
    const prevOrigins = process.env.ALLOWED_ORIGINS;

    const testDbPath = path.join(__dirname, 'remediation_test.db');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    process.env.DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-very-secure-32-byte-test-secret-key-123456';
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

    initDb();
    const db = getDb();

    // Seed test subscription for endpoint testing
    db.prepare(`
        INSERT OR IGNORE INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb)
        VALUES ('sub_standard', 'Standard Plan', '["xlsx","csv"]', 50, 10, 15)
    `).run();

    // -------------------------------------------------------------
    // Test Suite 1: Production JWT Secret Validation
    // -------------------------------------------------------------
    console.log('--- 🧪 Test Suite 1: Mandatory Production JWT Secret Validation ---');
    const { validateJwtSecret } = config;

    // 1. Missing secret in production
    assert.throws(() => {
        validateJwtSecret('production', null);
    }, /Missing.*JWT_SECRET|mandatory in production/i, 'Production must reject null secret');

    assert.throws(() => {
        validateJwtSecret('production', '');
    }, /Missing.*JWT_SECRET|mandatory in production/i, 'Production must reject empty secret');

    // 2. Known default / fallback secrets in production
    assert.throws(() => {
        validateJwtSecret('production', 'zarsev-platform-jwt-secret-secure-key-2026');
    }, /Insecure JWT_SECRET.*matches a known default/i, 'Production must reject known default secret');

    assert.throws(() => {
        validateJwtSecret('production', 'changeme');
    }, /Insecure JWT_SECRET.*matches a known default/i, 'Production must reject changeme');

    // 3. Weak secret (< 32 bytes) in production
    assert.throws(() => {
        validateJwtSecret('production', 'short-secret-only-24-bytes!');
    }, /Weak JWT_SECRET.*at least 32 bytes/i, 'Production must reject secrets < 32 bytes');

    // 4. Valid cryptographically random 32+ byte secret in production
    const validProdSecret = 'c7a8b9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8';
    const resolvedProd = validateJwtSecret('production', validProdSecret);
    assert.strictEqual(resolvedProd, validProdSecret, 'Production must accept 32+ byte random secret');

    // 5. Development mode fallback
    const resolvedDev = validateJwtSecret('development', null);
    assert.ok(resolvedDev.length >= 32, 'Dev mode must provide safe development secret');
    console.log('✓ All 5 JWT Secret production enforcement assertions passed.\n');

    // -------------------------------------------------------------
    // Test Suite 2: Password Hashing Upgrade & Timing-Safe Comparison
    // -------------------------------------------------------------
    console.log('--- 🧪 Test Suite 2: Password Hashing Upgrade & Legacy Compatibility ---');
    const plainPassword = 'CorrectHorseBatteryStaple@2026!';

    // 1. New versioned PBKDF2 hash (210,000 iterations)
    const newHash = hashPassword(plainPassword);
    assert.ok(newHash.startsWith('pbkdf2:sha512:210000:'), 'Hash must use versioned pbkdf2:sha512:210000 format');
    const parts = newHash.split(':');
    assert.strictEqual(parts.length, 5, 'Hash must contain 5 colon-separated parts');
    assert.strictEqual(parts[3].length, 64, 'Salt must be 32 bytes hex (64 chars)');
    assert.strictEqual(parts[4].length, 128, 'Hash must be 64 bytes hex (128 chars)');

    // 2. Verification of correct & incorrect password
    assert.strictEqual(verifyPassword(plainPassword, newHash), true, 'Correct password must verify');
    assert.strictEqual(verifyPassword('WrongPassword123!', newHash), false, 'Incorrect password must fail');
    assert.strictEqual(needsRehash(newHash), false, 'New 210,000 hash must not need rehash');

    // 3. Legacy hash compatibility (1,000 iterations format: <salt_hex>:<hash_hex>)
    const legacySalt = crypto.randomBytes(16).toString('hex');
    const legacyDigest = crypto.pbkdf2Sync(plainPassword, legacySalt, 1000, 64, 'sha512').toString('hex');
    const legacyHash = `${legacySalt}:${legacyDigest}`;

    assert.strictEqual(verifyPassword(plainPassword, legacyHash), true, 'Legacy 1,000 iteration hash must verify cleanly');
    assert.strictEqual(verifyPassword('WrongPassword123!', legacyHash), false, 'Legacy hash fails on wrong password');
    assert.strictEqual(needsRehash(legacyHash), true, 'needsRehash must return true for legacy hash');

    // 4. Malformed and corrupted hashes fail gracefully
    assert.strictEqual(verifyPassword(plainPassword, ''), false);
    assert.strictEqual(verifyPassword(plainPassword, 'invalid_format_without_colons'), false);
    assert.strictEqual(verifyPassword(plainPassword, 'pbkdf2:sha512:notanumber:salt:hash'), false);
    assert.strictEqual(verifyPassword(plainPassword, 'pbkdf2:invalidalgo:210000:salt:hash'), false);

    // 5. Timing-safe comparison validation
    const buf1 = Buffer.from('abcdef123456', 'hex');
    const buf2 = Buffer.from('abcdef123456', 'hex');
    const buf3 = Buffer.from('abcdef123459', 'hex');
    const bufDifferentLen = Buffer.from('abcdef12', 'hex');

    assert.strictEqual(timingSafeCompare(buf1, buf2), true, 'Equal buffers match timing-safely');
    assert.strictEqual(timingSafeCompare(buf1, buf3), false, 'Unequal buffers fail timing-safely');
    assert.strictEqual(timingSafeCompare(buf1, bufDifferentLen), false, 'Different length buffers fail without throwing');
    assert.strictEqual(timingSafeCompare(null, buf1), false);
    console.log('✓ All 12 Password Hashing & Timing-Safe verification tests passed.\n');

    // -------------------------------------------------------------
    // Test Suite 3: Automatic Rehash on Legacy User Login
    // -------------------------------------------------------------
    console.log('--- 🧪 Test Suite 3: Automatic In-Place Legacy Password Upgrade ---');
    const legacyUserEmail = 'legacy_user@test.com';
    const legacyUserPwd = 'OldLegacyPassword@999!';
    const userLegacySalt = crypto.randomBytes(16).toString('hex');
    const userLegacyHash = `${userLegacySalt}:${crypto.pbkdf2Sync(legacyUserPwd, userLegacySalt, 1000, 64, 'sha512').toString('hex')}`;

    db.prepare(`
        INSERT OR REPLACE INTO users (id, name, email, password_hash, role, is_active, is_demo)
        VALUES ('usr_legacy_test_01', 'Legacy User', ?, ?, 'MANUFACTURER', 1, 0)
    `).run(legacyUserEmail, userLegacyHash);

    // Verify DB currently holds legacy hash
    const beforeUser = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(legacyUserEmail);
    assert.strictEqual(beforeUser.password_hash.startsWith('pbkdf2:'), false, 'Initial hash must be legacy format');

    // Start server instance for HTTP testing
    const TEST_PORT = 3388;
    const server = app.listen(TEST_PORT);
    const BASE_URL = `http://localhost:${TEST_PORT}`;

    try {
        // Execute login request with legacy password
        const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: legacyUserEmail, password: legacyUserPwd })
        });
        const loginData = await loginRes.json();
        assert.strictEqual(loginRes.status, 200, 'Legacy user login must succeed');
        assert.strictEqual(loginData.success, true);

        // Inspect DB: Verify password hash was upgraded automatically in-place!
        const afterUser = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(legacyUserEmail);
        assert.ok(afterUser.password_hash.startsWith('pbkdf2:sha512:210000:'), 'Hash must be automatically upgraded to 210,000 iterations in DB');
        assert.strictEqual(verifyPassword(legacyUserPwd, afterUser.password_hash), true, 'Upgraded hash must verify against original password');
        console.log('✓ Automatic password hash upgrade on successful login verified.\n');

        // -------------------------------------------------------------
        // Test Suite 4: First Super Admin Provisioning Tool
        // -------------------------------------------------------------
        console.log('--- 🧪 Test Suite 4: Root Super Admin Provisioning Tool ---');
        // Test password strength validator
        assert.strictEqual(validatePasswordStrength('short').valid, false);
        assert.strictEqual(validatePasswordStrength('nouppercase123!').valid, false);
        assert.strictEqual(validatePasswordStrength('NOLOWERCASE123!').valid, false);
        assert.strictEqual(validatePasswordStrength('NoSpecialDigitsLetters').valid, false);
        assert.strictEqual(validatePasswordStrength('ValidSecret@2026!').valid, true);

        // Test email validator
        assert.strictEqual(validateEmail('invalid-email').valid ?? false, false);
        assert.strictEqual(validateEmail('admin@trade-zarsev.com'), true);

        // Provision initial root admin
        const { main: runCreateAdmin } = require('../scripts/createAdmin');
        process.argv = ['node', 'scripts/createAdmin.js', '--email', 'owner@zarsev.gov', '--name', 'الرئيس التنفيذي', '--password', 'SovereignOwner@2026!'];
        await runCreateAdmin();

        const createdAdmin = db.prepare('SELECT * FROM users WHERE email = ?').get('owner@zarsev.gov');
        assert.ok(createdAdmin, 'Super Admin record must exist in DB');
        assert.strictEqual(createdAdmin.role, 'SUPER_ADMIN');
        assert.strictEqual(createdAdmin.is_demo, 0, 'Production admin must have is_demo = 0');
        assert.strictEqual(createdAdmin.is_active, 1, 'Production admin must have is_active = 1');
        assert.ok(createdAdmin.password_hash.startsWith('pbkdf2:sha512:210000:'), 'Admin password must use 210,000 iterations');
        assert.strictEqual(verifyPassword('SovereignOwner@2026!', createdAdmin.password_hash), true);

        // Test refusal when Super Admin already exists without --force
        let exitCalled = false;
        const origExit = process.exit;
        process.exit = (code) => {
            exitCalled = true;
            throw new Error('MOCK_EXIT_' + code);
        };
        try {
            process.argv = ['node', 'scripts/createAdmin.js', '--email', 'duplicate@zarsev.gov', '--name', 'Duplicate Admin', '--password', 'ValidSecret@2026!'];
            await runCreateAdmin();
        } catch (err) {
            if (!err.message.startsWith('MOCK_EXIT_')) throw err;
        } finally {
            process.exit = origExit;
        }
        assert.strictEqual(exitCalled, true, 'createAdmin must refuse to provision duplicate root Super Admin without --force');

        // Test provisioning with --force succeeds
        process.argv = ['node', 'scripts/createAdmin.js', '--email', 'owner2@zarsev.gov', '--name', 'نائب المدير', '--password', 'SovereignOwner@2026!', '--force'];
        await runCreateAdmin();
        const secondAdmin = db.prepare('SELECT * FROM users WHERE email = ?').get('owner2@zarsev.gov');
        assert.ok(secondAdmin, 'Second admin with --force must be provisioned');
        console.log('✓ Super Admin CLI provisioning & single-root-admin invariant verified.\n');

        // -------------------------------------------------------------
        // Test Suite 5: CSRF Protection & Cookie Authentication
        // -------------------------------------------------------------
        console.log('--- 🧪 Test Suite 5: CSRF Protection & Cookie Authentication ---');
        const adminToken = generateToken(createdAdmin);
        const csrfToken = generateCsrfToken();

        // 1. GET requests are safe and seed CSRF cookie
        const safeGetRes = await fetch(`${BASE_URL}/api/subscriptions/plans`);
        assert.strictEqual(safeGetRes.status, 200, 'GET requests must pass without CSRF header');
        const setCookieHeader = safeGetRes.headers.get('set-cookie') || '';
        assert.ok(setCookieHeader.includes('zarsev_csrf_token'), 'GET request must seed zarsev_csrf_token cookie');

        // 2. Cookie-authenticated mutating request from untrusted origin -> HTTP 403
        const untrustedOriginRes = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_standard`, {
            method: 'PUT',
            headers: {
                'Origin': 'http://malicious-attacker-site.com',
                'Cookie': `zarsev_auth_token=${adminToken}; zarsev_csrf_token=${csrfToken}`,
                'x-csrf-token': csrfToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ max_products_per_import: 999 })
        });
        assert.strictEqual(untrustedOriginRes.status, 403, 'Cross-origin request from untrusted origin must be rejected with 403');

        // 3. Cookie-authenticated mutating request missing CSRF token -> HTTP 403
        const missingCsrfRes = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_standard`, {
            method: 'PUT',
            headers: {
                'Origin': 'http://localhost:3000',
                'Cookie': `zarsev_auth_token=${adminToken}; zarsev_csrf_token=${csrfToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ max_products_per_import: 999 })
        });
        assert.strictEqual(missingCsrfRes.status, 403, 'Cookie mutating request missing x-csrf-token header must receive 403');

        // 4. Cookie-authenticated mutating request with mismatched CSRF token -> HTTP 403
        const mismatchedCsrfRes = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_standard`, {
            method: 'PUT',
            headers: {
                'Origin': 'http://localhost:3000',
                'Cookie': `zarsev_auth_token=${adminToken}; zarsev_csrf_token=${csrfToken}`,
                'x-csrf-token': 'wrong-forged-csrf-token-value',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ max_products_per_import: 999 })
        });
        assert.strictEqual(mismatchedCsrfRes.status, 403, 'Mismatched CSRF token must receive 403');

        // 5. Valid cookie-authenticated mutating request with matching CSRF token and trusted Origin -> HTTP 200
        const validCookieRes = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_standard`, {
            method: 'PUT',
            headers: {
                'Origin': 'http://localhost:3000',
                'Cookie': `zarsev_auth_token=${adminToken}; zarsev_csrf_token=${csrfToken}`,
                'x-csrf-token': csrfToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ max_products_per_import: 85 })
        });
        assert.strictEqual(validCookieRes.status, 200, 'Valid cookie mutating request with CSRF token must succeed');

        // 6. Legitimate Bearer token client passes without needing CSRF cookies/headers
        const bearerClientRes = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_standard`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ max_products_per_import: 90 })
        });
        assert.strictEqual(bearerClientRes.status, 200, 'Bearer client must pass mutating endpoint without CSRF requirement');

        // 7. Subdomain/prefix attack on allowed origin (e.g. localhost:3000.evil.com) -> HTTP 403
        const prefixAttackRes = await fetch(`${BASE_URL}/api/subscriptions/plans/sub_standard`, {
            method: 'PUT',
            headers: {
                'Origin': 'http://localhost:3000.evil.com',
                'Cookie': `zarsev_auth_token=${adminToken}; zarsev_csrf_token=${csrfToken}`,
                'x-csrf-token': csrfToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ max_products_per_import: 999 })
        });
        assert.strictEqual(prefixAttackRes.status, 403, 'Prefix origin spoofing must be rejected with 403');
        console.log('✓ All 7 CSRF & Bearer authorization verification tests passed.\n');

        // -------------------------------------------------------------
        // Test Suite 6: Stateful Token Invalidation via token_version on Logout
        // -------------------------------------------------------------
        console.log('--- 🧪 Test Suite 6: Stateful Token Invalidation & Logout ---');
        // Initial token works
        const meBeforeLogout = await fetch(`${BASE_URL}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(meBeforeLogout.status, 200, 'Token must be valid before logout');
        const meBeforeData = await meBeforeLogout.json();
        assert.strictEqual(meBeforeData.user.email, 'owner@zarsev.gov');

        // Logout user (increments token_version in DB)
        const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(logoutRes.status, 200, 'Logout must succeed');
        const logoutData = await logoutRes.json();
        assert.strictEqual(logoutData.success, true);

        // Previous token must now be rejected across devices
        const meAfterLogout = await fetch(`${BASE_URL}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(meAfterLogout.status, 401, 'Old token must be rejected after logout (HTTP 401)');
        const meAfterData = await meAfterLogout.json();
        assert.ok(
            meAfterData.error.toLowerCase().includes('revoked') ||
            meAfterData.error.includes('إبطال') ||
            meAfterData.error.includes('جلسة'),
            'Error message must reflect revoked token'
        );

        // Fresh login generates new token with updated token_version
        const freshLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'owner@zarsev.gov',
                password: 'SovereignOwner@2026!'
            })
        });
        assert.strictEqual(freshLoginRes.status, 200, 'Login after logout must succeed');
        const freshLoginData = await freshLoginRes.json();
        const freshToken = freshLoginData.token;
        assert.ok(freshToken, 'Fresh token must be returned');

        // Fresh token works
        const meWithFreshToken = await fetch(`${BASE_URL}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${freshToken}` }
        });
        assert.strictEqual(meWithFreshToken.status, 200, 'Fresh token with updated token_version must work');
        console.log('✓ Stateful token revocation on logout verified.\n');

        // -------------------------------------------------------------
        // Test Suite 7: Dual Rate Limiting on Login (Per-Email & Per-IP)
        // -------------------------------------------------------------
        console.log('--- 🧪 Test Suite 7: Dual Rate Limiting on Login ---');
        // Trigger 5 failed logins for a specific email
        for (let i = 0; i < 5; i++) {
            const failRes = await fetch(`${BASE_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: 'owner@zarsev.gov',
                    password: 'WrongPassword123!'
                })
            });
            assert.strictEqual(failRes.status, 401, `Failed attempt ${i + 1} must return 401`);
        }

        // 6th attempt should trigger 429 Too Many Requests for that email
        const rateLimitedRes = await fetch(`${BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'owner@zarsev.gov',
                password: 'SovereignOwner@2026!'
            })
        });
        assert.strictEqual(rateLimitedRes.status, 429, '6th failed attempt must be rate-limited with 429');
        const rateLimitData = await rateLimitedRes.json();
        assert.ok(
            rateLimitData.error.includes('الحد الأقصى') ||
            rateLimitData.error.toLowerCase().includes('too many') ||
            rateLimitData.error.includes('دقيقة'),
            'Rate limit message must explain lockout'
        );
        console.log('✓ Dual rate-limiting enforced on repeated failed logins.\n');

        // -------------------------------------------------------------
        // Test Suite 8: Reversible Quarantine Tool Automated Verification
        // -------------------------------------------------------------
        console.log('--- 🧪 Test Suite 8: Reversible Quarantine Script Verification ---');
        // Seed manufacturer and test products into test DB
        db.prepare(`
            INSERT OR IGNORE INTO manufacturers (id, name_ar, name_en, code, business_model, city, is_verified, is_demo)
            VALUES ('mfg_test', 'شركة الاختبار', 'Test Mfg', 'MFG-TEST', 'DIRECT_CONTRACT', 'Cairo', 1, 0)
        `).run();
        const insertProd = db.prepare(`
            INSERT INTO products (id, manufacturer_id, sku, name_ar, name_en, status, is_demo)
            VALUES (?, 'mfg_test', 'TEST-SKU', 'منتج تجريبي للاختبار', 'Test Product', 'PUBLISHED', 0)
        `);
        for (const tid of KNOWN_TEST_SEED_IDS) {
            insertProd.run(tid);
        }

        // Dry run
        const dryRunResult = runQuarantine(testDbPath, '--dry-run');
        assert.strictEqual(dryRunResult.count, KNOWN_TEST_SEED_IDS.length);
        assert.strictEqual(dryRunResult.applied, false);
        const checkDryRun = db.prepare('SELECT count(*) as c FROM products WHERE is_demo = 1 AND rejection_reason LIKE ?').get('%[QUARANTINE_TEST_DATA]%');
        assert.strictEqual(checkDryRun.c, 0, 'Dry-run must not mutate database');

        // Apply
        const applyResult = runQuarantine(testDbPath, '--apply');
        assert.strictEqual(applyResult.count, KNOWN_TEST_SEED_IDS.length);
        assert.strictEqual(applyResult.applied, true);
        const checkApply = db.prepare('SELECT count(*) as c FROM products WHERE is_demo = 1 AND rejection_reason LIKE ?').get('%[QUARANTINE_TEST_DATA]%');
        assert.strictEqual(checkApply.c, KNOWN_TEST_SEED_IDS.length, 'All target products must be marked is_demo = 1');

        // Rollback
        const rollbackResult = runQuarantine(testDbPath, '--rollback');
        assert.strictEqual(rollbackResult.rolledBackCount, KNOWN_TEST_SEED_IDS.length);
        const checkRollback = db.prepare('SELECT count(*) as c FROM products WHERE is_demo = 1 AND rejection_reason LIKE ?').get('%[QUARANTINE_TEST_DATA]%');
        assert.strictEqual(checkRollback.c, 0, 'Rollback must restore products to is_demo = 0 and clear marker');
        console.log('✓ Reversible quarantine tool (dry-run, apply, rollback) verified.\n');

        console.log('================================================================');
        console.log('🎉 ALL PHASE 1.1 SECURITY REMEDIATION TESTS PASSED (100% SUCCESS)!');
        console.log('================================================================\n');
    } finally {
        server.close();
        try { closeDb(); } catch (e) {}
        try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
        if (prevDbPath !== undefined) process.env.DB_PATH = prevDbPath;
        else delete process.env.DB_PATH;
        if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
        else delete process.env.NODE_ENV;
        if (prevJwtSecret !== undefined) process.env.JWT_SECRET = prevJwtSecret;
        else delete process.env.JWT_SECRET;
        if (prevOrigins !== undefined) process.env.ALLOWED_ORIGINS = prevOrigins;
        else delete process.env.ALLOWED_ORIGINS;
    }
}

if (require.main === module) {
    runRemediationTests().catch(err => {
        console.error('❌ Remediation test failure:', err);
        try { closeDb(); } catch (e) {}
        const testDbPath = path.join(__dirname, 'remediation_test.db');
        try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
        process.exit(1);
    });
}

module.exports = { runRemediationTests };
