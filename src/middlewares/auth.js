const dbClient = require('../db/dbClient');
const { verifyToken } = require('../utils/authUtils');
const config = require('../config');

/**
 * Safely and strictly checks whether an entity is active across SQLite and PostgreSQL.
 * SQLite represents booleans as integer 1 (active) or 0 (inactive).
 * PostgreSQL represents booleans natively as true (active) or false (inactive).
 * Strictly avoids blind truthiness conversion (e.g. '0' or 'false' or null).
 */
function isEntityActive(isActiveVal) {
    if (typeof isActiveVal === 'boolean') {
        return isActiveVal === true;
    }
    if (typeof isActiveVal === 'number') {
        return isActiveVal === 1;
    }
    if (typeof isActiveVal === 'string') {
        const norm = isActiveVal.trim().toLowerCase();
        return norm === 'true' || norm === 't' || norm === '1';
    }
    return false;
}

/**
 * Authentication Middleware
 * Enforces signed JWT authentication via Authorization Bearer header or HTTP-only cookie.
 * Strictly eliminates header, query, and body impersonation (x-user-id, user_id).
 * Resolves user existence, active status, role, and manufacturer identity from trusted server-side database.
 */
async function authMiddleware(req, res, next) {
    let token = null;

    // 1. Check Authorization Bearer header
    const authHeader = req.headers ? req.headers['authorization'] : null;
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
            code: 'TOKEN_REQUIRED',
            error: 'غير مصرح: يلزم تسجيل الدخول وتقديم رمز جلسة صالح للوصول إلى هذا المورد'
        });
    }

    // 3. Verify JWT signature & expiration
    const payload = verifyToken(token);
    if (!payload || !payload.id) {
        return res.status(401).json({
            success: false,
            code: 'INVALID_TOKEN',
            error: 'غير مصرح: رمز الجلسة غير صالح أو منتهي الصلاحية'
        });
    }

    // 4. Verify user existence and active status against server-side database
    const dbOpts = req.dbClientOptions || {};
    let user = null;
    try {
        user = await dbClient.queryOne('SELECT * FROM users WHERE id = ?', [payload.id], dbOpts);
    } catch (err) {
        console.error('[authMiddleware] Database query failure:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء التحقق من الهوية'
        });
    }

    if (!user) {
        return res.status(401).json({
            success: false,
            code: 'USER_NOT_FOUND',
            error: 'غير مصرح: المستخدم غير مسجل بالنظام'
        });
    }

    if (!isEntityActive(user.is_active)) {
        return res.status(401).json({
            success: false,
            code: 'USER_INACTIVE',
            error: 'غير مصرح: تم تجميد أو تعطيل هذا الحساب'
        });
    }

    // 5. Invalidate revoked tokens (Mandatory Token Version Check - Strict numeric comparison, NO fallback to 1)
    if (payload.token_version === undefined || payload.token_version === null) {
        return res.status(401).json({
            success: false,
            code: 'TOKEN_VERSION_REQUIRED',
            error: 'غير مصرح: رمز الجلسة يفتقر إلى إصدار التوكن الإلزامي'
        });
    }

    const tokenVersion = Number(payload.token_version);
    if (!Number.isInteger(tokenVersion) || tokenVersion < 1) {
        return res.status(401).json({
            success: false,
            code: 'INVALID_TOKEN_VERSION',
            error: 'غير مصرح: إصدار رمز الجلسة غير صالح'
        });
    }

    const currentVersion = user.token_version !== undefined && user.token_version !== null ? Number(user.token_version) : 1;
    if (tokenVersion !== currentVersion) {
        return res.status(401).json({
            success: false,
            code: 'SESSION_REVOKED',
            error: 'غير مصرح: تم تسجيل الخروج وإبطال جلسة هذا الرمز (Session Revoked)'
        });
    }

    // Sanitize user object (never expose password hashes in req.user)
    delete user.password_hash;
    delete user.password;
    delete user.salt;

    // Attach trusted server-side identity
    req.user = user;

    // 6. Unified Manufacturer Resolution & Suspension Check
    if (user.role === 'MANUFACTURER') {
        if (!user.manufacturer_id) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_UNLINKED',
                error: 'غير مصرح: حساب المصنع غير مرتبط بمنشأة صالحة'
            });
        }
        try {
            const mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
            if (!mfg) {
                return res.status(403).json({
                    success: false,
                    code: 'MANUFACTURER_NOT_FOUND',
                    error: 'غير مصرح: منشأة المصنع غير موجودة بالنظام'
                });
            }
            if (mfg.is_active !== undefined && !isEntityActive(mfg.is_active)) {
                return res.status(403).json({
                    success: false,
                    code: 'MANUFACTURER_SUSPENDED',
                    error: 'غير مصرح: تم تعليق أو تجميد منشأة المصنع'
                });
            }
            req.manufacturer = mfg;
            if (mfg.subscription_id) {
                req.subscription = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [mfg.subscription_id], dbOpts) || null;
            } else {
                req.subscription = null;
            }
        } catch (err) {
            console.error('[authMiddleware] Failed to resolve manufacturer/subscription:', err.message);
            return res.status(500).json({
                success: false,
                error: 'خطأ في خادم قاعدة البيانات أثناء تحميل بيانات المصنع والاشتراك'
            });
        }
    } else if (user.manufacturer_id) {
        try {
            const mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
            req.manufacturer = mfg || null;
            if (mfg && mfg.subscription_id) {
                req.subscription = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [mfg.subscription_id], dbOpts) || null;
            } else {
                req.subscription = null;
            }
        } catch (err) {
            console.error('[authMiddleware] Failed to resolve manufacturer/subscription for non-mfg:', err.message);
            return res.status(500).json({
                success: false,
                error: 'خطأ في خادم قاعدة البيانات أثناء تحميل بيانات المصنع والاشتراك'
            });
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
async function optionalAuthMiddleware(req, res, next) {
    let token = null;
    const authHeader = req.headers ? req.headers['authorization'] : null;
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

    const dbOpts = req.dbClientOptions || {};
    let user = null;
    try {
        user = await dbClient.queryOne('SELECT * FROM users WHERE id = ?', [payload.id], dbOpts);
    } catch (err) {
        console.error('[optionalAuthMiddleware] Database query failure:', err.message);
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    if (!user || !isEntityActive(user.is_active)) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    if (payload.token_version === undefined || payload.token_version === null) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    const tokenVersion = Number(payload.token_version);
    if (!Number.isInteger(tokenVersion) || tokenVersion < 1) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    const currentVersion = user.token_version !== undefined && user.token_version !== null ? Number(user.token_version) : 1;
    if (tokenVersion !== currentVersion) {
        req.user = null;
        req.manufacturer = null;
        req.subscription = null;
        return next();
    }

    delete user.password_hash;
    delete user.password;
    delete user.salt;
    req.user = user;

    if (user.role === 'MANUFACTURER') {
        if (!user.manufacturer_id) {
            req.user = null;
            req.manufacturer = null;
            req.subscription = null;
            return next();
        }
        try {
            const mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
            if (!mfg || (mfg.is_active !== undefined && !isEntityActive(mfg.is_active))) {
                req.user = null;
                req.manufacturer = null;
                req.subscription = null;
                return next();
            }
            req.manufacturer = mfg;
            if (mfg.subscription_id) {
                req.subscription = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [mfg.subscription_id], dbOpts) || null;
            } else {
                req.subscription = null;
            }
        } catch (err) {
            req.user = null;
            req.manufacturer = null;
            req.subscription = null;
            return next();
        }
    } else if (user.manufacturer_id) {
        try {
            const mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
            req.manufacturer = mfg || null;
            if (mfg && mfg.subscription_id) {
                req.subscription = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [mfg.subscription_id], dbOpts) || null;
            } else {
                req.subscription = null;
            }
        } catch (err) {
            req.manufacturer = null;
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
 * Checks req.user.role and req.user.sub_role against allowed roles.
 * @param {Array<string>} roles - e.g. ['SUPER_ADMIN', 'LOGISTICS_OFFICER']
 */
function requireRole(roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                code: 'UNAUTHORIZED',
                error: 'غير مصرح: يجب تسجيل الدخول أولاً'
            });
        }
        const userRoles = [req.user.role, req.user.sub_role].filter(Boolean);
        const hasRole = userRoles.some(r => roles.includes(r));
        if (!hasRole) {
            return res.status(403).json({
                success: false,
                code: 'FORBIDDEN_ROLE',
                error: 'غير مسموح: ليس لديك الصلاحية لتنفيذ هذا الإجراء'
            });
        }
        next();
    };
}

/**
 * Sub-role authorization guard for MANUFACTURER accounts
 * Deny by default: rejects if user has no sub_role or sub_role is not in allowed list.
 * @param {Array<string>} allowedSubRoles - e.g. ['OWNER', 'SALES']
 * @param {Object} [options]
 * @param {Array<string>} [options.allowRoles] - Global roles to allow without sub_role check (defaults to ['SUPER_ADMIN'])
 */
function requireSubRole(allowedSubRoles, options = {}) {
    if (!Array.isArray(allowedSubRoles)) {
        throw new Error('requireSubRole expects an array of allowed sub-roles');
    }
    const allowRoles = options.allowRoles || ['SUPER_ADMIN'];

    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                code: 'UNAUTHORIZED',
                error: 'غير مصرح: يجب تسجيل الدخول أولاً'
            });
        }

        // Bypass for permitted global administrative roles
        const userRoles = [req.user.role, req.user.sub_role].filter(Boolean);
        if (userRoles.some(r => allowRoles.includes(r))) {
            return next();
        }

        // Strict enforcement for MANUFACTURER role
        if (req.user.role === 'MANUFACTURER') {
            const subRole = req.user.sub_role;
            if (!subRole || !allowedSubRoles.includes(subRole)) {
                return res.status(403).json({
                    success: false,
                    code: 'INSUFFICIENT_SUB_ROLE',
                    error: 'غير مصرح: ليس لديك الدور الفرعي المطلوب لتنفيذ هذا الإجراء',
                    required_sub_roles: allowedSubRoles,
                    current_sub_role: subRole || null
                });
            }
            return next();
        }

        // Deny by default for any other role
        return res.status(403).json({
            success: false,
            code: 'INSUFFICIENT_ROLE',
            error: 'غير مصرح: ليس لديك الصلاحية لتنفيذ هذا الإجراء'
        });
    };
}

module.exports = {
    authMiddleware,
    optionalAuthMiddleware,
    requireRole,
    requireSubRole,
    isEntityActive
};
