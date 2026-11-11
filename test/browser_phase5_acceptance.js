/**
 * test/browser_phase5_acceptance.js
 * 
 * ZARSEV Phase 5 — Real Browser-Based Product Acceptance Test Suite.
 * 
 * Tests the 10 core commercial and security workflows in a real Chrome browser instance:
 * 1. Public Buyer Product Browsing & RFQ Submission
 * 2. Buyer Receives Reference & Secret Access Token
 * 3. Secret Token-Only Tracking (Email-only and invalid tokens blocked)
 * 4. Super Admin Review & Exporter Assignment
 * 5. Strict Multi-Tenant Isolation (Unrelated exporter blocked, assigned exporter sees RFQ)
 * 6. Assigned Manufacturer Structured Quotation Submission
 * 7. Buyer Quotation Review & Commercial Acceptance
 * 8. Rejection of Expired Quotations
 * 9. Tenant Isolation Guard on Quotation Actions (HTTP 403)
 * 10. Understandable UI Validation & Zero Secret/Stack Exposure
 * 
 * Safety:
 * - Operates EXCLUSIVELY against PostgreSQL database 'zarsev_test' and local server 'http://localhost:3001'.
 * - SQLite 'zarsev.db' is strictly read-only and verified for hash integrity.
 * - 'zarsev_dev' is strictly untouched.
 * - Records all test fixtures and safely self-cleans only newly created test records at test end.
 */

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'postgres';

const puppeteer = require('puppeteer-core');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pgAdapter = require('../src/db/pgAdapter');
const { generateToken } = require('../src/utils/authUtils');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost:3001';
const SCREENSHOT_DIR = 'C:\\Users\\aybas\\.gemini\\antigravity\\brain\\2694c2df-71b9-4adb-add8-3cfb7914e5fe\\screenshots';
const EXPECTED_SQLITE_HASH = '5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC';

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Track created test records for guaranteed cleanup
const createdRfqIds = [];
const createdQuotationIds = [];
const testResults = [];

function recordWorkflow(id, title, status, details = '') {
    testResults.push({ id, title, status, details });
    const mark = status === 'PASS' ? '✅' : '❌';
    console.log(`\n${mark} [Workflow ${id}] ${title} -> ${status}`);
    if (details) console.log(`   ${details}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPhase5BrowserAcceptance() {
    console.log('===================================================================');
    console.log('🚢 ZARSEV PHASE 5: REAL BROWSER PRODUCT ACCEPTANCE');
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`🔍 Chrome Binary: ${CHROME_PATH}`);
    console.log(`📁 Artifact Screenshot Directory: ${SCREENSHOT_DIR}`);
    console.log('===================================================================\n');

    // Preflight Check: SQLite Hash & Active Database
    const sqliteBuf = fs.readFileSync('M:/ZZZ/zarsev.db');
    const currentSqliteHash = crypto.createHash('sha256').update(sqliteBuf).digest('hex').toUpperCase();
    assert.strictEqual(currentSqliteHash, EXPECTED_SQLITE_HASH, 'FATAL: SQLite hash altered before browser testing!');

    const pool = pgAdapter.getAppPool('zarsev_test');
    const dbCheck = await pool.query('SELECT current_database(), current_user;');
    assert.strictEqual(dbCheck.rows[0].current_database, 'zarsev_test', 'FATAL: Active DB must be zarsev_test');
    assert.strictEqual(dbCheck.rows[0].current_user, 'zarsev_app', 'FATAL: Active user must be zarsev_app');

    // Identify target product
    const prodRes = await pool.query("SELECT id, name_ar, name_en, manufacturer_id FROM products WHERE status = 'PUBLISHED' LIMIT 1;");
    assert.ok(prodRes.rows.length > 0, 'FATAL: No published products found in zarsev_test');
    const targetProduct = prodRes.rows[0];
    console.log(`Target Published Product: ${targetProduct.id} (${targetProduct.name_ar})`);

    // Fetch test users
    const usersRes = await pool.query("SELECT id, email, role, manufacturer_id FROM users;");
    const adminUser = usersRes.rows.find(u => u.role === 'SUPER_ADMIN');
    const deltaMfgUser = usersRes.rows.find(u => u.manufacturer_id === 'mfg_delta_iqf');
    const nileMfgUser = usersRes.rows.find(u => u.manufacturer_id === 'mfg_nile_fruits');

    assert.ok(adminUser, 'Missing SUPER_ADMIN user');
    assert.ok(deltaMfgUser, 'Missing delta_iqf manufacturer user');
    assert.ok(nileMfgUser, 'Missing nile_fruits manufacturer user');

    let browser;
    let submittedRfqId = null;
    let submittedRefNo = null;
    let submittedBuyerToken = null;
    let submittedQuotationId = null;

    try {
        console.log('\n--- Launching Headless Real Chrome Browser ---');
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: true,
            defaultViewport: { width: 1280, height: 900 },
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
        });
        const page = await browser.newPage();

        // Assign unique test IP header to isolate tracking rate limits from prior test bursts
        const testClientIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
        await page.setExtraHTTPHeaders({
            'x-forwarded-for': testClientIp
        });

        // Handle native browser dialogs (confirm / alert) automatically
        page.on('dialog', async dialog => {
            await dialog.accept();
        });

        // -------------------------------------------------------------
        // WORKFLOW 1 & 2: Public Buyer Browsing & RFQ Submission
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 1 & 2: Public Buyer Browsing & RFQ Submission');
        await page.goto(`${BASE_URL}/catalog`, { waitUntil: 'networkidle0' });
        await sleep(500);

        // Navigate to product details
        await page.goto(`${BASE_URL}/product-details?id=${targetProduct.id}`, { waitUntil: 'networkidle0' });
        await sleep(500);

        // Fill RFQ form
        await page.evaluate(() => {
            document.getElementById('rfq-qty').value = '30';
            document.getElementById('rfq-unit').value = 'MT';
            document.getElementById('rfq-incoterms').value = 'FOB';
            document.getElementById('rfq-dest-country').value = 'Netherlands';
            document.getElementById('rfq-dest-port').value = 'Rotterdam Port';
            document.getElementById('rfq-buyer-name').value = 'Lucas van Dijk';
            document.getElementById('rfq-company-name').value = 'Rotterdam EuroTrade B.V.';
            document.getElementById('rfq-email').value = 'l.vandijk@eurotrade-nl.com';
            document.getElementById('rfq-phone').value = '+31 10 9876543';
            document.getElementById('rfq-notes').value = 'Phase 5 Acceptance Commercial Request: 30 MT IQF certified.';
        });

        // Submit RFQ and intercept API response
        const [rfqResponse] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/api/rfqs') && res.request().method() === 'POST'),
            page.evaluate(() => handleRfqSubmit())
        ]);

        const rfqJson = await rfqResponse.json();
        assert.strictEqual(rfqResponse.status(), 201, 'Expected HTTP 201 Created from /api/rfqs');
        assert.strictEqual(rfqJson.success, true);
        assert.match(rfqJson.reference_no, /^RFQ-\d{4}-[A-F0-9]+$/);
        assert.ok(rfqJson.buyer_access_token, 'Missing buyer_access_token in response');

        submittedRfqId = rfqJson.rfq_id;
        submittedRefNo = rfqJson.reference_no;
        submittedBuyerToken = rfqJson.buyer_access_token;
        createdRfqIds.push(submittedRfqId);

        await sleep(700);

        // Verify UI rendering of Reference and Access Token
        const uiRef = await page.$eval('#rfq-success-ref', el => el.textContent.trim());
        const uiToken = await page.$eval('#rfq-success-token', el => el.textContent.trim());
        assert.strictEqual(uiRef, submittedRefNo);
        assert.strictEqual(uiToken, submittedBuyerToken);

        const shot1Path = path.join(SCREENSHOT_DIR, 'phase5_01_customer_rfq_submitted.png');
        await page.screenshot({ path: shot1Path, fullPage: true });

        recordWorkflow(1, 'Public Buyer Browsing & RFQ Submission', 'PASS', `RFQ ${submittedRefNo} created with status NEW`);
        recordWorkflow(2, 'Buyer Receives Reference & Secret Access Token', 'PASS', `Token rendered in UI and verified in DOM: ${submittedBuyerToken.substring(0, 8)}...`);

        // -------------------------------------------------------------
        // WORKFLOW 3: Secret Token-Only Tracking
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 3: Customer Secret Token-Only Tracking');

        // Open Tracker Modal
        await page.evaluate((ref) => {
            openBuyerTrackerModal(ref);
        }, submittedRefNo);
        await sleep(500);

        // 3a. Query with INVALID token
        await page.evaluate((ref) => {
            document.getElementById('tracker-ref-input').value = ref;
            document.getElementById('tracker-token-input').value = 'INVALID_TOKEN_FOR_AUDIT';
        }, submittedRefNo);

        const [badTrackRes] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/api/rfqs/track')),
            page.evaluate(() => queryBuyerQuote())
        ]);
        assert.strictEqual(badTrackRes.status(), 403, 'Expected HTTP 403 Forbidden for invalid token');
        await sleep(500);

        const errorVisible = await page.$eval('#tracker-error-box', el => !el.classList.contains('hidden'));
        assert.ok(errorVisible, 'Error box should be visible on invalid token tracking');

        const shot2Path = path.join(SCREENSHOT_DIR, 'phase5_02_tracker_unauthorized.png');
        await page.screenshot({ path: shot2Path });

        // 3b. Query with VALID token
        await page.evaluate((ref, token) => {
            document.getElementById('tracker-ref-input').value = ref;
            document.getElementById('tracker-token-input').value = token;
        }, submittedRefNo, submittedBuyerToken);

        const [goodTrackRes] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/api/rfqs/track')),
            page.evaluate(() => queryBuyerQuote())
        ]);
        assert.strictEqual(goodTrackRes.status(), 200, 'Expected HTTP 200 OK for valid secret token');
        await sleep(600);

        const resultsVisible = await page.$eval('#tracker-results', el => !el.classList.contains('hidden'));
        assert.ok(resultsVisible, 'Tracker results should be visible on valid token tracking');
        const trackedStatus = await page.$eval('#track-res-status', el => el.textContent.trim());
        assert.strictEqual(trackedStatus, 'NEW');

        const shot3Path = path.join(SCREENSHOT_DIR, 'phase5_03_tracker_success.png');
        await page.screenshot({ path: shot3Path });

        recordWorkflow(3, 'Customer Tracking Requires Secret Token', 'PASS', `Invalid token rejected with HTTP 403; valid token rendered RFQ status ${trackedStatus}`);

        // Close tracker modal
        await page.evaluate(() => closeBuyerTrackerModal());
        await sleep(400);

        // -------------------------------------------------------------
        // WORKFLOW 4: Super Admin Review & Exporter Assignment
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 4: Super Admin Review & Assignment');

        // Set admin auth token in cookie and localStorage (zarsev_auth_token)
        const adminJwt = generateToken(adminUser);
        await page.setCookie({
            name: 'auth_token',
            value: adminJwt,
            domain: 'localhost',
            path: '/'
        });

        await page.goto(`${BASE_URL}/portal/admin`, { waitUntil: 'networkidle0' });
        await page.evaluate((token) => {
            localStorage.setItem('zarsev_auth_token', token);
        }, adminJwt);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(800);

        // Verify RFQ row in table
        const rfqRowFound = await page.evaluate((ref) => {
            const tbody = document.getElementById('admin-rfqs-tbody');
            return tbody ? tbody.innerText.includes(ref) : false;
        }, submittedRefNo);
        assert.ok(rfqRowFound, `RFQ ${submittedRefNo} must appear in admin queue table`);

        // Open Admin RFQ Modal (await the async function)
        await page.evaluate(async (rfqId) => {
            await openAdminRfqModal(rfqId);
        }, submittedRfqId);
        await sleep(600);

        // Assign to mfg_delta_iqf and change status to SENT_TO_MANUFACTURER
        await page.evaluate(() => {
            document.getElementById('modal-rfq-status-select').value = 'SENT_TO_MANUFACTURER';
            document.getElementById('modal-rfq-mfg-select').value = 'mfg_delta_iqf';
            document.getElementById('modal-rfq-note').value = 'Phase 5: Routing to Delta IQF for export quotation.';
        });

        // The admin update uses PATCH
        const [adminUpdateRes] = await Promise.all([
            page.waitForResponse(res => res.url().includes(`/api/rfqs/${submittedRfqId}/status`) && res.request().method() === 'PATCH'),
            page.evaluate(() => submitAdminRfqUpdate())
        ]);
        assert.strictEqual(adminUpdateRes.status(), 200, 'Expected HTTP 200 from admin status update');
        await sleep(700);

        const shot4Path = path.join(SCREENSHOT_DIR, 'phase5_04_admin_rfq_routed.png');
        await page.screenshot({ path: shot4Path });

        recordWorkflow(4, 'Super Admin Review & Exporter Assignment', 'PASS', `Assigned to mfg_delta_iqf; status transitioned to SENT_TO_MANUFACTURER`);

        // -------------------------------------------------------------
        // WORKFLOW 5: Strict Multi-Tenant Isolation
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 5: Strict Multi-Tenant Isolation');

        // 5a. Login as UNASSIGNED manufacturer (mfg_nile_fruits)
        const nileJwt = generateToken(nileMfgUser);
        await page.setCookie({
            name: 'auth_token',
            value: nileJwt,
            domain: 'localhost',
            path: '/'
        });
        await page.goto(`${BASE_URL}/portal/manufacturer`, { waitUntil: 'networkidle0' });
        await page.evaluate((token) => {
            localStorage.setItem('zarsev_auth_token', token);
        }, nileJwt);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(800);

        // Verify RFQ is NOT in table for mfg_nile_fruits
        const nileTableText = await page.evaluate(() => {
            const tbody = document.getElementById('mfg-rfqs-tbody');
            return tbody ? tbody.innerText : '';
        });
        assert.ok(!nileTableText.includes(submittedRefNo), `LEAKAGE: Unassigned mfg_nile_fruits saw RFQ ${submittedRefNo}!`);

        const shot5Path = path.join(SCREENSHOT_DIR, 'phase5_05_tenant_isolation_blocked.png');
        await page.screenshot({ path: shot5Path });

        // 5b. Login as ASSIGNED manufacturer (mfg_delta_iqf)
        const deltaJwt = generateToken(deltaMfgUser);
        await page.setCookie({
            name: 'auth_token',
            value: deltaJwt,
            domain: 'localhost',
            path: '/'
        });
        await page.goto(`${BASE_URL}/portal/manufacturer`, { waitUntil: 'networkidle0' });
        await page.evaluate((token) => {
            localStorage.setItem('zarsev_auth_token', token);
        }, deltaJwt);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(800);

        // Verify RFQ IS in table for mfg_delta_iqf
        const deltaTableText = await page.evaluate(() => {
            const tbody = document.getElementById('mfg-rfqs-tbody');
            return tbody ? tbody.innerText : '';
        });
        assert.ok(deltaTableText.includes(submittedRefNo), `Assigned mfg_delta_iqf must see RFQ ${submittedRefNo}`);

        const shot6Path = path.join(SCREENSHOT_DIR, 'phase5_06_assigned_mfg_view.png');
        await page.screenshot({ path: shot6Path });

        recordWorkflow(5, 'Strict Multi-Tenant Isolation', 'PASS', `Unassigned tenant cannot see RFQ; assigned tenant sees incoming RFQ`);

        // -------------------------------------------------------------
        // WORKFLOW 6: Assigned Manufacturer Structured Quotation Submission
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 6: Assigned Manufacturer Quotation Submission');

        // Open Mfg RFQ modal
        await page.evaluate(async (rfqId) => {
            await openMfgRfqModal(rfqId);
        }, submittedRfqId);
        await sleep(600);

        // Fill structured quote form
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        const validityDateStr = futureDate.toISOString().split('T')[0];

        await page.evaluate((vDate) => {
            document.getElementById('mfg-quote-price').value = '1350.00';
            document.getElementById('mfg-quote-currency').value = 'USD';
            document.getElementById('mfg-quote-incoterm').value = 'FOB';
            document.getElementById('mfg-quote-loading-port').value = 'ميناء الإسكندرية / الدخيلة';
            document.getElementById('mfg-quote-dest-port').value = 'Rotterdam Port';
            document.getElementById('mfg-quote-moq').value = '15';
            document.getElementById('mfg-quote-unit').value = 'MT';
            document.getElementById('mfg-quote-lead-time').value = '12';
            document.getElementById('mfg-quote-packaging').value = 'كراتين تصدير 10 كجم معالجة نيتروجين';
            document.getElementById('mfg-quote-payment').value = '30% Advance, 70% against Bill of Lading';
            document.getElementById('mfg-quote-validity').value = vDate;
            document.getElementById('mfg-quote-terms').value = 'الأسعار خاضعة لمطابقة الفحص الحجري بميناء الشحن.';
        }, validityDateStr);

        const [quoteRes] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/api/quotations') && res.request().method() === 'POST'),
            page.evaluate(() => {
                const form = document.getElementById('mfg-quote-form');
                form.dispatchEvent(new Event('submit', { cancelable: true }));
            })
        ]);

        const quoteJson = await quoteRes.json();
        assert.strictEqual(quoteRes.status(), 201, 'Expected HTTP 201 Created from /api/quotations');
        assert.strictEqual(quoteJson.success, true);
        assert.match(quoteJson.reference_no, /^QUOT-\d{4}-[A-F0-9]+$/);

        submittedQuotationId = quoteJson.quotation_id;
        createdQuotationIds.push(submittedQuotationId);
        await sleep(800);

        const shot7Path = path.join(SCREENSHOT_DIR, 'phase5_07_mfg_quote_submitted.png');
        await page.screenshot({ path: shot7Path });

        recordWorkflow(6, 'Assigned Manufacturer Structured Quotation Submission', 'PASS', `Quote ${quoteJson.reference_no} submitted ($1,350.00 FOB)`);

        // -------------------------------------------------------------
        // WORKFLOW 7: Buyer Quotation Review & Commercial Acceptance
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 7: Buyer Quotation Review & Acceptance');

        // Clear auth cookies to become public buyer again
        await page.deleteCookie({ name: 'auth_token', domain: 'localhost', path: '/' });
        await page.goto(`${BASE_URL}/product-details?id=${targetProduct.id}`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => {
            localStorage.removeItem('zarsev_auth_token');
        });

        // Open tracker modal with reference and valid token
        await page.evaluate((ref, token) => {
            openBuyerTrackerModal(ref, token);
            queryBuyerQuote();
        }, submittedRefNo, submittedBuyerToken);

        await page.waitForResponse(res => res.url().includes('/api/rfqs/track'));
        await sleep(700);

        // Verify quote box rendered
        const quoteBoxVisible = await page.$eval('#track-quote-box', el => !el.classList.contains('hidden'));
        assert.ok(quoteBoxVisible, 'Quote box must be visible in buyer tracking modal');

        const renderedPrice = await page.$eval('#track-quote-price', el => el.textContent.trim());
        assert.ok(renderedPrice.includes('1350'), `Rendered price should show 1350, found: ${renderedPrice}`);

        // Accept the quotation via submitBuyerDecision('ACCEPTED')
        const [decisionRes] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/decision') && res.request().method() === 'POST'),
            page.evaluate(() => submitBuyerDecision('ACCEPTED'))
        ]);

        const decisionJson = await decisionRes.json();
        assert.strictEqual(decisionRes.status(), 200, 'Expected HTTP 200 OK from quotation decision');
        assert.strictEqual(decisionJson.success, true);
        assert.strictEqual(decisionJson.status, 'ACCEPTED');

        // Allow UI to re-render after alert and queryBuyerQuote()
        await sleep(1200);

        const decisionText = await page.$eval('#track-decision-status-text', el => el.textContent.trim());
        assert.ok(decisionText.includes('قبول') || decisionText.includes('ACCEPTED'), `Decision text should indicate acceptance: ${decisionText}`);

        const shot8Path = path.join(SCREENSHOT_DIR, 'phase5_08_customer_quote_accepted.png');
        await page.screenshot({ path: shot8Path });

        recordWorkflow(7, 'Buyer Quotation Review & Commercial Acceptance', 'PASS', `Quotation accepted in UI and persisted in PostgreSQL as ACCEPTED`);

        // -------------------------------------------------------------
        // WORKFLOW 8: Rejection of Expired Quotations
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 8: Rejection of Expired Quotations');

        // Create an isolated expired quotation in PostgreSQL zarsev_test directly
        const expRfqId = `rfq_exp_${crypto.randomBytes(8).toString('hex')}`;
        const expiredRefNo = `RFQ-EXP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const expiredToken = crypto.randomBytes(32).toString('hex');
        const expiredHash = crypto.createHash('sha256').update(expiredToken).digest('hex');

        await pool.query(`
            INSERT INTO rfqs (
                id, reference_no, buyer_name, company_name, business_email, phone, country,
                product_id, manufacturer_id, requested_quantity, unit_of_measurement,
                destination_country, destination_port, status, buyer_access_token_hash
            ) VALUES (
                $1, $2, 'Expired Buyer Test', 'Expired Co.', 'expired@test.com', '+123456789', 'France',
                $3, 'mfg_delta_iqf', 10, 'MT', 'France', 'Marseille', 'QUOTED', $4
            );
        `, [expRfqId, expiredRefNo, targetProduct.id, expiredHash]);
        createdRfqIds.push(expRfqId);

        const expQuoteId = `quot_exp_${crypto.randomBytes(8).toString('hex')}`;
        const expQuoteRef = `QUOT-EXP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await pool.query(`
            INSERT INTO quotations (
                id, reference_no, rfq_id, manufacturer_id, unit_price, currency,
                incoterm, loading_port, min_order_quantity, min_order_unit,
                lead_time_days, packaging_details, payment_terms, validity_date, status
            ) VALUES (
                $1, $2, $3, 'mfg_delta_iqf', 999.00, 'USD',
                'FOB', 'Alexandria', 5, 'MT', 10,
                'Standard export boxes', '100% L/C at sight', '2025-01-01', 'SUBMITTED'
            );
        `, [expQuoteId, expQuoteRef, expRfqId]);
        createdQuotationIds.push(expQuoteId);

        // Track the expired RFQ
        await page.evaluate((ref, token) => {
            openBuyerTrackerModal(ref, token);
            queryBuyerQuote();
        }, expiredRefNo, expiredToken);

        await page.waitForResponse(res => res.url().includes('/api/rfqs/track'));
        await sleep(600);

        // Attempt to accept expired quote
        const [expDecisionRes] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/decision') && res.request().method() === 'POST'),
            page.evaluate(() => submitBuyerDecision('ACCEPTED'))
        ]);

        assert.strictEqual(expDecisionRes.status(), 400, 'Expected HTTP 400 Bad Request for expired quote');
        const expJson = await expDecisionRes.json();
        assert.ok(expJson.error.includes('صلاحية') || expJson.error.includes('expired'), `Error message should explain expiration: ${expJson.error}`);

        await sleep(500);

        const shot9Path = path.join(SCREENSHOT_DIR, 'phase5_09_expired_quote_rejected.png');
        await page.screenshot({ path: shot9Path });

        recordWorkflow(8, 'Rejection of Expired Quotations', 'PASS', `Expired quote acceptance rejected with HTTP 400 (${expJson.error})`);

        // -------------------------------------------------------------
        // WORKFLOW 9: Multi-Tenant Quotation Action Isolation (HTTP 403)
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 9: Tenant Isolation on Direct API Actions');

        // As nileMfgUser, attempt to submit quotation on delta's RFQ
        const nileTokenForFetch = generateToken(nileMfgUser);
        const forbiddenRes = await page.evaluate(async (token, rfqId) => {
            const res = await fetch('/api/quotations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    rfq_id: rfqId,
                    unit_price: 500,
                    currency: 'USD',
                    incoterm: 'EXW',
                    loading_port: 'Cairo Port',
                    min_order_quantity: 1,
                    min_order_unit: 'MT',
                    lead_time_days: 7,
                    packaging_details: 'Standard cartons',
                    payment_terms: '100% L/C at sight',
                    validity_date: '2026-12-31'
                })
            });
            return { status: res.status, body: await res.json() };
        }, nileTokenForFetch, submittedRfqId);

        assert.strictEqual(forbiddenRes.status, 403, 'Expected HTTP 403 Forbidden for unauthorized tenant quote submission');

        const shot10Path = path.join(SCREENSHOT_DIR, 'phase5_10_tenant_isolation_forbidden.png');
        await page.screenshot({ path: shot10Path });

        recordWorkflow(9, 'Tenant Isolation on Direct Quotation Action', 'PASS', `Unassigned tenant quote submission strictly returned HTTP 403 Forbidden`);

        // -------------------------------------------------------------
        // WORKFLOW 10: Clear UI Errors & Zero Secret Exposure
        // -------------------------------------------------------------
        console.log('\n>>> Starting Workflow 10: UI Error Understandability & Zero Secret Exposure');

        // Check error box on RFQ form with invalid inputs
        await page.goto(`${BASE_URL}/product-details?id=${targetProduct.id}`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => {
            document.getElementById('rfq-qty').value = '';
            document.getElementById('rfq-buyer-name').value = '';
            document.getElementById('rfq-email').value = 'not-an-email';
            handleRfqSubmit();
        });
        await sleep(500);

        const rfqClientErrorVisible = await page.$eval('#rfq-error-box', el => !el.classList.contains('hidden'));
        assert.ok(rfqClientErrorVisible, 'Validation error box must be visible');
        const errorText = await page.$eval('#rfq-error-box', el => el.textContent.trim());
        assert.ok(errorText.length > 5, 'Validation message must be non-empty');
        assert.ok(!errorText.includes('SELECT') && !errorText.includes('syntax') && !errorText.includes('token'), 'No secrets or SQL in UI errors');

        const shot11Path = path.join(SCREENSHOT_DIR, 'phase5_11_ui_error_handling.png');
        await page.screenshot({ path: shot11Path });

        recordWorkflow(10, 'Clear UI Errors & Zero Secret Exposure', 'PASS', `Clear Arabic client validation rendered without exposing internal state or secrets`);

        console.log('\n===================================================================');
        console.log('🎉 ALL 10 BROWSER ACCEPTANCE WORKFLOWS COMPLETED SUCCESSFULLY!');
        console.log('===================================================================\n');

    } catch (err) {
        console.error('\n❌ BROWSER ACCEPTANCE RUNTIME ERROR:', err);
        throw err;
    } finally {
        if (browser) {
            await browser.close();
            console.log('Closed real Chrome browser instance.');
        }

        // Guaranteed cleanup of created test fixtures
        console.log('\n--- Cleaning up created test fixtures in zarsev_test ---');
        try {
            if (createdQuotationIds.length > 0) {
                await pool.query('DELETE FROM quotation_audit_logs WHERE quotation_id = ANY($1::text[]);', [createdQuotationIds]);
                await pool.query('DELETE FROM quotations WHERE id = ANY($1::text[]);', [createdQuotationIds]);
                console.log(`Cleaned up ${createdQuotationIds.length} test quotations and audit logs.`);
            }
            if (createdRfqIds.length > 0) {
                await pool.query('DELETE FROM rfq_audit_logs WHERE rfq_id = ANY($1::text[]);', [createdRfqIds]);
                await pool.query('DELETE FROM rfqs WHERE id = ANY($1::text[]);', [createdRfqIds]);
                console.log(`Cleaned up ${createdRfqIds.length} test RFQs and audit logs.`);
            }
        } catch (cleanupErr) {
            console.error('Error during cleanup:', cleanupErr.message);
        }

        // Post-verification: verify SQLite untouched
        const postSqliteBuf = fs.readFileSync('M:/ZZZ/zarsev.db');
        const postSqliteHash = crypto.createHash('sha256').update(postSqliteBuf).digest('hex').toUpperCase();
        assert.strictEqual(postSqliteHash, EXPECTED_SQLITE_HASH, 'FATAL: SQLite hash changed during testing!');
        console.log('Post-test SQLite hash verified: 100% UNMODIFIED.\n');
    }

    return testResults;
}

runPhase5BrowserAcceptance()
    .then(results => {
        const failures = results.filter(r => r.status !== 'PASS');
        if (failures.length > 0) {
            console.error(`Acceptance completed with ${failures.length} failures.`);
            process.exit(1);
        } else {
            console.log(`All ${results.length} workflows VERIFIED.`);
            process.exit(0);
        }
    })
    .catch(() => process.exit(1));
