const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middlewares/auth');

// List subscription plans
router.get('/plans', (req, res) => {
    const db = getDb();
    const plans = db.prepare('SELECT * FROM subscriptions ORDER BY max_products_per_import ASC').all();
    const formatted = plans.map(p => ({
        ...p,
        allowed_formats: JSON.parse(p.allowed_formats || '[]')
    }));

    res.json({
        success: true,
        plans: formatted
    });
});

// Update plan configuration (Super Admin only - no code changes needed)
router.put('/plans/:id', authMiddleware, requireRole(['SUPER_ADMIN']), (req, res) => {
    const db = getDb();
    const { id } = req.params;
    const { allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb, ai_extraction_enabled, bulk_import_enabled } = req.body;

    const plan = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    if (!plan) {
        return res.status(404).json({ success: false, error: 'باقة الاشتراك غير موجودة' });
    }

    db.prepare(`
        UPDATE subscriptions 
        SET allowed_formats = ?,
            max_products_per_import = ?,
            max_monthly_imports = ?,
            max_file_size_mb = ?,
            ai_extraction_enabled = ?,
            bulk_import_enabled = ?
        WHERE id = ?
    `).run(
        JSON.stringify(allowed_formats || ['xlsx', 'csv']),
        max_products_per_import ?? plan.max_products_per_import,
        max_monthly_imports ?? plan.max_monthly_imports,
        max_file_size_mb ?? plan.max_file_size_mb,
        ai_extraction_enabled ? 1 : 0,
        bulk_import_enabled ? 1 : 0,
        id
    );

    const updated = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    res.json({
        success: true,
        message: 'تم تحديث إعدادات باقة الاشتراك بنجاح',
        plan: {
            ...updated,
            allowed_formats: JSON.parse(updated.allowed_formats || '[]')
        }
    });
});

module.exports = router;
