const assert = require('assert');
const { setupTestEnvironment, cleanupTestDatabase } = require('./test_helper');
const { checkForDuplicateProduct } = require('../src/services/duplicateDetectionService');
const { hammingDistance } = require('../src/services/parsers/imageParser');

async function runDuplicateDetectionTests() {
    console.log('--- 🧪 Test Suite 4: Duplicate Detection (SKU, Name, Image dHash) ---');
    const { db, isolatedDbPath } = setupTestEnvironment('duplicate_detection');

    try {

    // 1. Test Duplicate by Exact SKU match
    // Seeded product has SKU 'EG-CIT-01'
    const itemWithDuplicateSku = {
        extracted_data: {
            name_ar: 'برتقال فالنسيا جديد',
            sku: 'EG-CIT-01'
        },
        assigned_images: []
    };
    const skuDupCheck = await checkForDuplicateProduct(itemWithDuplicateSku, 'mfg_bustan_citrus');
    console.log(`✓ SKU Duplicate Detected: ${skuDupCheck.is_duplicate} - Reason: ${skuDupCheck.reason}`);
    assert.strictEqual(skuDupCheck.is_duplicate, true);
    assert.ok(skuDupCheck.reason.includes('EG-CIT-01'));

    // 2. Test Duplicate by Name Similarity
    // Seeded product has name: 'الفراولة المجمدة والرمان السريع IQF'
    const itemWithSimilarName = {
        extracted_data: {
            name_ar: 'الفراولة المجمدة والرمان IQF السريع للتصدير',
            sku: 'EG-UNIQUE-888'
        },
        assigned_images: []
    };
    const nameDupCheck = await checkForDuplicateProduct(itemWithSimilarName, 'mfg_delta_iqf');
    console.log(`✓ Name Duplicate Detected: ${nameDupCheck.is_duplicate} - Reason: ${nameDupCheck.reason}`);
    assert.strictEqual(nameDupCheck.is_duplicate, true);
    assert.ok(nameDupCheck.reason.includes('تشابه مرتفع'));

    // 3. Test Non-Duplicate (Unique Product)
    const uniqueItem = {
        extracted_data: {
            name_ar: 'مانجو عويس فص فاخرة للتصدير الجوي',
            sku: 'EG-MNG-999'
        },
        assigned_images: []
    };
    const uniqueCheck = await checkForDuplicateProduct(uniqueItem, 'mfg_bustan_citrus');
    console.log(`✓ Unique Item Check: is_duplicate=${uniqueCheck.is_duplicate}`);
    assert.strictEqual(uniqueCheck.is_duplicate, false);

    // 4. Test Image Perceptual Hash Distance
    const hashA = 'ffff0000ffff0000';
    const hashB = 'ffff0000ffff0001'; // 1 bit flip = distance 1
    const dist = hammingDistance(hashA, hashB);
    console.log(`✓ Hamming Distance Test: distance between near-identical hashes = ${dist}`);
    assert.strictEqual(dist, 1);
    assert.ok(dist <= 4, 'Should be flagged as near-duplicate image');

    console.log('✅ ALL DUPLICATE DETECTION TESTS PASSED!\n');
    } finally {
        cleanupTestDatabase(isolatedDbPath);
    }
}

if (require.main === module) {
    runDuplicateDetectionTests().catch(err => {
        console.error('❌ Duplicate detection test failed:', err);
        process.exit(1);
    });
}

module.exports = { runDuplicateDetectionTests };
