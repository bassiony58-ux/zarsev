const config = require('../../config');
const { normalizeExtractedProduct, suggestCategory } = require('./localDeterministicProvider');
const { checkForDuplicateProduct } = require('../duplicateDetectionService');

/**
 * Universal AI Processing & Normalization Service.
 * Validates, normalizes, detects duplicates, and assigns categories.
 */
async function processAndNormalizeItem(item, targetManufacturerId) {
    // 1. Normalize fields (prevent hallucinations, clean strings, check completeness)
    const normalized = normalizeExtractedProduct(item);

    // 2. Perform Duplicate Detection against DB
    const duplicateCheck = checkForDuplicateProduct(normalized, targetManufacturerId);
    normalized.is_duplicate = duplicateCheck.is_duplicate ? 1 : 0;
    normalized.duplicate_matched_id = duplicateCheck.matched_id;
    normalized.duplicate_reason = duplicateCheck.reason;

    if (duplicateCheck.is_duplicate) {
        normalized.validation_warnings = normalized.validation_warnings || [];
        normalized.validation_warnings.push(`تحذير تكرار: ${duplicateCheck.reason}`);
    }

    return normalized;
}

module.exports = {
    processAndNormalizeItem,
    suggestCategory
};
