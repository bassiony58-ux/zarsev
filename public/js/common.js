/**
 * ZARSEV Maritime Sovereign Common Client JS
 * Handles Persona Switching, API Fetching with Auth Headers, and Common Components.
 */

// Active persona storage
const CURRENT_USER_KEY = 'zarsev_active_user_id';

function getActiveUserId() {
    return localStorage.getItem(CURRENT_USER_KEY) || 'usr_super_admin';
}

function setActiveUserId(userId) {
    localStorage.setItem(CURRENT_USER_KEY, userId);
    window.location.reload();
}

/**
 * Enhanced fetch wrapper that attaches x-user-id header automatically
 */
async function zarsevFetch(url, options = {}) {
    options.headers = options.headers || {};
    if (!(options.body instanceof FormData)) {
        options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
    }
    options.headers['x-user-id'] = getActiveUserId();

    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok && data.error) {
        throw new Error(data.error);
    }
    return data;
}

/**
 * Renders the top persona bar and ZARSEV Navigation Header
 */
async function renderZarsevHeader(activeTab = 'importer') {
    try {
        const authData = await zarsevFetch('/api/auth/me');
        const personasData = await zarsevFetch('/api/auth/personas');
        const currentUser = authData.user;
        const currentMfg = authData.manufacturer;

        const headerContainer = document.getElementById('zarsev-header-mount');
        if (!headerContainer) return;

        let roleBadge = '';
        if (currentUser.role === 'SUPER_ADMIN') {
            roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-700 border border-amber-500/30">المدير العام (Super Admin)</span>';
        } else if (currentUser.role === 'LOGISTICS_OFFICER') {
            roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/20 text-blue-700 border border-blue-500/30">مسؤول لوجستيات الموانئ</span>';
        } else {
            roleBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-teal-500/20 text-teal-700 border border-teal-500/30">مصنع تسويقي: ${currentMfg?.name_ar || 'حساب المصنع'}</span>`;
        }

        const personaOptions = personasData.personas.map(p => `
            <option value="${p.id}" ${p.id === currentUser.id ? 'selected' : ''}>
                ${p.name} (${p.role === 'SUPER_ADMIN' ? 'إدارة عليا' : p.role === 'LOGISTICS_OFFICER' ? 'لوجستيات' : p.mfg_name || 'مصنع'})
            </option>
        `).join('');

        headerContainer.innerHTML = `
            <div class="w-full bg-[#172D46] text-white text-[12px] py-1.5 px-4 shadow-inner">
                <div class="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <span class="flex items-center gap-1.5 text-secondary-fixed">
                            <span class="material-symbols-outlined text-[16px]">anchor</span>
                            <span class="font-bold">منظومة زارسيف السيادية للتصدير والموانئ</span>
                        </span>
                        <span class="text-white/30">|</span>
                        <span>المستخدم الحالي: <strong class="text-white">${currentUser.name}</strong></span>
                        ${roleBadge}
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-white/70 text-[11px]">محاكاة الحساب / تبديل الهوية:</span>
                        <select onchange="setActiveUserId(this.value)" class="bg-[#001830] text-white text-[11px] px-2 py-1 rounded border border-white/20 focus:outline-none focus:ring-1 focus:ring-secondary">
                            ${personaOptions}
                        </select>
                    </div>
                </div>
            </div>

            <header class="w-full bg-white border-b border-[#E4E7EC] shadow-sm sticky top-0 z-40">
                <div class="max-w-[1440px] mx-auto px-6 h-20 flex items-center justify-between">
                    <div class="flex items-center gap-4">
                        <a href="/importer" class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-lg bg-[#172D46] flex items-center justify-center text-white shadow">
                                <span class="material-symbols-outlined text-[24px]">anchor</span>
                            </div>
                            <div class="flex flex-col">
                                <span class="text-[20px] font-bold text-[#172D46] tracking-tight leading-none">ZARSEV</span>
                                <span class="text-[10px] text-[#1F686E] uppercase font-semibold tracking-wider">الاستيراد الذكي وأتمتة الكتالوج</span>
                            </div>
                        </a>
                    </div>

                    <nav class="hidden md:flex items-center gap-6 text-[14px] font-medium text-[#43474D]">
                        <a href="/importer" class="${activeTab === 'landing' ? 'text-[#1F686E] font-bold border-b-2 border-[#1F686E] py-2' : 'hover:text-[#172D46] py-2'}">
                            بوابة الاستيراد الذكي
                        </a>
                        <a href="/importer/upload" class="${activeTab === 'upload' ? 'text-[#1F686E] font-bold border-b-2 border-[#1F686E] py-2' : 'hover:text-[#172D46] py-2'}">
                            رفع الملفات والصور
                        </a>
                        <a href="/importer/history" class="${activeTab === 'history' ? 'text-[#1F686E] font-bold border-b-2 border-[#1F686E] py-2' : 'hover:text-[#172D46] py-2'}">
                            سجل العمليات والتقارير
                        </a>
                        <a href="/catalog" class="${activeTab === 'catalog' ? 'text-[#1F686E] font-bold border-b-2 border-[#1F686E] py-2' : 'hover:text-[#172D46] py-2'}">
                            كتالوج الصادرات
                        </a>
                        ${currentUser.role !== 'MANUFACTURER' ? `
                            <a href="/admin/approvals" class="${activeTab === 'approvals' ? 'text-[#1F686E] font-bold border-b-2 border-[#1F686E] py-2' : 'hover:text-[#172D46] py-2'} flex items-center gap-1.5">
                                <span>قائمة الاعتماد</span>
                                <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                            </a>
                        ` : ''}
                    </nav>

                    <div class="flex items-center gap-3">
                        <a href="/importer/upload" class="inline-flex items-center gap-2 px-4 py-2.5 rounded bg-[#1F686E] hover:bg-[#1F686E]/90 text-white text-[13px] font-semibold transition-all shadow-sm">
                            <span class="material-symbols-outlined text-[18px]">cloud_upload</span>
                            <span>استيراد منتجات جديدة</span>
                        </a>
                    </div>
                </div>
            </header>
        `;
    } catch (err) {
        console.error('Failed to render header:', err);
    }
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
