const express = require('express');
const router = express.Router();
const dbClient = require('../db/dbClient');
const { authMiddleware } = require('../middlewares/auth');

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

/**
 * Builds dialect-specific SQL query for catalog listing.
 */
function buildCatalogQuery(engine, filters) {
    const isPg = engine === 'postgres';
    const primaryCheck = isPg ? 'pi.is_primary = true' : 'pi.is_primary = 1';
    const demoCheck = isPg ? '(p.is_demo = false OR p.is_demo IS NULL)' : '(p.is_demo = 0 OR p.is_demo IS NULL)';

    let sql = `
        SELECT p.*, m.name_ar as manufacturer_name, m.city as manufacturer_city,
               c.name_ar as category_name,
               (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND ${primaryCheck} LIMIT 1) as primary_image
        FROM products p
        JOIN manufacturers m ON p.manufacturer_id = m.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE 1=1
    `;
    const params = [];

    // Public view only shows 'PUBLISHED' products unless an admin explicitly filters by status
    if (filters.status) {
        sql += ' AND p.status = ?';
        params.push(filters.status);
    } else {
        sql += " AND p.status = 'PUBLISHED'";
    }

    // Exclude demo records from public catalog
    sql += ` AND ${demoCheck}`;

    if (filters.category_id) {
        sql += ' AND (p.category_id = ? OR p.subcategory_id = ?)';
        params.push(filters.category_id, filters.category_id);
    }

    if (filters.manufacturer_id) {
        sql += ' AND p.manufacturer_id = ?';
        params.push(filters.manufacturer_id);
    }

    if (filters.search) {
        sql += ' AND (p.name_ar LIKE ? OR p.description_ar LIKE ? OR p.sku LIKE ?)';
        const term = `%${filters.search}%`;
        params.push(term, term, term);
    }

    sql += ' ORDER BY p.created_at DESC';
    return { sql, params };
}

// Get products catalog (combines Direct Contract and Marketing Subscription products)
router.get('/', async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const { category_id, manufacturer_id, search, status } = req.query || {};

    const filters = { category_id, manufacturer_id, search, status };
    const qSqlite = buildCatalogQuery('sqlite', filters);
    const qPg = buildCatalogQuery('postgres', filters);

    const catalogQuery = {
        sqlite: qSqlite.sql,
        postgres: qPg.sql
    };

    try {
        const products = await dbClient.queryAll(catalogQuery, qSqlite.params, dbOpts);
        const formatted = products.map(p => ({
            ...p,
            specifications: parseSpecifications(p.specifications)
        }));

        return res.json({
            success: true,
            count: formatted.length,
            products: formatted
        });
    } catch (err) {
        console.error('[productRoutes] GET / error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء استرجاع قائمة المنتجات'
        });
    }
});

// Dedicated My-Products Catalog endpoint for authenticated Manufacturers (Phase 4.0-F)
router.get('/my-catalog', authMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const user = req.user;

    if (user.role !== 'MANUFACTURER' || !user.manufacturer_id) {
        return res.status(403).json({ success: false, error: 'هذه الواجهة مخصصة لحسابات المصانع فقط' });
    }

    try {
        const products = await dbClient.queryAll(`
            SELECT p.*, c.name_ar as category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.manufacturer_id = ?
            ORDER BY p.created_at DESC
        `, [user.manufacturer_id], dbOpts);

        const formatted = products.map(p => ({
            ...p,
            specifications: parseSpecifications(p.specifications)
        }));

        return res.json({
            success: true,
            manufacturer_id: user.manufacturer_id,
            count: formatted.length,
            products: formatted
        });
    } catch (err) {
        console.error('[productRoutes] GET /my-catalog error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في استرجاع كتالوج منتجات المصنع' });
    }
});

// Get single product details
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    const singleQuery = {
        sqlite: `
            SELECT p.*, m.name_ar as manufacturer_name, m.city as manufacturer_city,
                   c.name_ar as category_name
            FROM products p
            JOIN manufacturers m ON p.manufacturer_id = m.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.id = ? AND (p.is_demo = 0 OR p.is_demo IS NULL)
        `,
        postgres: `
            SELECT p.*, m.name_ar as manufacturer_name, m.city as manufacturer_city,
                   c.name_ar as category_name
            FROM products p
            JOIN manufacturers m ON p.manufacturer_id = m.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.id = $1 AND (p.is_demo = false OR p.is_demo IS NULL)
        `
    };

    try {
        const prod = await dbClient.queryOne(singleQuery, [id], dbOpts);
        if (!prod) {
            return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
        }

        const images = await dbClient.queryAll(
            'SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order ASC',
            [id],
            dbOpts
        );

        return res.json({
            success: true,
            product: {
                ...prod,
                specifications: parseSpecifications(prod.specifications),
                images
            }
        });
    } catch (err) {
        console.error('[productRoutes] GET /:id error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء استرجاع تفاصيل المنتج'
        });
    }
});

// Update product through normal management interface (Hardened for Phase 4.0-F)
router.put('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};
    const user = req.user;

    try {
        const prod = await dbClient.queryOne('SELECT * FROM products WHERE id = ?', [id], dbOpts);
        if (!prod) {
            return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
        }

        // Multi-tenant check: Manufacturer can only edit their own products
        if (user.role === 'MANUFACTURER' && prod.manufacturer_id !== user.manufacturer_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح بتعديل هذا المنتج (يتبع لمنشأة أخرى)' });
        }

        const {
            name_ar,
            name_en,
            description_ar,
            price,
            currency,
            price_unit,
            moq,
            packaging_info,
            specifications,
            category_id,
            status: requestedStatus
        } = req.body || {};

        // Invariant: Manufacturer cannot self-approve or self-publish a product
        if (user.role === 'MANUFACTURER' && requestedStatus && requestedStatus === 'APPROVED') {
            return res.status(403).json({ success: false, error: 'غير مصرح للمصنع باعتماد أو نشر المنتج ذاتياً. الاعتماد حصري للإدارة المركزية.' });
        }

        const specsVal = specifications !== undefined
            ? (typeof specifications === 'object' ? JSON.stringify(specifications) : String(specifications))
            : (typeof prod.specifications === 'object' ? JSON.stringify(prod.specifications) : prod.specifications);

        // Check if sensitive fields changed by Manufacturer
        let newStatus = prod.status;
        let requiresReviewNotice = false;

        if (user.role === 'MANUFACTURER') {
            const nameArChanged = name_ar !== undefined && name_ar !== prod.name_ar;
            const nameEnChanged = name_en !== undefined && name_en !== prod.name_en;
            const specsChanged = specifications !== undefined && specsVal !== (typeof prod.specifications === 'object' ? JSON.stringify(prod.specifications) : prod.specifications);
            const packagingChanged = packaging_info !== undefined && packaging_info !== prod.packaging_info;
            const categoryChanged = category_id !== undefined && category_id !== prod.category_id;

            if (nameArChanged || nameEnChanged || specsChanged || packagingChanged || categoryChanged) {
                newStatus = 'PENDING_APPROVAL';
                requiresReviewNotice = true;
            }
        } else if (user.role === 'ADMIN' && requestedStatus) {
            newStatus = requestedStatus;
        }

        const updateSql = `
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
                status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `;

        await dbClient.execute(updateSql, [
            name_ar ?? prod.name_ar,
            name_en ?? prod.name_en,
            description_ar ?? prod.description_ar,
            price !== undefined ? price : prod.price,
            currency ?? prod.currency,
            price_unit ?? prod.price_unit,
            moq ?? prod.moq,
            packaging_info ?? prod.packaging_info,
            specsVal,
            category_id ?? prod.category_id,
            newStatus,
            id
        ], dbOpts);

        return res.json({
            success: true,
            message: requiresReviewNotice
                ? 'تم حفظ تعديلات المنتج، ونظراً لتعديل حقول المواصفات الحساسة تم إرجاع حالة المنتج للمراجعة المركزية (قيد المراجعة).'
                : 'تم تحديث بيانات المنتج بنجاح',
            status: newStatus,
            requires_review: requiresReviewNotice
        });
    } catch (err) {
        console.error('[productRoutes] PUT /:id error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء تحديث بيانات المنتج'
        });
    }
});

module.exports = router;
