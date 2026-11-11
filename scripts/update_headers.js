const fs = require('fs');
const path = require('path');

const NAV_ITEMS = [
  { id: 'home', label: 'الرئيسية', href: '/' },
  { id: 'catalog', label: 'كتالوج المنتجات', href: '/catalog' },
  { id: 'product-details', label: 'مواصفات التصدير', href: '/product-details' },
  { id: 'services', label: 'خدمات الموانئ', href: '/services' },
  { id: 'consulting', label: 'استشارات الجودة', href: '/consulting' },
  { id: 'about', label: 'من نحن', href: '/about' },
  { id: 'contact', label: 'اتصل بنا', href: '/contact' }
];

function generateHeader(activeId) {
  const desktopLinks = NAV_ITEMS.map(item => {
    if (item.id === activeId) {
      return `    <a href="${item.href}" class="px-3.5 py-2 rounded-lg font-bold text-[#1F686E] bg-[#EBF5F5] border-b-2 border-[#1F686E] transition-all whitespace-nowrap" aria-current="page">${item.label}</a>`;
    }
    return `    <a href="${item.href}" class="px-3.5 py-2 rounded-lg hover:text-[#172D46] hover:bg-[#F0F3FF] transition-all whitespace-nowrap">${item.label}</a>`;
  }).join('\n');

  const mobileLinks = NAV_ITEMS.map(item => {
    if (item.id === activeId) {
      return `  <a href="${item.href}" class="flex items-center justify-between p-2.5 rounded-lg bg-[#EBF5F5] text-[14px] font-bold text-[#1F686E]">
    <span>${item.label}</span>
    <span class="material-symbols-outlined text-[18px] text-[#1F686E]">check</span>
  </a>`;
    }
    return `  <a href="${item.href}" class="flex items-center justify-between p-2.5 rounded-lg hover:bg-[#F0F3FF] text-[14px] font-medium text-[#172D46]">
    <span>${item.label}</span>
    <span class="material-symbols-outlined text-[18px] text-[#74777E]">chevron_left</span>
  </a>`;
  }).join('\n');

  return `<header class="sticky top-0 w-full z-40 bg-white/95 backdrop-blur-md border-b border-[#E4E7EC] shadow-[0_2px_12px_rgba(23,45,70,0.06)]">
<!-- Top Sovereign Bar -->
<div class="bg-[#172D46] text-[#E7EEFF] text-[12px] py-2 px-4 md:px-8 border-b border-white/10">
  <div class="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <span class="w-2 h-2 rounded-full bg-[#1F686E] animate-pulse"></span>
      <span class="font-medium text-white/90">شركة زارسيف للموانئ والتصدير الدولي | موثوقية سيادية وبنية لوجستية متطورة</span>
    </div>
    <div class="flex items-center gap-5 text-[11px] md:text-xs font-mono" dir="ltr">
      <a href="tel:0572700595" class="hover:text-[#A8EBF2] flex items-center gap-1.5 transition-colors">
        <span class="material-symbols-outlined text-[15px] text-[#A8EBF2]">call</span>
        <span>+20 57 2700595</span>
      </a>
      <span class="text-white/20">|</span>
      <a href="tel:01000099872" class="hover:text-[#A8EBF2] flex items-center gap-1.5 transition-colors">
        <span class="material-symbols-outlined text-[15px] text-[#A8EBF2]">smartphone</span>
        <span>+20 100 009 9872</span>
      </a>
      <span class="hidden md:inline text-white/20">|</span>
      <span class="hidden md:flex items-center gap-1.5 text-white/70" dir="rtl">
        <span class="material-symbols-outlined text-[15px] text-[#A8EBF2]">schedule</span>
        <span>السبت - الخميس: 08:00 - 17:00</span>
      </span>
    </div>
  </div>
</div>

<!-- Main Bar -->
<div class="max-w-[1440px] mx-auto px-4 md:px-8 h-[76px] flex items-center justify-between gap-4">
  <!-- 1. Logo & Typographic Wordmark (Right) -->
  <a href="/" class="flex items-center gap-3 shrink-0 group">
    <div class="w-11 h-11 rounded-xl bg-gradient-to-br from-[#172D46] to-[#001830] border border-[#C5A46D]/40 flex items-center justify-center text-[#FFDEA9] shadow group-hover:scale-105 transition-transform">
      <span class="material-symbols-outlined text-[26px]">anchor</span>
    </div>
    <div class="flex flex-col text-right">
      <div class="font-bold text-[19px] md:text-[21px] text-[#172D46] tracking-tight leading-tight flex items-center gap-2">
        <span>زارسيف</span>
        <span class="text-[12px] md:text-[13px] font-bold text-[#1F686E] uppercase font-mono tracking-wider">ZARSEV</span>
      </div>
      <span class="text-[11px] text-[#74777E] font-medium tracking-wide">خدمات التصدير والموانئ البحرية</span>
    </div>
  </a>

  <!-- 2. Centered Desktop Navigation (Middle) -->
  <nav class="hidden xl:flex items-center gap-1 lg:gap-1.5 text-[14px] font-medium text-[#43474D] whitespace-nowrap">
${desktopLinks}
  </nav>

  <!-- 3. Smart Importer CTA & Mobile Toggle (Left) -->
  <div class="flex items-center gap-3 shrink-0">
    <a href="/importer" class="hidden sm:inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-[#1F686E] hover:bg-[#185358] text-white font-bold text-[13px] tracking-wide transition-all shadow-sm hover:shadow-md transform hover:-translate-y-0.5">
      <span class="material-symbols-outlined text-[19px]">cloud_upload</span>
      <span class="whitespace-nowrap">بوابة الاستيراد الذكي</span>
      <span class="material-symbols-outlined text-[16px]">arrow_back</span>
    </a>
    
    <!-- Mobile Hamburger Toggle Button -->
    <button type="button" onclick="toggleMobileMenu()" class="xl:hidden w-11 h-11 rounded-lg border border-[#E4E7EC] hover:bg-[#F0F3FF] flex items-center justify-center text-[#172D46] transition-colors" aria-label="فتح القائمة">
      <span class="material-symbols-outlined text-[26px]" id="mobile-menu-icon">menu</span>
    </button>
  </div>
</div>

<!-- Mobile Drawer / Dropdown Menu -->
<div id="mobile-nav-menu" class="hidden xl:hidden bg-white border-t border-[#E4E7EC] shadow-xl px-4 py-4 space-y-2 text-right">
${mobileLinks}
  <div class="pt-2 border-t border-[#E4E7EC]">
    <a href="/importer" class="flex items-center justify-center gap-2 w-full h-11 rounded-lg bg-[#1F686E] text-white font-bold text-[14px] shadow-sm">
      <span class="material-symbols-outlined text-[20px]">cloud_upload</span>
      <span>بوابة الاستيراد الذكي وأتمتة الكتالوج</span>
    </a>
  </div>
</div>
</header>`;
}

const files = [
  { file: path.join(__dirname, '..', 'zarsev_1', 'code.html'), active: 'home', ptClass: 'pt-4' },
  { file: path.join(__dirname, '..', 'zarsev_3', 'code.html'), active: 'services', ptClass: 'pt-4' },
  { file: path.join(__dirname, '..', 'zarsev_4', 'code.html'), active: 'product-details', ptClass: 'pt-4' },
  { file: path.join(__dirname, '..', 'zarsev_5', 'code.html'), active: 'consulting', ptClass: 'pt-4' },
  { file: path.join(__dirname, '..', 'zarsev_6', 'code.html'), active: 'about', ptClass: 'pt-4' },
  { file: path.join(__dirname, '..', 'zarsev_7', 'code.html'), active: 'contact', ptClass: 'pt-4' }
];

for (const target of files) {
  let content = fs.readFileSync(target.file, 'utf8');
  
  // Replace <header ...>...</header>
  const headerRegex = /<header[\s\S]*?<\/header>/i;
  if (!headerRegex.test(content)) {
    console.error(`Could not find <header> in ${target.file}`);
    continue;
  }
  
  const newHeader = generateHeader(target.active);
  content = content.replace(headerRegex, newHeader);
  
  // Also adjust main pt-* if needed so it starts with pt-4
  content = content.replace(/<main class="w-full pt-\[[^\]]+\]/i, '<main class="w-full pt-4');
  content = content.replace(/<main class="w-full pt-28/i, '<main class="w-full pt-4');
  
  fs.writeFileSync(target.file, content, 'utf8');
  console.log(`Successfully updated header in: ${path.basename(path.dirname(target.file))}/${path.basename(target.file)} [Active: ${target.active}]`);
}
