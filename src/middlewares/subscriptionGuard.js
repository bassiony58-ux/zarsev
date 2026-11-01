const { getDb } = require('../db/database');

/**
 * Validates upload and import parameters against the manufacturer's active subscription tier.
 */
function checkSubscriptionLimits(options = {}) {
    return (req, res, next) => {
        const db = getDb();
        const user = req.user;

        // Super Admin and Logistics Officers have unlimited or Enterprise privileges
        if (user.role === 'SUPER_ADMIN' || user.role === 'LOGISTICS_OFFICER') {
            req.subscription = {
                id: 'sub_enterprise',
                name: 'Enterprise Unlimited (إدارة زارسيف)',
                allowed_formats: ['xlsx', 'xls', 'csv', 'pdf', 'docx', 'images', 'zip'],
                max_products_per_import: 5000,
                max_monthly_imports: 10000,
                max_file_size_mb: 250,
                ai_extraction_enabled: 1,
                bulk_import_enabled: 1
            };
            return next();
        }

        // For Marketing Subscription Manufacturers:
        if (!user.manufacturer_id) {
            return res.status(403).json({
                success: false,
                error: 'حساب المستخدم غير مقترن بملف مصنع معتمد'
            });
        }

        const mfg = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(user.manufacturer_id);
        if (!mfg) {
            return res.status(404).json({
                success: false,
                error: 'بيانات المصنع غير موجودة'
            });
        }

        const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(mfg.subscription_id);
        if (!sub) {
            return res.status(403).json({
                success: false,
                error: 'لا توجد باقة اشتراك سارية لهذا المصنع'
            });
        }

        const allowedFormats = JSON.parse(sub.allowed_formats || '[]');
        req.subscription = {
            ...sub,
            allowed_formats: allowedFormats
        };

        // Check monthly imports quota
        const currentMonthCount = db.prepare(`
            SELECT COUNT(*) as count 
            FROM imports 
            WHERE manufacturer_id = ? 
              AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
        `).get(user.manufacturer_id);

        if (currentMonthCount.count >= sub.max_monthly_imports) {
            return res.status(429).json({
                success: false,
                error: `لقد تجاوزت الحد الأقصى المسموح به لعمليات الاستيراد الشهرية (${sub.max_monthly_imports} عمليات). يرجى ترقية باقة الاشتراك.`
            });
        }

        next();
    };
}

module.exports = {
    checkSubscriptionLimits
};
