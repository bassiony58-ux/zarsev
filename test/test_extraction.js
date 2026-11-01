const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { Jimp } = require('jimp');
const { parseExcel } = require('../src/services/parsers/excelParser');
const { parseCsv } = require('../src/services/parsers/csvParser');
const { parseImage } = require('../src/services/parsers/imageParser');
const { extractZip } = require('../src/services/parsers/zipParser');
const { clusterImages } = require('../src/services/imageClusteringService');
const { processAndNormalizeItem } = require('../src/services/ai/aiService');

async function runExtractionTests() {
    console.log('--- 🧪 Test Suite 1: File Parsing, OCR & Multi-Format Extractor ---');

    // 1. Test Excel Parsing
    const excelPath = path.join(__dirname, 'sample_products.xlsx');
    const excelRes = parseExcel(excelPath);
    console.log(`✓ Parsed Excel: Found ${excelRes.items.length} items`);
    assert.strictEqual(excelRes.items.length, 3, 'Excel should contain 3 items');
    assert.strictEqual(excelRes.items[0].extracted_data.sku, 'EG-CIT-99');
    assert.strictEqual(excelRes.items[0].extracted_data.name_ar, 'ليمون يوريكا مصري فاخر');
    assert.strictEqual(excelRes.items[0].extracted_data.price, 650);
    assert.strictEqual(excelRes.items[0].extracted_data.currency, 'USD');

    // 2. Test CSV Parsing
    const csvPath = path.join(__dirname, 'sample_products.csv');
    const csvRes = parseCsv(csvPath);
    console.log(`✓ Parsed CSV: Found ${csvRes.items.length} items`);
    assert.strictEqual(csvRes.items.length, 2, 'CSV should contain 2 items');
    assert.strictEqual(csvRes.items[0].extracted_data.name_ar, 'تمر مجدول عضوي فاخر');
    assert.strictEqual(csvRes.items[0].extracted_data.price, 3500);

    // 3. Test Image Parsing & Perceptual Hashing with real Jimp image
    const tempImgPath = path.join(__dirname, 'temp_test_image.png');
    const newImg = new Jimp({ width: 40, height: 40, color: 0xFF0000FF });
    await newImg.write(tempImgPath);

    const imgRes = await parseImage(tempImgPath);
    console.log(`✓ Parsed Image: width=${imgRes.width}, height=${imgRes.height}, dHash=${imgRes.dhash}`);
    assert.strictEqual(imgRes.width, 40);
    assert.strictEqual(imgRes.height, 40);
    assert.ok(imgRes.thumbnail_url, 'Thumbnail URL should be generated');
    assert.ok(imgRes.dhash, 'dHash should be computed');

    // 4. Test Image Clustering
    const mockImages = [
        { filename: 'valencia_oranges_front.jpg', suggested_title: 'Valencia Oranges', dhash: 'aaaa0000aaaa0000', web_url: '/img1', width: 800, height: 600 },
        { filename: 'valencia_oranges_box.jpg', suggested_title: 'Valencia Oranges', dhash: 'aaaa0000aaaa0001', web_url: '/img2', width: 800, height: 600 },
        { filename: 'red_onions_main.jpg', suggested_title: 'Red Onions', dhash: '1111222233334444', web_url: '/img3', width: 800, height: 600 }
    ];
    const clustered = clusterImages(mockImages);
    console.log(`✓ Image Clustering: Formed ${clustered.clusters.length} product clusters`);
    assert.strictEqual(clustered.clusters.length, 2, 'Should group 3 images into 2 products');
    const valenciaCluster = clustered.clusters.find(c => c.cluster_key.includes('valencia'));
    assert.strictEqual(valenciaCluster.images.length, 2, 'Valencia cluster should have 2 images');
    assert.strictEqual(valenciaCluster.images.filter(i => i.is_primary).length, 1, 'Only 1 primary image allowed per cluster');

    // 5. Test ZIP Parsing
    const zipPath = path.join(__dirname, 'sample_bundle.zip');
    const unzippedTarget = path.join(__dirname, 'unzipped_test');
    const zipRes = extractZip(zipPath, unzippedTarget);
    console.log(`✓ Extracted ZIP: Found ${zipRes.spreadsheets.length} spreadsheet, ${zipRes.images.length} images`);
    assert.strictEqual(zipRes.spreadsheets.length, 1);
    assert.strictEqual(zipRes.images.length, 3);

    // 6. Test Zero Hallucination Guarantee
    const incompleteItem = {
        raw_data: { title: 'منتج تجريبي بدون مواصفات' },
        extracted_data: { name_ar: 'منتج تجريبي بدون مواصفات', price: null },
        validation_warnings: []
    };
    const normalized = await processAndNormalizeItem(incompleteItem, 'mfg_bustan_citrus');
    console.log(`✓ Zero Hallucination Test: Price remains ${normalized.extracted_data.price}, warnings=${normalized.validation_warnings.length}`);
    assert.strictEqual(normalized.extracted_data.price, null, 'Price must NOT be invented');
    assert.ok(normalized.validation_warnings.some(w => w.includes('السعر غير متوفر')), 'Warning must flag missing price');

    // Clean up
    if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
    if (fs.existsSync(path.join(__dirname, 'test_real.png'))) fs.unlinkSync(path.join(__dirname, 'test_real.png'));
    if (fs.existsSync(unzippedTarget)) fs.rmSync(unzippedTarget, { recursive: true, force: true });

    console.log('✅ ALL EXTRACTION TESTS PASSED!\n');
}

if (require.main === module) {
    runExtractionTests().catch(err => {
        console.error('❌ Extraction test failed:', err);
        process.exit(1);
    });
}

module.exports = { runExtractionTests };
