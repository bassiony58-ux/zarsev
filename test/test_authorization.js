const assert = require('assert');
const { setupTestEnvironment, cleanupTestDatabase } = require('./test_helper');
const { checkSubscriptionLimits } = require('../src/middlewares/subscriptionGuard');
const { requireRole } = require('../src/middlewares/auth');

async function runAuthorizationTests() {
    console.log('--- 🧪 Test Suite 3: Authorization, RBAC & Subscription Quotas ---');
    const { db, isolatedDbPath } = setupTestEnvironment('authorization');

    try {

    // 1. Role Authorization Middleware Test
    const adminUser = { role: 'SUPER_ADMIN' };
    const mfgUser = { role: 'MANUFACTURER' };

    let passedAdmin = false;
    const adminGuard = requireRole(['SUPER_ADMIN']);
    adminGuard({ user: adminUser }, { status: () => ({ json: () => {} }) }, () => { passedAdmin = true; });
    assert.strictEqual(passedAdmin, true, 'Super Admin should pass SUPER_ADMIN guard');
    console.log('✓ RBAC: Super Admin passed role check');

    let blockedMfg = false;
    adminGuard({ user: mfgUser }, {
        status: (code) => {
            assert.strictEqual(code, 403);
            return {
                json: (res) => {
                    blockedMfg = true;
                    assert.strictEqual(res.success, false);
                }
            };
        }
    }, () => {});
    assert.strictEqual(blockedMfg, true, 'Marketing Manufacturer must receive 403 on Super Admin endpoint');
    console.log('✓ RBAC: Marketing Manufacturer blocked with 403 on Super Admin endpoint');

    // 2. Subscription Quota & Format Checking Test
    const standardMfg = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get('mfg_delta_iqf');
    assert.strictEqual(standardMfg.subscription_id, 'sub_standard');

    const standardSub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get('sub_standard');
    const allowedFormats = JSON.parse(standardSub.allowed_formats);
    console.log(`✓ Subscription Plan: Standard formats allowed: [${allowedFormats.join(', ')}]`);
    assert.strictEqual(allowedFormats.includes('pdf'), false, 'Standard plan should NOT allow PDF by default');
    assert.strictEqual(allowedFormats.includes('xlsx'), true, 'Standard plan allows xlsx');

    // 3. Super Admin Reconfiguring Subscription Limits (No Code Changes)
    const updateStmt = db.prepare(`
        UPDATE subscriptions 
        SET allowed_formats = ?, max_products_per_import = ?
        WHERE id = ?
    `);
    updateStmt.run(JSON.stringify(['xlsx', 'csv', 'images', 'pdf']), 75, 'sub_standard');

    const updatedSub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get('sub_standard');
    const newFormats = JSON.parse(updatedSub.allowed_formats);
    assert.strictEqual(newFormats.includes('pdf'), true, 'Updated plan now allows PDF without code modification');
    assert.strictEqual(updatedSub.max_products_per_import, 75);
    console.log(`✓ Subscription Reconfiguration: Super Admin successfully updated allowed formats and product limit to 75`);

    // Reset back to standard for consistency
    updateStmt.run(JSON.stringify(['xlsx', 'csv', 'images']), 50, 'sub_standard');

    console.log('✅ ALL AUTHORIZATION & SUBSCRIPTION TESTS PASSED!\n');
    } finally {
        cleanupTestDatabase(isolatedDbPath);
    }
}

if (require.main === module) {
    runAuthorizationTests().catch(err => {
        console.error('❌ Authorization test failed:', err);
        process.exit(1);
    });
}

module.exports = { runAuthorizationTests };
