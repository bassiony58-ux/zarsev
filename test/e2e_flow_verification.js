const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runE2EVerification() {
    console.log('--- 🧪 Test Suite 6: Full End-to-End System Integration Test ---');
    
    // Start local server instance
    const app = require('../src/app');
    const { initDb } = require('../src/db/database');
    const { seedDatabase } = require('../src/db/seed');
    const { generateToken } = require('../src/utils/authUtils');
    initDb();
    seedDatabase();

    const adminToken = generateToken({ id: 'usr_super_admin', email: 'admin@zarsev.com' });
    const authHeaders = { 'Authorization': `Bearer ${adminToken}` };

    const server = app.listen(3344);
    const BASE_URL = 'http://localhost:3344';

    try {
        // Step 1: Upload sample_products.xlsx
        console.log('1. Uploading Excel catalog...');
        const filePath = path.join(__dirname, 'sample_products.xlsx');
        const fileBuffer = fs.readFileSync(filePath);

        const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substring(2);
        let bodyBuffer = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="sample_products.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
            fileBuffer,
            Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="manufacturer_id"\r\n\r\nmfg_bustan_citrus\r\n--${boundary}--\r\n`)
        ]);

        const uploadRes = await fetch(`${BASE_URL}/api/imports/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                ...authHeaders
            },
            body: bodyBuffer
        });
        const uploadData = await uploadRes.json();
        console.log('✓ Upload Accepted:', uploadData);
        assert.strictEqual(uploadData.success, true);
        const importId = uploadData.import_id;

        // Step 2: Poll status until REVIEW_READY
        console.log('2. Waiting for background extraction to complete...');
        let isReady = false;
        let attempts = 0;
        while (!isReady && attempts < 20) {
            await new Promise(r => setTimeout(r, 400));
            attempts++;
            const statusRes = await fetch(`${BASE_URL}/api/imports/status/${importId}`, {
                headers: authHeaders
            });
            const statusData = await statusRes.json();
            if (statusData.import.status === 'REVIEW_READY') {
                isReady = true;
                console.log(`✓ Background Worker finished: status=${statusData.import.status}, detected=${statusData.import.total_detected}, valid=${statusData.import.total_valid}`);
                assert.strictEqual(statusData.import.total_detected, 3);
            }
        }
        assert.strictEqual(isReady, true, 'Import should reach REVIEW_READY');

        // Step 3: Fetch extracted items
        console.log('3. Fetching extracted items for review...');
        const itemsRes = await fetch(`${BASE_URL}/api/imports/${importId}/items`, {
            headers: authHeaders
        });
        const itemsData = await itemsRes.json();
        assert.strictEqual(itemsData.items.length, 3);
        console.log(`✓ Review items fetched (${itemsData.items.length} items ready for editing)`);

        // Step 4: Submit items for approval
        console.log('4. Submitting items into approval workflow...');
        const submitRes = await fetch(`${BASE_URL}/api/imports/${importId}/submit-approval`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            },
            body: JSON.stringify({
                selected_item_ids: [itemsData.items[0].id, itemsData.items[1].id],
                direct_publish: false
            })
        });
        const submitData = await submitRes.json();
        console.log('✓ Submitted for Approval:', submitData.message);
        assert.strictEqual(submitData.success, true);

        // Step 5: Check approval queue
        console.log('5. Checking Super Admin approval queue...');
        const queueRes = await fetch(`${BASE_URL}/api/approvals/queue`, {
            headers: authHeaders
        });
        const queueData = await queueRes.json();
        console.log(`✓ Approval queue contains ${queueData.count} items`);
        assert.ok(queueData.count >= 2);

        // Step 6: Approve item to publish
        const targetProd = queueData.queue[0];
        console.log(`6. Approving product "${targetProd.name_ar}"...`);
        const approveRes = await fetch(`${BASE_URL}/api/approvals/${targetProd.id}/decide`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            },
            body: JSON.stringify({ decision: 'APPROVE' })
        });
        const approveData = await approveRes.json();
        console.log('✓ Decision Result:', approveData.message);
        assert.strictEqual(approveData.status, 'PUBLISHED');

        // Step 7: Verify appearance in public catalog
        console.log('7. Verifying product in public catalog...');
        const catalogRes = await fetch(`${BASE_URL}/api/products`);
        const catalogData = await catalogRes.json();
        const found = catalogData.products.some(p => p.id === targetProd.id);
        console.log(`✓ Product "${targetProd.name_ar}" publicly visible: ${found}`);
        assert.strictEqual(found, true);

        console.log('🎉 END-TO-END FLOW VERIFICATION COMPLETE AND 100% SUCCESSFUL!\n');
    } finally {
        server.close();
    }
}

if (require.main === module) {
    runE2EVerification().catch(err => {
        console.error('❌ E2E verification failed:', err);
        process.exit(1);
    });
}

module.exports = { runE2EVerification };
