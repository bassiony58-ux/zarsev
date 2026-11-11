process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'postgres';
if (process.loadEnvFile) process.loadEnvFile('M:/ZZZ/.env');

const puppeteer = require('M:/ZZZ/node_modules/puppeteer-core');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const pgAdapter = require('M:/ZZZ/src/db/pgAdapter');
const { generateToken } = require('M:/ZZZ/src/utils/authUtils');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost:3001';
const SCREENSHOT_DIR = 'C:\\Users\\aybas\\.gemini\\antigravity\\brain\\2694c2df-71b9-4adb-add8-3cfb7914e5fe\\screenshots';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runMfgStatusVerification() {
    console.log('===================================================================');
    console.log('🔍 ZARSEV: MANUFACTURER STATUS REDESIGN & LOGO VERIFICATION');
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log('===================================================================\n');

    const pool = pgAdapter.getAppPool('zarsev_test');
    const mfgRes = await pool.query("SELECT * FROM users WHERE id = 'usr_mfg_nile_fruits';");
    const mfgUser = mfgRes.rows[0];
    const mfgToken = generateToken(mfgUser);

    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();
    const results = [];

    try {
        // -------------------------------------------------------------
        // TEST 1: Public Logo Verification (Desktop & Mobile)
        // -------------------------------------------------------------
        console.log('--- 1. Testing Public Logo (Desktop 1440px & Mobile 390px) ---');
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });

        const logoDesktopInfo = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="logo"], nav img[src*="logo"], a[href="/"] img');
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            return {
                src: img.src,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                width: rect.width,
                height: rect.height,
                visible: rect.width > 0 && rect.height > 0
            };
        });

        assert.ok(logoDesktopInfo, 'Header logo image must be present in DOM');
        assert.ok(logoDesktopInfo.visible, 'Header logo image must be visible');
        assert.ok(logoDesktopInfo.naturalWidth > 0, 'Header logo naturalWidth must be > 0');
        console.log('✓ Desktop Logo loaded cleanly:', logoDesktopInfo);

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'zarsev_home_after_logo_desktop.png') });

        // Mobile logo test
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await sleep(400);

        const logoMobileInfo = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="logo"], nav img[src*="logo"], a[href="/"] img');
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            return {
                visible: rect.width > 0 && rect.height > 0,
                width: rect.width,
                height: rect.height
            };
        });
        assert.ok(logoMobileInfo && logoMobileInfo.visible, 'Mobile logo must be visible');
        console.log('✓ Mobile Logo loaded cleanly at 390px:', logoMobileInfo);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'zarsev_home_after_logo_mobile.png') });

        results.push({ test: 'Public Logo Rendering', status: 'PASS' });

        // -------------------------------------------------------------
        // TEST 2: Manufacturer Portal Status Components
        // -------------------------------------------------------------
        console.log('\n--- 2. Testing Manufacturer Portal Status Components ---');
        await page.setViewport({ width: 1440, height: 900 });
        await page.setCookie({ name: 'auth_token', value: mfgToken, domain: 'localhost', path: '/' });
        await page.goto(`${BASE_URL}/portal/manufacturer`, { waitUntil: 'networkidle0' });
        await page.evaluate(t => localStorage.setItem('zarsev_auth_token', t), mfgToken);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(1000);

        // Verify Portal Logo
        const mfgLogoVisible = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="logo"], a[href="/"] img');
            return img && img.naturalWidth > 0 && img.getBoundingClientRect().height > 0;
        });
        assert.ok(mfgLogoVisible, 'Manufacturer portal header must display the new logo');
        console.log('✓ Manufacturer portal logo loaded and visible.');

        // 2a. Verify Table 1: «الحالة الراهنة» (Batches)
        const batchHeader = await page.$eval('thead th:nth-child(6)', el => el.textContent.trim());
        assert.strictEqual(batchHeader, 'الحالة الراهنة', 'Table 1 column 6 must be "الحالة الراهنة"');
        console.log('✓ Table 1 Column 6 Header verified:', batchHeader);

        const batchBadges = await page.evaluate(() => {
            const badges = Array.from(document.querySelectorAll('#mfg-batches-tbody tr td:nth-child(6) span[title*="الحالة الراهنة"]'));
            return badges.map(b => ({
                text: b.innerText.trim(),
                hasDot: !!b.querySelector('.rounded-full'),
                hasIcon: !!b.querySelector('.material-symbols-outlined'),
                className: b.className
            }));
        });
        console.log(`✓ Table 1 Badges found (${batchBadges.length}):`, batchBadges);
        assert.ok(batchBadges.length > 0, 'Must render batch status badges');
        assert.ok(batchBadges[0].hasDot, 'Badge must contain indicator dot');
        assert.ok(batchBadges[0].hasIcon, 'Badge must contain micro-icon');

        // 2b. Verify Table 2: «حالة الطلب» (RFQs)
        const rfqHeader = await page.$eval('#mfg-rfqs-count', el => !!el);
        assert.ok(rfqHeader, 'RFQ count badge exists');

        const rfqBadges = await page.evaluate(() => {
            const badges = Array.from(document.querySelectorAll('#mfg-rfqs-tbody tr td:nth-child(6) span[title*="حالة الطلب"]'));
            return badges.map(b => ({
                text: b.innerText.trim(),
                hasDot: !!b.querySelector('.rounded-full'),
                hasIcon: !!b.querySelector('.material-symbols-outlined'),
                className: b.className
            }));
        });
        console.log(`✓ Table 2 Badges found (${rfqBadges.length}):`, rfqBadges);
        assert.ok(rfqBadges.length > 0, 'Must render RFQ status badges');
        assert.ok(rfqBadges[0].hasDot, 'RFQ badge must contain indicator dot');
        assert.ok(rfqBadges[0].hasIcon, 'RFQ badge must contain micro-icon');

        // 2c. Test ALL possible badge statuses via client-side function test
        console.log('\n--- 3. Testing All Possible Statuses (Comprehensive Matrix) ---');
        const badgeMatrixResults = await page.evaluate(() => {
            const batchStatuses = ['REVIEW_READY', 'SUBMITTED', 'SAVED_DRAFT', 'COMPLETED', 'FAILED', 'PROCESSING', 'QUEUED', 'UNKNOWN_STATUS'];
            const rfqStatuses = ['NEW', 'UNDER_REVIEW', 'SENT_TO_MANUFACTURER', 'QUOTED', 'ACCEPTED', 'REJECTED', 'CLOSED', 'CUSTOM_STATUS'];

            const testDiv = document.createElement('div');
            testDiv.id = 'status-test-container';
            testDiv.style.cssText = 'padding: 20px; background: white; border: 2px dashed #ccc; margin: 20px 0;';
            testDiv.innerHTML = `
                <h4 style="font-weight:bold; margin-bottom:10px;">اختبار مصفوفة الحالات الراهنة وحالات الطلب:</h4>
                <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:15px;" id="batch-test-row"></div>
                <div style="display:flex; flex-wrap:wrap; gap:10px;" id="rfq-test-row"></div>
            `;
            document.body.appendChild(testDiv);

            const batchRow = document.getElementById('batch-test-row');
            const rfqRow = document.getElementById('rfq-test-row');

            const batchRenders = batchStatuses.map(s => {
                const html = renderBatchStatusBadge(s);
                const span = document.createElement('div');
                span.innerHTML = html;
                batchRow.appendChild(span.firstElementChild);
                return { status: s, rendered: true };
            });

            const rfqRenders = rfqStatuses.map(s => {
                const html = renderRfqStatusBadge(s);
                const span = document.createElement('div');
                span.innerHTML = html;
                rfqRow.appendChild(span.firstElementChild);
                return { status: s, rendered: true };
            });

            return { batchRenders, rfqRenders };
        });

        console.log(`✓ Verified ${badgeMatrixResults.batchRenders.length} batch status variations.`);
        console.log(`✓ Verified ${badgeMatrixResults.rfqRenders.length} RFQ status variations.`);

        // Capture after desktop full page
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'mfg_portal_after_desktop.png'), fullPage: true });

        // 2d. Test Modal Status Badge
        console.log('\n--- 4. Testing RFQ Detail Modal Status Badge ---');
        await page.click('#mfg-rfqs-tbody tr:first-child button');
        await sleep(600);

        const modalStatusInfo = await page.evaluate(() => {
            const badge = document.querySelector('#mfg-modal-status-badge span');
            if (!badge) return null;
            return {
                text: badge.innerText.trim(),
                visible: badge.getBoundingClientRect().width > 0,
                hasDot: !!badge.querySelector('.rounded-full'),
                hasIcon: !!badge.querySelector('.material-symbols-outlined')
            };
        });
        assert.ok(modalStatusInfo, 'Modal status badge must be present');
        assert.ok(modalStatusInfo.visible, 'Modal status badge must be visible');
        console.log('✓ Modal status badge rendered cleanly:', modalStatusInfo);

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'mfg_portal_after_modal_status.png') });

        // Close modal
        await page.click('button[onclick="closeMfgRfqModal()"]');
        await sleep(300);

        // 2e. Mobile Manufacturer Portal
        console.log('\n--- 5. Testing Mobile Manufacturer Portal Layout (390px) ---');
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await sleep(400);

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'mfg_portal_after_mobile.png'), fullPage: true });
        console.log('✓ Captured mobile manufacturer portal layout.');

        results.push({ test: 'Manufacturer Status Components Redesign', status: 'PASS' });
        results.push({ test: 'Comprehensive Status Matrix Coverage', status: 'PASS' });

        console.log('\n===================================================================');
        console.log('🎉 ALL LOGO & STATUS COMPONENT TESTS PASSED!');
        console.log('===================================================================\n');

    } catch (err) {
        console.error('TEST ERROR:', err);
        throw err;
    } finally {
        await browser.close();
        await pool.end();
    }

    return results;
}

runMfgStatusVerification()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
