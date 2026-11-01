const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const config = require('../config');
const { parseExcel } = require('./parsers/excelParser');
const { parseCsv } = require('./parsers/csvParser');
const { parseDocx } = require('./parsers/docxParser');
const { parsePdf } = require('./parsers/pdfParser');
const { parseImage } = require('./parsers/imageParser');
const { extractZip } = require('./parsers/zipParser');
const { clusterImages, getProductClusterKey } = require('./imageClusteringService');
const { processAndNormalizeItem } = require('./ai/aiService');
const { findMatchingManufacturer } = require('./duplicateDetectionService');

/**
 * Appends a log entry to import_logs table.
 */
function logImportStep(importId, step, message, severity = 'INFO') {
    try {
        const db = getDb();
        const logId = 'log_' + crypto.randomBytes(6).toString('hex');
        db.prepare(`
            INSERT INTO import_logs (id, import_id, step, message, severity)
            VALUES (?, ?, ?, ?, ?)
        `).run(logId, importId, step, message, severity);
    } catch (err) {
        console.error('Failed to write import log:', err);
    }
}

/**
 * Updates import progress and status.
 */
function updateImportProgress(importId, status, progressPercent, updates = {}) {
    try {
        const db = getDb();
        let setClauses = ['status = ?', 'progress_percent = ?', 'updated_at = CURRENT_TIMESTAMP'];
        let params = [status, progressPercent];

        if (updates.total_detected !== undefined) {
            setClauses.push('total_detected = ?');
            params.push(updates.total_detected);
        }
        if (updates.total_valid !== undefined) {
            setClauses.push('total_valid = ?');
            params.push(updates.total_valid);
        }
        if (updates.total_failed !== undefined) {
            setClauses.push('total_failed = ?');
            params.push(updates.total_failed);
        }
        if (updates.error_summary !== undefined) {
            setClauses.push('error_summary = ?');
            params.push(updates.error_summary);
        }
        if (updates.manufacturer_id !== undefined) {
            setClauses.push('manufacturer_id = ?');
            params.push(updates.manufacturer_id);
        }

        params.push(importId);
        db.prepare(`UPDATE imports SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    } catch (err) {
        console.error('Failed to update import progress:', err);
    }
}

/**
 * Asynchronous Background Worker that processes an import session.
 */
async function processImportJob(importId) {
    const db = getDb();
    const importRecord = db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
    if (!importRecord) return;

    try {
        logImportStep(importId, 'START', 'بدء معالجة حزمة الاستيراد والملفات المرفوعة...');
        updateImportProgress(importId, 'PARSING', 15);

        const sourceFiles = JSON.parse(importRecord.source_files || '[]');
        let targetManufacturerId = importRecord.manufacturer_id;

        // Collections for parsed contents
        const extractedItems = [];
        const parsedImages = [];
        const filesToProcess = [...sourceFiles];

        // 1. Unzip any archives first
        const unzippedDirs = [];
        for (const file of sourceFiles) {
            const ext = path.extname(file.path).toLowerCase();
            if (ext === '.zip') {
                logImportStep(importId, 'UNZIP', `فك ضغط الأرشيف: ${file.originalname}`);
                const extractDir = path.join(path.dirname(file.path), 'unzipped_' + path.basename(file.path, ext));
                const zipContents = extractZip(file.path, extractDir);
                unzippedDirs.push(extractDir);

                // Add unzipped files to processing list
                zipContents.spreadsheets.forEach(s => filesToProcess.push({ path: s.fullPath, originalname: s.filename, folderName: s.folderName }));
                zipContents.documents.forEach(d => filesToProcess.push({ path: d.fullPath, originalname: d.filename, folderName: d.folderName }));
                zipContents.pdfs.forEach(p => filesToProcess.push({ path: p.fullPath, originalname: p.filename, folderName: p.folderName }));
                zipContents.images.forEach(img => filesToProcess.push({ path: img.fullPath, originalname: img.filename, folderName: img.folderName }));
            }
        }

        updateImportProgress(importId, 'PARSING', 35);

        // 2. Process all documents and images
        for (const file of filesToProcess) {
            const ext = path.extname(file.path).toLowerCase();
            const filePath = file.path;

            if (['.xlsx', '.xls'].includes(ext)) {
                logImportStep(importId, 'PARSE_EXCEL', `قراءة جدول البيانات: ${file.originalname}`);
                const excelRes = parseExcel(filePath);
                extractedItems.push(...excelRes.items);
            } else if (ext === '.csv') {
                logImportStep(importId, 'PARSE_CSV', `قراءة ملف CSV: ${file.originalname}`);
                const csvRes = parseCsv(filePath);
                extractedItems.push(...csvRes.items);
            } else if (['.docx', '.doc'].includes(ext)) {
                logImportStep(importId, 'PARSE_DOCX', `قراءة مستند Word: ${file.originalname}`);
                const docxRes = await parseDocx(filePath);
                extractedItems.push(...docxRes.items);
            } else if (ext === '.pdf') {
                logImportStep(importId, 'PARSE_PDF', `تحليل كتالوج PDF: ${file.originalname}`);
                const pdfRes = await parsePdf(filePath);
                extractedItems.push(...pdfRes.items);
            } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
                // Compute relative web path for UI serving
                const relativeWeb = `/storage/uploads/${importId}/original/${path.basename(filePath)}`;
                const imgInfo = await parseImage(filePath, relativeWeb);
                imgInfo.folderName = file.folderName || '';
                parsedImages.push(imgInfo);
            }
        }

        updateImportProgress(importId, 'EXTRACTING', 60);
        logImportStep(importId, 'IMAGE_CLUSTERING', `تنظيم وفرز الصور المرفوعة (العدد: ${parsedImages.length})...`);

        // 3. Image grouping & Product matching
        if (extractedItems.length === 0 && parsedImages.length > 0) {
            // Case A: User uploaded ONLY images (or images in zip)
            const clustered = clusterImages(parsedImages);
            logImportStep(importId, 'CLUSTER_DONE', `تم تجميع الصور إلى (${clustered.clusters.length}) أصناف مقترحة.`);

            clustered.clusters.forEach((cl, idx) => {
                const primaryImg = cl.images.find(img => img.is_primary) || cl.images[0];
                extractedItems.push({
                    raw_data: { cluster_name: cl.suggested_title, images_count: cl.images.length },
                    extracted_data: {
                        name_ar: cl.suggested_title,
                        name_en: '',
                        sku: '',
                        description_ar: `صنف مستخرج آلياً من ملفات الصور المرفوعة (${cl.images.length} صور).`,
                        specifications: {},
                        packaging_info: '',
                        price: null,
                        currency: 'USD',
                        price_unit: 'MT',
                        moq: '',
                        country_of_origin: 'مصر'
                    },
                    assigned_images: cl.images,
                    confidence_score: 0.70,
                    validation_warnings: ['مستخرج من مجموعة صور - يرجى إدخال السعر والمواصفات'],
                    source_reference: `مجموعة صور: ${cl.suggested_title}`
                });
            });
        } else if (extractedItems.length > 0 && parsedImages.length > 0) {
            // Case B: User uploaded spreadsheets/documents AND images
            // Associate images with products based on SKU or Name keyword match
            const clustered = clusterImages(parsedImages);
            
            extractedItems.forEach(item => {
                item.assigned_images = item.assigned_images || [];
                const itemName = (item.extracted_data.name_ar || item.extracted_data.name_en || '').toLowerCase();
                const itemSku = (item.extracted_data.sku || '').toLowerCase();

                clustered.clusters.forEach(cl => {
                    const clKey = cl.cluster_key.toLowerCase();
                    if ((itemSku && clKey.includes(itemSku)) || (itemName && (itemName.includes(clKey) || clKey.includes(itemName)))) {
                        item.assigned_images.push(...cl.images);
                    }
                });

                // Deduplicate assigned images
                const seenUrls = new Set();
                item.assigned_images = item.assigned_images.filter(img => {
                    if (seenUrls.has(img.url)) return false;
                    seenUrls.add(img.url);
                    return true;
                });

                // Ensure exactly one primary image
                if (item.assigned_images.length > 0 && !item.assigned_images.some(i => i.is_primary)) {
                    item.assigned_images[0].is_primary = true;
                }
            });
        }

        updateImportProgress(importId, 'EXTRACTING', 80);
        logImportStep(importId, 'NORMALIZATION', 'تنقيح البيانات واكتشاف التكرارات وتصنيف المنتجات...');

        // 4. Auto-detect manufacturer from document if not selected
        if (!targetManufacturerId && extractedItems.length > 0) {
            for (const it of extractedItems) {
                const detected = it.raw_data ? Object.values(it.raw_data).join(' ') : '';
                const match = findMatchingManufacturer(detected);
                if (match && match.match_confidence > 0.5) {
                    targetManufacturerId = match.id;
                    logImportStep(importId, 'MFG_MATCH', `تم اقتراح المصنع المطابق: "${match.name_ar}" (ثقة: ${Math.round(match.match_confidence * 100)}%)`);
                    break;
                }
            }
        }

        // 5. Run AI Normalization, Duplicate Detection, and Category Suggestion
        const finalizedItems = [];
        let validCount = 0;
        let failedCount = 0;

        for (const item of extractedItems) {
            const processed = await processAndNormalizeItem(item, targetManufacturerId);
            
            // Generate DB record for import_items
            const itemId = 'item_' + crypto.randomBytes(6).toString('hex');
            const status = (processed.extracted_data && processed.extracted_data.name_ar) ? 'AWAITING_REVIEW' : 'FAILED';
            if (status === 'AWAITING_REVIEW') validCount++;
            else failedCount++;

            db.prepare(`
                INSERT INTO import_items (
                    id, import_id, suggested_manufacturer_id, suggested_category_id,
                    raw_data, extracted_data, confidence_score, validation_warnings,
                    is_duplicate, duplicate_matched_id, duplicate_reason, assigned_images, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                itemId,
                importId,
                targetManufacturerId,
                processed.suggested_category_id || null,
                JSON.stringify(processed.raw_data || {}),
                JSON.stringify(processed.extracted_data || {}),
                processed.confidence_score || 0.8,
                JSON.stringify(processed.validation_warnings || []),
                processed.is_duplicate ? 1 : 0,
                processed.duplicate_matched_id || null,
                processed.duplicate_reason || null,
                JSON.stringify(processed.assigned_images || []),
                status
            );

            finalizedItems.push({ itemId, ...processed });
        }

        // 6. Complete Import Job
        updateImportProgress(importId, 'REVIEW_READY', 100, {
            total_detected: extractedItems.length,
            total_valid: validCount,
            total_failed: failedCount,
            manufacturer_id: targetManufacturerId
        });

        logImportStep(importId, 'COMPLETE', `اكتملت المعالجة بنجاح: تم التعرف على (${extractedItems.length}) منتجات، وجاهزة للمراجعة.`);

    } catch (err) {
        console.error('Import processing error:', err);
        logImportStep(importId, 'ERROR', `حدث خطأ أثناء معالجة الاستيراد: ${err.message}`, 'ERROR');
        updateImportProgress(importId, 'FAILED', 100, {
            error_summary: err.message
        });
    }
}

module.exports = {
    processImportJob,
    logImportStep,
    updateImportProgress
};
