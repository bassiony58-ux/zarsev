const express = require('express');
const router = express.Router();
const dbClient = require('../db/dbClient');
const { authMiddleware, requireRole } = require('../middlewares/auth');

/**
 * Safely parses allowed_formats across SQLite (JSON string) and PostgreSQL (JSONB array/object)
 */
function parseAllowedFormats(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

/**
 * Validates payload for PUT /plans/:id
 * Returns error string or null if valid.
 */
function validatePlanUpdatePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'بيانات التحديث غير صالحة';
    }

    const { allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb } = body;

    if (allowed_formats !== undefined) {
        if (!Array.isArray(allowed_formats)) {
            return 'صيغ الملفات المسموحة يجب أن تكون مصفوفة';
        }
        for (const fmt of allowed_formats) {
            if (typeof fmt !== 'string' || !fmt.trim()) {
                return 'كل صيغة ملف يجب أن تكون نصاً غير فارغ';
            }
        }
    }

    if (max_products_per_import !== undefined) {
        if (typeof max_products_per_import !== 'number' || isNaN(max_products_per_import) || max_products_per_import < 0) {
            return 'الحد الأقصى للمنتجات لكل عملية استيراد يجب أن يكون رقماً موجباً';
        }
    }

    if (max_monthly_imports !== undefined) {
        if (typeof max_monthly_imports !== 'number' || isNaN(max_monthly_imports) || max_monthly_imports < 0) {
            return 'الحد الأقصى للعمليات الشهرية يجب أن يكون رقماً موجباً';
        }
    }

    if (max_file_size_mb !== undefined) {
        if (typeof max_file_size_mb !== 'number' || isNaN(max_file_size_mb) || max_file_size_mb <= 0) {
            return 'الحد الأقصى لحجم الملف يجب أن يكون رقماً أكبر من صفر';
        }
    }

    return null;
}

// List subscription plans
router.get('/plans', async (req, res) => {
    try {
        const dbOpts = req.dbClientOptions || {};
        const plans = await dbClient.queryAll('SELECT * FROM subscriptions ORDER BY max_products_per_import ASC', [], dbOpts);
        const formatted = plans.map(p => ({
            ...p,
            allowed_formats: parseAllowedFormats(p.allowed_formats)
        }));

        return res.json({
            success: true,
            plans: formatted
        });
    } catch (err) {
        console.error('[subscriptionRoutes] Error fetching subscription plans:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في استرجاع باقات الاشتراك من قاعدة البيانات'
        });
    }
});

// Update plan configuration (Super Admin only - no code changes needed)
router.put('/plans/:id', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    const validationError = validatePlanUpdatePayload(req.body);
    if (validationError) {
        return res.status(400).json({
            success: false,
            error: validationError
        });
    }

    try {
        const plan = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [id], dbOpts);
        if (!plan) {
            return res.status(404).json({
                success: false,
                error: 'باقة الاشتراك غير موجودة'
            });
        }

        const {
            allowed_formats,
            max_products_per_import,
            max_monthly_imports,
            max_file_size_mb,
            ai_extraction_enabled,
            bulk_import_enabled
        } = req.body;

        const formatsToStore = allowed_formats !== undefined
            ? JSON.stringify(allowed_formats)
            : JSON.stringify(parseAllowedFormats(plan.allowed_formats));

        const aiEnabled = ai_extraction_enabled !== undefined
            ? (ai_extraction_enabled ? 1 : 0)
            : (plan.ai_extraction_enabled ? 1 : 0);

        const bulkEnabled = bulk_import_enabled !== undefined
            ? (bulk_import_enabled ? 1 : 0)
            : (plan.bulk_import_enabled ? 1 : 0);

        let updated = null;
        await dbClient.transaction(async (tx) => {
            await tx.execute(`
                UPDATE subscriptions 
                SET allowed_formats = ?,
                    max_products_per_import = ?,
                    max_monthly_imports = ?,
                    max_file_size_mb = ?,
                    ai_extraction_enabled = ?,
                    bulk_import_enabled = ?
                WHERE id = ?
            `, [
                formatsToStore,
                max_products_per_import ?? plan.max_products_per_import,
                max_monthly_imports ?? plan.max_monthly_imports,
                max_file_size_mb ?? plan.max_file_size_mb,
                aiEnabled,
                bulkEnabled,
                id
            ]);

            updated = await tx.queryOne('SELECT * FROM subscriptions WHERE id = ?', [id]);
        }, dbOpts);

        return res.json({
            success: true,
            message: 'تم تحديث إعدادات باقة الاشتراك بنجاح',
            plan: {
                ...updated,
                allowed_formats: parseAllowedFormats(updated.allowed_formats)
            }
        });
    } catch (err) {
        console.error('[subscriptionRoutes] Error updating subscription plan:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في تحديث إعدادات باقة الاشتراك في قاعدة البيانات'
        });
    }
});

router.parseAllowedFormats = parseAllowedFormats;
router.validatePlanUpdatePayload = validatePlanUpdatePayload;
module.exports = router;
