/**
 * ZARSEV Maritime Sovereign Common Client JS
 * Handles Signed JWT Authentication, Dev Persona Switching, Responsive Sidebar,
 * Breadcrumbs, Role-Filtered Navigation, Orientation Banners, and Help Center.
 */

// Global Mobile Navigation Drawer Toggle (Public Portal)
function toggleMobileMenu() {
    const menu = document.getElementById('mobile-nav-menu');
    const icon = document.getElementById('mobile-menu-icon');
    if (menu) {
        const isHidden = menu.classList.contains('hidden');
        if (isHidden) {
            menu.classList.remove('hidden');
            if (icon) icon.textContent = 'close';
        } else {
            menu.classList.add('hidden');
            if (icon) icon.textContent = 'menu';
        }
    }
}

// Workspace Collapsible Sidebar Toggle
function toggleWorkspaceSidebar() {
    const sidebar = document.getElementById('zarsev-workspace-sidebar');
    const overlay = document.getElementById('zarsev-sidebar-overlay');
    if (sidebar) {
        sidebar.classList.toggle('hidden');
    }
    if (overlay) {
        overlay.classList.toggle('hidden');
    }
}

// Universal Help Modal Handlers
function openHelpModal(role = '') {
    let modal = document.getElementById('zarsev-global-help-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'zarsev-global-help-modal';
        modal.className = 'fixed inset-0 z-50 bg-[#001830]/70 backdrop-blur-sm flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white rounded-2xl max-w-2xl w-full p-6 md:p-8 shadow-2xl border border-[#E4E7EC] space-y-5 text-right relative max-h-[90vh] overflow-y-auto">
                <div class="flex items-center justify-between pb-3 border-b border-[#E4E7EC]">
                    <div class="flex items-center gap-2.5">
                        <div class="w-10 h-10 rounded-xl bg-[#EBF5F5] text-[#1F686E] flex items-center justify-center">
                            <span class="material-symbols-outlined text-[24px]">help</span>
                        </div>
                        <div>
                            <h3 class="font-bold text-[#172D46] text-base">دليل استخدام منصة زارسيف السريع</h3>
                            <p class="text-xs text-[#74777E]">إرشادات فورية لكيفية أداء المهام وفق دورك الحالي</p>
                        </div>
                    </div>
                    <button type="button" onclick="closeHelpModal()" class="text-[#74777E] hover:text-[#BA1A1A] p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                        <span class="material-symbols-outlined text-[20px]">close</span>
                    </button>
                </div>

                <!-- Role Guide Tabs -->
                <div class="flex items-center gap-2 border-b border-[#E4E7EC] pb-2 overflow-x-auto text-xs">
                    <button type="button" onclick="switchModalHelpTab('mfg')" id="modal-tab-mfg" class="px-3.5 py-1.5 rounded-lg font-bold bg-[#1F686E] text-white">🏭 المصنع</button>
                    <button type="button" onclick="switchModalHelpTab('admin')" id="modal-tab-admin" class="px-3.5 py-1.5 rounded-lg font-semibold text-[#43474D] hover:bg-gray-100">👑 الإدارة</button>
                    <button type="button" onclick="switchModalHelpTab('logistics')" id="modal-tab-logistics" class="px-3.5 py-1.5 rounded-lg font-semibold text-[#43474D] hover:bg-gray-100">⚓ اللوجستيات</button>
                    <button type="button" onclick="switchModalHelpTab('buyer')" id="modal-tab-buyer" class="px-3.5 py-1.5 rounded-lg font-semibold text-[#43474D] hover:bg-gray-100">🌍 المشتري الدولي</button>
                </div>

                <div id="modal-help-body" class="space-y-4 text-xs text-[#43474D] leading-relaxed">
                    <!-- Populated dynamically -->
                </div>

                <div class="pt-4 border-t border-[#E4E7EC] flex items-center justify-between">
                    <a href="/help" class="text-xs text-[#1F686E] font-bold hover:underline flex items-center gap-1">
                        <span>فتح مركز المعرفة الكامل</span>
                        <span class="material-symbols-outlined text-[16px]">open_in_new</span>
                    </a>
                    <button type="button" onclick="closeHelpModal()" class="px-5 py-2 rounded-lg bg-[#172D46] text-white font-bold text-xs">
                        إغلاق الدليل
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    } else {
        modal.classList.remove('hidden');
    }

    switchModalHelpTab(role || 'mfg');
}

function closeHelpModal() {
    const modal = document.getElementById('zarsev-global-help-modal');
    if (modal) modal.classList.add('hidden');
}

function switchModalHelpTab(tab) {
    const guides = {
        'mfg': `
            <div class="space-y-3">
                <div class="p-3 rounded-lg bg-[#EBF5F5] text-[#1F686E] font-bold">خطوات عمل المصنع ومستورد الكتالوجات:</div>
                <ol class="space-y-2 list-decimal list-inside text-[#172D46]">
                    <li><strong>رفع الكتالوج:</strong> ارفع ملفك (Excel/CSV/PDF) من صفحة <a href="/importer/upload" class="text-[#1F686E] underline">رفع الكتالوجات</a>.</li>
                    <li><strong>متابعة الاستخراج:</strong> انتظر حتى يصل مؤشر الذكاء الاصطناعي إلى 100%.</li>
                    <li><strong>المراجعة والتدقيق:</strong> افحص الأصناف في شاشة المراجعة، وصحح الأسعار أو أضف منتجات يدوية.</li>
                    <li><strong>التقديم للاعتماد:</strong> انقر على "إرسال كل المنتجات للاعتماد" لنقل الدفعة لإدارة المنصة.</li>
                </ol>
                <div class="p-3 bg-amber-50 rounded-lg text-amber-800 text-[11px]">
                    <strong>تنبيه:</strong> لن تظهر المنتجات للجمهور إلا بعد اعتمادها رسمياً من قِبل المدير العام.
                </div>
            </div>
        `,
        'admin': `
            <div class="space-y-3">
                <div class="p-3 rounded-lg bg-amber-50 text-amber-900 font-bold">مهام الإدارة العليا والرقابة:</div>
                <ol class="space-y-2 list-decimal list-inside text-[#172D46]">
                    <li><strong>طابور الاعتماد:</strong> ادخل على <a href="/admin/approvals" class="text-amber-800 underline font-bold">طابور الاعتمادات</a> لفحص المنتجات المعلقة.</li>
                    <li><strong>الاعتماد والنشر:</strong> انقر على "اعتماد ونشر في الكتالوج" للمنتج المستوفي للمواصفات لنشره فورياً.</li>
                    <li><strong>الرفض والتوجيه:</strong> انقر على "رفض مع إبداء السبب" لتوجيه ملاحظات فنية للمصنع لإعادة التقديم.</li>
                    <li><strong>إدارة المصانع:</strong> عيّن نماذج العمل (عقد مباشر / اشتراك تسويقي) من <a href="/importer/manufacturer-select" class="text-secondary underline">إدارة المصانع</a>.</li>
                </ol>
            </div>
        `,
        'logistics': `
            <div class="space-y-3">
                <div class="p-3 rounded-lg bg-blue-50 text-blue-900 font-bold">مهام العمليات ومسؤولي الموانئ:</div>
                <ol class="space-y-2 list-decimal list-inside text-[#172D46]">
                    <li><strong>فحص المطابقة الذكي:</strong> استخدم محرك Fuzzy Matcher قبل تسجيل أي منشأة لتجنب تكرار السجلات.</li>
                    <li><strong>إدارة المحطات:</strong> توثيق عقود الشحن المباشر ومحطات الفرز والتعبئة في ميناء دمياط والإسكندرية.</li>
                    <li><strong>تنسيق الحاويات المبردة:</strong> مراجعة مواصفات التبريد والتخزين الجمركي المعتمد.</li>
                </ol>
            </div>
        `,
        'buyer': `
            <div class="space-y-3">
                <div class="p-3 rounded-lg bg-[#EBF5F5] text-[#1F686E] font-bold">دليل المشتري والمستورد الدولي:</div>
                <ol class="space-y-2 list-decimal list-inside text-[#172D46]">
                    <li><strong>استعراض السلع:</strong> ادخل على <a href="/catalog" class="text-[#1F686E] underline">كتالوج المنتجات</a> وابحث بالاسم أو الفئة.</li>
                    <li><strong>المواصفات الفنية:</strong> انقر على سهم التفاصيل لمعاينة شهادات الجودة وأوزان العبوات.</li>
                    <li><strong>طلب عرض الأسعار (RFQ):</strong> انقر على "طلب عرض سعر ومواصفات" وسيتم تعبئة النموذج آلياً.</li>
                </ol>
            </div>
        `
    };

    const container = document.getElementById('modal-help-body');
    if (container) container.innerHTML = guides[tab] || guides['mfg'];

    ['mfg', 'admin', 'logistics', 'buyer'].forEach(t => {
        const btn = document.getElementById(`modal-tab-${t}`);
        if (btn) {
            if (t === tab) {
                btn.className = 'px-3.5 py-1.5 rounded-lg font-bold bg-[#1F686E] text-white';
            } else {
                btn.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-[#43474D] hover:bg-gray-100';
            }
        }
    });
}

const TOKEN_KEY = 'zarsev_auth_token';

// Global Semantic Route Mapping for ZARSEV Portal and Workspace screens
const ROUTE_MAP = {
    'home': '/',
    'about': '/about',
    'about-us': '/about',
    'services': '/services',
    'products': '/catalog',
    'products-catalog': '/catalog',
    'product-details': '/product-details',
    'quality-consulting': '/consulting',
    'why-us': '/about',
    'contact': '/contact',
    'contact-us': '/contact',
    'request-quote': '/contact',
    'client-portal': '/portal/manufacturer',
    'customer-portal': '/importer',
    'employee-portal': '/portal/logistics',
    'admin-dashboard': '/portal/admin',
    'auth-hub': '/importer'
};

function initNavigation() {
    document.querySelectorAll('a[data-path]').forEach(link => {
        const pathKey = link.getAttribute('data-path');
        if (ROUTE_MAP[pathKey]) {
            link.href = ROUTE_MAP[pathKey];
        }
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNavigation);
    } else {
        initNavigation();
    }
}

function getAuthToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function setAuthToken(token) {
    if (token) {
        localStorage.setItem(TOKEN_KEY, token);
    } else {
        localStorage.removeItem(TOKEN_KEY);
    }
}

/**
 * Dev persona switcher: switches user via authenticated /api/auth/dev-login endpoint.
 */
async function switchDevPersona(userId) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch('/api/auth/dev-login', {
            method: 'POST',
            headers,
            body: JSON.stringify({ user_id: userId })
        });
        const data = await response.json();
        if (data.success && data.token) {
            setAuthToken(data.token);
            window.location.reload();
        } else {
            console.error('Failed to switch persona:', data.error);
        }
    } catch (e) {
        console.error('Error switching persona:', e);
    }
}

/**
 * Robust fetch wrapper that attaches JWT and handles token refresh/CSRF
 */
async function zarsevFetch(url, options = {}) {
    options.headers = options.headers || {};
    const token = getAuthToken();
    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && !(options.body instanceof FormData)) {
        if (!options.headers['Content-Type']) {
            options.headers['Content-Type'] = 'application/json';
        }
    }

    const response = await fetch(url, options);

    // If 401 Unauthorized, try dev auto-login in local development
    if (response.status === 401) {
        const devLoginRes = await fetch('/api/auth/dev-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'usr_super_admin' })
        }).catch(() => null);

        if (devLoginRes && devLoginRes.ok) {
            const devData = await devLoginRes.json();
            if (devData.token) {
                setAuthToken(devData.token);
                options.headers['Authorization'] = `Bearer ${devData.token}`;
                const retryRes = await fetch(url, options);
                return await retryRes.json();
            }
        }
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok && data.error) {
        throw new Error(data.error);
    }
    return data;
}

/**
 * Generates Breadcrumb HTML based on activeTab
 */
function getBreadcrumbsHtml(activeTab, currentUser) {
    const role = currentUser ? currentUser.role : 'PUBLIC';
    let baseDashboard = '/importer';
    let baseName = 'بوابة العمليات';

    if (role === 'MANUFACTURER') {
        baseDashboard = '/portal/manufacturer';
        baseName = 'لوحة المصنع';
    } else if (role === 'SUPER_ADMIN') {
        baseDashboard = '/portal/admin';
        baseName = 'لوحة الإدارة';
    } else if (role === 'LOGISTICS_OFFICER') {
        baseDashboard = '/portal/logistics';
        baseName = 'لوحة اللوجستيات';
    }

    const crumbs = [
        `<a href="/" class="hover:text-[#172D46] transition-colors">الرئيسية</a>`,
        `<span class="text-gray-300">/</span>`,
        `<a href="${baseDashboard}" class="hover:text-[#172D46] transition-colors">${baseName}</a>`
    ];

    const tabNames = {
        'portal-mfg': 'نظرة عامة',
        'portal-admin': 'الرقابة التنفيذية',
        'portal-logistics': 'العمليات الميدانية',
        'upload': 'رفع الكتالوجات (خطوة 1)',
        'progress': 'المتابعة الذكية (خطوة 2)',
        'review': 'مراجعة وتدقيق الأصناف (خطوة 3)',
        'bulk-edit': 'التعديل الجماعي في جدول إكسل',
        'history': 'سجل العمليات والتقارير',
        'failed': 'تقرير الأخطاء وإعادة المحاولة',
        'approvals': 'طابور فحص طلبات الاعتماد',
        'manufacturer-select': 'محطات التعبئة والمطابقة الذكية',
        'help': 'مركز المساعدة ودليل الاستخدام'
    };

    if (tabNames[activeTab] && !activeTab.startsWith('portal-')) {
        crumbs.push(`<span class="text-gray-300">/</span>`);
        crumbs.push(`<span class="text-[#1F686E] font-bold">${tabNames[activeTab]}</span>`);
    }

    return `<nav class="flex items-center gap-1.5 text-xs text-[#74777E] font-medium" aria-label="مسار التنقل">${crumbs.join('')}</nav>`;
}

/**
 * Generates Back Button target based on activeTab
 */
function getBackButton(activeTab, currentUser) {
    const role = currentUser ? currentUser.role : 'PUBLIC';
    let defaultBack = '/portal/manufacturer';
    if (role === 'SUPER_ADMIN') defaultBack = '/portal/admin';
    if (role === 'LOGISTICS_OFFICER') defaultBack = '/portal/logistics';

    const backTargets = {
        'upload': defaultBack,
        'progress': '/importer/history',
        'review': defaultBack,
        'bulk-edit': `/importer/review/${window.location.pathname.split('/').pop()}`,
        'failed': '/importer/history',
        'approvals': '/portal/admin',
        'manufacturer-select': role === 'LOGISTICS_OFFICER' ? '/portal/logistics' : '/portal/admin',
        'help': defaultBack
    };

    const targetUrl = backTargets[activeTab] || defaultBack;
    return `
        <a href="${targetUrl}" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#E4E7EC] hover:bg-gray-50 text-xs font-semibold text-[#172D46] transition-colors" title="الرجوع للخطوة أو اللوحة السابقة">
            <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
            <span>رجوع</span>
        </a>
    `;
}

/**
 * Universal Workspace Shell Renderer with Collapsible Sidebar and Role-Filtered Navigation
 */
async function renderZarsevHeader(activeTab = 'importer') {
    try {
        let authData;
        try {
            authData = await zarsevFetch('/api/auth/me');
        } catch (e) {
            const devRes = await fetch('/api/auth/dev-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: 'usr_super_admin' })
            }).catch(() => null);

            if (devRes && devRes.ok) {
                const devData = await devRes.json();
                setAuthToken(devData.token);
                authData = await zarsevFetch('/api/auth/me');
            } else {
                return;
            }
        }

        const currentUser = authData?.user;
        const currentMfg = authData?.manufacturer;
        if (!currentUser) return;

        const headerContainer = document.getElementById('zarsev-header-mount');
        if (!headerContainer) return;

        // Pending count for Admin/Logistics
        let pendingCount = 0;
        if (currentUser.role === 'SUPER_ADMIN' || currentUser.role === 'LOGISTICS_OFFICER') {
            try {
                const q = await zarsevFetch('/api/approvals/queue');
                pendingCount = (q.queue || []).length;
            } catch (e) {}
        }

        // Personas options for dev switcher
        let personasBarHtml = '';
        try {
            const personasRes = await fetch('/api/auth/personas');
            if (personasRes.ok) {
                const personasData = await personasRes.json();
                if (personasData.success && Array.isArray(personasData.personas)) {
                    const personaOptions = personasData.personas.map(p => `
                        <option value="${p.id}" ${p.id === currentUser.id ? 'selected' : ''}>
                            ${p.name} (${p.role === 'SUPER_ADMIN' ? 'إدارة عليا' : p.role === 'LOGISTICS_OFFICER' ? 'لوجستيات' : p.mfg_name || 'مصنع'})
                        </option>
                    `).join('');

                    let roleBadge = '';
                    if (currentUser.role === 'SUPER_ADMIN') {
                        roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">👑 المدير العام (Super Admin)</span>';
                    } else if (currentUser.role === 'LOGISTICS_OFFICER') {
                        roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">⚓ مسؤول لوجستيات الموانئ</span>';
                    } else {
                        roleBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30">🏭 مصنع: ${currentMfg?.name_ar || 'حساب المصنع'}</span>`;
                    }

                    personasBarHtml = `
                        <div class="w-full bg-[#102236] text-white text-[11px] md:text-[12px] py-1.5 px-4 shadow-inner border-b border-white/10">
                            <div class="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
                                <div class="flex items-center gap-3">
                                    <a href="/" class="flex items-center gap-1.5 text-[#FFDEA9] hover:underline font-bold">
                                        <span class="material-symbols-outlined text-[16px]">anchor</span>
                                        <span>منظومة زارسيف السيادية</span>
                                    </a>
                                    <span class="text-white/30 hidden sm:inline">|</span>
                                    <span>المستخدم: <strong class="text-white">${currentUser.name}</strong></span>
                                    ${roleBadge}
                                </div>
                                <div class="flex items-center gap-3">
                                    <div class="flex items-center gap-1.5">
                                        <span class="text-white/70 text-[10px] md:text-[11px] shrink-0">تبديل الحساب (تجريبي):</span>
                                        <select onchange="switchDevPersona(this.value)" class="bg-[#001830] text-white text-[11px] px-2 py-1 rounded border border-white/20 focus:outline-none focus:ring-1 focus:ring-secondary">
                                            ${personaOptions}
                                        </select>
                                    </div>
                                    <a href="/" class="text-white/80 hover:text-white text-xs flex items-center gap-1 hover:underline">
                                        <span>الموقع العام</span>
                                        <span class="material-symbols-outlined text-[14px]">arrow_forward</span>
                                    </a>
                                </div>
                            </div>
                        </div>
                    `;
                }
            }
        } catch (e) {}

        // Role-Based Sidebar Navigation Items
        let sidebarLinks = [];
        if (currentUser.role === 'MANUFACTURER') {
            sidebarLinks = [
                { id: 'portal-mfg', label: 'لوحة المصنع الرئيسية', href: '/portal/manufacturer', icon: 'dashboard' },
                { id: 'upload', label: 'رفع كتالوج جديد', href: '/importer/upload', icon: 'cloud_upload' },
                { id: 'history', label: 'سجل العمليات والمسودات', href: '/importer/history', icon: 'history' },
                { id: 'catalog', label: 'الكتالوج الدولي للمشترين', href: '/catalog', icon: 'visibility' },
                { id: 'help', label: 'مركز المساعدة ودليل المصنع', href: '/help?role=mfg', icon: 'help' }
            ];
        } else if (currentUser.role === 'SUPER_ADMIN') {
            sidebarLinks = [
                { id: 'portal-admin', label: 'لوحة الإدارة التنفيذية', href: '/portal/admin', icon: 'admin_panel_settings' },
                { id: 'approvals', label: 'طلبات الاعتماد الفورية', href: '/admin/approvals', icon: 'verified', badge: pendingCount },
                { id: 'manufacturer-select', label: 'إدارة المصانع والشركاء', href: '/importer/manufacturer-select', icon: 'factory' },
                { id: 'catalog', label: 'الكتالوج العام والمشترين', href: '/catalog', icon: 'inventory_2' },
                { id: 'history', label: 'سجل التدقيق الشامل', href: '/importer/history', icon: 'history' },
                { id: 'help', label: 'مركز المساعدة ودليل الإدارة', href: '/help?role=admin', icon: 'help' }
            ];
        } else if (currentUser.role === 'LOGISTICS_OFFICER') {
            sidebarLinks = [
                { id: 'portal-logistics', label: 'لوحة العمليات واللوجستيات', href: '/portal/logistics', icon: 'hub' },
                { id: 'manufacturer-select', label: 'محطات الفرز والمطابقة', href: '/importer/manufacturer-select', icon: 'psychology' },
                { id: 'approvals', label: 'فحص جاهزية الشحنات', href: '/admin/approvals', icon: 'rule', badge: pendingCount },
                { id: 'services', label: 'محطات الأرصفة والتخزين', href: '/services', icon: 'warehouse' },
                { id: 'help', label: 'مركز المساعدة ودليل العمليات', href: '/help?role=logistics', icon: 'help' }
            ];
        } else {
            sidebarLinks = [
                { id: 'landing', label: 'بوابة الاستيراد الذكي', href: '/importer', icon: 'cloud_upload' },
                { id: 'catalog', label: 'كتالوج الصادرات', href: '/catalog', icon: 'inventory_2' },
                { id: 'help', label: 'مركز المساعدة', href: '/help', icon: 'help' }
            ];
        }

        const sidebarLinksHtml = sidebarLinks.map(link => {
            const isActive = activeTab === link.id;
            return `
                <a href="${link.href}" class="flex items-center justify-between p-3 rounded-xl transition-all ${isActive ? 'bg-[#1F686E] text-white font-bold shadow-sm' : 'text-[#43474D] hover:bg-[#F0F3FF] hover:text-[#172D46] font-medium'}">
                    <div class="flex items-center gap-3">
                        <span class="material-symbols-outlined text-[20px] ${isActive ? 'text-white' : 'text-[#74777E]'}">${link.icon}</span>
                        <span class="text-xs">${link.label}</span>
                    </div>
                    ${link.badge ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${isActive ? 'bg-white text-[#1F686E]' : 'bg-amber-100 text-amber-800 font-mono'}">${link.badge}</span>` : ''}
                </a>
            `;
        }).join('');

        const breadcrumbsHtml = getBreadcrumbsHtml(activeTab, currentUser);
        const backBtnHtml = getBackButton(activeTab, currentUser);

        headerContainer.innerHTML = `
            ${personasBarHtml}

            <!-- Main Workspace Topbar -->
            <header class="w-full bg-white border-b border-[#E4E7EC] shadow-sm sticky top-0 z-40">
                <div class="max-w-[1440px] mx-auto px-4 md:px-8 h-16 flex items-center justify-between gap-4">
                    <div class="flex items-center gap-4">
                        <!-- Sidebar Toggle Button -->
                        <button type="button" onclick="toggleWorkspaceSidebar()" class="w-10 h-10 rounded-xl border border-[#E4E7EC] hover:bg-gray-50 flex items-center justify-center text-[#172D46] transition-colors" title="فتح/إغلاق القائمة الجانبية">
                            <span class="material-symbols-outlined text-[22px]">menu_open</span>
                        </button>

                        <!-- ZARSEV Identity Badge -->
                        <a href="/" class="flex items-center gap-2.5 shrink-0 group">
                            <img src="/images/zarsev-logo.jpg" alt="ZARSEV - زرع وسيف" class="h-10 md:h-12 w-auto max-w-[200px] object-contain group-hover:scale-105 transition-transform" style="object-fit: contain;" />
                        </a>

                        <div class="h-6 w-px bg-gray-200 hidden md:block"></div>

                        <!-- Breadcrumbs -->
                        <div class="hidden md:block">
                            ${breadcrumbsHtml}
                        </div>
                    </div>

                    <div class="flex items-center gap-3">
                        ${backBtnHtml}

                        <!-- In-App Notifications Bell Dropdown (Phase 4.0-E) -->
                        <div class="relative">
                            <button type="button" onclick="toggleNotificationsDropdown()" class="relative p-2 rounded-lg bg-surface-container-low hover:bg-surface-container text-[#172D46] border border-outline-variant transition-all" title="الإشعارات">
                                <span class="material-symbols-outlined text-[20px]">notifications</span>
                                <span id="header-notif-badge" class="hidden absolute -top-1 -right-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-rose-600 text-white font-mono">0</span>
                            </button>
                            <div id="header-notif-dropdown" class="hidden absolute left-0 mt-2 w-80 bg-white rounded-2xl border border-outline-variant shadow-2xl z-50 overflow-hidden divide-y divide-outline-variant/40">
                                <div class="p-3 bg-surface-container-low flex items-center justify-between">
                                    <span class="font-bold text-xs text-primary">الإشعارات الواردة</span>
                                    <button type="button" onclick="markAllNotificationsRead()" class="text-[10px] font-bold text-secondary hover:underline">تحديد الكل كمقروء</button>
                                </div>
                                <div id="header-notif-list" class="max-h-72 overflow-y-auto divide-y divide-outline-variant/30 text-xs p-1">
                                    <div class="p-4 text-center text-on-surface-variant text-xs">جاري تحميل الإشعارات...</div>
                                </div>
                            </div>
                        </div>

                        <!-- Quick Help Button -->
                        <button type="button" onclick="openHelpModal('${currentUser.role === 'SUPER_ADMIN' ? 'admin' : currentUser.role === 'LOGISTICS_OFFICER' ? 'logistics' : 'mfg'}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container-low hover:bg-surface-container text-[#1F686E] text-xs font-semibold border border-outline-variant transition-all">
                            <span class="material-symbols-outlined text-[16px]">help</span>
                            <span class="hidden sm:inline">دليل المساعدة</span>
                        </button>

                        <!-- Public Website Direct CTA -->
                        <a href="/catalog" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1F686E] hover:bg-[#185358] text-white text-xs font-bold transition-all shadow-sm">
                            <span class="material-symbols-outlined text-[16px]">public</span>
                            <span class="hidden sm:inline">كتالوج المنتجات</span>
                        </a>
                    </div>
                </div>
            </header>

            <!-- Collapsible Workspace Sidebar Drawer -->
            <div id="zarsev-sidebar-overlay" onclick="toggleWorkspaceSidebar()" class="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 hidden transition-opacity"></div>
            <aside id="zarsev-workspace-sidebar" class="fixed top-0 right-0 h-full w-72 bg-white border-l border-[#E4E7EC] shadow-2xl z-50 hidden flex flex-col justify-between transition-transform duration-300">
                <div class="p-5 space-y-6">
                    <div class="flex items-center justify-between pb-4 border-b border-[#E4E7EC]">
                        <div class="flex items-center gap-2.5">
                            <img src="/images/zarsev-logo.jpg" alt="ZARSEV Logo" class="h-10 w-auto max-w-[120px] object-contain rounded shadow-xs" style="object-fit: contain;" />
                            <div>
                                <h3 class="font-bold text-[#172D46] text-sm leading-tight">بوابات زارسيف الدولية</h3>
                                <p class="text-[10px] text-[#74777E]">قائمة التنقل المخصصة لدورك</p>
                            </div>
                        </div>
                        <button type="button" onclick="toggleWorkspaceSidebar()" class="text-[#74777E] hover:text-[#BA1A1A] p-1 rounded">
                            <span class="material-symbols-outlined text-[20px]">close</span>
                        </button>
                    </div>

                    <!-- Role Badge In Sidebar -->
                    <div class="p-3.5 rounded-xl bg-[#F0F3FF] border border-[#E4E7EC] space-y-1">
                        <div class="text-[10px] text-[#74777E]">الحساب النشط:</div>
                        <div class="font-bold text-xs text-[#172D46] truncate">${currentUser.name}</div>
                        <div class="text-[11px] font-semibold text-[#1F686E]">
                            ${currentUser.role === 'SUPER_ADMIN' ? '👑 الإدارة العليا (Super Admin)' : currentUser.role === 'LOGISTICS_OFFICER' ? '⚓ مسؤول اللوجستيات الميدانية' : `🏭 ${currentMfg?.name_ar || 'مصنع معتمد'}`}
                        </div>
                    </div>

                    <!-- Navigation Links -->
                    <nav class="space-y-1.5">
                        <div class="text-[10px] uppercase font-bold text-[#74777E] px-2 mb-2">أقسام مساحة العمل:</div>
                        ${sidebarLinksHtml}
                    </nav>
                </div>

                <div class="p-4 border-t border-[#E4E7EC] bg-gray-50/50 space-y-2">
                    <a href="/" class="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-lg border border-[#E4E7EC] bg-white hover:bg-gray-100 text-xs font-bold text-[#172D46] transition-colors shadow-xs">
                        <span class="material-symbols-outlined text-[16px]">home</span>
                        <span>العودة للموقع العام</span>
                    </a>
                </div>
            </aside>
        `;

        // Render Orientation Banner if an element exists or auto-inject for certain screens
        renderAutoOrientation(activeTab, currentUser, currentMfg);

    } catch (err) {
        console.error('Failed to render unified header:', err);
    }
}

/**
 * Injects a helpful "أنا فين؟ وماذا أفعل الآن؟ والخطوة التالية" banner on functional workspace screens
 */
function renderAutoOrientation(activeTab, currentUser, currentMfg) {
    let mount = document.getElementById('zarsev-orientation-mount');
    if (!mount) {
        const headerContainer = document.getElementById('zarsev-header-mount');
        if (headerContainer && headerContainer.parentNode) {
            mount = document.createElement('div');
            mount.id = 'zarsev-orientation-mount';
            mount.className = 'max-w-[1440px] mx-auto px-4 md:px-8 pt-4';
            headerContainer.parentNode.insertBefore(mount, headerContainer.nextSibling);
        } else {
            return;
        }
    }

    const guidance = {
        'upload': {
            title: 'رفع الملفات والكتالوجات التصديرية (الخطوة 1 من 3)',
            purpose: 'اختر أو اسحب ملفات الكتالوجات (Excel، CSV، PDF، أو أرشيف صور ZIP). سيقوم المحرك الذكي بقراءة الأصناف وربطها بالمنشأة تلقائياً.',
            nextStep: 'انقر على "بدء المعالجة والاستخراج الذكي" لبدء الاستخراج في الخلفية دون تجميد المتصفح.',
            backUrl: currentUser?.role === 'SUPER_ADMIN' ? '/portal/admin' : '/portal/manufacturer'
        },
        'progress': {
            title: 'متابعة المعالجة الفورية والذكاء الاصطناعي (الخطوة 2 من 3)',
            purpose: 'تتم الآن معالجة الجداول، تجميع الأسعار ومواصفات التبريد، واستخراج الأوصاف التصديرية وفحص المطابقة الجمركية.',
            nextStep: 'بمجرد بلوغ النسبة 100%، سيظهر زر "الانتقال إلى شاشة المراجعة" لمراجعة الأصناف بدقة.',
            backUrl: '/importer/history'
        },
        'review': {
            title: 'مراجعة وتدقيق المنتجات المستخرجة (الخطوة 3 من 3)',
            purpose: 'افحص بيانات الأصناف، أصلح أي تحذيرات بالأحمر، عدل الأسعار أو أنماط التعبئة، وأضف منتجات يدوية غير مدرجة بالملف.',
            nextStep: 'حدد الأصناف وانقر على "إرسال كل المنتجات للاعتماد" لنقل الدفعة إلى فريق الرقابة الإدارية.',
            backUrl: currentUser?.role === 'SUPER_ADMIN' ? '/portal/admin' : '/portal/manufacturer'
        },
        'bulk-edit': {
            title: 'التعديل المجمع لمواصفات وتعبئة الأصناف',
            purpose: 'تطبيق تعديلات فورية على مجموعة كبيرة من المنتجات دفعة واحدة (تحديث العملة، موانئ الشحن، شروط الحفظ، أو نسب الخصم).',
            nextStep: 'حدد الأصناف المراد تعديلها ثم انقر على "تطبيق التعديلات وحفظ الدفعة".',
            backUrl: '/importer/history'
        },
        'failed-retry': {
            title: 'مركز معالجة الأخطاء وإعادة المحاولة الذكية',
            purpose: 'فحص السجلات غير المطابقة والأخطاء التنسيقية وتصحيحها أو استبعادها لإتمام معالجة الدفعة.',
            nextStep: 'راجع قائمة الأخطاء وانقر على "إعادة محاولة المعالجة" بعد تصحيح البيانات.',
            backUrl: '/importer/history'
        },
        'history': {
            title: 'سجل عمليات الاستيراد وأرشيف الكتالوجات',
            purpose: 'تتبع كافة دفعات الاستيراد السابقة، راجع حالات الاعتماد (معتمد / قيد المراجعة / مسودة)، وحمل تقارير الأخطاء للدفعات المتعثرة.',
            nextStep: 'انقر على "مراجعة الأصناف" لأي دفعة مكتملة، أو "استيراد جديد" لرفع ملف آخر.',
            backUrl: currentUser?.role === 'SUPER_ADMIN' ? '/portal/admin' : '/portal/manufacturer'
        },
        'approvals': {
            title: 'طابور فحص طلبات الاعتماد الإدارية والرقابة',
            purpose: 'مراجعة المنتجات المقدمة من المصانع وفحص مطابقتها للمواصفات التصديرية والشهادات الدولية قبل عرضها للجمهور.',
            nextStep: 'انقر على "اعتماد ونشر في الكتالوج" للمنتج المطابق، أو "رفض مع إبداء السبب" لطلب تعديل من المصنع.',
            backUrl: '/portal/admin'
        },
        'manufacturer-select': {
            title: 'دليل محطات الفرز والتعبئة ومحرك المطابقة الذكي',
            purpose: 'إدارة المنشآت المصدرة المعتمدة، توثيق نماذج العمل (عقد مباشر / اشتراك تسويقي)، وفحص تشابه الأسماء لمنع التكرار.',
            nextStep: 'جرب كتابة اسم منشأة في مربع المطابقة، أو انقر على "إضافة ملف مصنع جديد".',
            backUrl: currentUser?.role === 'LOGISTICS_OFFICER' ? '/portal/logistics' : '/portal/admin'
        }
    };

    const g = guidance[activeTab];
    if (!g) return;

    mount.innerHTML = `
        <div class="bg-surface-container-lowest rounded-2xl p-5 border border-outline-variant shadow-sm mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div class="space-y-1.5">
                <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-secondary animate-pulse"></span>
                    <span class="text-xs font-bold text-primary font-mono">📍 أنت الآن في: ${g.title}</span>
                </div>
                <p class="text-xs text-on-surface-variant leading-relaxed">
                    🎯 <strong>الغرض من الصفحة:</strong> ${g.purpose}
                </p>
                <p class="text-xs text-secondary font-semibold">
                    ⚡ <strong>الخطوة الموصى بها:</strong> ${g.nextStep}
                </p>
            </div>
            <div class="shrink-0 flex items-center gap-2">
                <a href="${g.backUrl}" class="inline-flex items-center gap-1 px-3.5 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container text-primary text-xs font-semibold border border-outline-variant transition-all">
                    <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
                    <span>الرجوع للوحة التحكم</span>
                </a>
            </div>
        </div>
    `;
}

/**
 * Toast Notification Helper
 */
function showToast(message, type = 'info') {
    const existing = document.getElementById('zarsev-toast');
    if (existing) existing.remove();

    const colors = {
        success: 'bg-emerald-700 text-white',
        error: 'bg-rose-700 text-white',
        warning: 'bg-amber-600 text-white',
        info: 'bg-[#172D46] text-white'
    };

    const icons = {
        success: 'check_circle',
        error: 'error',
        warning: 'warning',
        info: 'info'
    };

    const toast = document.createElement('div');
    toast.id = 'zarsev-toast';
    toast.className = `fixed bottom-6 left-6 z-50 px-5 py-3.5 rounded-lg shadow-xl flex items-center gap-3 text-[14px] font-medium transition-all transform translate-y-0 ${colors[type] || colors.info}`;
    toast.innerHTML = `
        <span class="material-symbols-outlined text-[20px]">${icons[type] || icons.info}</span>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// Global format helpers
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Mounts just the Dev Persona Bar at the top of editorial/portal pages
 */
async function renderDevPersonaBar(containerId = 'zarsev-persona-mount') {
    try {
        const mount = document.getElementById(containerId);
        if (!mount) return;

        let authData;
        try {
            authData = await zarsevFetch('/api/auth/me');
        } catch (e) {
            const devRes = await fetch('/api/auth/dev-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: 'usr_super_admin' })
            }).catch(() => null);

            if (devRes && devRes.ok) {
                const devData = await devRes.json();
                setAuthToken(devData.token);
                authData = await zarsevFetch('/api/auth/me');
            } else {
                return;
            }
        }

        const currentUser = authData?.user;
        const currentMfg = authData?.manufacturer;
        if (!currentUser) return;

        const personasRes = await fetch('/api/auth/personas');
        if (!personasRes.ok) return;
        const personasData = await personasRes.json();
        if (!personasData.success || !Array.isArray(personasData.personas)) return;

        const personaOptions = personasData.personas.map(p => `
            <option value="${p.id}" ${p.id === currentUser.id ? 'selected' : ''}>
                ${p.name} (${p.role === 'SUPER_ADMIN' ? 'إدارة عليا' : p.role === 'LOGISTICS_OFFICER' ? 'لوجستيات' : p.mfg_name || 'مصنع'})
            </option>
        `).join('');

        let roleBadge = '';
        let targetPortal = '/importer';
        if (currentUser.role === 'SUPER_ADMIN') {
            roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">👑 المدير العام (Super Admin)</span>';
            targetPortal = '/portal/admin';
        } else if (currentUser.role === 'LOGISTICS_OFFICER') {
            roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">⚓ مسؤول لوجستيات الموانئ</span>';
            targetPortal = '/portal/logistics';
        } else {
            roleBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30">🏭 مصنع: ${currentMfg?.name_ar || 'حساب المصنع'}</span>`;
            targetPortal = '/portal/manufacturer';
        }

        mount.innerHTML = `
            <div class="w-full bg-[#102236] text-white text-[11px] md:text-[12px] py-1.5 px-3 md:px-6 shadow-inner relative z-50 border-b border-white/10">
                <div class="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <a href="/" class="flex items-center gap-1.5 text-[#FFDEA9] hover:underline font-bold">
                            <span class="material-symbols-outlined text-[15px]">anchor</span>
                            <span>زارسيف السيادية</span>
                        </a>
                        <span class="text-white/30 hidden sm:inline">|</span>
                        <span class="text-white/80">المستخدم: <strong class="text-white">${currentUser.name}</strong></span>
                        ${roleBadge}
                    </div>
                    <div class="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
                        <span class="text-white/70 text-[10px] md:text-[11px] shrink-0">تبديل الحساب:</span>
                        <select onchange="switchDevPersona(this.value)" class="bg-[#001830] text-white text-[11px] px-2 py-1 rounded border border-white/20 focus:outline-none focus:ring-1 focus:ring-secondary">
                            ${personaOptions}
                        </select>
                        <a href="${targetPortal}" class="px-2.5 py-1 rounded bg-[#1F686E] hover:bg-[#185358] text-white text-[11px] font-bold shrink-0 shadow-xs">
                            دخول لوحة التحكم
                        </a>
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Failed to render persona bar:', err);
    }
}


// =========================================================================
// Real In-App Notification Client Handlers (Phase 4.0-E)
// =========================================================================
let notifDropdownOpen = false;

async function loadHeaderNotificationCount() {
    try {
        const res = await zarsevFetch('/api/notifications/unread-count').catch(() => null);
        const count = res?.unread_count || 0;
        const badge = document.getElementById('header-notif-badge');
        if (badge) {
            if (count > 0) {
                badge.textContent = count;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }
    } catch (_) {}
}

async function toggleNotificationsDropdown() {
    const dropdown = document.getElementById('header-notif-dropdown');
    if (!dropdown) return;

    notifDropdownOpen = !notifDropdownOpen;
    if (notifDropdownOpen) {
        dropdown.classList.remove('hidden');
        await loadHeaderNotificationsList();
    } else {
        dropdown.classList.add('hidden');
    }
}

async function loadHeaderNotificationsList() {
    const list = document.getElementById('header-notif-list');
    if (!list) return;

    try {
        const res = await zarsevFetch('/api/notifications?limit=15').catch(() => null);
        const notifications = res?.notifications || [];

        if (notifications.length === 0) {
            list.innerHTML = '<div class="p-4 text-center text-on-surface-variant text-xs">لا توجد إشعارات مسجلة</div>';
            return;
        }

        list.innerHTML = notifications.map(n => `
            <div class="p-3 hover:bg-surface-container-low transition-colors space-y-1 ${n.is_read ? 'opacity-70' : 'bg-[#EBF5F5]/40'}">
                <div class="flex items-center justify-between">
                    <span class="font-bold text-primary text-xs">${escapeHtml(n.title_ar || n.title_en)}</span>
                    <span class="font-mono text-[10px] text-on-surface-variant">${new Date(n.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p class="text-[11px] text-on-surface-variant leading-relaxed">${escapeHtml(n.body_ar || n.body_en)}</p>
                ${!n.is_read ? `
                    <div class="text-left pt-1">
                        <button type="button" onclick="markSingleNotificationRead('${n.id}')" class="text-[10px] font-bold text-secondary hover:underline">تعليم كمقروء</button>
                    </div>
                ` : ''}
            </div>
        `).join('');

        await loadHeaderNotificationCount();
    } catch (err) {
        list.innerHTML = '<div class="p-4 text-center text-rose-600 text-xs">تعذر استرجاع الإشعارات</div>';
    }
}

async function markAllNotificationsRead() {
    try {
        await zarsevFetch('/api/notifications/mark-all-read', { method: 'POST' });
        await loadHeaderNotificationsList();
        await loadHeaderNotificationCount();
    } catch (_) {}
}

async function markSingleNotificationRead(id) {
    try {
        await zarsevFetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
        await loadHeaderNotificationsList();
        await loadHeaderNotificationCount();
    } catch (_) {}
}

// Auto load notifications when header renders
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(loadHeaderNotificationCount, 1500);
    });
}
