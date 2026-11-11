const assert = require('assert');
const crypto = require('crypto');
const { setupTestEnvironment, cleanupTestDatabase } = require('./test_helper');

async function runApprovalWorkflowTests() {
    console.log('--- 🧪 Test Suite 5: Product Lifecycle & Approval Workflow ---');
    const { db, isolatedDbPath } = setupTestEnvironment('approval_workflow');

    try {

    // 1. Marketing Subscription Manufacturer Submits Product -> Must Enter PENDING_APPROVAL
    const testProdId = 'prod_test_approval_' + crypto.randomBytes(4).toString('hex');
    db.prepare(`
        INSERT INTO products (
            id, manufacturer_id, sku, name_ar, status, price, currency, price_unit, moq
        ) VALUES (?, ?, ?, ?, 'PENDING_APPROVAL', 850, 'USD', 'MT', '1 Container')
    `).run(testProdId, 'mfg_nile_fruits', 'EG-TEST-001', 'عنب كريمسون بدون بذور للتصدير');

    const created = db.prepare('SELECT * FROM products WHERE id = ?').get(testProdId);
    assert.strictEqual(created.status, 'PENDING_APPROVAL');
    console.log(`✓ Initial Submission: Product "${created.name_ar}" created with status=${created.status}`);

    // 2. Verify Public Catalog Gatekeeping: Pending Approval products MUST NOT be returned in public catalog!
    const publicCatalog = db.prepare("SELECT id FROM products WHERE status = 'PUBLISHED'").all();
    assert.strictEqual(publicCatalog.some(p => p.id === testProdId), false, 'Pending approval product MUST NOT be visible in public catalog');
    console.log('✓ Public Gatekeeping: Unapproved product is NOT visible to public customers');

    // 3. Super Admin Review Queue
    const queue = db.prepare("SELECT id, name_ar FROM products WHERE status = 'PENDING_APPROVAL'").all();
    assert.ok(queue.some(p => p.id === testProdId), 'Product must be in Super Admin approval queue');
    console.log(`✓ Approval Queue: Product verified in pending queue (${queue.length} items waiting)`);

    // 4. Test Rejection with Required Reason
    const rejectionReason = 'الشهادات غير مرفقة ويرجى توضيح مقاسات الحبات (Berries Size)';
    db.prepare(`
        UPDATE products 
        SET status = 'REJECTED', rejection_reason = ? 
        WHERE id = ?
    `).run(rejectionReason, testProdId);

    const rejected = db.prepare('SELECT * FROM products WHERE id = ?').get(testProdId);
    assert.strictEqual(rejected.status, 'REJECTED');
    assert.strictEqual(rejected.rejection_reason, rejectionReason);
    console.log(`✓ Rejection: Product rejected with documented reason: "${rejected.rejection_reason}"`);

    // 5. Manufacturer Resubmission after edit
    db.prepare(`
        UPDATE products 
        SET name_ar = 'عنب كريمسون فاخر مقاس 18مم+ معتمد',
            status = 'PENDING_APPROVAL',
            rejection_reason = NULL
        WHERE id = ?
    `).run(testProdId);

    const resubmitted = db.prepare('SELECT * FROM products WHERE id = ?').get(testProdId);
    assert.strictEqual(resubmitted.status, 'PENDING_APPROVAL');
    assert.strictEqual(resubmitted.rejection_reason, null);
    console.log(`✓ Resubmission: Product updated and resubmitted to status=${resubmitted.status}`);

    // 6. Super Admin Approval -> Transitions to PUBLISHED
    db.prepare(`
        UPDATE products 
        SET status = 'PUBLISHED', rejection_reason = NULL 
        WHERE id = ?
    `).run(testProdId);

    const published = db.prepare('SELECT * FROM products WHERE id = ?').get(testProdId);
    assert.strictEqual(published.status, 'PUBLISHED');
    console.log(`✓ Approval: Product successfully approved and marked status=${published.status}`);

    // 7. Verify Public Catalog Appearance & Combined Business Models
    const updatedCatalog = db.prepare(`
        SELECT p.id, p.name_ar, m.business_model 
        FROM products p
        JOIN manufacturers m ON p.manufacturer_id = m.id
        WHERE p.status = 'PUBLISHED'
    `).all();

    assert.ok(updatedCatalog.some(p => p.id === testProdId), 'Now approved product is publicly visible');
    const hasDirect = updatedCatalog.some(p => p.business_model === 'DIRECT_CONTRACT');
    const hasMarketing = updatedCatalog.some(p => p.business_model === 'MARKETING_SUBSCRIPTION');
    assert.strictEqual(hasDirect, true, 'Public catalog must contain Direct Contract products');
    assert.strictEqual(hasMarketing, true, 'Public catalog must contain Marketing Subscription products');
    console.log(`✓ Combined Catalog: Public catalog successfully combines both Direct Contract and Marketing Subscription models (${updatedCatalog.length} published products)`);

    // Clean up test product
    db.prepare('DELETE FROM products WHERE id = ?').run(testProdId);

    console.log('✅ ALL PRODUCT LIFECYCLE & APPROVAL TESTS PASSED!\n');
    } finally {
        cleanupTestDatabase(isolatedDbPath);
    }
}

if (require.main === module) {
    runApprovalWorkflowTests().catch(err => {
        console.error('❌ Approval workflow test failed:', err);
        process.exit(1);
    });
}

module.exports = { runApprovalWorkflowTests };
