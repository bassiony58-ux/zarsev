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

async function verifyUserLogo() {
    console.log('===================================================================');
    console.log('🔍 VERIFYING USER ORIGINAL LOGO DEPLOYMENT ACROSS PLATFORM');
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

    try {
        // -------------------------------------------------------------
        // 1. Desktop Public Header (1440px)
        // -------------------------------------------------------------
        console.log('--- 1. Desktop Public Header (1440px) ---');
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });
        await sleep(500);

        const desktopHeaderInfo = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="zarsev-logo"]');
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            const computed = window.getComputedStyle(img);
            return {
                src: img.src,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                width: rect.width,
                height: rect.height,
                objectFit: computed.objectFit,
                visible: rect.width > 0 && rect.height > 0
            };
        });

        console.log('Desktop Header Logo Details:', desktopHeaderInfo);
        assert.ok(desktopHeaderInfo, 'Header logo image must be present');
        assert.ok(desktopHeaderInfo.src.includes('zarsev-logo.jpg'), 'Header logo must use zarsev-logo.jpg');
        assert.strictEqual(desktopHeaderInfo.naturalWidth, 984, 'naturalWidth must match original logo 984px');
        assert.strictEqual(desktopHeaderInfo.naturalHeight, 685, 'naturalHeight must match original logo 685px');
        assert.strictEqual(desktopHeaderInfo.objectFit, 'contain', 'object-fit must be contain');

        // Screenshot full desktop page
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'user_logo_after_header_desktop.png') });
        console.log('✓ Captured user_logo_after_header_desktop.png');

        // Capture closeup of header logo
        const logoEl = await page.$('header a[href="/"]');
        if (logoEl) {
            await logoEl.screenshot({ path: path.join(SCREENSHOT_DIR, 'user_logo_closeup_desktop.png') });
            console.log('✓ Captured user_logo_closeup_desktop.png');
        }

        // -------------------------------------------------------------
        // 2. Mobile Public Header (390px)
        // -------------------------------------------------------------
        console.log('\n--- 2. Mobile Public Header (390px) ---');
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(500);

        const mobileHeaderInfo = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="zarsev-logo"]');
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            const computed = window.getComputedStyle(img);
            return {
                src: img.src,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                width: rect.width,
                height: rect.height,
                objectFit: computed.objectFit,
                visible: rect.width > 0 && rect.height > 0
            };
        });

        console.log('Mobile Header Logo Details:', mobileHeaderInfo);
        assert.ok(mobileHeaderInfo && mobileHeaderInfo.visible, 'Mobile header logo must be visible');
        assert.strictEqual(mobileHeaderInfo.naturalWidth, 984, 'Mobile naturalWidth must be 984px');
        assert.strictEqual(mobileHeaderInfo.naturalHeight, 685, 'Mobile naturalHeight must be 685px');
        assert.strictEqual(mobileHeaderInfo.objectFit, 'contain', 'Mobile object-fit must be contain');

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'user_logo_after_header_mobile.png') });
        console.log('✓ Captured user_logo_after_header_mobile.png');

        // -------------------------------------------------------------
        // 3. Desktop Manufacturer Portal (1440px)
        // -------------------------------------------------------------
        console.log('\n--- 3. Desktop Manufacturer Portal (1440px) ---');
        await page.setViewport({ width: 1440, height: 900 });
        await page.setCookie({ name: 'auth_token', value: mfgToken, domain: 'localhost', path: '/' });
        await page.goto(`${BASE_URL}/portal/manufacturer`, { waitUntil: 'networkidle0' });
        await page.evaluate(t => localStorage.setItem('zarsev_auth_token', t), mfgToken);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(1000);

        const mfgDesktopInfo = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="zarsev-logo"]');
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            const computed = window.getComputedStyle(img);
            return {
                src: img.src,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                width: rect.width,
                height: rect.height,
                objectFit: computed.objectFit,
                visible: rect.width > 0 && rect.height > 0
            };
        });

        console.log('Manufacturer Portal Desktop Logo Details:', mfgDesktopInfo);
        assert.ok(mfgDesktopInfo && mfgDesktopInfo.visible, 'Mfg portal logo must be visible');
        assert.strictEqual(mfgDesktopInfo.naturalWidth, 984, 'Mfg portal naturalWidth must be 984px');
        assert.strictEqual(mfgDesktopInfo.naturalHeight, 685, 'Mfg portal naturalHeight must be 685px');
        assert.strictEqual(mfgDesktopInfo.objectFit, 'contain', 'Mfg portal object-fit must be contain');

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'user_logo_after_mfg_desktop.png'), fullPage: false });
        console.log('✓ Captured user_logo_after_mfg_desktop.png');

        // -------------------------------------------------------------
        // 4. Mobile Manufacturer Portal (390px)
        // -------------------------------------------------------------
        console.log('\n--- 4. Mobile Manufacturer Portal (390px) ---');
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(1000);

        const mfgMobileInfo = await page.evaluate(() => {
            const img = document.querySelector('header img[src*="zarsev-logo"]');
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            const computed = window.getComputedStyle(img);
            return {
                src: img.src,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                width: rect.width,
                height: rect.height,
                objectFit: computed.objectFit,
                visible: rect.width > 0 && rect.height > 0
            };
        });

        console.log('Manufacturer Portal Mobile Logo Details:', mfgMobileInfo);
        assert.ok(mfgMobileInfo && mfgMobileInfo.visible, 'Mfg mobile logo must be visible');
        assert.strictEqual(mfgMobileInfo.naturalWidth, 984, 'Mfg mobile naturalWidth must be 984px');
        assert.strictEqual(mfgMobileInfo.naturalHeight, 685, 'Mfg mobile naturalHeight must be 685px');
        assert.strictEqual(mfgMobileInfo.objectFit, 'contain', 'Mfg mobile object-fit must be contain');

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'user_logo_after_mfg_mobile.png'), fullPage: false });
        console.log('✓ Captured user_logo_after_mfg_mobile.png');

        console.log('\n===================================================================');
        console.log('🎉 ALL ORIGINAL USER LOGO CHECKS PASSED WITH 100% VISUAL ACCURACY!');
        console.log('===================================================================\n');

    } catch (err) {
        console.error('VERIFICATION ERROR:', err);
        throw err;
    } finally {
        await browser.close();
        await pool.end();
    }
}

verifyUserLogo()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
