const express = require('express');
const router = express.Router();
const dbClient = require('../db/dbClient');
const { authMiddleware, requireRole } = require('../middlewares/auth');

/**
 * Safely parses specifications JSON column.
 * Handles both SQLite (raw JSON string) and PostgreSQL (pre-parsed JSONB object).
 */
function parseSpecifications(specs) {
    if (!specs) return {};
    if (typeof specs === 'object') return specs;
    try {
        return JSON.parse(specs);
    } catch (_) {
        return {};
    }
}

// Get approval queue (Super Admin / Logistics Officer)
router.get('/queue', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const dbOpts = req.dbClientOptions || {};

    const queueQuery = {
        sqlite: `
            SELECT p.*, m.name_ar as manufacturer_name, m.business_model, m.code as manufacturer_code,
                   c.name_ar as category_name,
                   (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = 1 LIMIT 1) as primary_image
            FROM products p
            JOIN manufacturers m ON p.manufacturer_id = m.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.status = 'PENDING_APPROVAL'
            ORDER BY p.created_at ASC
        `,
        postgres: `
            SELECT p.*, m.name_ar as manufacturer_name, m.business_model, m.code as manufacturer_code,
                   c.name_ar as category_name,
                   (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1) as primary_image
            FROM products p
            JOIN manufacturers m ON p.manufacturer_id = m.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.status = 'PENDING_APPROVAL'
            ORDER BY p.created_at ASC
        `
    };

    try {
        const queue = await dbClient.queryAll(queueQuery, [], dbOpts);
        const formatted = queue.map(p => ({
            ...p,
            specifications: parseSpecifications(p.specifications)
        }));

        return res.json({
            success: true,
            queue: formatted,
            count: formatted.length
        });
    } catch (err) {
        console.error('[approvalRoutes] GET /queue error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء استرجاع قائمة المنتجات المعلقة للاعتماد'
        });
    }
});

// Approve or Reject a product
router.post('/:productId/decide', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const { productId } = req.params;
    const { decision, rejection_reason } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    try {
        const prod = await dbClient.queryOne('SELECT * FROM products WHERE id = ?', [productId], dbOpts);
        if (!prod) {
            return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
        }

        if (decision === 'APPROVE') {
            await dbClient.execute(`
                UPDATE products 
                SET status = 'PUBLISHED', rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [productId], dbOpts);

            return res.json({
                success: true,
                message: `تم اعتماد المنتج "${prod.name_ar}" ونشره بالكتالوج العام بنجاح`,
                status: 'PUBLISHED'
            });
        } else if (decision === 'REJECT') {
            if (!rejection_reason || !rejection_reason.trim()) {
                return res.status(400).json({ success: false, error: 'يرجى تقديم سبب الرفض لتوجيه المصنع للتعديل' });
            }

            await dbClient.execute(`
                UPDATE products 
                SET status = 'REJECTED', rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [rejection_reason.trim(), productId], dbOpts);

            return res.json({
                success: true,
                message: `تم رفض المنتج وإرسال سبب الرفض: "${rejection_reason.trim()}"`,
                status: 'REJECTED'
            });
        } else {
            return res.status(400).json({ success: false, error: 'قرار غير صالح (مسموح: APPROVE أو REJECT)' });
        }
    } catch (err) {
        console.error('[approvalRoutes] POST /:productId/decide error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء معالجة قرار اعتماد المنتج'
        });
    }
});

// Resubmit rejected product (Manufacturer)
router.post('/:productId/resubmit', authMiddleware, async (req, res) => {
    const { productId } = req.params;
    const { name_ar, price, moq, specifications } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    try {
        const prod = await dbClient.queryOne('SELECT * FROM products WHERE id = ?', [productId], dbOpts);
        if (!prod) {
            return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
        }

        if (req.user.role === 'MANUFACTURER' && prod.manufacturer_id !== req.user.manufacturer_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح بتعديل هذا المنتج' });
        }

        const currentSpecs = parseSpecifications(prod.specifications);
        const updatedSpecs = { ...currentSpecs, ...(specifications || {}) };

        await dbClient.execute(`
            UPDATE products 
            SET name_ar = ?,
                price = ?,
                moq = ?,
                specifications = ?,
                status = 'PENDING_APPROVAL',
                rejection_reason = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            name_ar || prod.name_ar,
            price !== undefined ? price : prod.price,
            moq || prod.moq,
            JSON.stringify(updatedSpecs),
            productId
        ], dbOpts);

        return res.json({
            success: true,
            message: 'تمت إعادة تقديم المنتج للمراجعة والاعتماد بنجاح',
            status: 'PENDING_APPROVAL'
        });
    } catch (err) {
        console.error('[approvalRoutes] POST /:productId/resubmit error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء إعادة تقديم المنتج'
        });
    }
});

module.exports = router;
