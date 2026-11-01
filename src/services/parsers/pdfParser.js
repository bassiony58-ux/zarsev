const fs = require('fs');
const pdfParse = require('pdf-parse');

/**
 * Parses PDF catalogs and extracts product entities and sections.
 */
async function parsePdf(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        const text = data.text || '';
        const pagesCount = data.numpages || 1;

        const items = [];
        // Split by form feeds or multiple newlines
        const sections = text.split(/\f|\n{3,}/).map(s => s.trim()).filter(Boolean);

        sections.forEach((sec, idx) => {
            if (sec.length < 15) return;

            const lines = sec.split('\n').map(l => l.trim()).filter(Boolean);
            const title = lines[0];

            const extracted = {
                name_ar: title,
                name_en: '',
                sku: '',
                description_ar: lines.slice(1, 4).join(' '),
                specifications: {},
                packaging_info: '',
                price: null,
                currency: 'USD',
                price_unit: 'MT',
                moq: '',
                country_of_origin: 'مصر'
            };

            // Scan lines for export attributes
            lines.forEach(line => {
                // Price matching
                const priceMatch = line.match(/(\$|€|USD|EUR|EGP|جنيه)\s*([0-9,.]+)/i) || line.match(/([0-9,.]+)\s*(\$|€|USD|EUR|EGP|طن)/i);
                if (priceMatch && !extracted.price) {
                    const num = parseFloat((priceMatch[2] || priceMatch[1]).replace(/,/g, ''));
                    if (!isNaN(num)) extracted.price = num;
                }

                // MOQ matching
                if (/حاوية|كونتينر|طن|cartons|boxes|MOQ|الحد الأدنى/i.test(line) && !extracted.moq) {
                    extracted.moq = line;
                }

                // Packaging matching
                if (/كرتون|أكياس|جامبو|تلسكوبي|packaging|pack|carton|bags/i.test(line) && !extracted.packaging_info) {
                    extracted.packaging_info = line;
                }

                // Calibers or Brix matching
                if (/caliber|مقاس|brix|بريكس|حرارة|°C/i.test(line)) {
                    extracted.specifications['details'] = (extracted.specifications['details'] ? extracted.specifications['details'] + ' | ' : '') + line;
                }
            });

            const warnings = [];
            let confidence = 0.80;

            if (extracted.price === null) {
                warnings.push('السعر غير محدد في الكتالوج');
            }
            if (!extracted.moq) {
                warnings.push('الحد الأدنى للطلب (MOQ) غير محدد');
            }

            items.push({
                raw_data: { section_text: sec },
                extracted_data: extracted,
                confidence_score: confidence,
                validation_warnings: warnings,
                source_reference: `كتالوج PDF - صفحة/قسم ${idx + 1}`
            });
        });

        return { items, warnings: [] };
    } catch (err) {
        console.error('Error in parsePdf:', err);
        return { items: [], warnings: [`تعذر معالجة كتالوج PDF: ${err.message}`] };
    }
}

module.exports = {
    parsePdf
};
