const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middlewares/auth');
const { checkSubscriptionLimits } = require('../middlewares/subscriptionGuard');
const { upload } = require('../middlewares/uploadValidator');
const { processImportJob } = require('../services/importJobQueue');

/**
 * Access Control Helper: Verifies user permission for a specific import session.
 * Prevents tenant crossover and unauthorized cross-manufacturer operations.
 */
function checkImportAccess(importId, user) {
    const db = getDb();
    const imp = db.prepare(`
        SELECT i.*, m.business_model, m.name_ar as mfg_name
        FROM imports i
        LEFT JOIN manufacturers m ON i.manufacturer_id = m.id
        WHERE i.id = ?
    `).get(importId);

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
router.post('/upload', authMiddleware, checkSubscriptionLimits(), (req, res) => {
    const importId = 'imp_' + crypto.randomBytes(6).toString('hex');
    req.importSessionId = importId;

    upload.array('files', 50)(req, res, (err) => {
        if (err) {
            return res.status(400).json({ success: false, error: err.message });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: 'لم يتم اختيار أي ملفات للرفع' });
        }

        const db = getDb();
        let targetManufacturerId = req.body.manufacturer_id || null;

        // Security check for Marketing Subscription Manufacturers:
        // Client-supplied manufacturer_id is STRICTLY ignored! Always bind to own manufacturer account.
        if (req.user.role === 'MANUFACTURER') {
            targetManufacturerId = req.user.manufacturer_id;
        } else if (req.user.role === 'LOGISTICS_OFFICER' && targetManufacturerId) {
            // Logistics officer can only assign to DIRECT_CONTRACT manufacturers
            const targetMfg = db.prepare('SELECT business_model FROM manufacturers WHERE id = ?').get(targetManufacturerId);
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

        db.prepare(`
            INSERT INTO imports (id, user_id, manufacturer_id, source_files, status, progress_percent, is_demo)
            VALUES (?, ?, ?, ?, 'PENDING', 5, ?)
        `).run(
            importId,
            req.user.id,
            targetManufacturerId,
            JSON.stringify(sourceFiles),
            req.user.is_demo || 0
        );

        // Fire background worker asynchronously
        setImmediate(() => {
            processImportJob(importId).catch(jobErr => {
                console.error(`Background job failure for import ${importId}:`, jobErr);
            });
        });

        res.status(202).json({
            success: true,
            message: 'تم استلام الملفات وبدأت عملية الفحص والاستخراج في الخلفية',
            import_id: importId,
            status_url: `/api/imports/status/${importId}`
        });
    });
});

// 2. Poll import progress and background status
router.get('/status/:id', authMiddleware, (req, res) => {
    const access = checkImportAccess(req.params.id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const imp = access.importRecord;
    const db = getDb();
    const logs = db.prepare('SELECT * FROM import_logs WHERE import_id = ? ORDER BY timestamp ASC').all(req.params.id);

    res.json({
        success: true,
        import: {
            ...imp,
            source_files: JSON.parse(imp.source_files || '[]')
        },
        logs
    });
});

// 3. Get extracted draft items for review
router.get('/:id/items', authMiddleware, (req, res) => {
    const access = checkImportAccess(req.params.id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const db = getDb();
    const items = db.prepare(`
        SELECT ii.*, m.name_ar as suggested_manufacturer_name, c.name_ar as suggested_category_name
        FROM import_items ii
        LEFT JOIN manufacturers m ON ii.suggested_manufacturer_id = m.id
        LEFT JOIN categories c ON ii.suggested_category_id = c.id
        WHERE ii.import_id = ?
        ORDER BY ii.created_at ASC
    `).all(req.params.id);

    const formatted = items.map(item => ({
        ...item,
        extracted_data: JSON.parse(item.extracted_data || '{}'),
        validation_warnings: JSON.parse(item.validation_warnings || '[]'),
        assigned_images: JSON.parse(item.assigned_images || '[]')
    }));

    res.json({
        success: true,
        items: formatted,
        import_id: req.params.id
    });
});

// 4. Update single item during review (Enforces Import Ownership & IDOR Protection)
router.put('/:id/items/:itemId', authMiddleware, (req, res) => {
    const { id, itemId } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const db = getDb();
    const { extracted_data, suggested_category_id, suggested_manufacturer_id, status } = req.body;

    // Strict IDOR Check: Ensure item strictly belongs to this exact import session
    const item = db.prepare('SELECT * FROM import_items WHERE id = ? AND import_id = ?').get(itemId, id);
    if (!item) {
        return res.status(404).json({ success: false, error: 'المنتج غير موجود في عملية الاستيراد المحددة' });
    }

    // Manufacturer security: Marketing manufacturer cannot reassign to another manufacturer profile
    let finalMfgId = suggested_manufacturer_id ?? item.suggested_manufacturer_id;
    if (req.user.role === 'MANUFACTURER') {
        finalMfgId = req.user.manufacturer_id;
    }

    const currentExtracted = JSON.parse(item.extracted_data || '{}');
    const updatedExtracted = { ...currentExtracted, ...(extracted_data || {}) };

    db.prepare(`
        UPDATE import_items 
        SET extracted_data = ?,
            suggested_category_id = ?,
            suggested_manufacturer_id = ?,
            status = ?
        WHERE id = ? AND import_id = ?
    `).run(
        JSON.stringify(updatedExtracted),
        suggested_category_id ?? item.suggested_category_id,
        finalMfgId,
        status ?? item.status,
        itemId,
        id
    );

    res.json({
        success: true,
        message: 'تم تحديث بيانات المنتج بنجاح'
    });
});

// 5. Bulk edit items (category, manufacturer, status, price adjustments)
router.post('/:id/bulk-update', authMiddleware, (req, res) => {
    const { id } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const { item_ids, category_id, manufacturer_id, status, price_multiplier, currency } = req.body;

    if (!Array.isArray(item_ids) || item_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'لم يتم تحديد أي أصناف للتعديل الجماعي' });
    }

    const db = getDb();
    let finalMfgId = manufacturer_id;
    if (req.user.role === 'MANUFACTURER') {
        finalMfgId = req.user.manufacturer_id;
    }

    let updatedCount = 0;
    item_ids.forEach(itemId => {
        // Enforce that item strictly belongs to the requested import session
        const item = db.prepare('SELECT * FROM import_items WHERE id = ? AND import_id = ?').get(itemId, id);
        if (!item) return;

        const ext = JSON.parse(item.extracted_data || '{}');
        if (currency) ext.currency = currency;
        if (price_multiplier && ext.price) {
            ext.price = parseFloat((ext.price * price_multiplier).toFixed(2));
        }

        const cat = category_id !== undefined ? category_id : item.suggested_category_id;
        const mfg = finalMfgId !== undefined ? finalMfgId : item.suggested_manufacturer_id;
        const stat = status !== undefined ? status : item.status;

        db.prepare(`
            UPDATE import_items 
            SET extracted_data = ?,
                suggested_category_id = ?,
                suggested_manufacturer_id = ?,
                status = ?
            WHERE id = ? AND import_id = ?
        `).run(JSON.stringify(ext), cat, mfg, stat, itemId, id);

        updatedCount++;
    });

    res.json({
        success: true,
        message: `تم تطبيق التعديلات الجماعية على (${updatedCount}) منتجات بنجاح`,
        updated_count: updatedCount
    });
});

// 6. Reassign images or change primary image
router.post('/:id/reassign-image', authMiddleware, (req, res) => {
    const { id } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const { from_item_id, to_item_id, image_url, make_primary, remove_image } = req.body;
    const db = getDb();

    // Verify source item belongs to this import
    const sourceItem = db.prepare('SELECT * FROM import_items WHERE id = ? AND import_id = ?').get(from_item_id, id);
    if (!sourceItem) return res.status(404).json({ success: false, error: 'الصنف المصدر غير موجود في هذه العملية' });

    let sourceImages = JSON.parse(sourceItem.assigned_images || '[]');
    const targetImg = sourceImages.find(img => img.url === image_url);
    if (!targetImg) return res.status(404).json({ success: false, error: 'الصورة غير موجودة في الصنف' });

    if (remove_image) {
        sourceImages = sourceImages.filter(img => img.url !== image_url);
        if (sourceImages.length > 0 && !sourceImages.some(i => i.is_primary)) {
            sourceImages[0].is_primary = true;
        }
        db.prepare('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?')
            .run(JSON.stringify(sourceImages), from_item_id, id);

        return res.json({ success: true, message: 'تم إزالة الصورة بنجاح' });
    }

    if (from_item_id === to_item_id && make_primary) {
        sourceImages.forEach(img => { img.is_primary = (img.url === image_url); });
        db.prepare('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?')
            .run(JSON.stringify(sourceImages), from_item_id, id);

        return res.json({ success: true, message: 'تم تعيين الصورة كصورة رئيسية' });
    }

    if (from_item_id !== to_item_id) {
        // Verify destination item also belongs to this exact import
        const destItem = db.prepare('SELECT * FROM import_items WHERE id = ? AND import_id = ?').get(to_item_id, id);
        if (!destItem) return res.status(404).json({ success: false, error: 'الصنف المستهدف غير موجود في هذه العملية' });

        // Remove from source
        sourceImages = sourceImages.filter(img => img.url !== image_url);
        db.prepare('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?')
            .run(JSON.stringify(sourceImages), from_item_id, id);

        // Add to dest
        const destImages = JSON.parse(destItem.assigned_images || '[]');
        targetImg.is_primary = destImages.length === 0;
        destImages.push(targetImg);
        db.prepare('UPDATE import_items SET assigned_images = ? WHERE id = ? AND import_id = ?')
            .run(JSON.stringify(destImages), to_item_id, id);

        return res.json({ success: true, message: 'تم نقل الصورة إلى الصنف المحدد' });
    }

    res.json({ success: true });
});

// 7. Save items as DRAFT into products catalog
router.post('/:id/save-draft', authMiddleware, (req, res) => {
    const { id } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const imp = access.importRecord;
    const { selected_item_ids } = req.body;
    const db = getDb();

    let query = "SELECT * FROM import_items WHERE import_id = ? AND status != 'SKIPPED'";
    const params = [id];
    if (Array.isArray(selected_item_ids) && selected_item_ids.length > 0) {
        query += ` AND id IN (${selected_item_ids.map(() => '?').join(',')})`;
        params.push(...selected_item_ids);
    }

    const items = db.prepare(query).all(...params);
    if (items.length === 0) {
        return res.status(400).json({ success: false, error: 'لا توجد أصناف صالحة للحفظ كمسودة' });
    }

    let savedCount = 0;
    for (const item of items) {
        const ext = JSON.parse(item.extracted_data || '{}');
        let mfgId = item.suggested_manufacturer_id || imp.manufacturer_id;

        // Strict manufacturer enforcement
        if (req.user.role === 'MANUFACTURER') {
            mfgId = req.user.manufacturer_id;
        }

        if (!mfgId) continue;

        const prodId = 'prod_' + crypto.randomBytes(6).toString('hex');
        db.prepare(`
            INSERT INTO products (
                id, manufacturer_id, category_id, sku, name_ar, name_en,
                description_ar, specifications, packaging_info, country_of_origin,
                price, currency, price_unit, moq, available_quantity, status, source_import_id, is_demo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
        `).run(
            prodId,
            mfgId,
            item.suggested_category_id || null,
            ext.sku || null,
            ext.name_ar || 'صنف جديد بدون اسم',
            ext.name_en || null,
            ext.description_ar || null,
            JSON.stringify(ext.specifications || {}),
            ext.packaging_info || null,
            ext.country_of_origin || 'مصر',
            ext.price ?? null,
            ext.currency || 'USD',
            ext.price_unit || 'MT',
            ext.moq || null,
            ext.available_quantity || null,
            id,
            req.user.is_demo || 0
        );

        // Product images
        const images = JSON.parse(item.assigned_images || '[]');
        images.forEach((img, idx) => {
            const imgId = 'pimg_' + crypto.randomBytes(6).toString('hex');
            db.prepare(`
                INSERT INTO product_images (id, product_id, url, thumbnail_url, is_primary, display_order, dhash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(imgId, prodId, img.url, img.thumbnail_url || null, img.is_primary ? 1 : 0, idx + 1, img.dhash || null);
        });

        db.prepare("UPDATE import_items SET status = 'SAVED' WHERE id = ?").run(item.id);
        savedCount++;
    }

    db.prepare("UPDATE imports SET status = 'SAVED_DRAFT', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

    res.json({
        success: true,
        message: `تم حفظ (${savedCount}) منتجات كمسودات (Draft) في كتالوج المنصة بنجاح`,
        saved_count: savedCount
    });
});

// 8. Submit items for Approval Workflow
router.post('/:id/submit-approval', authMiddleware, (req, res) => {
    const { id } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const imp = access.importRecord;
    const { selected_item_ids, direct_publish } = req.body;
    const db = getDb();

    let query = "SELECT * FROM import_items WHERE import_id = ? AND status != 'SKIPPED'";
    const params = [id];
    if (Array.isArray(selected_item_ids) && selected_item_ids.length > 0) {
        query += ` AND id IN (${selected_item_ids.map(() => '?').join(',')})`;
        params.push(...selected_item_ids);
    }

    const items = db.prepare(query).all(...params);
    if (items.length === 0) {
        return res.status(400).json({ success: false, error: 'لا توجد منتجات معتمدة لتقديمها للاعتماد' });
    }

    let targetStatus = 'PENDING_APPROVAL';
    if (req.user.role === 'SUPER_ADMIN' && direct_publish) {
        targetStatus = 'PUBLISHED';
    }

    let submittedCount = 0;
    for (const item of items) {
        const ext = JSON.parse(item.extracted_data || '{}');
        let mfgId = item.suggested_manufacturer_id || imp.manufacturer_id;

        if (req.user.role === 'MANUFACTURER') {
            mfgId = req.user.manufacturer_id;
        }

        if (!mfgId) continue;

        const prodId = 'prod_' + crypto.randomBytes(6).toString('hex');
        db.prepare(`
            INSERT INTO products (
                id, manufacturer_id, category_id, sku, name_ar, name_en,
                description_ar, specifications, packaging_info, country_of_origin,
                price, currency, price_unit, moq, available_quantity, status, source_import_id, is_demo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            prodId,
            mfgId,
            item.suggested_category_id || null,
            ext.sku || null,
            ext.name_ar || 'صنف جديد بدون اسم',
            ext.name_en || null,
            ext.description_ar || null,
            JSON.stringify(ext.specifications || {}),
            ext.packaging_info || null,
            ext.country_of_origin || 'مصر',
            ext.price ?? null,
            ext.currency || 'USD',
            ext.price_unit || 'MT',
            ext.moq || null,
            ext.available_quantity || null,
            targetStatus,
            id,
            req.user.is_demo || 0
        );

        // Images
        const images = JSON.parse(item.assigned_images || '[]');
        images.forEach((img, idx) => {
            const imgId = 'pimg_' + crypto.randomBytes(6).toString('hex');
            db.prepare(`
                INSERT INTO product_images (id, product_id, url, thumbnail_url, is_primary, display_order, dhash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(imgId, prodId, img.url, img.thumbnail_url || null, img.is_primary ? 1 : 0, idx + 1, img.dhash || null);
        });

        db.prepare("UPDATE import_items SET status = 'SAVED' WHERE id = ?").run(item.id);
        submittedCount++;
    }

    db.prepare("UPDATE imports SET status = 'SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

    const message = targetStatus === 'PUBLISHED'
        ? `تم نشر (${submittedCount}) منتجات في الكتالوج العام مباشرة بنجاح`
        : `تم رفع (${submittedCount}) منتجات إلى قائمة الاعتماد (Pending Approval) للمراجعة من قبل إدارة زارسيف`;

    res.json({
        success: true,
        message,
        submitted_count: submittedCount,
        status: targetStatus
    });
});

// 9. Import History (Tenant Isolated)
router.get('/history', authMiddleware, (req, res) => {
    const db = getDb();
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
    const imports = db.prepare(query).all(...params);

    const formatted = imports.map(imp => ({
        ...imp,
        source_files: JSON.parse(imp.source_files || '[]')
    }));

    res.json({
        success: true,
        history: formatted
    });
});

// 10. Downloadable Error Report (CSV)
router.get('/:id/error-report', authMiddleware, (req, res) => {
    const { id } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const db = getDb();
    const failedItems = db.prepare(`
        SELECT * FROM import_items 
        WHERE import_id = ? AND (status = 'FAILED' OR validation_warnings != '[]')
    `).all(id);

    let csvContent = '\uFEFF'; // BOM for Excel Arabic UTF-8
    csvContent += 'رقم_السجل,اسم_المنتج,الخطأ_أو_التحذير,حالة_السجل,المرجع_الأصلي\n';

    failedItems.forEach((item, idx) => {
        const ext = JSON.parse(item.extracted_data || '{}');
        const warnings = JSON.parse(item.validation_warnings || '[]');
        const errorMsg = item.error_message || warnings.join(' | ') || 'بيانات ناقصة';
        const raw = JSON.parse(item.raw_data || '{}');
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
    res.send(csvContent);
});

// 11. Retry failed items without duplicating valid items
router.post('/:id/retry-failed', authMiddleware, (req, res) => {
    const { id } = req.params;
    const access = checkImportAccess(id, req.user);
    if (!access.allowed) {
        return res.status(access.statusCode).json({ success: false, error: access.error });
    }

    const db = getDb();
    const failedItems = db.prepare('SELECT * FROM import_items WHERE import_id = ? AND status = "FAILED"').all(id);
    if (failedItems.length === 0) {
        return res.json({ success: true, message: 'لا توجد سجلات فاشلة لإعادة محاولتها' });
    }

    let recoveredCount = 0;
    for (const item of failedItems) {
        const raw = JSON.parse(item.raw_data || '{}');
        const recoveredName = raw.cluster_name || Object.values(raw).find(v => typeof v === 'string' && v.trim().length > 3) || 'صنف مسترجع';

        const ext = {
            name_ar: recoveredName,
            price: null,
            currency: 'USD',
            price_unit: 'MT',
            moq: 'حاوية واحدة',
            country_of_origin: 'مصر'
        };

        db.prepare(`
            UPDATE import_items 
            SET extracted_data = ?,
                status = 'AWAITING_REVIEW',
                validation_warnings = '["تم استرجاع السجل في وضع المراجعة اليدوية"]'
            WHERE id = ? AND import_id = ?
        `).run(JSON.stringify(ext), item.id, id);

        recoveredCount++;
    }

    // Update counts on parent import
    const validCount = db.prepare('SELECT COUNT(*) as c FROM import_items WHERE import_id = ? AND status = "AWAITING_REVIEW"').get(id).c;
    const remainingFailed = db.prepare('SELECT COUNT(*) as c FROM import_items WHERE import_id = ? AND status = "FAILED"').get(id).c;

    db.prepare('UPDATE imports SET total_valid = ?, total_failed = ? WHERE id = ?').run(validCount, remainingFailed, id);

    res.json({
        success: true,
        message: `تمت إعادة محاولة معالجة (${recoveredCount}) سجلات فاشلة بنجاح وإتاحتها للمراجعة`,
        recovered_count: recoveredCount
    });
});

module.exports = router;
