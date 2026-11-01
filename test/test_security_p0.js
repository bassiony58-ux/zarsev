const assert = require('assert');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { initDb, getDb } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { generateToken } = require('../src/utils/authUtils');
const config = require('../src/config');
const app = require('../src/app');

async function runSecurityP0Tests() {
    console.log('================================================================');
    console.log('🔒 ZARSEV P0 Security Lockdown & Demo Data Isolation Test Suite');
    console.log('================================================================\n');

    initDb();
    const db = getDb();

    // Start dedicated test server
    const TEST_PORT = 3355;
    const server = app.listen(TEST_PORT);
    const BASE_URL = `http://localhost:${TEST_PORT}`;

    try {
        // Setup tokens for testing
        const adminToken = generateToken({ id: 'usr_super_admin', email: 'admin@zarsev.com' });
        const logisticsToken = generateToken({ id: 'usr_logistics_officer', email: 'logistics@zarsev.com' });
        const mfgNileToken = generateToken({ id: 'usr_mfg_nile_fruits', email: 'nile_export@company.com' });
        const mfgDeltaToken = generateToken({ id: 'usr_mfg_delta_iqf', email: 'delta_sales@company.com' });

        // Setup test imports in DB
        const testImportNileId = 'imp_sec_nile_' + crypto.randomBytes(3).toString('hex');
        db.prepare(`
            INSERT INTO imports (id, user_id, manufacturer_id, source_files, status, progress_percent, is_demo)
            VALUES (?, 'usr_mfg_nile_fruits', 'mfg_nile_fruits', '[]', 'REVIEW_READY', 100, 0)
        `).run(testImportNileId);

        const testItemNileId = 'item_sec_nile_' + crypto.randomBytes(3).toString('hex');
        db.prepare(`
            INSERT INTO import_items (id, import_id, suggested_manufacturer_id, extracted_data, status)
            VALUES (?, ?, 'mfg_nile_fruits', '{"name_ar":"منتج نيل سري"}', 'AWAITING_REVIEW')
        `).run(testItemNileId, testImportNileId);

        const testImportDirectId = 'imp_sec_direct_' + crypto.randomBytes(3).toString('hex');
        db.prepare(`
            INSERT INTO imports (id, user_id, manufacturer_id, source_files, status, progress_percent, is_demo)
            VALUES (?, 'usr_logistics_officer', 'mfg_bustan_citrus', '[]', 'REVIEW_READY', 100, 0)
        `).run(testImportDirectId);

        const testItemDirectId = 'item_sec_direct_' + crypto.randomBytes(3).toString('hex');
        db.prepare(`
            INSERT INTO import_items (id, import_id, suggested_manufacturer_id, extracted_data, status)
            VALUES (?, ?, 'mfg_bustan_citrus', '{"name_ar":"برتقال عقد مباشر"}', 'AWAITING_REVIEW')
        `).run(testItemDirectId, testImportDirectId);

        // -------------------------------------------------------------
        // Check 1: Rejection of unauthenticated requests (HTTP 401)
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 1: Rejection of Unauthenticated Requests ---');
        const unauthRes1 = await fetch(`${BASE_URL}/api/auth/me`);
        assert.strictEqual(unauthRes1.status, 401, 'Unauthenticated /api/auth/me must return 401');

        const unauthRes2 = await fetch(`${BASE_URL}/api/imports/history`);
        assert.strictEqual(unauthRes2.status, 401, 'Unauthenticated /api/imports/history must return 401');

        const unauthRes3 = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/items`);
        assert.strictEqual(unauthRes3.status, 401, 'Unauthenticated import items lookup must return 401');
        console.log('✓ Check 1 Passed: Unauthenticated requests rejected with HTTP 401\n');

        // -------------------------------------------------------------
        // Check 2: Rejection of forged tokens (HTTP 401)
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 2: Rejection of Forged and Malformed Tokens ---');
        const forgedToken = jwt.sign({ id: 'usr_super_admin' }, 'malicious-forged-secret-key-999');
        const forgedRes = await fetch(`${BASE_URL}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${forgedToken}` }
        });
        assert.strictEqual(forgedRes.status, 401, 'Forged JWT signature must receive 401');

        const malformedRes = await fetch(`${BASE_URL}/api/auth/me`, {
            headers: { 'Authorization': 'Bearer totally.not.valid' }
        });
        assert.strictEqual(malformedRes.status, 401, 'Malformed JWT must receive 401');
        console.log('✓ Check 2 Passed: Forged & malformed tokens rejected with HTTP 401\n');

        // -------------------------------------------------------------
        // Check 3: Rejection of x-user-id impersonation
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 3: Rejection of x-user-id Header Impersonation ---');
        const xUserIdRes = await fetch(`${BASE_URL}/api/imports/history`, {
            headers: { 'x-user-id': 'usr_super_admin' }
        });
        assert.strictEqual(xUserIdRes.status, 401, 'Requests relying on x-user-id must be rejected with 401');

        const xUserIdMeRes = await fetch(`${BASE_URL}/api/auth/me`, {
            headers: { 'x-user-id': 'usr_super_admin' }
        });
        assert.strictEqual(xUserIdMeRes.status, 401, 'x-user-id impersonation rejected on /api/auth/me');
        console.log('✓ Check 3 Passed: x-user-id impersonation strictly eliminated\n');

        // -------------------------------------------------------------
        // Check 4: Rejection of query-param and body user_id impersonation
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 4: Rejection of Query & Body user_id Impersonation ---');
        const queryImpersonateRes = await fetch(`${BASE_URL}/api/imports/history?user_id=usr_super_admin`);
        assert.strictEqual(queryImpersonateRes.status, 401, 'query user_id impersonation rejected with 401');

        const bodyImpersonateRes = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/items/${testItemNileId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'usr_super_admin', status: 'READY' })
        });
        assert.strictEqual(bodyImpersonateRes.status, 401, 'body user_id impersonation rejected with 401');
        console.log('✓ Check 4 Passed: Query & body user_id impersonation strictly blocked\n');

        // -------------------------------------------------------------
        // Check 5: Tenant isolation across manufacturer imports
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 5: Tenant Isolation Across Manufacturers ---');
        // Delta IQF tries to access Nile Fruits import
        const crossTenantRes1 = await fetch(`${BASE_URL}/api/imports/status/${testImportNileId}`, {
            headers: { 'Authorization': `Bearer ${mfgDeltaToken}` }
        });
        assert.strictEqual(crossTenantRes1.status, 403, 'Cross-tenant status check must return 403');

        const crossTenantRes2 = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/items`, {
            headers: { 'Authorization': `Bearer ${mfgDeltaToken}` }
        });
        assert.strictEqual(crossTenantRes2.status, 403, 'Cross-tenant items access must return 403');

        const crossTenantRes3 = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/items/${testItemNileId}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${mfgDeltaToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ extracted_data: { name_ar: 'اختراق' } })
        });
        assert.strictEqual(crossTenantRes3.status, 403, 'Cross-tenant item edit must return 403');

        const crossTenantRes4 = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/save-draft`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${mfgDeltaToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });
        assert.strictEqual(crossTenantRes4.status, 403, 'Cross-tenant save-draft must return 403');
        console.log('✓ Check 5 Passed: Tenant isolation verified across all endpoints\n');

        // -------------------------------------------------------------
        // Check 6: Super Admin access to cross-tenant imports
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 6: Super Admin Cross-Tenant Access Oversight ---');
        const adminAccessRes1 = await fetch(`${BASE_URL}/api/imports/status/${testImportNileId}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(adminAccessRes1.status, 200, 'Super Admin must have access to import status');

        const adminAccessRes2 = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/items`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(adminAccessRes2.status, 200, 'Super Admin must have access to import items');
        console.log('✓ Check 6 Passed: Super Admin oversight verified\n');

        // -------------------------------------------------------------
        // Check 7: Logistics Officer access boundaries
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 7: Logistics Officer Access Boundaries ---');
        // Logistics officer blocked from private Marketing Subscription imports
        const logiPrivateRes = await fetch(`${BASE_URL}/api/imports/status/${testImportNileId}`, {
            headers: { 'Authorization': `Bearer ${logisticsToken}` }
        });
        assert.strictEqual(logiPrivateRes.status, 403, 'Logistics Officer must be blocked from Marketing Subscription imports');

        // Logistics officer CAN access Direct Contract imports
        const logiDirectRes = await fetch(`${BASE_URL}/api/imports/status/${testImportDirectId}`, {
            headers: { 'Authorization': `Bearer ${logisticsToken}` }
        });
        assert.strictEqual(logiDirectRes.status, 200, 'Logistics Officer must be able to access Direct Contract imports');
        console.log('✓ Check 7 Passed: Logistics Officer access boundaries properly enforced\n');

        // -------------------------------------------------------------
        // Check 8: IDOR protection on import items
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 8: IDOR Protection on Import Items ---');
        // Attempt to manipulate item from Direct Contract import inside Nile Fruits import path
        const idorRes = await fetch(`${BASE_URL}/api/imports/${testImportNileId}/items/${testItemDirectId}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'READY' })
        });
        assert.strictEqual(idorRes.status, 404, 'Mismatched importId and itemId must return 404');
        const idorData = await idorRes.json();
        assert.strictEqual(idorData.success, false);
        console.log('✓ Check 8 Passed: IDOR attack blocked with HTTP 404\n');

        // -------------------------------------------------------------
        // Check 9: Prevention of demo seeding in production mode
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 9: Prevention of Demo Seeding in Production Mode ---');
        const origNodeEnv = process.env.NODE_ENV;
        const origEnableSeed = process.env.ENABLE_DEMO_SEED;

        process.env.NODE_ENV = 'production';
        process.env.ENABLE_DEMO_SEED = 'true';
        const prodSeedResult = seedDatabase();
        assert.strictEqual(prodSeedResult.success, false, 'Seeding must fail when NODE_ENV=production');
        assert.strictEqual(prodSeedResult.message, 'Seeding forbidden in production');

        // Test with development but ENABLE_DEMO_SEED not true
        process.env.NODE_ENV = 'development';
        process.env.ENABLE_DEMO_SEED = 'false';
        const devDisabledResult = seedDatabase();
        assert.strictEqual(devDisabledResult.success, false);
        assert.strictEqual(devDisabledResult.message, 'ENABLE_DEMO_SEED not enabled');

        process.env.NODE_ENV = origNodeEnv;
        process.env.ENABLE_DEMO_SEED = origEnableSeed;
        console.log('✓ Check 9 Passed: Demo seeding is strictly impossible in production\n');

        // -------------------------------------------------------------
        // Check 10: Public catalog exclusion of demo products
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 10: Public Catalog Exclusion of Demo Products ---');
        const demoProdId = 'prod_sec_demo_' + crypto.randomBytes(3).toString('hex');
        db.prepare(`
            INSERT INTO products (
                id, manufacturer_id, sku, name_ar, status, price, is_demo
            ) VALUES (?, 'mfg_bustan_citrus', 'SKU-DEMO-SEC', 'منتج تجريبي سري للغاية', 'PUBLISHED', 999, 1)
        `).run(demoProdId);

        const publicCatalogRes = await fetch(`${BASE_URL}/api/products`);
        const publicCatalog = await publicCatalogRes.json();
        const demoFound = publicCatalog.products.some(p => p.id === demoProdId);
        assert.strictEqual(demoFound, false, 'Demo product (is_demo=1) must NEVER appear in public catalog');

        const singlePublicDemoRes = await fetch(`${BASE_URL}/api/products/${demoProdId}`);
        assert.strictEqual(singlePublicDemoRes.status, 404, 'Single public product lookup for demo product must return 404');
        console.log('✓ Check 10 Passed: Demo products strictly hidden from public catalog\n');

        // -------------------------------------------------------------
        // Check 11: Public manufacturer endpoints do not leak private fields
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 11: Public Manufacturer Privacy Protection ---');
        const publicMfgsRes = await fetch(`${BASE_URL}/api/manufacturers`);
        const publicMfgsData = await publicMfgsRes.json();
        assert.strictEqual(publicMfgsData.success, true);
        assert.ok(publicMfgsData.manufacturers.length > 0);

        for (const mfg of publicMfgsData.manufacturers) {
            assert.strictEqual(mfg.business_model, undefined, 'Public manufacturer must NOT leak business_model');
            assert.strictEqual(mfg.subscription_id, undefined, 'Public manufacturer must NOT leak subscription_id');
            assert.strictEqual(mfg.subscription_name, undefined, 'Public manufacturer must NOT leak subscription_name');
            assert.strictEqual(mfg.contact_email, undefined, 'Public manufacturer must NOT leak contact_email');
            assert.strictEqual(mfg.contact_phone, undefined, 'Public manufacturer must NOT leak contact_phone');
            assert.ok(mfg.name_ar, 'Public manufacturer must have name_ar');
            assert.ok(mfg.code, 'Public manufacturer must have code');
            assert.ok(mfg.city, 'Public manufacturer must have city');
        }

        // Authenticated Super Admin gets full fields
        const adminMfgsRes = await fetch(`${BASE_URL}/api/manufacturers`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const adminMfgsData = await adminMfgsRes.json();
        const adminMfgSample = adminMfgsData.manufacturers[0];
        assert.ok(adminMfgSample.business_model, 'Admin endpoint MUST include business_model');
        assert.ok(adminMfgSample.subscription_name, 'Admin endpoint MUST include subscription_name');
        console.log('✓ Check 11 Passed: Public serializer strips all private fields; Admin serializer retains them\n');

        // -------------------------------------------------------------
        // Check 12: Persona switcher endpoint disabled in production mode
        // -------------------------------------------------------------
        console.log('--- 🧪 Check 12: Persona Switcher Disabled in Production Mode ---');
        // Emulate production mode in config
        const originalConfigEnv = config.NODE_ENV;
        config.NODE_ENV = 'production';

        const prodPersonasRes = await fetch(`${BASE_URL}/api/auth/personas`);
        assert.strictEqual(prodPersonasRes.status, 404, 'GET /api/auth/personas must return 404 in production');

        const prodDevLoginRes = await fetch(`${BASE_URL}/api/auth/dev-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'usr_super_admin' })
        });
        assert.strictEqual(prodDevLoginRes.status, 404, 'POST /api/auth/dev-login must return 404 in production');

        config.NODE_ENV = originalConfigEnv;
        console.log('✓ Check 12 Passed: Persona switcher & dev-login strictly disabled in production\n');

        console.log('================================================================');
        console.log('🎉 ALL 12 P0 SECURITY LOCKDOWN CHECKS PASSED WITH 100% SUCCESS!');
        console.log('================================================================\n');
    } finally {
        server.close();
    }
}

if (require.main === module) {
    runSecurityP0Tests().catch(err => {
        console.error('❌ Security P0 Test Failed:', err);
        process.exit(1);
    });
}

module.exports = { runSecurityP0Tests };
