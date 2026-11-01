const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const AdmZip = require('adm-zip');

const testDir = path.join(__dirname);

// 1. Generate sample Excel file
function generateExcel() {
    const data = [
        ['كود الصنف', 'اسم المنتج', 'الوصف', 'التصنيف', 'السعر', 'العملة', 'الوحدة', 'الحد الأدنى للطلب', 'نمط التعبئة'],
        ['EG-CIT-99', 'ليمون يوريكا مصري فاخر', 'ليمون عالي العصارية معالج للتصدير للاتحاد الأوروبي', 'الموالح والحمضيات الطازجة', 650, 'USD', 'MT', '1 Reefer Container (24 MT)', 'كرتون 15 كجم'],
        ['EG-VEG-55', 'بصل أحمر تصديري ممتاز', 'بصل جاف ذو قشرة صلبة خالي من العفن', 'الدرنات والبصليات الطازجة', 380, 'USD', 'MT', '2 Containers (50 MT)', 'أكياس شبك Lenobags 25 كجم'],
        ['EG-FRZ-88', 'رمان مجمد حبات وندرفول IQF', 'حبات رمان مجمدة تجميد سريع بدون مواد حافظة', 'الخضار والفواكه المجمدة IQF', 1200, 'EUR', 'MT', '1 Container', 'كرتون 10 كجم']
    ];

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Export Products');
    const excelPath = path.join(testDir, 'sample_products.xlsx');
    xlsx.writeFile(wb, excelPath);
    console.log('Generated:', excelPath);
    return excelPath;
}

// 2. Generate sample CSV file
function generateCsv() {
    const csvContent = 
`كود الصنف,اسم المنتج,السعر,العملة,الوحدة,الحد الأدنى للطلب
EG-DAT-10,تمر مجدول عضوي فاخر,3500,USD,MT,5 Tons
EG-OIL-02,زيت زيتون بكر ممتاز معصور على البارد,4500,EUR,MT,1 Container (20 MT)`;

    const csvPath = path.join(testDir, 'sample_products.csv');
    fs.writeFileSync(csvPath, '\uFEFF' + csvContent, 'utf-8');
    console.log('Generated:', csvPath);
    return csvPath;
}

// 3. Generate sample ZIP bundle
function generateZip(excelPath) {
    const zip = new AdmZip();
    zip.addLocalFile(excelPath, '', 'products.xlsx');

    // Create dummy image buffer (a tiny 10x10 PNG)
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9QzwAEjDAGYzAEAB1WAf9s+hZ/AAAAAElFTkSuQmCC', 'base64');
    zip.addFile('valencia_oranges/orange_front.png', tinyPng);
    zip.addFile('valencia_oranges/orange_box.png', tinyPng);
    zip.addFile('red_onions/onions.png', tinyPng);

    const zipPath = path.join(testDir, 'sample_bundle.zip');
    zip.writeZip(zipPath);
    console.log('Generated:', zipPath);
    return zipPath;
}

generateExcel();
generateCsv();
generateZip(path.join(testDir, 'sample_products.xlsx'));
console.log('All sample test files generated successfully.');
