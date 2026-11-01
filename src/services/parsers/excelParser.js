const xlsx = require('xlsx');
const path = require('path');

// Column mapping dictionary for Arabic and English headers
const FIELD_SYNONYMS = {
    sku: ['كود الصنف', 'الكود', 'كود التصدير', 'رمز الصنف', 'رقم الصنف', 'كود', 'sku', 'code', 'item code', 'hs code', 'hs_code'],
    name_ar: ['اسم المنتج', 'اسم الصنف', 'المنتج', 'product name', 'product', 'item name', 'item'],
    name_en: ['product name en', 'english name', 'item en', 'name en'],
    category: ['التصنيف', 'القسم', 'الفئة', 'المجموعة', 'category', 'group'],
    subcategory: ['التصنيف الفرعي', 'الفئة الفرعية', 'النوع', 'subcategory', 'sub_category', 'type'],
    description_ar: ['الوصف', 'شرح الصنف', 'تفاصيل المنتج', 'بيانات المنتج', 'description', 'details'],
    price: ['السعر', 'سعر التصدير', 'سعر الطن', 'سعر الوحدة', 'price', 'unit price', 'fob price', 'cif price'],
    currency: ['العملة', 'نوع العملة', 'currency', 'curr'],
    price_unit: ['الوحدة', 'وحدة القياس', 'unit', 'price unit', 'uom'],
    moq: ['الحد الادنى للطلب', 'الحد الأدنى', 'اقل كمية', 'الحد الادنى', 'moq', 'minimum order quantity', 'min order'],
    country_of_origin: ['بلد المنشا', 'بلد المنشأ', 'المنشا', 'المنشأ', 'country of origin', 'origin'],
    packaging_info: ['التعبئة', 'نمط التعبئة', 'العبوة', 'التغليف', 'packaging', 'packing', 'package'],
    available_quantity: ['الكمية المتاحة', 'المخزون المتاح', 'الكمية', 'available quantity', 'stock', 'quantity'],
    calibers: ['المقاسات', 'الاحجام', 'الأحجام', 'الكالبر', 'calibers', 'sizes'],
    storage_temp: ['درجة الحرارة', 'حرارة التخزين', 'حرارة التبريد', 'temperature', 'storage temp']
};

function normalizeHeader(header) {
    if (!header) return '';
    return header.toString().trim().toLowerCase()
        .replace(/[\u064B-\u065F]/g, '') // Remove Arabic tashkeel
        .replace(/أ|إ|آ/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function matchHeaderToField(header) {
    const norm = normalizeHeader(header);
    if (!norm) return null;

    // 1. Pass 1: Exact matches
    for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
        for (const syn of synonyms) {
            if (norm === normalizeHeader(syn)) {
                return field;
            }
        }
    }

    // 2. Specific keywords override
    if (norm.includes('كود') || norm.includes('رمز') || norm.includes('sku') || norm.includes('code')) {
        return 'sku';
    }
    if (norm.includes('اسم') || norm.includes('صنف') || norm.includes('منتج')) {
        return 'name_ar';
    }

    // 3. Pass 2: Partial matches
    for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
        for (const syn of synonyms) {
            const normSyn = normalizeHeader(syn);
            if (norm.includes(normSyn) || normSyn.includes(norm)) {
                return field;
            }
        }
    }
    return null;
}

/**
 * Parses an Excel file (.xlsx, .xls) and returns structured product items.
 */
function parseExcel(filePath) {
    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawRows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (!rawRows || rawRows.length < 2) {
        return { items: [], warnings: ['الملف فارغ أو لا يحتوي على صفوف بيانات'] };
    }

    // Detect header row (usually first non-empty row)
    let headerRowIndex = 0;
    while (headerRowIndex < rawRows.length && (!rawRows[headerRowIndex] || rawRows[headerRowIndex].filter(Boolean).length < 2)) {
        headerRowIndex++;
    }

    if (headerRowIndex >= rawRows.length) {
        return { items: [], warnings: ['لم يتم العثور على عناوين أعمدة واضحة'] };
    }

    const headers = rawRows[headerRowIndex];
    const columnFieldMap = {};
    headers.forEach((header, colIdx) => {
        const field = matchHeaderToField(header);
        if (field) {
            columnFieldMap[colIdx] = field;
        }
    });

    const items = [];
    for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
        const row = rawRows[r];
        if (!row || row.filter(Boolean).length === 0) continue;

        const rawItem = {};
        const extracted = {
            name_ar: '',
            name_en: '',
            sku: '',
            category: '',
            subcategory: '',
            description_ar: '',
            price: null,
            currency: 'USD',
            price_unit: 'MT',
            moq: '',
            country_of_origin: 'مصر',
            packaging_info: '',
            available_quantity: null,
            specifications: {}
        };

        headers.forEach((h, idx) => {
            if (h) rawItem[h.toString().trim()] = row[idx] ?? '';
        });

        // Extract matched fields
        Object.entries(columnFieldMap).forEach(([colIdx, field]) => {
            const val = row[colIdx];
            if (val !== undefined && val !== null && val !== '') {
                const strVal = val.toString().trim();
                if (field === 'price') {
                    const num = parseFloat(strVal.replace(/[^0-9.]/g, ''));
                    if (!isNaN(num)) extracted.price = num;
                } else if (field === 'calibers' || field === 'storage_temp') {
                    extracted.specifications[field] = strVal;
                } else {
                    extracted[field] = strVal;
                }
            }
        });

        // If product name is missing, look for first non-numeric text column
        if (!extracted.name_ar) {
            for (let i = 0; i < row.length; i++) {
                const val = row[i];
                if (typeof val === 'string' && val.trim().length > 2 && isNaN(Number(val)) && columnFieldMap[i] !== 'sku') {
                    extracted.name_ar = val.trim();
                    break;
                }
            }
        }

        // Validate extraction confidence
        const warnings = [];
        let confidence = 0.95;

        if (!extracted.name_ar) {
            confidence -= 0.5;
            warnings.push('اسم المنتج غير متوفر في السجل');
        }
        if (extracted.price === null) {
            warnings.push('السعر غير محدد في ملف المصدر');
        }
        if (!extracted.moq) {
            warnings.push('الحد الأدنى للطلب (MOQ) غير محدد');
        }

        items.push({
            raw_data: rawItem,
            extracted_data: extracted,
            confidence_score: Math.max(0.1, confidence),
            validation_warnings: warnings,
            source_reference: `ورقة العمل: ${sheetName}، الصف: ${r + 1}`
        });
    }

    return { items, warnings: [] };
}

module.exports = {
    parseExcel,
    matchHeaderToField
};
