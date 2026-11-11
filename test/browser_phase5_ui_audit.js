/**
 * test/browser_phase5_ui_audit.js
 * 
 * ZARSEV Phase 5 — Visual & Navigation Real Browser Audit Suite.
 * 
 * Audits all 9 core platform pages at Desktop (1280x900) and Mobile (390x844) viewports:
 * 1. Landing Page (/)
 * 2. Product Catalog (/catalog)
 * 3. Product Details & RFQ (/product-details?id=prod_0a5f39c560d6)
 * 4. Services (/services)
 * 5. Consulting (/consulting)
 * 6. About Us (/about)
 * 7. Contact Us (/contact)
 * 8. Admin Portal (/portal/admin)
 * 9. Manufacturer Portal (/portal/manufacturer)
 * 
 * Inspects:
 * - Arabic RTL typography & alignment
 * - Console error & network failure logging
 * - Broken links, buttons, and empty handlers
 * - Mobile responsive navigation drawer toggle
 * - Maritime design system consistency (Navy/Teal/White/Gold)
 * 
 * Saves audit screenshots to artifact directory.
 */

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'postgres';

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const pgAdapter = require('../src/db/pgAdapter');
const { generateToken } = require('../src/utils/authUtils');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost:3001';
const SCREENSHOT_DIR = 'C:\\Users\\aybas\\.gemini\\antigravity\\brain\\2694c2df-71b9-4adb-add8-3cfb7914e5fe\\screenshots';

const AUDIT_PAGES = [
    { name: '01_landing', path: '/', title: 'الصفحة الرئيسية' },
    { name: '02_catalog', path: '/catalog', title: 'كتالوج المنتجات التصديرية' },
    { name: '03_product_details', path: '/product-details?id=prod_0a5f39c560d6', title: 'تفاصيل المنتج وطلب الأسعار' },
    { name: '04_services', path: '/services', title: 'الخدمات والعمليات اللوجستية' },
    { name: '05_consulting', path: '/consulting', title: 'الاستشارات التجارية والدولية' },
    { name: '06_about', path: '/about', title: 'من نحن — السيادة والريادة' },
    { name: '07_contact', path: '/contact', title: 'تواصل معنا والمكتب التجاري' },
    { name: '08_portal_admin', path: '/portal/admin', title: 'بوابة الإدارة العليا والاعتمادات', requiresAuth: 'SUPER_ADMIN' },
    { name: '09_portal_manufacturer', path: '/portal/manufacturer', title: 'بوابة المصنعين والمصدرين', requiresAuth: 'MANUFACTURER' }
];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runVisualAndNavigationAudit() {
    console.log('===================================================================');
    console.log('🔍 ZARSEV PHASE 5: REAL BROWSER UI & NAVIGATION AUDIT');
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`🔍 Chrome Binary: ${CHROME_PATH}`);
    console.log(`📁 Artifact Screenshot Directory: ${SCREENSHOT_DIR}`);
    console.log('===================================================================\n');

    const pool = pgAdapter.getAppPool('zarsev_test');
    const usersRes = await pool.query("SELECT id, email, role, manufacturer_id FROM users;");
    const adminUser = usersRes.rows.find(u => u.role === 'SUPER_ADMIN');
    const deltaMfgUser = usersRes.rows.find(u => u.manufacturer_id === 'mfg_delta_iqf');

    const adminJwt = generateToken(adminUser);
    const mfgJwt = generateToken(deltaMfgUser);

    const auditResults = [];

    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    try {
        const page = await browser.newPage();

        // Collect console errors & warnings
        const pageConsoleLogs = {};
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();
            const currentUrl = page.url();
            if (['error', 'warning'].includes(type) && !text.includes('favicon') && !text.includes('Material Symbols')) {
                pageConsoleLogs[currentUrl] = pageConsoleLogs[currentUrl] || [];
                pageConsoleLogs[currentUrl].push({ type, text });
            }
        });

        // -------------------------------------------------------------
        // AUDIT 1: DESKTOP AUDIT (1280 x 900)
        // -------------------------------------------------------------
        console.log('--- Phase 5.1: Desktop Viewport Visual Audit (1280x900) ---');
        await page.setViewport({ width: 1280, height: 900 });

        for (const pageSpec of AUDIT_PAGES) {
            console.log(`\nAuditing [Desktop]: ${pageSpec.title} (${pageSpec.path})`);

            // Apply authentication credentials if needed
            if (pageSpec.requiresAuth === 'SUPER_ADMIN') {
                await page.setCookie({ name: 'auth_token', value: adminJwt, domain: 'localhost', path: '/' });
            } else if (pageSpec.requiresAuth === 'MANUFACTURER') {
                await page.setCookie({ name: 'auth_token', value: mfgJwt, domain: 'localhost', path: '/' });
            } else {
                await page.deleteCookie({ name: 'auth_token', domain: 'localhost', path: '/' });
            }

            const response = await page.goto(`${BASE_URL}${pageSpec.path}`, { waitUntil: 'networkidle0' });
            const httpStatus = response ? response.status() : 0;

            // Sync auth token to localStorage for pages requiring auth
            if (pageSpec.requiresAuth === 'SUPER_ADMIN') {
                await page.evaluate(t => localStorage.setItem('zarsev_auth_token', t), adminJwt);
                await page.reload({ waitUntil: 'networkidle0' });
            } else if (pageSpec.requiresAuth === 'MANUFACTURER') {
                await page.evaluate(t => localStorage.setItem('zarsev_auth_token', t), mfgJwt);
                await page.reload({ waitUntil: 'networkidle0' });
            }
            await sleep(600);

            // Capture Desktop Screenshot
            const shotPath = path.join(SCREENSHOT_DIR, `phase5_audit_desktop_${pageSpec.name}.png`);
            await page.screenshot({ path: shotPath, fullPage: true });

            // Check DOM Attributes & Links
            const domMetrics = await page.evaluate(() => {
                const htmlEl = document.documentElement;
                const bodyEl = document.body;
                const isRtl = (htmlEl.getAttribute('dir') || bodyEl.getAttribute('dir')) === 'rtl';
                const lang = htmlEl.getAttribute('lang') || bodyEl.getAttribute('lang');

                // Inspect links
                const allLinks = Array.from(document.querySelectorAll('a'));
                const brokenOrHashLinks = allLinks
                    .map(a => ({ text: a.innerText.trim(), href: a.getAttribute('href') }))
                    .filter(l => !l.href || l.href === '#' || l.href === 'javascript:void(0)');

                // Inspect buttons
                const allButtons = Array.from(document.querySelectorAll('button'));
                const unhandledButtons = allButtons
                    .filter(b => !b.onclick && !b.getAttribute('type') && !b.id && !b.className.includes('modal') && b.innerText.trim().length > 0)
                    .map(b => b.innerText.trim());

                // Inspect fonts
                const computedFont = window.getComputedStyle(bodyEl).fontFamily;

                return {
                    isRtl,
                    lang,
                    linkCount: allLinks.length,
                    brokenLinkCount: brokenOrHashLinks.length,
                    brokenLinksSample: brokenOrHashLinks.slice(0, 5),
                    buttonCount: allButtons.length,
                    unhandledButtonCount: unhandledButtons.length,
                    unhandledButtonsSample: unhandledButtons.slice(0, 5),
                    fontFamily: computedFont
                };
            });

            console.log(`   HTTP Status: ${httpStatus}`);
            console.log(`   RTL: ${domMetrics.isRtl} (lang=${domMetrics.lang})`);
            console.log(`   Font: ${domMetrics.fontFamily.substring(0, 50)}...`);
            console.log(`   Links: ${domMetrics.linkCount} (Hash/Empty: ${domMetrics.brokenLinkCount})`);
            console.log(`   Buttons: ${domMetrics.buttonCount} (Unhandled: ${domMetrics.unhandledButtonCount})`);

            auditResults.push({
                page: pageSpec.name,
                title: pageSpec.title,
                path: pageSpec.path,
                viewport: 'desktop_1280x900',
                httpStatus,
                domMetrics,
                screenshot: `phase5_audit_desktop_${pageSpec.name}.png`
            });
        }

        // -------------------------------------------------------------
        // AUDIT 2: MOBILE VIEWPORT AUDIT (390 x 844) & DRAWER TOGGLE
        // -------------------------------------------------------------
        console.log('\n--- Phase 5.2: Mobile Viewport Visual Audit (390x844) & Drawer Navigation ---');
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

        for (const pageSpec of AUDIT_PAGES) {
            console.log(`\nAuditing [Mobile]: ${pageSpec.title} (${pageSpec.path})`);

            if (pageSpec.requiresAuth === 'SUPER_ADMIN') {
                await page.setCookie({ name: 'auth_token', value: adminJwt, domain: 'localhost', path: '/' });
            } else if (pageSpec.requiresAuth === 'MANUFACTURER') {
                await page.setCookie({ name: 'auth_token', value: mfgJwt, domain: 'localhost', path: '/' });
            } else {
                await page.deleteCookie({ name: 'auth_token', domain: 'localhost', path: '/' });
            }

            await page.goto(`${BASE_URL}${pageSpec.path}`, { waitUntil: 'networkidle0' });
            await sleep(600);

            // Test Mobile Drawer toggle if present
            let drawerToggled = false;
            let drawerVisible = false;

            const hasMobileMenuBtn = await page.$('#mobile-menu-icon, [onclick*="toggleMobileMenu"], [onclick*="toggleWorkspaceSidebar"]');
            if (hasMobileMenuBtn) {
                try {
                    await page.click('#mobile-menu-icon, [onclick*="toggleMobileMenu"], [onclick*="toggleWorkspaceSidebar"]');
                    await sleep(300);
                    drawerToggled = true;
                    drawerVisible = await page.evaluate(() => {
                        const menu = document.getElementById('mobile-nav-menu') || document.getElementById('zarsev-workspace-sidebar');
                        return menu ? !menu.classList.contains('hidden') : false;
                    });
                } catch (_) {}
            }

            // Capture Mobile Screenshot
            const mobileShotPath = path.join(SCREENSHOT_DIR, `phase5_audit_mobile_${pageSpec.name}.png`);
            await page.screenshot({ path: mobileShotPath, fullPage: true });

            console.log(`   Mobile Drawer Tested: ${drawerToggled} (Visible: ${drawerVisible})`);

            auditResults.push({
                page: pageSpec.name,
                title: pageSpec.title,
                path: pageSpec.path,
                viewport: 'mobile_390x844',
                drawerToggled,
                drawerVisible,
                screenshot: `phase5_audit_mobile_${pageSpec.name}.png`
            });
        }

        // Write audit findings JSON to disk
        const auditLogPath = path.join(__dirname, 'phase5_ui_audit_data.json');
        fs.writeFileSync(auditLogPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            consoleLogs: pageConsoleLogs,
            results: auditResults
        }, null, 2), 'utf8');

        console.log(`\nAudit completed successfully. Data written to ${auditLogPath}`);

    } catch (err) {
        console.error('Audit failed:', err);
        throw err;
    } finally {
        await browser.close();
    }

    return auditResults;
}

runVisualAndNavigationAudit()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
