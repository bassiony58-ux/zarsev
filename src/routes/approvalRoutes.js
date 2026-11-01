const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middlewares/auth');

// Get approval queue (Super Admin / Logistics Officer)
router.get('/queue', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), (req, res) => {
    const db = getDb();
    const queue = db.prepare(`
        SELECT p.*, m.name_ar as manufacturer_name, m.business_model, m.code as manufacturer_code,
               c.name_ar as category_name,
               (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = 1 LIMIT 1) as primary_image
        FROM products p
        JOIN manufacturers m ON p.manufacturer_id = m.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.status = 'PENDING_APPROVAL'
        ORDER BY p.created_at ASC
    `).all();

    const formatted = queue.map(p => ({
        ...p,
        specifications: JSON.parse(p.specifications || '{}')
    }));

    res.json({
        success: true,
        queue: formatted,
        count: formatted.length
    });
});

// Approve or Reject a product
router.post('/:productId/decide', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), (req, res) => {
    const db = getDb();
    const { productId } = req.params;
    const { decision, rejection_reason } = req.body; // decision: 'APPROVE' or 'REJECT'

    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!prod) {
        return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    }

    if (decision === 'APPROVE') {
        db.prepare(`
            UPDATE products 
            SET status = 'PUBLISHED', rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(productId);

        return res.json({
            success: true,
            message: `تم اعتماد المنتج "${prod.name_ar}" ونشره بالكتالوج العام بنجاح`,
            status: 'PUBLISHED'
        });
    } else if (decision === 'REJECT') {
        if (!rejection_reason) {
            return res.status(400).json({ success: false, error: 'يرجى تقديم سبب الرفض لتوجيه المصنع للتعديل' });
        }

        db.prepare(`
            UPDATE products 
            SET status = 'REJECTED', rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(rejection_reason.trim(), productId);

        return res.json({
            success: true,
            message: `تم رفض المنتج وإرسال سبب الرفض: "${rejection_reason}"`,
            status: 'REJECTED'
        });
    } else {
        return res.status(400).json({ success: false, error: 'قرار غير صالح (مسموح: APPROVE أو REJECT)' });
    }
});

// Resubmit rejected product (Manufacturer)
router.post('/:productId/resubmit', authMiddleware, (req, res) => {
    const db = getDb();
    const { productId } = req.params;
    const { name_ar, price, moq, specifications } = req.body;

    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!prod) {
        return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    }

    if (req.user.role === 'MANUFACTURER' && prod.manufacturer_id !== req.user.manufacturer_id) {
        return res.status(403).json({ success: false, error: 'غير مصرح بتعديل هذا المنتج' });
    }

    const currentSpecs = JSON.parse(prod.specifications || '{}');
    const updatedSpecs = { ...currentSpecs, ...(specifications || {}) };

    db.prepare(`
        UPDATE products 
        SET name_ar = ?,
            price = ?,
            moq = ?,
            specifications = ?,
            status = 'PENDING_APPROVAL',
            rejection_reason = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        name_ar || prod.name_ar,
        price !== undefined ? price : prod.price,
        moq || prod.moq,
        JSON.stringify(updatedSpecs),
        productId
    );

    res.json({
        success: true,
        message: 'تمت إعادة تقديم المنتج للمراجعة والاعتماد بنجاح',
        status: 'PENDING_APPROVAL'
    });
});

module.exports = router;
