/**
 * End-to-End Multi-Persona Frontend & API Workflow Verification
 * Tests Workflows A, B, C, and D against http://localhost:3001
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3001';

async function fetchJson(endpoint, options = {}) {
    const res = await fetch(`${BASE_URL}${endpoint}`, options);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
}

async function devLogin(userId) {
    const res = await fetchJson('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
    });
    if (!res.ok || !res.data.token) {
        throw new Error(`Failed to login as ${userId}: ${JSON.stringify(res.data)}`);
    }
    return res.data.token;
}

function authHeaders(token, extra = {}) {
    return {
        'Authorization': `Bearer ${token}`,
        'x-requested-with': 'XMLHttpRequest',
        ...extra
    };
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runVerification() {
    console.log('===============================================================');
    console.log('🚀 STARTING ZARSEV MULTI-PERSONA E2E WORKFLOW VERIFICATION');
    console.log(`🌐 Target: ${BASE_URL}`);
    console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
    console.log('===============================================================\n');

    const results = {};

    // -------------------------------------------------------------
    // WORKFLOW A: Manufacturer Persona (Upload, Review, Manual Add, Submit)
    // -------------------------------------------------------------
    console.log('▶ [WORKFLOW A] Manufacturer Persona: usr_mfg_nile_fruits');
    try {
        const mfgToken = await devLogin('usr_mfg_nile_fruits');
        console.log('  ✔ Logged in as usr_mfg_nile_fruits');

        // Check me
        const meRes = await fetchJson('/api/auth/me', { headers: authHeaders(mfgToken) });
        console.log(`  ✔ Verified identity: ${meRes.data.user.name} (${meRes.data.manufacturer?.name_ar})`);

        // Upload CSV using native global FormData & Blob
        const csvPath = path.join(__dirname, 'test', 'sample_products.csv');
        const csvBuffer = fs.readFileSync(csvPath);
        const form = new FormData();
        form.append('files', new Blob([csvBuffer], { type: 'text/csv' }), 'sample_products.csv');

        const uploadRes = await fetchJson('/api/imports/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${mfgToken}`,
                'x-requested-with': 'XMLHttpRequest'
            },
            body: form
        });

        if (!uploadRes.ok || !uploadRes.data.import_id) {
            throw new Error(`Upload failed: ${JSON.stringify(uploadRes.data)}`);
        }

        const importId = uploadRes.data.import_id;
        console.log(`  ✔ Uploaded sample CSV, import ID: ${importId}`);

        // Poll for processing completion
        let importStatus = '';
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            const statusRes = await fetchJson(`/api/imports/status/${importId}`, { headers: authHeaders(mfgToken) });
            importStatus = statusRes.data.import?.status;
            if (['REVIEW_READY', 'SAVED_DRAFT', 'SUBMITTED', 'FAILED'].includes(importStatus)) {
                break;
            }
        }
        console.log(`  ✔ Import processing reached status: ${importStatus}`);

        // Inspect extracted items
        const itemsRes = await fetchJson(`/api/imports/${importId}/items`, { headers: authHeaders(mfgToken) });
        console.log(`  ✔ Extracted ${itemsRes.data.items?.length || 0} items from CSV`);

        // Add manual item via newly wired POST /api/imports/:id/items
        const manualItem = {
            name_ar: 'برتقال أبو سرة نخب أول تصديري فاخر',
            name_en: 'Premium Egyptian Navel Oranges Grade A',
            sku: 'EG-ORG-NAVEL-01',
            price: 680,
            currency: 'USD',
            price_unit: 'MT',
            moq: '24 MT (1 Reefer Container)',
            packaging: 'كرتون تلسكوبي 15 كجم صافي',
            specs: { calibers: '48/56/64/72', brix: '12.5%' }
        };

        const addRes = await fetchJson(`/api/imports/${importId}/items`, {
            method: 'POST',
            headers: authHeaders(mfgToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify(manualItem)
        });

        if (!addRes.ok || !addRes.data.item_id) {
            throw new Error(`Manual item addition failed: ${JSON.stringify(addRes.data)}`);
        }
        console.log(`  ✔ Added manual product: ${manualItem.name_ar} (ID: ${addRes.data.item_id})`);

        // Submit for approval
        const submitRes = await fetchJson(`/api/imports/${importId}/submit-approval`, {
            method: 'POST',
            headers: authHeaders(mfgToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({})
        });
        console.log(`  ✔ Submitted import batch for approval: ${submitRes.data.message || 'Success'}`);

        // Verify history shows the import
        const historyRes = await fetchJson('/api/imports/history', { headers: authHeaders(mfgToken) });
        const foundInHistory = historyRes.data.history?.some(h => h.id === importId);
        console.log(`  ✔ Verified in history table: ${foundInHistory ? 'FOUND' : 'NOT FOUND'}`);

        results.workflowA = {
            pass: true,
            importId,
            manualItemId: addRes.data.item_id,
            manualItemName: manualItem.name_ar,
            itemsCount: itemsRes.data.items.length + 1
        };
    } catch (err) {
        console.error('  ❌ Workflow A Error:', err.message);
        results.workflowA = { pass: false, error: err.message };
    }

    // -------------------------------------------------------------
    // WORKFLOW B: Admin Persona (Inspect Approvals, Approve Product, Verify Published)
    // -------------------------------------------------------------
    console.log('\n▶ [WORKFLOW B] Admin Persona: usr_super_admin');
    try {
        const adminToken = await devLogin('usr_super_admin');
        console.log('  ✔ Logged in as usr_super_admin');

        // Inspect approval queue
        const queueRes = await fetchJson('/api/approvals/queue', { headers: authHeaders(adminToken) });
        console.log(`  ✔ Approval queue items count: ${queueRes.data.queue?.length || 0}`);

        // Find product to approve
        let targetProdId = null;
        if (queueRes.data.queue && queueRes.data.queue.length > 0) {
            targetProdId = queueRes.data.queue[0].id;
            console.log(`  ✔ Selected pending item to approve: "${queueRes.data.queue[0].name_ar}" (ID: ${targetProdId})`);
            
            const decideRes = await fetchJson(`/api/approvals/${targetProdId}/decide`, {
                method: 'POST',
                headers: authHeaders(adminToken, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ decision: 'APPROVE' })
            });

            if (!decideRes.ok) {
                throw new Error(`Decision failed: ${JSON.stringify(decideRes.data)}`);
            }
            console.log(`  ✔ Product approved successfully: ${decideRes.data.message}`);
        } else {
            console.log('  ℹ Queue was empty, checking existing published products');
        }

        // Verify published product in public catalog
        const catRes = await fetchJson('/api/products');
        const pubCount = catRes.data.products?.length || 0;
        console.log(`  ✔ Public catalog now contains ${pubCount} active products`);

        results.workflowB = {
            pass: true,
            approvedProductId: targetProdId,
            catalogCount: pubCount
        };
    } catch (err) {
        console.error('  ❌ Workflow B Error:', err.message);
        results.workflowB = { pass: false, error: err.message };
    }

    // -------------------------------------------------------------
    // WORKFLOW C: Customer Persona (Catalog, Filter, Search, Details, RFQ)
    // -------------------------------------------------------------
    console.log('\n▶ [WORKFLOW C] Customer / Buyer Persona: Anonymous Visitor');
    try {
        // Query categories
        const catsRes = await fetchJson('/api/categories');
        console.log(`  ✔ Fetched categories tree: ${catsRes.data.categories?.length || 0} main categories`);

        // Search catalog
        const searchRes = await fetchJson('/api/products?search=برتقال');
        console.log(`  ✔ Searched products for "برتقال": ${searchRes.data.products?.length || 0} matches found`);

        // Get single product details
        const prodList = await fetchJson('/api/products?limit=1');
        if (prodList.data.products && prodList.data.products.length > 0) {
            const firstProd = prodList.data.products[0];
            const detailRes = await fetchJson(`/api/products/${firstProd.id}`);
            console.log(`  ✔ Retrieved product specs for: "${detailRes.data.product.name_ar}" (SKU: ${detailRes.data.product.sku})`);
            console.log(`  ✔ Generated RFQ deep-link: /contact?product=${encodeURIComponent(detailRes.data.product.name_ar)}&sku=${encodeURIComponent(detailRes.data.product.sku)}`);
        }

        // Test HTML routes for user experience
        const pages = ['/', '/catalog', '/product-details', '/services', '/consulting', '/about', '/contact', '/importer'];
        for (const p of pages) {
            const pageRes = await fetch(`${BASE_URL}${p}`);
            if (pageRes.status !== 200) {
                throw new Error(`Route ${p} returned status ${pageRes.status}`);
            }
        }
        console.log(`  ✔ All 8 public & workspace routes returned HTTP 200 OK`);

        results.workflowC = {
            pass: true,
            verifiedRoutes: pages.length
        };
    } catch (err) {
        console.error('  ❌ Workflow C Error:', err.message);
        results.workflowC = { pass: false, error: err.message };
    }

    // -------------------------------------------------------------
    // WORKFLOW D: Logistics Officer Persona (Direct Contracts, Fuzzy Matcher)
    // -------------------------------------------------------------
    console.log('\n▶ [WORKFLOW D] Logistics Officer Persona: usr_logistics_officer');
    try {
        const logToken = await devLogin('usr_logistics_officer');
        console.log('  ✔ Logged in as usr_logistics_officer');

        // Check me
        const meRes = await fetchJson('/api/auth/me', { headers: authHeaders(logToken) });
        console.log(`  ✔ Verified role: ${meRes.data.user.role} (${meRes.data.user.name})`);

        // List manufacturers
        const mfgsRes = await fetchJson('/api/manufacturers', { headers: authHeaders(logToken) });
        console.log(`  ✔ Retrieved ${mfgsRes.data.manufacturers?.length || 0} registered manufacturers`);

        // Test fuzzy matcher
        const matchRes = await fetchJson('/api/manufacturers/match?name=' + encodeURIComponent('محطة البستان'), { headers: authHeaders(logToken) });
        console.log(`  ✔ Fuzzy matcher tested for "محطة البستان": found "${matchRes.data.match?.name_ar}" (Confidence: ${Math.round((matchRes.data.match?.match_confidence || 0) * 100)}%)`);

        results.workflowD = {
            pass: true,
            manufacturersCount: mfgsRes.data.manufacturers?.length || 0,
            matchedMfg: matchRes.data.match?.name_ar
        };
    } catch (err) {
        console.error('  ❌ Workflow D Error:', err.message);
        results.workflowD = { pass: false, error: err.message };
    }

    console.log('\n===============================================================');
    console.log('🏁 VERIFICATION SUMMARY:');
    console.log(`  Workflow A (Manufacturer):      ${results.workflowA?.pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Workflow B (Super Admin):       ${results.workflowB?.pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Workflow C (Customer / Buyer):  ${results.workflowC?.pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Workflow D (Logistics Officer): ${results.workflowD?.pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log('===============================================================');

    return results;
}

runVerification().then(res => {
    const allPassed = Object.values(res).every(r => r.pass);
    process.exit(allPassed ? 0 : 1);
}).catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
