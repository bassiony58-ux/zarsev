const dbClient = require('../db/dbClient');

/**
 * Normalizes allowed_formats safely across SQLite and PostgreSQL.
 * SQLite returns a JSON serialized text string (requiring JSON.parse).
 * PostgreSQL returns a native parsed JSON array/object.
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
 * Validates upload and import parameters against the manufacturer's active subscription tier.
 */
function checkSubscriptionLimits(options = {}) {
    return async (req, res, next) => {
        const user = req.user;

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'غير مصرح: يلزم تسجيل الدخول للتحقق من صلاحيات الاشتراك'
            });
        }

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

        const dbOpts = req.dbClientOptions || {};
        let mfg = null;
        try {
            mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
        } catch (err) {
            console.error('[subscriptionGuard] DB error fetching manufacturer:', err.message);
            return res.status(500).json({
                success: false,
                error: 'خطأ في قاعدة البيانات أثناء التحقق من بيانات المصنع'
            });
        }

        if (!mfg) {
            return res.status(404).json({
                success: false,
                error: 'بيانات المصنع غير موجودة'
            });
        }

        // DIRECT_CONTRACT manufacturers are quota-exempt
        const isDirectContract = mfg.business_model === 'DIRECT_CONTRACT';

        let sub = null;
        if (mfg.subscription_id) {
            try {
                sub = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [mfg.subscription_id], dbOpts);
            } catch (err) {
                console.error('[subscriptionGuard] DB error fetching subscription:', err.message);
                return res.status(500).json({
                    success: false,
                    error: 'خطأ في قاعدة البيانات أثناء التحقق من باقة الاشتراك'
                });
            }
        }

        // If DIRECT_CONTRACT has no custom subscription record, provision Enterprise defaults
        if (!sub && isDirectContract) {
            sub = {
                id: 'sub_enterprise',
                name: 'Enterprise Direct Contract (عقد مباشر)',
                allowed_formats: ['xlsx', 'xls', 'csv', 'pdf', 'docx', 'images', 'zip'],
                max_products_per_import: 5000,
                max_monthly_imports: 10000,
                max_file_size_mb: 250,
                ai_extraction_enabled: 1,
                bulk_import_enabled: 1
            };
        }

        if (!sub) {
            return res.status(403).json({
                success: false,
                error: 'لا توجد باقة اشتراك سارية لهذا المصنع'
            });
        }

        // Subscription expiration check if expires_at is present
        if (sub.expires_at && new Date(sub.expires_at).getTime() < Date.now()) {
            return res.status(403).json({
                success: false,
                error: 'باقة الاشتراك الخاصة بهذا المصنع منتهية الصلاحية'
            });
        }

        const allowedFormats = parseAllowedFormats(sub.allowed_formats);
        req.subscription = {
            ...sub,
            allowed_formats: allowedFormats
        };

        // Monthly quota check: DIRECT_CONTRACT is quota-exempt
        if (!isDirectContract) {
            const countSql = {
                sqlite: `
                    SELECT COUNT(*) as count 
                    FROM imports 
                    WHERE manufacturer_id = ? 
                      AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
                `,
                postgres: `
                    SELECT COUNT(*)::int as count 
                    FROM imports 
                    WHERE manufacturer_id = $1 
                      AND to_char(created_at, 'YYYY-MM') = to_char(CURRENT_TIMESTAMP, 'YYYY-MM')
                `
            };

            let currentMonthCount = null;
            try {
                currentMonthCount = await dbClient.queryOne(countSql, [user.manufacturer_id], dbOpts);
            } catch (err) {
                console.error('[subscriptionGuard] DB error calculating quota:', err.message);
                return res.status(500).json({
                    success: false,
                    error: 'خطأ في قاعدة البيانات أثناء احتساب العمليات الشهرية'
                });
            }

            const quotaUsed = currentMonthCount?.count !== undefined && currentMonthCount?.count !== null
                ? Number(currentMonthCount.count)
                : 0;
            const quotaMax = Number(sub.max_monthly_imports || 0);

            if (quotaUsed >= quotaMax) {
                return res.status(429).json({
                    success: false,
                    error: `لقد تجاوزت الحد الأقصى المسموح به لعمليات الاستيراد الشهرية (${sub.max_monthly_imports} عمليات). يرجى ترقية باقة الاشتراك.`
                });
            }
        }

        next();
    };
}

module.exports = {
    checkSubscriptionLimits,
    parseAllowedFormats
};
