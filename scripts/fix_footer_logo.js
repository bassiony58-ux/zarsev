const fs = require('fs');
const path = require('path');

const svgBadge = '<div class="w-9 h-9 rounded-lg bg-gradient-to-br from-[#172D46] to-[#001830] border border-[#C5A46D]/40 flex items-center justify-center text-[#FFDEA9] shadow-sm"><span class="material-symbols-outlined text-[20px]">anchor</span></div>';

for (let i = 1; i <= 7; i++) {
  const filePath = path.join(__dirname, '..', `zarsev_${i}`, 'code.html');
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    const regex = /<img\s+alt="ZARSEV Logo"[^>]*src="https:\/\/lh3\.googleusercontent\.com\/aida\/AEtjO1Ujq[^>]*\/>/g;
    if (regex.test(content)) {
      content = content.replace(regex, svgBadge);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Replaced footer image in zarsev_${i}/code.html`);
    }
  }
}
