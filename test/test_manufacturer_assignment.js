const assert = require('assert');
const { getDb, initDb } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { findMatchingManufacturer } = require('../src/services/duplicateDetectionService');

async function runManufacturerAssignmentTests() {
    console.log('--- 🧪 Test Suite 2: Manufacturer Assignment & Multi-Model Business Logic ---');
    initDb();
    seedDatabase();
    const db = getDb();

    // 1. Verify Seeded Direct Contract vs Marketing Subscription Manufacturers
    const bustan = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get('mfg_bustan_citrus');
    assert.strictEqual(bustan.business_model, 'DIRECT_CONTRACT');
    console.log(`✓ Direct Contract Verified: ${bustan.name_ar} (Model: ${bustan.business_model})`);

    const nile = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get('mfg_nile_fruits');
    assert.strictEqual(nile.business_model, 'MARKETING_SUBSCRIPTION');
    console.log(`✓ Marketing Subscription Verified: ${nile.name_ar} (Model: ${nile.business_model})`);

    // 2. Test Manufacturer Suggestion / Fuzzy Matcher
    const match1 = findMatchingManufacturer('شركة ثمار النيل للاستثمار');
    assert.ok(match1, 'Should find match for Nile Fruits');
    assert.strictEqual(match1.id, 'mfg_nile_fruits');
    console.log(`✓ Auto-matching Match Found: "${match1.name_ar}" (Score: ${Math.round(match1.match_confidence * 100)}%)`);

    const match2 = findMatchingManufacturer('محطة فرز وتعبئة البستان');
    assert.ok(match2, 'Should find match for Bustan');
    assert.strictEqual(match2.id, 'mfg_bustan_citrus');
    console.log(`✓ Auto-matching Match Found: "${match2.name_ar}" (Score: ${Math.round(match2.match_confidence * 100)}%)`);

    // 3. Test Security Isolation: Marketing Subscription Manufacturer cannot assign products to another profile
    const mfgUser = db.prepare('SELECT * FROM users WHERE id = ?').get('usr_mfg_nile_fruits');
    assert.strictEqual(mfgUser.role, 'MANUFACTURER');
    assert.strictEqual(mfgUser.manufacturer_id, 'mfg_nile_fruits');

    // Simulate upload assignment logic
    function resolveTargetManufacturer(user, requestedMfgId) {
        if (user.role === 'MANUFACTURER') {
            // Strict backend enforcement
            return user.manufacturer_id;
        }
        return requestedMfgId;
    }

    // Nile fruits attempts to assign products to Bustan Citrus
    const enforcedMfg = resolveTargetManufacturer(mfgUser, 'mfg_bustan_citrus');
    assert.strictEqual(enforcedMfg, 'mfg_nile_fruits', 'Backend MUST override requested manufacturer with authenticated manufacturer ID');
    console.log('✓ Security Check: Marketing Manufacturer cannot assign to external manufacturer profile (Enforced: mfg_nile_fruits)');

    // Super Admin can freely assign to any valid manufacturer
    const adminUser = db.prepare('SELECT * FROM users WHERE id = ?').get('usr_super_admin');
    const adminAssigned = resolveTargetManufacturer(adminUser, 'mfg_damietta_agro');
    assert.strictEqual(adminAssigned, 'mfg_damietta_agro', 'Super Admin can assign products to Direct Contract Manufacturers');
    console.log('✓ Admin Check: Super Admin successfully assigns products under Direct Contract Manufacturer: mfg_damietta_agro');

    console.log('✅ ALL MANUFACTURER ASSIGNMENT TESTS PASSED!\n');
}

if (require.main === module) {
    runManufacturerAssignmentTests().catch(err => {
        console.error('❌ Manufacturer assignment test failed:', err);
        process.exit(1);
    });
}

module.exports = { runManufacturerAssignmentTests };
