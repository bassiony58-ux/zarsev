const { getDb } = require('../db/database');

/**
 * Authentication & Role-Based Access Control Middleware
 * Supports session/header token simulation with multi-persona switching.
 */
function authMiddleware(req, res, next) {
    const db = getDb();
    
    // Check header, cookie, or query parameter for user context
    const userId = req.headers['x-user-id'] || req.query.user_id || req.body?.user_id || 'usr_super_admin';
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
        return res.status(401).json({
            success: false,
            error: 'غير مصرح: المستخدم غير موجود في النظام'
        });
    }

    // Attach user and manufacturer details
    req.user = user;
    if (user.manufacturer_id) {
        req.manufacturer = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(user.manufacturer_id);
    } else {
        req.manufacturer = null;
    }

    next();
}

/**
 * Role authorization guard
 * @param {Array<string>} roles - e.g. ['SUPER_ADMIN', 'LOGISTICS_OFFICER']
 */
function requireRole(roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'غير مسموح: ليس لديك الصلاحية لتنفيذ هذا الإجراء'
            });
        }
        next();
    };
}

module.exports = {
    authMiddleware,
    requireRole
};
