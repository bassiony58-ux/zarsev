const dbClient = require('../db/dbClient');
const { hammingDistance } = require('./parsers/imageParser');

/**
 * Tokenizes and normalizes Arabic and English text for matching.
 * Strips tashkeel, standardizes alefs/yahs/tahs, and strips common prefixes.
 */
function tokenize(text) {
    if (!text) return new Set();
    const clean = text.toLowerCase()
        .replace(/[\u064B-\u065F]/g, '')
        .replace(/أ|إ|آ/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, ' ');

    const words = clean.split(/\s+/).filter(w => w.length > 1);
    const normalizedWords = words.map(w => {
        // Strip leading 'ال' or 'و'
        if (w.startsWith('ال') && w.length > 3) return w.slice(2);
        if (w.startsWith('و') && w.length > 3) return w.slice(1);
        if (w.startsWith('ل') && w.length > 3) return w.slice(1);
        return w;
    });

    return new Set(normalizedWords.filter(w => w.length > 1));
}

function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
        if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Checks an extracted product item against the existing database for potential duplicates.
 * Preserves exact duplicate detection semantics across SQLite and PostgreSQL.
 * @param {Object} item - Extracted item { extracted_data, assigned_images }
 * @param {string} targetManufacturerId - ID of the assigned manufacturer
 * @param {Object} [dbOpts={}] - Database routing options
 */
async function checkForDuplicateProduct(item, targetManufacturerId, dbOpts = {}) {
    const data = item.extracted_data || {};
    const sku = data.sku ? data.sku.trim() : null;
    const nameAr = data.name_ar ? data.name_ar.trim() : '';

    // 1. Check exact SKU match (if SKU is provided)
    if (sku && sku.length > 2) {
        const skuSql = `
            SELECT p.id, p.name_ar, p.sku, m.name_ar as mfg_name
            FROM products p
            JOIN manufacturers m ON p.manufacturer_id = m.id
            WHERE LOWER(p.sku) = LOWER(?)
        `;

        const skuMatch = await dbClient.queryOne(skuSql, [sku], dbOpts);
        if (skuMatch) {
            return {
                is_duplicate: true,
                matched_id: skuMatch.id,
                reason: `تطابق تام في كود الصنف (SKU: ${sku}) مع المنتج الموجود: "${skuMatch.name_ar}" لدى مصنع (${skuMatch.mfg_name})`
            };
        }
    }

    // 2. Check Name similarity under the same manufacturer or globally
    if (nameAr.length > 3) {
        const tokensNew = tokenize(nameAr);
        const query = targetManufacturerId 
            ? 'SELECT id, name_ar, sku FROM products WHERE manufacturer_id = ?'
            : 'SELECT id, name_ar, sku FROM products';
        const params = targetManufacturerId ? [targetManufacturerId] : [];

        const existingProducts = await dbClient.queryAll(query, params, dbOpts);

        for (const existing of existingProducts) {
            const tokensExisting = tokenize(existing.name_ar);
            const sim = jaccardSimilarity(tokensNew, tokensExisting);
            if (sim >= 0.70) {
                return {
                    is_duplicate: true,
                    matched_id: existing.id,
                    reason: `تشابه مرتفع في الاسم (${Math.round(sim * 100)}%) مع منتج قائم: "${existing.name_ar}"`
                };
            }
        }
    }

    // 3. Check Image Perceptual Hash match against existing product images
    if (item.assigned_images && item.assigned_images.length > 0) {
        const imagesSql = `
            SELECT pi.product_id, pi.dhash, p.name_ar
            FROM product_images pi
            JOIN products p ON pi.product_id = p.id
            WHERE pi.dhash IS NOT NULL
        `;

        const existingImages = await dbClient.queryAll(imagesSql, [], dbOpts);

        for (const newImg of item.assigned_images) {
            if (!newImg.dhash) continue;
            for (const existImg of existingImages) {
                const dist = hammingDistance(newImg.dhash, existImg.dhash);
                if (dist <= 4) {
                    return {
                        is_duplicate: true,
                        matched_id: existImg.product_id,
                        reason: `الصورة المرفقة مطابقة بصرياً لصورة منتج قائم: "${existImg.name_ar}"`
                    };
                }
            }
        }
    }

    return {
        is_duplicate: false,
        matched_id: null,
        reason: null
    };
}

/**
 * Searches existing manufacturers to suggest matching profiles for extracted names.
 * Prevents accidental duplication of manufacturer profiles.
 * Preserves exact fuzzy matching semantics.
 * @param {string} extractedName
 * @param {Object} [dbOpts={}] - Database routing options
 */
async function findMatchingManufacturer(extractedName, dbOpts = {}) {
    if (!extractedName || extractedName.length < 2) return null;

    const manufacturers = await dbClient.queryAll('SELECT id, name_ar, name_en, code, business_model FROM manufacturers', [], dbOpts);
    const tokensNew = tokenize(extractedName);

    let bestMatch = null;
    let highestScore = 0;

    for (const mfg of manufacturers) {
        const tokensAr = tokenize(mfg.name_ar);
        const tokensEn = tokenize(mfg.name_en);
        const simAr = jaccardSimilarity(tokensNew, tokensAr);
        const simEn = jaccardSimilarity(tokensNew, tokensEn);
        const score = Math.max(simAr, simEn);

        // Check if distinctive root tokens match (e.g. 'بستان', 'نيل', 'دمياط')
        const hasDistinctiveKeyword = Array.from(tokensNew).some(t => t.length >= 4 && (tokensAr.has(t) || tokensEn.has(t)));

        if ((score > highestScore && score >= 0.25) || (hasDistinctiveKeyword && score >= 0.20)) {
            highestScore = score;
            bestMatch = {
                ...mfg,
                match_confidence: Math.max(score, hasDistinctiveKeyword ? 0.65 : score)
            };
        }
    }

    return bestMatch;
}

module.exports = {
    checkForDuplicateProduct,
    findMatchingManufacturer,
    jaccardSimilarity,
    tokenize
};
