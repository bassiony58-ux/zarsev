const { getDb } = require('../../db/database');

// Keywords mapping to ZARSEV Category IDs
const CATEGORY_KEYWORDS = {
    cat_citrus: ['برتقال', 'ليمون', 'يوسفي', 'جريب فروت', 'حمضيات', 'موالح', 'orange', 'lemon', 'mandarin', 'citrus', 'valencia'],
    cat_iqf: ['مجمد', 'تجميد', 'iqf', 'فراولة', 'رمان', 'بازلاء', 'خرشوف', 'خضار مجمد', 'فاكهة مجمدة', 'frozen', 'strawberry'],
    cat_tubers: ['بصل', 'بطاطس', 'ثوم', 'درنات', 'بصليات', 'onion', 'potato', 'garlic'],
    cat_dates: ['تمر', 'بلح', 'مجدول', 'سيوي', 'أعشاب', 'شمر', 'بردقوش', 'dates', 'herbs'],
    cat_oils: ['زيت', 'زيتون', 'مخلل', 'olive oil', 'oil', 'pickles'],
    cat_textiles: ['قطن', 'كتان', 'غزول', 'منسوجات', 'textile', 'cotton', 'yarn']
};

/**
 * Suggests category based on product title and description text.
 */
function suggestCategory(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const [catId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        for (const kw of keywords) {
            if (lower.includes(kw)) {
                return catId;
            }
        }
    }
    return null;
}

/**
 * Deterministic normalization function: cleans values and ensures no hallucination.
 */
function normalizeExtractedProduct(item) {
    const raw = item.raw_data || {};
    const ext = { ...item.extracted_data };
    const warnings = [...(item.validation_warnings || [])];

    // Clean Arabic strings
    if (ext.name_ar) {
        ext.name_ar = ext.name_ar.trim().replace(/\s+/g, ' ');
    }

    // Auto-suggest category if not set
    if (!item.suggested_category_id) {
        const catId = suggestCategory((ext.name_ar || '') + ' ' + (ext.description_ar || ''));
        item.suggested_category_id = catId;
    }

    // Price unit normalization
    if (ext.price_unit) {
        const unitNorm = ext.price_unit.toLowerCase();
        if (/طن|ton|mt/i.test(unitNorm)) ext.price_unit = 'MT';
        else if (/كجم|كيلو|kg/i.test(unitNorm)) ext.price_unit = 'KG';
        else if (/كرتون|carton|box/i.test(unitNorm)) ext.price_unit = 'Carton';
    } else {
        ext.price_unit = 'MT'; // Default export unit
    }

    // Currency normalization
    if (ext.currency) {
        const currNorm = ext.currency.toLowerCase();
        if (/دولار|\$|usd/i.test(currNorm)) ext.currency = 'USD';
        else if (/يورو|€|eur/i.test(currNorm)) ext.currency = 'EUR';
        else if (/جنيه|egp/i.test(currNorm)) ext.currency = 'EGP';
        else if (/ريال|sar/i.test(currNorm)) ext.currency = 'SAR';
    } else {
        ext.currency = 'USD';
    }

    // Country of origin
    if (!ext.country_of_origin) {
        ext.country_of_origin = 'مصر';
    }

    // Never invent price, MOQ, or specifications
    if (ext.price === undefined || ext.price === null || isNaN(ext.price)) {
        ext.price = null;
        if (!warnings.includes('السعر غير متوفر ويحتاج لمراجعة يدوية')) {
            warnings.push('السعر غير متوفر ويحتاج لمراجعة يدوية');
        }
    }

    if (!ext.moq) {
        if (!warnings.includes('الحد الأدنى للطلب (MOQ) غير متوفر')) {
            warnings.push('الحد الأدنى للطلب (MOQ) غير متوفر');
        }
    }

    // Compute final confidence
    let confidence = 0.95;
    if (!ext.name_ar) confidence -= 0.40;
    if (ext.price === null) confidence -= 0.15;
    if (!ext.moq) confidence -= 0.10;
    if (!item.suggested_category_id) confidence -= 0.10;

    return {
        ...item,
        extracted_data: ext,
        confidence_score: Math.max(0.2, parseFloat(confidence.toFixed(2))),
        validation_warnings: warnings
    };
}

module.exports = {
    suggestCategory,
    normalizeExtractedProduct
};
