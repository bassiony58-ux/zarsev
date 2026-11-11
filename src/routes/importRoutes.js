const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const dbClient = require('../db/dbClient');
const { authMiddleware, requireSubRole } = require('../middlewares/auth');
const { checkSubscriptionLimits } = require('../middlewares/subscriptionGuard');
const { upload } = require('../middlewares/uploadValidator');
const { processImportJob } = require('../services/importJobQueue');

/**
 * Safely parses JSON columns across SQLite (strings) and PostgreSQL (objects/arrays).
 */
function parseJsonField(val, fallback) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'object') return val;
    try {
        return JSON.parse(val);
    } catch (_) {
        return fallback;
    }
}

/**
 * Access Control Helper: Verifies user permission for a specific import session asynchronously.
 * Prevents tenant crossover and unauthorized cross-manufacturer operations.
 * @param {string} importId
 * @param {Object} user
 * @param {Object} [dbOpts={}] - Database routing options
 */
async function checkImportAccess(importId, user, dbOpts = {}) {
    const imp = await dbClient.queryOne(`
        SELECT i.*, m.business_model, m.name_ar as mfg_name
        FROM imports i
        LEFT JOIN manufacturers m ON i.manufacturer_id = m.id
        WHERE i.id = ?
    `, [importId], dbOpts);

    if (!imp) {
        return { allowed: false, statusCode: 404, error: 'عملية الاستيراد غير موجودة' };
    }

    // 1. Super Admin: full access
    if (user.role === 'SUPER_ADMIN') {
        return { allowed: true, importRecord: imp };
    }

    // 2. Logistics Officer: access Direct Contract imports or own created imports
    if (user.role === 'LOGISTICS_OFFICER') {
        if (imp.business_model === 'DIRECT_CONTRACT' || imp.user_id === user.id) {
            return { allowed: true, importRecord: imp };
        }
        return {
            allowed: false,
            statusCode: 403,
            error: 'غير مصرح: لا يمتلك مسؤول العمليات اللوجستية صلاحية الوصول إلى عمليات الاشتراكات التسويقية المستقلة'
        };
    }

    // 3. Marketing Subscription Manufacturer: strictly isolated to their own manufacturer account
    if (user.role === 'MANUFACTURER') {
        if (imp.manufacturer_id && imp.manufacturer_id === user.manufacturer_id) {
            if (!user.sub_role || !['OWNER', 'PRODUCTION'].includes(user.sub_role)) {
                return {
                    allowed: false,
                    statusCode: 403,
                    error: 'غير مصرح: ليس لديك الدور الفرعي المطلوب لإدارة عمليات الاستيراد والكتالوج'
                };
            }
            return { allowed: true, importRecord: imp };
        }
        return {
            allowed: false,
            statusCode: 403,
            error: 'غير مصرح: لا يمكنك الوصول إلى عمليات استيراد تخص حساب مصنع آخر'
        };
    }

    return { allowed: false, statusCode: 403, error: 'غير مصرح بالوصول' };
}

// 1. Upload files and launch background import job
router.post('/upload', authMiddleware, requireSubRole(['OWNER', 'PRODUCTION'], { allowRoles: ['SUPER_ADMIN', 'LOGISTICS_OFFICER'] }), checkSubscriptionLimits(), (req, res) => {
    const importId = 'imp_' + crypto.randomBytes(6).toString('hex');
    req.importSessionId = importId;
    const dbOpts = req.dbClientOptions || {};

    upload.array('files', 50)(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, error: err.message });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: 'لم يتم اختيار أي ملفات للرفع' });
        }

        try {
            let targetManufacturerId = req.body.manufacturer_id || null;

            // Security check for Marketing Subscription Manufacturers:
            // Client-supplied manufacturer_id is STRICTLY ignored! Always bind to own manufacturer account.
            if (req.user.role === 'MANUFACTURER') {
                targetManufacturerId = req.user.manufacturer_id;
            } else if (req.user.role === 'LOGISTICS_OFFICER' && targetManufacturerId) {
                // Logistics officer can only assign to DIRECT_CONTRACT manufacturers
                const targetMfg = await dbClient.queryOne('SELECT business_model FROM manufacturers WHERE id = ?', [targetManufacturerId], dbOpts);
                if (targetMfg && targetMfg.business_model !== 'DIRECT_CONTRACT') {
                    return res.status(403).json({
                        success: false,
                        error: 'غير مصرح: يمكن لمسؤول العمليات إدارة مصانع العقود المباشرة فقط'
                    });
                }
            }

            const sourceFiles = req.files.map(f => ({
                originalname: f.originalname,
                filename: f.filename,
                path: f.path,
                size: f.size,
                mimetype: f.mimetype
            }));

            const activeEngine = dbOpts.engine || (dbOpts.dbNameOverride ? 'postgres' : ((process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres' ? 'postgres' : 'sqlite'));
            const isPg = activeEngine === 'postgres';
            const isDemoVal = isPg ? Boolean(req.user.is_demo) : (req.user.is_demo ? 1 : 0);

            await dbClient.execute(`
                INSERT INTO imports (id, user_id, manufacturer_id, source_files, status, progress_percent, is_demo)
                VALUES (?, ?, ?, ?, 'PENDING', 5, ?)
            `, [
                importId,
                req.user.id,
                targetManufacturerId,
                JSON.stringify(sourceFiles),
                isDemoVal
            ], dbOpts);

            // Fire background worker asynchronously
            setImmediate(() => {
                processImportJob(importId, dbOpts).catch(jobErr => {
                    console.error(`Background job failure for import ${importId}:`, jobErr);
                });
            });

            return res.status(202).json({
                success: true,
                message: 'تم استلام الملفات وبدأت عملية الفحص والاستخراج في الخلفية',
                import_id: importId,
                status_url: `/api/imports/status/${importId}`
            });
        } catch (uploadErr) {
            console.error('[importRoutes] POST /upload error:', uploadErr.message);
            return res.status(500).json({
                success: false,
                error: 'خطأ في خادم قاعدة البيانات أثناء تسجيل عملية الاستيراد'
            });
        }
    });
});

// 2. Poll import progress and background status
router.get('/status/:id', authMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    try {
        const access = await checkImportAccess(req.params.id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const imp = access.importRecord;
        const logs = await dbClient.queryAll('SELECT * FROM import_logs WHERE import_id = ? ORDER BY timestamp ASC', [req.params.id], dbOpts);

        return res.json({
            success: true,
            import: {
                ...imp,
                source_files: parseJsonField(imp.source_files, [])
            },
            logs
        });
    } catch (err) {
        console.error('[importRoutes] GET /status/:id error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في استرجاع حالة عملية الاستيراد' });
    }
});

// 3. Get extracted draft items for review
router.get('/:id/items', authMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    try {
        const access = await checkImportAccess(req.params.id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const items = await dbClient.queryAll(`
            SELECT ii.*, m.name_ar as suggested_manufacturer_name, c.name_ar as suggested_category_name
            FROM import_items ii
            LEFT JOIN manufacturers m ON ii.suggested_manufacturer_id = m.id
            LEFT JOIN categories c ON ii.suggested_category_id = c.id
            WHERE ii.import_id = ?
            ORDER BY ii.created_at ASC
        `, [req.params.id], dbOpts);

        const formatted = items.map(item => ({
            ...item,
            extracted_data: parseJsonField(item.extracted_data, {}),
            validation_warnings: parseJsonField(item.validation_warnings, []),
            assigned_images: parseJsonField(item.assigned_images, [])
        }));

        return res.json({
            success: true,
            items: formatted,
            import_id: req.params.id
        });
    } catch (err) {
        console.error('[importRoutes] GET /:id/items error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في استرجاع بنود عملية الاستيراد' });
    }
});

// 4. Update single item during review (Enforces Import Ownership & IDOR Protection)
router.put('/:id/items/:itemId', authMiddleware, async (req, res) => {
    const { id, itemId } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const { extracted_data, suggested_category_id, suggested_manufacturer_id, status } = req.body || {};

        // Strict IDOR Check: Ensure item strictly belongs to this exact import session
        const item = await dbClient.queryOne('SELECT * FROM import_items WHERE id = ? AND import_id = ?', [itemId, id], dbOpts);
        if (!item) {
            return res.status(404).json({ success: false, error: 'المنتج غير موجود في عملية الاستيراد المحددة' });
        }

        // Manufacturer security: Marketing manufacturer cannot reassign to another manufacturer profile
        let finalMfgId = suggested_manufacturer_id ?? item.suggested_manufacturer_id;
        if (req.user.role === 'MANUFACTURER') {
            finalMfgId = req.user.manufacturer_id;
        }

        const currentExtracted = parseJsonField(item.extracted_data, {});
        const updatedExtracted = { ...currentExtracted, ...(extracted_data || {}) };

        await dbClient.execute(`
            UPDATE import_items 
            SET extracted_data = ?,
                suggested_category_id = ?,
                suggested_manufacturer_id = ?,
                status = ?
            WHERE id = ? AND import_id = ?
        `, [
            JSON.stringify(updatedExtracted),
            suggested_category_id ?? item.suggested_category_id,
            finalMfgId,
            status ?? item.status,
            itemId,
            id
        ], dbOpts);

        return res.json({
            success: true,
            message: 'تم تحديث بيانات المنتج بنجاح'
        });
    } catch (err) {
        console.error('[importRoutes] PUT /:id/items/:itemId error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في تحديث بيانات البند' });
    }
});

// 4.1 Create manual item during review
router.post('/:id/items', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const { name_ar, sku, price, currency, moq, category_id, packaging_info, description_ar } = req.body || {};
        if (!name_ar || !name_ar.trim()) {
            return res.status(400).json({ success: false, error: 'اسم المنتج مطلوب' });
        }

        let targetMfgId = access.importRecord.manufacturer_id;
        if (req.user.role === 'MANUFACTURER') {
            targetMfgId = req.user.manufacturer_id;
        }

        const itemId = 'item_' + crypto.randomBytes(6).toString('hex');
        const extracted = {
            name_ar: name_ar.trim(),
            sku: sku ? sku.trim() : null,
            price: price ? parseFloat(price) : null,
            currency: currency || 'USD',
            price_unit: 'MT',
            moq: moq ? moq.trim() : '1 Container',
            packaging_info: packaging_info ? packaging_info.trim() : null,
            description_ar: description_ar ? description_ar.trim() : null,
            country_of_origin: 'مصر'
        };

        const isPg = (dbOpts.engine || process.env.DB_ENGINE) === 'postgres';
        const isDuplicateVal = isPg ? false : 0;

        await dbClient.execute(`
            INSERT INTO import_items (
                id, import_id, suggested_manufacturer_id, suggested_category_id,
                raw_data, extracted_data, confidence_score, validation_warnings,
                is_duplicate, duplicate_matched_id, duplicate_reason, assigned_images, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            itemId,
            id,
            targetMfgId,
            category_id || null,
            JSON.stringify(extracted),
            JSON.stringify(extracted),
            1.0,
            JSON.stringify([]),
            isDuplicateVal,
            null,
            null,
            JSON.stringify([]),
            'AWAITING_REVIEW'
        ], dbOpts);

        // Update counts on parent import
        await dbClient.execute(`
            UPDATE imports 
            SET total_detected = total_detected + 1,
                total_valid = total_valid + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [id], dbOpts);

        return res.json({
            success: true,
            message: `تمت إضافة الصنف "${name_ar.trim()}" إلى قائمة المراجعة بنجاح`,
            item_id: itemId
        });
    } catch (err) {
        console.error('[importRoutes] POST /:id/items error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في إضافة الصنف يدوياً' });
    }
});

// 5. Bulk edit items (category, manufacturer, status, price adjustments)
router.post('/:id/bulk-update', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const { item_ids, category_id, manufacturer_id, status, price_multiplier, currency } = req.body || {};

        if (!Array.isArray(item_ids) || item_ids.length === 0) {
            return res.status(400).json({ success: false, error: 'لم يتم تحديد أي أصناف للتعديل الجماعي' });
        }

        let finalMfgId = manufacturer_id;
        if (req.user.role === 'MANUFACTURER') {
            finalMfgId = req.user.manufacturer_id;
        }

        let updatedCount = 0;
        for (const itemId of item_ids) {
            // Enforce that item strictly belongs to the requested import session
            const item = await dbClient.queryOne('SELECT * FROM import_items WHERE id = ? AND import_id = ?', [itemId, id], dbOpts);
            if (!item) continue;

            const ext = parseJsonField(item.extracted_data, {});
            if (currency) ext.currency = currency;
            if (price_multiplier && ext.price) {
                ext.price = parseFloat((ext.price * price_multiplier).toFixed(2));
            }

            const cat = category_id !== undefined ? category_id : item.suggested_category_id;
            const mfg = finalMfgId !== undefined ? finalMfgId : item.suggested_manufacturer_id;
            const stat = status !== undefined ? status : item.status;

            await dbClient.execute(`
                UPDATE import_items 
                SET extracted_data = ?,
                    suggested_category_id = ?,
                    suggested_manufacturer_id = ?,
                    status = ?
                WHERE id = ? AND import_id = ?
            `, [JSON.stringify(ext), cat, mfg, stat, itemId, id], dbOpts);

            updatedCount++;
        }

        return res.json({
            success: true,
            message: `تم تطبيق التعديلات الجماعية على (${updatedCount}) منتجات بنجاح`,
            updated_count: updatedCount
        });
    } catch (err) {
        console.error('[importRoutes] POST /:id/bulk-update error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في معالجة التعديل الجماعي' });
    }
});

// 6. Reassign images or change primary image
router.post('/:id/reassign-image', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const { from_item_id, to_item_id, image_url, make_primary, remove_image } = req.body || {};

        // Verify source item belongs to this import
        const sourceItem = await dbClient.queryOne('SELECT * FROM import_items WHERE id = ? AND import_id = ?', [from_item_id, id], dbOpts);
        if (!sourceItem) return res.status(404).json({ success: false, error: 'الصنف المصدر غير موجود في هذه العملية' });

        let sourceImages = parseJsonField(sourceItem.assigned_images, []);
        const targetImg = sourceImages.find(img => img.url === image_url);
        if (!targetImg) return res.status(404).json({ success: false, error: 'الصورة غير موجودة في الصنف' });

        if (remove_image) {
            sourceImages = sourceImages.filter(img => img.url !== image_url);
            if (sourceImages.length > 0 && !sourceImages.some(i => i.is_primary)) {
                sourceImages[0].is_primary = true;
            }
            await dbClient.execute('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?', [
                JSON.stringify(sourceImages), from_item_id, id
            ], dbOpts);

            return res.json({ success: true, message: 'تم إزالة الصورة بنجاح' });
        }

        if (from_item_id === to_item_id && make_primary) {
            sourceImages.forEach(img => { img.is_primary = (img.url === image_url); });
            await dbClient.execute('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?', [
                JSON.stringify(sourceImages), from_item_id, id
            ], dbOpts);

            return res.json({ success: true, message: 'تم تعيين الصورة كصورة رئيسية' });
        }

        if (from_item_id !== to_item_id) {
            // Verify destination item also belongs to this exact import
            const destItem = await dbClient.queryOne('SELECT * FROM import_items WHERE id = ? AND import_id = ?', [to_item_id, id], dbOpts);
            if (!destItem) return res.status(404).json({ success: false, error: 'الصنف المستهدف غير موجود في هذه العملية' });

            // Remove from source
            sourceImages = sourceImages.filter(img => img.url !== image_url);
            await dbClient.execute('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?', [
                JSON.stringify(sourceImages), from_item_id, id
            ], dbOpts);

            // Add to dest
            const destImages = parseJsonField(destItem.assigned_images, []);
            targetImg.is_primary = destImages.length === 0;
            destImages.push(targetImg);
            await dbClient.execute('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?', [
                JSON.stringify(destImages), to_item_id, id
            ], dbOpts);

            return res.json({ success: true, message: 'تم نقل الصورة إلى الصنف المحدد' });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[importRoutes] POST /:id/reassign-image error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في إعادة تعيين الصورة' });
    }
});

// 7. Save items as DRAFT into products catalog (ATOMIC TRANSACTION BOUNDARY)
router.post('/:id/save-draft', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const imp = access.importRecord;
        const { selected_item_ids } = req.body || {};

        let query = "SELECT * FROM import_items WHERE import_id = ? AND status != 'SKIPPED'";
        const params = [id];
        if (Array.isArray(selected_item_ids) && selected_item_ids.length > 0) {
            query += ` AND id IN (${selected_item_ids.map(() => '?').join(',')})`;
            params.push(...selected_item_ids);
        }

        const items = await dbClient.queryAll(query, params, dbOpts);
        if (items.length === 0) {
            return res.status(400).json({ success: false, error: 'لا توجد أصناف صالحة للحفظ كمسودة' });
        }

        let savedCount = 0;

        await dbClient.transaction(async (tx) => {
            const isPg = tx.engine === 'postgres';
            const isDemoVal = isPg ? Boolean(req.user.is_demo) : (req.user.is_demo ? 1 : 0);

            for (const item of items) {
                const ext = parseJsonField(item.extracted_data, {});
                let mfgId = item.suggested_manufacturer_id || imp.manufacturer_id;

                // Strict manufacturer enforcement
                if (req.user.role === 'MANUFACTURER') {
                    mfgId = req.user.manufacturer_id;
                }

                if (!mfgId) continue;

                const prodId = 'prod_' + crypto.randomBytes(6).toString('hex');
                const specsVal = JSON.stringify(ext.specifications || {});

                await tx.execute(`
                    INSERT INTO products (
                        id, manufacturer_id, category_id, sku, name_ar, name_en,
                        description_ar, specifications, packaging_info, country_of_origin,
                        price, currency, price_unit, moq, available_quantity, status, source_import_id, is_demo
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
                `, [
                    prodId,
                    mfgId,
                    item.suggested_category_id || null,
                    ext.sku || null,
                    ext.name_ar || 'صنف جديد بدون اسم',
                    ext.name_en || null,
                    ext.description_ar || null,
                    specsVal,
                    ext.packaging_info || null,
                    ext.country_of_origin || 'مصر',
                    ext.price ?? null,
                    ext.currency || 'USD',
                    ext.price_unit || 'MT',
                    ext.moq || null,
                    ext.available_quantity || null,
                    id,
                    isDemoVal
                ]);

                // Product images
                const images = parseJsonField(item.assigned_images, []);
                for (let idx = 0; idx < images.length; idx++) {
                    const img = images[idx];
                    const imgId = 'pimg_' + crypto.randomBytes(6).toString('hex');
                    const isPrimaryVal = isPg ? Boolean(img.is_primary) : (img.is_primary ? 1 : 0);

                    await tx.execute(`
                        INSERT INTO product_images (id, product_id, url, thumbnail_url, is_primary, display_order, dhash)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `, [imgId, prodId, img.url, img.thumbnail_url || null, isPrimaryVal, idx + 1, img.dhash || null]);
                }

                await tx.execute("UPDATE import_items SET status = 'SAVED' WHERE id = ?", [item.id]);
                savedCount++;
            }

            await tx.execute("UPDATE imports SET status = 'SAVED_DRAFT', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
        }, dbOpts);

        return res.json({
            success: true,
            message: `تم حفظ (${savedCount}) منتجات كمسودات (Draft) في كتالوج المنصة بنجاح`,
            saved_count: savedCount
        });
    } catch (err) {
        console.error('[importRoutes] POST /:id/save-draft error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في حفظ البنود كمسودات' });
    }
});

// 8. Submit items for Approval Workflow (ATOMIC TRANSACTION BOUNDARY)
router.post('/:id/submit-approval', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const imp = access.importRecord;
        const { selected_item_ids, direct_publish } = req.body || {};

        let query = "SELECT * FROM import_items WHERE import_id = ? AND status != 'SKIPPED'";
        const params = [id];
        if (Array.isArray(selected_item_ids) && selected_item_ids.length > 0) {
            query += ` AND id IN (${selected_item_ids.map(() => '?').join(',')})`;
            params.push(...selected_item_ids);
        }

        const items = await dbClient.queryAll(query, params, dbOpts);
        if (items.length === 0) {
            return res.status(400).json({ success: false, error: 'لا توجد منتجات معتمدة لتقديمها للاعتماد' });
        }

        // Security rule: Only SUPER_ADMIN with explicit direct_publish flag can publish directly.
        // For MANUFACTURER and all other roles, status is strictly forced to PENDING_APPROVAL.
        let targetStatus = 'PENDING_APPROVAL';
        if (req.user.role === 'SUPER_ADMIN' && direct_publish) {
            targetStatus = 'PUBLISHED';
        }

        let submittedCount = 0;

        await dbClient.transaction(async (tx) => {
            const isPg = tx.engine === 'postgres';
            const isDemoVal = isPg ? Boolean(req.user.is_demo) : (req.user.is_demo ? 1 : 0);

            for (const item of items) {
                const ext = parseJsonField(item.extracted_data, {});
                let mfgId = item.suggested_manufacturer_id || imp.manufacturer_id;

                if (req.user.role === 'MANUFACTURER') {
                    mfgId = req.user.manufacturer_id;
                }

                if (!mfgId) continue;

                const prodId = 'prod_' + crypto.randomBytes(6).toString('hex');
                const specsVal = JSON.stringify(ext.specifications || {});

                await tx.execute(`
                    INSERT INTO products (
                        id, manufacturer_id, category_id, sku, name_ar, name_en,
                        description_ar, specifications, packaging_info, country_of_origin,
                        price, currency, price_unit, moq, available_quantity, status, source_import_id, is_demo
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    prodId,
                    mfgId,
                    item.suggested_category_id || null,
                    ext.sku || null,
                    ext.name_ar || 'صنف جديد بدون اسم',
                    ext.name_en || null,
                    ext.description_ar || null,
                    specsVal,
                    ext.packaging_info || null,
                    ext.country_of_origin || 'مصر',
                    ext.price ?? null,
                    ext.currency || 'USD',
                    ext.price_unit || 'MT',
                    ext.moq || null,
                    ext.available_quantity || null,
                    targetStatus,
                    id,
                    isDemoVal
                ]);

                // Images
                const images = parseJsonField(item.assigned_images, []);
                for (let idx = 0; idx < images.length; idx++) {
                    const img = images[idx];
                    const imgId = 'pimg_' + crypto.randomBytes(6).toString('hex');
                    const isPrimaryVal = isPg ? Boolean(img.is_primary) : (img.is_primary ? 1 : 0);

                    await tx.execute(`
                        INSERT INTO product_images (id, product_id, url, thumbnail_url, is_primary, display_order, dhash)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `, [imgId, prodId, img.url, img.thumbnail_url || null, isPrimaryVal, idx + 1, img.dhash || null]);
                }

                await tx.execute("UPDATE import_items SET status = 'SAVED' WHERE id = ?", [item.id]);
                submittedCount++;
            }

            await tx.execute("UPDATE imports SET status = 'SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
        }, dbOpts);

        const message = targetStatus === 'PUBLISHED'
            ? `تم نشر (${submittedCount}) منتجات في الكتالوج العام مباشرة بنجاح`
            : `تم رفع (${submittedCount}) منتجات إلى قائمة الاعتماد (Pending Approval) للمراجعة من قبل إدارة زارسيف`;

        return res.json({
            success: true,
            message,
            submitted_count: submittedCount,
            status: targetStatus
        });
    } catch (err) {
        console.error('[importRoutes] POST /:id/submit-approval error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في تقديم البنود للاعتماد' });
    }
});

// 9. Import History (Tenant Isolated)
router.get('/history', authMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    try {
        let query = `
            SELECT i.*, u.name as user_name, u.email as user_email, m.name_ar as manufacturer_name, m.code as manufacturer_code,
                   (SELECT COUNT(*) FROM import_items ii WHERE ii.import_id = i.id AND ii.status = 'AWAITING_REVIEW') as awaiting_count
            FROM imports i
            LEFT JOIN users u ON i.user_id = u.id
            LEFT JOIN manufacturers m ON i.manufacturer_id = m.id
        `;
        const params = [];

        // Role filtering:
        // Marketing manufacturers see ONLY their own imports
        if (req.user.role === 'MANUFACTURER') {
            query += ' WHERE i.manufacturer_id = ?';
            params.push(req.user.manufacturer_id);
        } else if (req.user.role === 'LOGISTICS_OFFICER') {
            // Logistics Officers only see Direct Contract imports or imports they created
            query += " WHERE m.business_model = 'DIRECT_CONTRACT' OR i.user_id = ?";
            params.push(req.user.id);
        }

        query += ' ORDER BY i.created_at DESC';
        const imports = await dbClient.queryAll(query, params, dbOpts);

        const formatted = imports.map(imp => ({
            ...imp,
            source_files: parseJsonField(imp.source_files, [])
        }));

        return res.json({
            success: true,
            history: formatted
        });
    } catch (err) {
        console.error('[importRoutes] GET /history error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في استرجاع سجل عمليات الاستيراد' });
    }
});

// 10. Downloadable Error Report (CSV)
router.get('/:id/error-report', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        const errorQuery = {
            sqlite: `
                SELECT * FROM import_items 
                WHERE import_id = ? AND (status = 'FAILED' OR validation_warnings != '[]')
            `,
            postgres: `
                SELECT * FROM import_items 
                WHERE import_id = $1 AND (status = 'FAILED' OR (validation_warnings IS NOT NULL AND validation_warnings::text != '[]'))
            `
        };

        const failedItems = await dbClient.queryAll(errorQuery, [id], dbOpts);

        let csvContent = '\uFEFF'; // BOM for Excel Arabic UTF-8
        csvContent += 'رقم_السجل,اسم_المنتج,الخطأ_أو_التحذير,حالة_السجل,المرجع_الأصلي\n';

        failedItems.forEach((item, idx) => {
            const ext = parseJsonField(item.extracted_data, {});
            const warnings = parseJsonField(item.validation_warnings, []);
            const errorMsg = item.error_message || warnings.join(' | ') || 'بيانات ناقصة';
            const raw = parseJsonField(item.raw_data, {});
            const ref = raw.paragraph || 'غير محدد';

            const row = [
                idx + 1,
                `"${(ext.name_ar || '').replace(/"/g, '""')}"`,
                `"${errorMsg.replace(/"/g, '""')}"`,
                item.status,
                `"${ref.replace(/"/g, '""')}"`
            ];
            csvContent += row.join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="zarsev_import_errors_${id}.csv"`);
        return res.send(csvContent);
    } catch (err) {
        console.error('[importRoutes] GET /:id/error-report error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في إنشاء تقرير الأخطاء' });
    }
});

// 11. Retry failed items without duplicating valid items
router.post('/:id/retry-failed', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const access = await checkImportAccess(id, req.user, dbOpts);
        if (!access.allowed) {
            return res.status(access.statusCode).json({ success: false, error: access.error });
        }

        let recoveredCount = 0;

        await dbClient.transaction(async (tx) => {
            const failedItems = await tx.queryAll('SELECT * FROM import_items WHERE import_id = ? AND status = ?', [id, 'FAILED']);
            if (failedItems.length === 0) {
                return;
            }

            for (const item of failedItems) {
                const raw = parseJsonField(item.raw_data, {});
                const recoveredName = raw.cluster_name || Object.values(raw).find(v => typeof v === 'string' && v.trim().length > 3) || 'صنف مسترجع';

                const ext = {
                    name_ar: recoveredName,
                    price: null,
                    currency: 'USD',
                    price_unit: 'MT',
                    moq: 'حاوية واحدة',
                    country_of_origin: 'مصر'
                };

                await tx.execute(`
                    UPDATE import_items 
                    SET extracted_data = ?,
                        status = 'AWAITING_REVIEW',
                        validation_warnings = '["تم استرجاع السجل في وضع المراجعة اليدوية"]'
                    WHERE id = ? AND import_id = ?
                `, [JSON.stringify(ext), item.id, id]);

                recoveredCount++;
            }

            // Update counts on parent import atomically
            const validRes = await tx.queryOne("SELECT COUNT(*) as c FROM import_items WHERE import_id = ? AND status = 'AWAITING_REVIEW'", [id]);
            const failedRes = await tx.queryOne("SELECT COUNT(*) as c FROM import_items WHERE import_id = ? AND status = 'FAILED'", [id]);

            const validCount = Number(validRes?.c || 0);
            const remainingFailed = Number(failedRes?.c || 0);

            await tx.execute('UPDATE imports SET total_valid = ?, total_failed = ? WHERE id = ?', [validCount, remainingFailed, id]);
        }, dbOpts);

        if (recoveredCount === 0) {
            return res.json({ success: true, message: 'لا توجد سجلات فاشلة لإعادة محاولتها' });
        }

        return res.json({
            success: true,
            message: `تمت إعادة محاولة معالجة (${recoveredCount}) سجلات فاشلة بنجاح وإتاحتها للمراجعة`,
            recovered_count: recoveredCount
        });
    } catch (err) {
        console.error('[importRoutes] POST /:id/retry-failed error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في إعادة محاولة معالجة البنود الفاشلة' });
    }
});

module.exports = router;
