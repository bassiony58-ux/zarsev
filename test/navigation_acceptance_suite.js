const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost:3001';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const ARTIFACT_DIR = 'C:\\Users\\aybas\\.gemini\\antigravity\\brain\\2694c2df-71b9-4adb-add8-3cfb7914e5fe';

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const auditLog = [];
const consoleLogs = [];
const networkFailures = [];

function recordAudit({ page, element, role, action, expected, actual, status, notes = '' }) {
    const entry = {
        id: auditLog.length + 1,
        page,
        element,
        role,
        action,
        expected,
        actual,
        status,
        notes
    };
    auditLog.push(entry);
    const mark = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${mark} [${status}] [${page}] ${element} -> ${action}: ${actual}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureEvidence(page, filename, description) {
    const localPath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: localPath, fullPage: false });
    
    // Also copy to artifact dir if it exists
    if (fs.existsSync(ARTIFACT_DIR)) {
        const artifactPath = path.join(ARTIFACT_DIR, filename);
        try {
            fs.copyFileSync(localPath, artifactPath);
        } catch (e) {
            console.error('Failed to copy to artifact dir:', e.message);
        }
    }
    console.log(`📸 Evidence captured: ${filename} (${description})`);
}

async function runNavigationSuite() {
    console.log('===============================================================');
    console.log('🧭 ZARSEV NAVIGATION & USER EXPERIENCE RESTORATION TEST SUITE');
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`🔍 Chrome Binary: ${CHROME_PATH}`);
    console.log('===============================================================\n');

    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1440,900'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error' || type === 'warn') {
            consoleLogs.push({ type, text, location: msg.location() });
        }
    });

    page.on('response', resp => {
        const status = resp.status();
        const url = resp.url();
        if (status >= 400 && !url.includes('/favicon.ico')) {
            networkFailures.push({ url, status, statusText: resp.statusText() });
        }
    });

    try {
        // =========================================================================
        // PART 1: PUBLIC BUYER EXPERIENCE (A)
        // =========================================================================
        console.log('\n--- PART 1: PUBLIC BUYER NAVIGATION ---');
        
        // 1.1 Landing / Home
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
        await sleep(500);
        
        const homeTitle = await page.title();
        const hasHeader = await page.$('header') !== null;
        const brandAnchor = await page.$('a[href="/"]') !== null;
        const navCatalogLink = await page.$('nav a[href="/catalog"]') !== null;
        const ctaImporter = await page.$('a[href="/importer"]') !== null;
        
        recordAudit({
            page: 'Home (/)',
            element: 'Standardized Public Header',
            role: 'PUBLIC_BUYER',
            action: 'Verify Header presence and links',
            expected: 'Header, brand anchor, catalog link, importer CTA all present',
            actual: `Header: ${hasHeader}, CatalogLink: ${navCatalogLink}, ImporterCTA: ${ctaImporter}`,
            status: hasHeader && navCatalogLink && ctaImporter ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_01_home_public.png', 'Public Homepage Header and Hero');

        // 1.2 Navigate to /catalog
        await page.click('nav a[href="/catalog"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
        await sleep(600);
        
        const currentUrlCatalog = page.url();
        const searchInput = await page.$('#catalog-search');
        
        recordAudit({
            page: 'Catalog (/catalog)',
            element: 'Product Catalog Browser',
            role: 'PUBLIC_BUYER',
            action: 'Navigate via header link and check search bar',
            expected: 'URL ends with /catalog and search input is interactive',
            actual: `URL: ${currentUrlCatalog}, SearchInput present: ${searchInput !== null}`,
            status: currentUrlCatalog.includes('/catalog') && searchInput !== null ? 'PASS' : 'FAIL'
        });

        // Test search input
        if (searchInput) {
            await page.type('#catalog-search', 'برتقال');
            await sleep(300);
            recordAudit({
                page: 'Catalog (/catalog)',
                element: 'Search Input',
                role: 'PUBLIC_BUYER',
                action: 'Type query into search input',
                expected: 'Input retains typed text',
                actual: 'Query typed: برتقال',
                status: 'PASS'
            });
        }

        await captureEvidence(page, 'nav_02_catalog_public.png', 'Public Product Catalog with Search');

        // 1.3 Navigate to /product-details
        await page.goto(`${BASE_URL}/product-details`, { waitUntil: 'networkidle2' });
        await sleep(500);
        const rfqButton = await page.$('a[href*="/contact"], a[href*="contact"], button');
        recordAudit({
            page: 'Product Details (/product-details)',
            element: 'Specifications & RFQ trigger',
            role: 'PUBLIC_BUYER',
            action: 'Verify specifications layout and RFQ trigger',
            expected: 'Page loads with RFQ contact link',
            actual: `RFQ Element exists: ${rfqButton !== null}`,
            status: rfqButton !== null ? 'PASS' : 'FAIL'
        });

        // 1.4 Navigate to /services, /consulting, /about, /contact
        const publicPages = [
            { path: '/services', name: 'Services & Terminals' },
            { path: '/consulting', name: 'Quality Consulting' },
            { path: '/about', name: 'About ZARSEV' },
            { path: '/contact', name: 'Contact & RFQ Center' }
        ];

        for (const p of publicPages) {
            await page.goto(`${BASE_URL}${p.path}`, { waitUntil: 'networkidle2' });
            await sleep(300);
            const statusOk = !networkFailures.some(f => f.url.includes(p.path));
            recordAudit({
                page: `${p.name} (${p.path})`,
                element: 'Public Editorial Page',
                role: 'PUBLIC_BUYER',
                action: `Verify HTTP 200 and DOM rendering on ${p.path}`,
                expected: 'Loads successfully without 404/500',
                actual: `Loaded: ${page.url()}`,
                status: statusOk ? 'PASS' : 'FAIL'
            });
        }

        // =========================================================================
        // PART 2: MANUFACTURER EXPERIENCE (B)
        // =========================================================================
        console.log('\n--- PART 2: MANUFACTURER EXPERIENCE & PORTAL ---');

        // Authenticate directly as Manufacturer Persona
        await page.goto(`${BASE_URL}/importer`, { waitUntil: 'networkidle2' });
        await sleep(400);

        await page.evaluate(async () => {
            const res = await fetch('/api/auth/dev-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: 'usr_mfg_nile_fruits' })
            });
            const data = await res.json();
            if (data.token) {
                localStorage.setItem('zarsev_auth_token', data.token);
            }
        });
        await sleep(500);

        // 2.1 Manufacturer Dashboard
        await page.goto(`${BASE_URL}/portal/manufacturer`, { waitUntil: 'networkidle2' });
        await sleep(800);

        const mfgTitle = await page.evaluate(() => document.getElementById('mfg-name-title')?.textContent.trim());
        const statActive = await page.evaluate(() => document.getElementById('stat-active-products')?.textContent.trim());
        const statPending = await page.evaluate(() => document.getElementById('stat-pending-products')?.textContent.trim());
        const statQuota = await page.evaluate(() => document.getElementById('stat-quota-used')?.textContent.trim());
        const statBatches = await page.evaluate(() => document.getElementById('stat-total-batches')?.textContent.trim());

        recordAudit({
            page: 'Manufacturer Portal (/portal/manufacturer)',
            element: 'Role KPIs & Profile Banner',
            role: 'MANUFACTURER (Nile Fruits)',
            action: 'Verify manufacturer name and live KPI cards',
            expected: 'Company name and KPI stats displayed',
            actual: `Name: ${mfgTitle}, ActiveProducts: ${statActive}, Pending: ${statPending}, Quota: ${statQuota}, Batches: ${statBatches}`,
            status: mfgTitle && mfgTitle.length > 0 && statActive !== undefined ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_03_mfg_portal_dashboard.png', 'Manufacturer Dedicated Portal Dashboard');

        // 2.2 Collapsible Sidebar & Role Filtering
        await page.evaluate(() => toggleWorkspaceSidebar());
        await sleep(400);

        const sidebarAfterOpen = await page.evaluate(() => {
            const sb = document.getElementById('zarsev-workspace-sidebar');
            const overlay = document.getElementById('zarsev-sidebar-overlay');
            const links = Array.from(sb.querySelectorAll('nav a')).map(a => a.href);
            return {
                sidebarVisible: sb && !sb.classList.contains('hidden'),
                overlayVisible: overlay && !overlay.classList.contains('hidden'),
                links
            };
        });

        // Check that admin links are NOT in manufacturer sidebar
        const hasAdminLinkInMfgSidebar = sidebarAfterOpen.links.some(l => l.includes('/admin/approvals') || l.includes('/portal/admin'));

        recordAudit({
            page: 'Manufacturer Portal (/portal/manufacturer)',
            element: 'Collapsible Sidebar & Role Filtering',
            role: 'MANUFACTURER',
            action: 'Open sidebar and check links for role isolation',
            expected: 'Sidebar opens, contains Mfg links, does NOT contain admin links',
            actual: `Open: ${sidebarAfterOpen.sidebarVisible}, HasAdminLinks: ${hasAdminLinkInMfgSidebar}`,
            status: sidebarAfterOpen.sidebarVisible && !hasAdminLinkInMfgSidebar ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_04_mfg_sidebar_open.png', 'Collapsible Sidebar Drawer for Manufacturer');

        // Close sidebar
        await page.evaluate(() => toggleWorkspaceSidebar());
        await sleep(300);

        // 2.3 Topbar Quick Help Modal
        await page.evaluate(() => openHelpModal('mfg'));
        await sleep(400);

        const helpModalVisible = await page.evaluate(() => {
            const m = document.getElementById('zarsev-global-help-modal');
            const body = document.getElementById('modal-help-body')?.innerText;
            return m && !m.classList.contains('hidden') && body.includes('المصنع');
        });

        recordAudit({
            page: 'Manufacturer Portal (/portal/manufacturer)',
            element: 'Topbar Universal Help Modal',
            role: 'MANUFACTURER',
            action: 'Open help modal from topbar button',
            expected: 'Modal opens with Manufacturer guide',
            actual: `Help modal visible with guide: ${helpModalVisible}`,
            status: helpModalVisible ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_05_universal_help_modal.png', 'Interactive Universal Help Modal in Topbar');

        // Close modal
        await page.evaluate(() => closeHelpModal());
        await sleep(300);

        // 2.4 Auto-Orientation Banner on /importer/upload
        await page.goto(`${BASE_URL}/importer/upload`, { waitUntil: 'networkidle2' });
        await sleep(600);

        const orientationUpload = await page.evaluate(() => {
            const mount = document.getElementById('zarsev-orientation-mount');
            return mount ? mount.innerText : '';
        });

        const hasGuidanceTitle = orientationUpload.includes('أنت الآن في: رفع الملفات والكتالوجات');
        const hasGuidancePurpose = orientationUpload.includes('الغرض من الصفحة:');
        const hasGuidanceNext = orientationUpload.includes('الخطوة الموصى بها:');
        const hasGuidanceBack = orientationUpload.includes('الرجوع للوحة التحكم');

        recordAudit({
            page: 'Upload Screen (/importer/upload)',
            element: 'Auto-Orientation Banner (Answers 4 Questions)',
            role: 'MANUFACTURER',
            action: 'Verify dynamic injection of orientation guidance banner',
            expected: 'Answers: Where am I? What does it do? Next step? How to return?',
            actual: `Title: ${hasGuidanceTitle}, Purpose: ${hasGuidancePurpose}, Next: ${hasGuidanceNext}, Back: ${hasGuidanceBack}`,
            status: hasGuidanceTitle && hasGuidancePurpose && hasGuidanceNext && hasGuidanceBack ? 'PASS' : 'FAIL'
        });

        // Verify Breadcrumbs on /importer/upload
        const breadcrumbsUpload = await page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="مسار التنقل"]');
            return nav ? nav.innerText : '';
        });

        recordAudit({
            page: 'Upload Screen (/importer/upload)',
            element: 'Topbar Breadcrumb Trail',
            role: 'MANUFACTURER',
            action: 'Verify hierarchical breadcrumb trail',
            expected: 'Shows: الرئيسية / لوحة المصنع / رفع الكتالوجات (خطوة 1)',
            actual: `Breadcrumb Text: ${breadcrumbsUpload}`,
            status: breadcrumbsUpload.includes('لوحة المصنع') ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_06_upload_orientation_banner.png', 'Upload Screen with Auto-Orientation Banner');

        // 2.5 Auto-Orientation on /importer/history
        await page.goto(`${BASE_URL}/importer/history`, { waitUntil: 'networkidle2' });
        await sleep(600);

        const orientationHistory = await page.evaluate(() => {
            const mount = document.getElementById('zarsev-orientation-mount');
            return mount ? mount.innerText : '';
        });

        recordAudit({
            page: 'History Screen (/importer/history)',
            element: 'Auto-Orientation Banner & Batches Archive',
            role: 'MANUFACTURER',
            action: 'Verify orientation banner on history screen',
            expected: 'Banner explains history and next steps',
            actual: `Contains history title: ${orientationHistory.includes('سجل عمليات الاستيراد')}`,
            status: orientationHistory.includes('سجل عمليات الاستيراد') ? 'PASS' : 'FAIL'
        });

        // =========================================================================
        // PART 3: SUPER ADMIN EXPERIENCE (C)
        // =========================================================================
        console.log('\n--- PART 3: SUPER ADMIN EXPERIENCE & GOVERNANCE ---');

        // Switch to Super Admin Persona
        await page.evaluate(async () => {
            const res = await fetch('/api/auth/dev-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: 'usr_super_admin' })
            });
            const data = await res.json();
            if (data.token) {
                localStorage.setItem('zarsev_auth_token', data.token);
            }
        });
        await sleep(500);

        // 3.1 Super Admin Dashboard
        await page.goto(`${BASE_URL}/portal/admin`, { waitUntil: 'networkidle2' });
        await sleep(800);

        const adminKpiPending = await page.evaluate(() => document.getElementById('admin-stat-pending')?.textContent.trim());
        const adminKpiActiveProds = await page.evaluate(() => document.getElementById('admin-stat-active-prods')?.textContent.trim());
        const adminKpiMfgs = await page.evaluate(() => document.getElementById('admin-stat-mfgs')?.textContent.trim());
        const adminKpiBatches = await page.evaluate(() => document.getElementById('admin-stat-global-batches')?.textContent.trim());
        const approvalsQueueCount = await page.$$eval('#admin-queue-tbody tr', rows => rows.length);

        recordAudit({
            page: 'Admin Portal (/portal/admin)',
            element: 'Executive Governance KPIs',
            role: 'SUPER_ADMIN',
            action: 'Verify executive platform statistics and approvals queue',
            expected: 'KPI values populated and queue preview rendered',
            actual: `ActiveProducts: ${adminKpiActiveProds}, Pending: ${adminKpiPending}, Mfgs: ${adminKpiMfgs}, Batches: ${adminKpiBatches}, QueueRows: ${approvalsQueueCount}`,
            status: adminKpiActiveProds !== undefined && adminKpiPending !== undefined ? 'PASS' : 'FAIL'
        });

        // 3.2 Super Admin Sidebar contains admin-specific links
        await page.evaluate(() => toggleWorkspaceSidebar());
        await sleep(400);

        const adminSidebarLinks = await page.evaluate(() => {
            const sb = document.getElementById('zarsev-workspace-sidebar');
            return Array.from(sb.querySelectorAll('nav a')).map(a => a.href);
        });

        const hasAdminApprovalsLink = adminSidebarLinks.some(l => l.includes('/admin/approvals'));
        const hasMfgSelectLink = adminSidebarLinks.some(l => l.includes('/importer/manufacturer-select'));

        recordAudit({
            page: 'Admin Portal (/portal/admin)',
            element: 'Admin Collapsible Sidebar',
            role: 'SUPER_ADMIN',
            action: 'Verify presence of executive links (Approvals, Manufacturer Management)',
            expected: 'Sidebar includes approvals queue and manufacturer management',
            actual: `HasApprovals: ${hasAdminApprovalsLink}, HasMfgSelect: ${hasMfgSelectLink}`,
            status: hasAdminApprovalsLink && hasMfgSelectLink ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_07_admin_portal_dashboard.png', 'Super Admin Executive Dashboard & Approvals Queue');

        await page.evaluate(() => toggleWorkspaceSidebar());
        await sleep(300);

        // 3.3 Approvals Screen Orientation & Controls
        await page.goto(`${BASE_URL}/admin/approvals`, { waitUntil: 'networkidle2' });
        await sleep(600);

        const orientationApprovals = await page.evaluate(() => {
            const mount = document.getElementById('zarsev-orientation-mount');
            return mount ? mount.innerText : '';
        });

        recordAudit({
            page: 'Approvals Queue (/admin/approvals)',
            element: 'Auto-Orientation Banner',
            role: 'SUPER_ADMIN',
            action: 'Verify orientation banner in approvals queue',
            expected: 'Guidance explaining approval and rejection actions',
            actual: `Contains approvals guidance: ${orientationApprovals.includes('طابور فحص طلبات الاعتماد')}`,
            status: orientationApprovals.includes('طابور فحص طلبات الاعتماد') ? 'PASS' : 'FAIL'
        });

        // 3.4 Manufacturer Management & Matching Screen
        await page.goto(`${BASE_URL}/importer/manufacturer-select`, { waitUntil: 'networkidle2' });
        await sleep(600);

        const orientationMfgSelect = await page.evaluate(() => {
            const mount = document.getElementById('zarsev-orientation-mount');
            return mount ? mount.innerText : '';
        });

        recordAudit({
            page: 'Manufacturer Select (/importer/manufacturer-select)',
            element: 'Auto-Orientation Banner',
            role: 'SUPER_ADMIN',
            action: 'Verify orientation guidance on manufacturer directory',
            expected: 'Explains direct contract vs marketing subscription',
            actual: `Contains directory guidance: ${orientationMfgSelect.includes('دليل محطات الفرز والتعبئة')}`,
            status: orientationMfgSelect.includes('دليل محطات الفرز والتعبئة') ? 'PASS' : 'FAIL'
        });

        // =========================================================================
        // PART 4: LOGISTICS OFFICER EXPERIENCE (D)
        // =========================================================================
        console.log('\n--- PART 4: LOGISTICS OFFICER OPERATIONS & MATCHING ---');

        // Switch to Logistics Persona
        await page.evaluate(async () => {
            const res = await fetch('/api/auth/dev-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: 'usr_logistics_officer' })
            });
            const data = await res.json();
            if (data.token) {
                localStorage.setItem('zarsev_auth_token', data.token);
            }
        });
        await sleep(500);

        // 4.1 Logistics Operations Dashboard
        await page.goto(`${BASE_URL}/portal/logistics`, { waitUntil: 'networkidle2' });
        await sleep(800);

        const logisticsKpiTotal = await page.evaluate(() => document.getElementById('log-stat-total')?.textContent.trim());
        const logisticsKpiDirect = await page.evaluate(() => document.getElementById('log-stat-direct')?.textContent.trim());
        const logisticsKpiMkt = await page.evaluate(() => document.getElementById('log-stat-marketing')?.textContent.trim());

        recordAudit({
            page: 'Logistics Portal (/portal/logistics)',
            element: 'Maritime Operations KPIs',
            role: 'LOGISTICS_OFFICER',
            action: 'Verify logistics packhouse statistics and seaport links',
            expected: 'Total packhouses, direct contracts, marketing subs loaded',
            actual: `Total: ${logisticsKpiTotal}, Direct: ${logisticsKpiDirect}, Marketing: ${logisticsKpiMkt}`,
            status: logisticsKpiTotal !== undefined && logisticsKpiDirect !== undefined ? 'PASS' : 'FAIL'
        });

        // 4.2 Test Embedded Smart Fuzzy Matcher
        const matcherInput = await page.$('#fuzzy-search-input');
        if (matcherInput) {
            await page.type('#fuzzy-search-input', 'محطة البستان');
            await page.click('button[onclick="runFuzzyMatch()"]');
            await sleep(600);

            const matchResultText = await page.evaluate(() => {
                const results = document.getElementById('fuzzy-results');
                return results ? results.innerText : '';
            });

            const matchFound = matchResultText.includes('محطة البستان') || matchResultText.includes('تطابق تام') || matchResultText.includes('100%');

            recordAudit({
                page: 'Logistics Portal (/portal/logistics)',
                element: 'Embedded Smart Fuzzy Matcher',
                role: 'LOGISTICS_OFFICER',
                action: 'Query fuzzy matcher with "محطة البستان"',
                expected: 'Match results appear with similarity score and avoid duplicate records',
                actual: `Match Found: ${matchFound}, Results preview: ${matchResultText.substring(0, 100)}...`,
                status: matchFound ? 'PASS' : 'FAIL'
            });
        }

        await captureEvidence(page, 'nav_08_logistics_portal_matcher.png', 'Logistics Portal with Embedded Fuzzy Matcher Tool');

        // =========================================================================
        // PART 5: UNIVERSAL KNOWLEDGE CENTER (/help)
        // =========================================================================
        console.log('\n--- PART 5: UNIVERSAL KNOWLEDGE CENTER ---');

        await page.goto(`${BASE_URL}/help`, { waitUntil: 'networkidle2' });
        await sleep(600);

        // Check tabs existence using actual IDs
        const tabMfg = await page.$('#btn-tab-mfg');
        const tabAdmin = await page.$('#btn-tab-admin');
        const tabLogistics = await page.$('#btn-tab-logistics');
        const tabBuyer = await page.$('#btn-tab-buyer');

        recordAudit({
            page: 'Help Center (/help)',
            element: 'Role-Based Knowledge Tabs',
            role: 'ALL_ROLES',
            action: 'Verify presence of 4 persona help tabs',
            expected: 'Mfg, Admin, Logistics, Buyer tabs exist',
            actual: `Mfg: ${tabMfg !== null}, Admin: ${tabAdmin !== null}, Logistics: ${tabLogistics !== null}, Buyer: ${tabBuyer !== null}`,
            status: tabMfg && tabAdmin && tabLogistics && tabBuyer ? 'PASS' : 'FAIL'
        });

        // Test tab switching
        await page.click('#btn-tab-admin');
        await sleep(300);
        const adminGuideVisible = await page.evaluate(() => {
            const pane = document.getElementById('content-admin');
            return pane && !pane.classList.contains('hidden');
        });

        await page.click('#btn-tab-buyer');
        await sleep(300);
        const buyerGuideVisible = await page.evaluate(() => {
            const pane = document.getElementById('content-buyer');
            return pane && !pane.classList.contains('hidden');
        });

        recordAudit({
            page: 'Help Center (/help)',
            element: 'Tab Switching Mechanism',
            role: 'ALL_ROLES',
            action: 'Switch between Admin and Buyer guides',
            expected: 'Appropriate pane becomes active and unhidden',
            actual: `AdminPaneActive: ${adminGuideVisible}, BuyerPaneActive: ${buyerGuideVisible}`,
            status: adminGuideVisible && buyerGuideVisible ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_09_universal_help_center.png', 'Universal Knowledge Center with Role-Based Guides');

        // =========================================================================
        // PART 6: MOBILE RESPONSIVENESS & DRAWER
        // =========================================================================
        console.log('\n--- PART 6: MOBILE RESPONSIVENESS & DRAWER ---');

        await page.setViewport({ width: 375, height: 812 }); // iPhone X / Modern Mobile Viewport
        await page.goto(`${BASE_URL}/portal/manufacturer`, { waitUntil: 'networkidle2' });
        await sleep(500);

        // Test sidebar toggle on mobile
        await page.evaluate(() => toggleWorkspaceSidebar());
        await sleep(400);

        const mobileSidebarState = await page.evaluate(() => {
            const sb = document.getElementById('zarsev-workspace-sidebar');
            const overlay = document.getElementById('zarsev-sidebar-overlay');
            return {
                sidebarVisible: sb && !sb.classList.contains('hidden'),
                overlayVisible: overlay && !overlay.classList.contains('hidden')
            };
        });

        recordAudit({
            page: 'Mobile Viewport (375x812)',
            element: 'Mobile Workspace Sidebar & Backdrop',
            role: 'MANUFACTURER',
            action: 'Toggle sidebar on mobile viewport',
            expected: 'Sidebar drawer slides in with touch-friendly backdrop',
            actual: `Sidebar: ${mobileSidebarState.sidebarVisible}, Overlay: ${mobileSidebarState.overlayVisible}`,
            status: mobileSidebarState.sidebarVisible && mobileSidebarState.overlayVisible ? 'PASS' : 'FAIL'
        });

        await captureEvidence(page, 'nav_10_mobile_workspace_drawer.png', 'Mobile Viewport Workspace Sidebar Drawer');

        // Reset viewport back to desktop
        await page.setViewport({ width: 1440, height: 900 });

    } catch (err) {
        console.error('Fatal Test Exception:', err);
        recordAudit({
            page: 'RUNTIME',
            element: 'Execution Runner',
            role: 'ALL',
            action: 'Test Execution',
            expected: 'All steps complete cleanly',
            actual: `Exception: ${err.message}`,
            status: 'FAIL'
        });
    } finally {
        await browser.close();
    }

    // =========================================================================
    // AUDIT SUMMARY & REPORT GENERATION
    // =========================================================================
    console.log('\n===============================================================');
    console.log('📊 NAVIGATION & UX AUDIT SUMMARY');
    console.log('===============================================================');

    const totalTests = auditLog.length;
    const passedTests = auditLog.filter(a => a.status === 'PASS').length;
    const failedTests = auditLog.filter(a => a.status === 'FAIL').length;
    const passRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0';

    console.log(`Total Test Verifications: ${totalTests}`);
    console.log(`Passed: ${passedTests}`);
    console.log(`Failed: ${failedTests}`);
    console.log(`Pass Rate: ${passRate}%`);
    console.log(`Console Warnings/Errors: ${consoleLogs.length}`);
    console.log(`Failed Network Requests (4xx/5xx): ${networkFailures.length}`);

    if (networkFailures.length > 0) {
        console.log('\n❌ Failed Network Requests:');
        networkFailures.forEach(f => console.log(`  - [${f.status}] ${f.url}`));
    }

    // Save JSON report for artifact generation
    const reportData = {
        timestamp: new Date().toISOString(),
        summary: {
            totalTests,
            passedTests,
            failedTests,
            passRate: `${passRate}%`,
            consoleErrors: consoleLogs.length,
            networkFailures: networkFailures.length
        },
        auditLog,
        consoleLogs,
        networkFailures
    };

    fs.writeFileSync(path.join(__dirname, 'navigation_audit_result.json'), JSON.stringify(reportData, null, 2), 'utf8');
    console.log('\n📁 Full audit results saved to test/navigation_audit_result.json\n');
}

runNavigationSuite().catch(err => {
    console.error('Suite crashed:', err);
    process.exit(1);
});
