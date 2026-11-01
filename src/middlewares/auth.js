const { getDb } = require('../db/database');
const { verifyToken } = require('../utils/authUtils');
const config = require('../config');

/**
 * Authentication Middleware
 * Enforces signed JWT authentication via Authorization Bearer header or HTTP-only cookie.
 * Strictly eliminates header, query, and body impersonation (x-user-id, user_id).
 * Resolves user existence, active status, role, and manufacturer identity from trusted server-side database.
 */
function authMiddleware(req, res, next) {
    let token = null;

    // 1. Check Authorization Bearer header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    }

    // 2. Fall back to secure HTTP-only cookie if header is not present
    if (!token && req.cookies && req.cookies[config.AUTH_COOKIE_NAME]) {
        token = req.cookies[config.AUTH_COOKIE_NAME];
    }

    // Unauthenticated requests must receive HTTP 401
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'غير مصرح: يلزم تسجيل الدخول وتقديم رمز جلسة صالح للوصول إلى هذا المورد'
        });
    }

    // 3. Verify JWT signature & expiration
    const payload = verifyToken(token);
    if (!payload || !payload.id) {
        return res.status(401).json({
            success: false,
            error: 'غير مصرح: رمز الجلسة غير صالح أو منتهي الصلاحية'
        });
    }

    // 4. Verify user existence and active status against server-side database
    const db = getDb();
    const user = db.prepare(`
        SELECT id, name, email, role, manufacturer_id, is_active, is_demo, token_version 
        FROM users 
        WHERE id = ?
    `).get(payload.id);

    if (!user) {
        return res.status(401).json({
            success: false,
            error: 'غير مصرح: المستخدم غير مسجل بالنظام'
        });
    }

    if (user.is_active !== 1) {
        return res.status(401).json({
            success: false,
            error: 'غير مصرح: تم تجميد أو تعطيل هذا الحساب'
        });
    }

    // 5. Invalidate revoked tokens (Token Version Check)
    const currentVersion = user.token_version || 1;
    const tokenVersion = payload.token_version !== undefined ? payload.token_version : 1;
    if (tokenVersion !== currentVersion) {
        return res.status(401).json({
            success: false,
            error: 'غير مصرح: تم تسجيل الخروج وإبطال جلسة هذا الرمز (Session Revoked)'
        });
    }

    // Attach trusted server-side identity (never trust client-supplied roles or manufacturer IDs)
    req.user = user;

    if (user.manufacturer_id) {
        const mfg = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(user.manufacturer_id);
        req.manufacturer = mfg || null;
        if (mfg && mfg.subscription_id) {
            req.subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(mfg.subscription_id) || null;
        } else {
            req.subscription = null;
        }
    } else {
        req.manufacturer = null;
        req.subscription = null;
    }

    next();
}

/**
 * Optional Authentication Middleware (e.g. for endpoints that behave differently if logged in)
 */
function optionalAuthMiddleware(req, res, next) {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    } else if (req.cookies && req.cookies[config.AUTH_COOKIE_NAME]) {
        token = req.cookies[config.AUTH_COOKIE_NAME];
    }

    if (!token) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    const payload = verifyToken(token);
    if (!payload || !payload.id) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    const db = getDb();
    const user = db.prepare(`
        SELECT id, name, email, role, manufacturer_id, is_active, is_demo, token_version 
        FROM users 
        WHERE id = ?
    `).get(payload.id);

    if (!user || user.is_active !== 1) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    const currentVersion = user.token_version || 1;
    const tokenVersion = payload.token_version !== undefined ? payload.token_version : 1;
    if (tokenVersion !== currentVersion) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    req.user = user;
    if (user.manufacturer_id) {
        const mfg = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(user.manufacturer_id);
        req.manufacturer = mfg || null;
        if (mfg && mfg.subscription_id) {
            req.subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(mfg.subscription_id) || null;
        } else {
            req.subscription = null;
        }
    } else {
        req.manufacturer = null;
        req.subscription = null;
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
    optionalAuthMiddleware,
    requireRole
};
