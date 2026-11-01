const mammoth = require('mammoth');
const fs = require('fs');

async function parseDocx(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath });
        const text = result.value || '';
        
        // Also extract HTML to see if there are table structures
        const htmlResult = await mammoth.convertToHtml({ path: filePath });
        const html = htmlResult.value || '';

        const items = [];
        
        // Check if there are tables in HTML
        if (html.includes('<table')) {
            // Simple regex parser for HTML tables
            const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
            if (rowMatches.length > 1) {
                // First row is headers
                const headerCells = (rowMatches[0].match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || [])
                    .map(c => c.replace(/<[^>]+>/g, '').trim());

                for (let i = 1; i < rowMatches.length; i++) {
                    const cells = (rowMatches[i].match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || [])
                        .map(c => c.replace(/<[^>]+>/g, '').trim());

                    if (cells.length > 0 && cells.some(Boolean)) {
                        const rawItem = {};
                        headerCells.forEach((h, idx) => {
                            rawItem[h || `عمود_${idx + 1}`] = cells[idx] || '';
                        });

                        const extracted = {
                            name_ar: cells[0] || '',
                            description_ar: cells[1] || '',
                            specifications: {},
                            price: null,
                            currency: 'USD',
                            price_unit: 'MT',
                            moq: '',
                            country_of_origin: 'مصر'
                        };

                        // Look for price and MOQ in cells
                        cells.forEach(cell => {
                            if (/(\$|€|USD|EUR|EGP|جنيه|\bدولار\b)/i.test(cell) || /[0-9]+\s*(طن|ton|kg|كجم)/i.test(cell)) {
                                const num = parseFloat(cell.replace(/[^0-9.]/g, ''));
                                if (!isNaN(num) && num > 0 && !extracted.price) extracted.price = num;
                            }
                            if (/(الحد الأدنى|MOQ|حاوية|طن)/i.test(cell) && !extracted.moq) {
                                extracted.moq = cell;
                            }
                        });

                        items.push({
                            raw_data: rawItem,
                            extracted_data: extracted,
                            confidence_score: extracted.name_ar ? 0.85 : 0.4,
                            validation_warnings: extracted.price === null ? ['السعر غير محدد'] : [],
                            source_reference: `مستند Word - جدول، الصف ${i}`
                        });
                    }
                }
            }
        }

        // If no table items found, parse paragraphs by sections
        if (items.length === 0 && text.trim().length > 0) {
            const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
            paragraphs.forEach((p, idx) => {
                if (p.length > 10) {
                    const lines = p.split('\n').map(l => l.trim()).filter(Boolean);
                    const title = lines[0];
                    const extracted = {
                        name_ar: title,
                        description_ar: lines.slice(1).join(' '),
                        specifications: {},
                        price: null,
                        currency: 'USD',
                        price_unit: 'MT',
                        moq: '',
                        country_of_origin: 'مصر'
                    };

                    items.push({
                        raw_data: { paragraph: p },
                        extracted_data: extracted,
                        confidence_score: 0.75,
                        validation_warnings: ['تم الاستخراج من فقرة نصية - يرجى مراجعة الحقول'],
                        source_reference: `مستند Word - فقرة ${idx + 1}`
                    });
                }
            });
        }

        return { items, warnings: [] };
    } catch (err) {
        console.error('Error in parseDocx:', err);
        return { items: [], warnings: [`تعذر معالجة ملف Word: ${err.message}`] };
    }
}

module.exports = {
    parseDocx
};
