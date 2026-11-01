const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middlewares/auth');

// Get products catalog (combines Direct Contract and Marketing Subscription products)
router.get('/', (req, res) => {
    const db = getDb();
    const { category_id, manufacturer_id, search, status } = req.query;

    let query = `
        SELECT p.*, m.name_ar as manufacturer_name, m.city as manufacturer_city,
               c.name_ar as category_name,
               (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = 1 LIMIT 1) as primary_image
        FROM products p
        JOIN manufacturers m ON p.manufacturer_id = m.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE 1=1
    `;
    const params = [];

    // Public view only shows 'PUBLISHED' products unless an admin explicitly filters by status
    if (status) {
        query += ' AND p.status = ?';
        params.push(status);
    } else {
        query += " AND p.status = 'PUBLISHED'";
    }

    if (category_id) {
        query += ' AND (p.category_id = ? OR p.subcategory_id = ?)';
        params.push(category_id, category_id);
    }

    if (manufacturer_id) {
        query += ' AND p.manufacturer_id = ?';
        params.push(manufacturer_id);
    }

    if (search) {
        query += ' AND (p.name_ar LIKE ? OR p.description_ar LIKE ? OR p.sku LIKE ?)';
        const term = `%${search}%`;
        params.push(term, term, term);
    }

    query += ' ORDER BY p.created_at DESC';

    const products = db.prepare(query).all(...params);
    const formatted = products.map(p => ({
        ...p,
        specifications: JSON.parse(p.specifications || '{}')
    }));

    res.json({
        success: true,
        count: formatted.length,
        products: formatted
    });
});

// Get single product details
router.get('/:id', (req, res) => {
    const db = getDb();
    const prod = db.prepare(`
        SELECT p.*, m.name_ar as manufacturer_name, m.city as manufacturer_city,
               c.name_ar as category_name
        FROM products p
        JOIN manufacturers m ON p.manufacturer_id = m.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.id = ?
    `).get(req.params.id);

    if (!prod) {
        return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    }

    const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order ASC').all(req.params.id);

    res.json({
        success: true,
        product: {
            ...prod,
            specifications: JSON.parse(prod.specifications || '{}'),
            images
        }
    });
});

// Update product through normal management interface
router.put('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!prod) {
        return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    }

    // Role check: Marketing manufacturer can only edit their own products
    if (req.user.role === 'MANUFACTURER' && prod.manufacturer_id !== req.user.manufacturer_id) {
        return res.status(403).json({ success: false, error: 'غير مصرح بتعديل هذا المنتج' });
    }

    const { name_ar, name_en, description_ar, price, currency, price_unit, moq, packaging_info, specifications, category_id } = req.body;

    db.prepare(`
        UPDATE products 
        SET name_ar = ?,
            name_en = ?,
            description_ar = ?,
            price = ?,
            currency = ?,
            price_unit = ?,
            moq = ?,
            packaging_info = ?,
            specifications = ?,
            category_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        name_ar ?? prod.name_ar,
        name_en ?? prod.name_en,
        description_ar ?? prod.description_ar,
        price !== undefined ? price : prod.price,
        currency ?? prod.currency,
        price_unit ?? prod.price_unit,
        moq ?? prod.moq,
        packaging_info ?? prod.packaging_info,
        specifications ? JSON.stringify(specifications) : prod.specifications,
        category_id ?? prod.category_id,
        req.params.id
    );

    res.json({
        success: true,
        message: 'تم تحديث بيانات المنتج بنجاح'
    });
});

module.exports = router;
