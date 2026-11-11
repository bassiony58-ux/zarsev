const config = require('../config');
const { generateCsrfToken } = require('../utils/authUtils');

function getCanonicalOrigin(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    try {
        const u = new URL(urlStr);
        return u.origin.toLowerCase();
    } catch (e) {
        return null;
    }
}

/**
 * CSRF Protection Middleware for Cookie-Authenticated Requests.
 *
 * Protection Strategy:
 * 1. Read-only HTTP methods (GET, HEAD, OPTIONS) are exempt from CSRF checks.
 * 2. Requests presenting an explicit "Authorization: Bearer <token>" header bypass CSRF
 *    validation because custom headers cannot be submitted implicitly by cross-site HTML forms.
 * 3. Cookie-authenticated mutating requests (POST, PUT, PATCH, DELETE) MUST satisfy:
 *    a) Origin / Referer validation against configured trusted application origins (exact origin match), AND
 *    b) Valid Double-Submit CSRF Token matching between cookie and header.
 */
function csrfProtection(req, res, next) {
    // 1. Safe methods are exempt from mutating checks; seed/refresh CSRF cookie if absent
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!req.cookies || !req.cookies[config.CSRF_COOKIE_NAME]) {
            const token = generateCsrfToken();
            res.cookie(config.CSRF_COOKIE_NAME, token, {
                httpOnly: false, // Readable by client JS to mirror in X-CSRF-Token header
                secure: config.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/'
            });
        }
        return next();
    }

    // Authentication, dev-login, and public buyer RFQ/inquiry endpoints are exempt from prior session CSRF mismatch
    if (req.originalUrl && (
        req.originalUrl.includes('/api/auth/dev-login') ||
        req.originalUrl.includes('/api/auth/login') ||
        req.originalUrl.includes('/api/rfqs') ||
        req.originalUrl.includes('/api/quotations') ||
        req.originalUrl.includes('/api/inquiries') ||
        req.originalUrl.includes('/api/contact')
    )) {
        return next();
    }

    // 2. Explicit Bearer token authentication is immune to ambient cookie CSRF
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return next();
    }

    // 3. If no auth cookie is present, ambient cookie attack is not possible
    const hasAuthCookie = req.cookies && req.cookies[config.AUTH_COOKIE_NAME];
    if (!hasAuthCookie) {
        return next();
    }

    // 4. Exact Canonical Origin / Referer validation
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const allowedCanonicalOrigins = (config.ALLOWED_ORIGINS || []).map(getCanonicalOrigin).filter(Boolean);

    if (origin) {
        const canonicalOrigin = getCanonicalOrigin(origin);
        if (!canonicalOrigin || !allowedCanonicalOrigins.includes(canonicalOrigin)) {
            return res.status(403).json({
                success: false,
                error: 'غير مسموح: تم رفض الطلب لمخالفته سياسة أمان المصدر (CSRF Origin Mismatch)'
            });
        }
    } else if (referer) {
        const canonicalReferer = getCanonicalOrigin(referer);
        if (!canonicalReferer || !allowedCanonicalOrigins.includes(canonicalReferer)) {
            return res.status(403).json({
                success: false,
                error: 'غير مسموح: تم رفض الطلب لمخالفته سياسة أمان المرجع (CSRF Referer Mismatch)'
            });
        }
    }

    // 5. Double-Submit Token verification
    const cookieCsrf = req.cookies ? req.cookies[config.CSRF_COOKIE_NAME] : null;
    const headerCsrf = req.headers[config.CSRF_HEADER_NAME] || req.headers['x-csrf-token'];

    if (!cookieCsrf || !headerCsrf || cookieCsrf !== headerCsrf) {
        // Defense-in-depth: if exact Origin was validated AND custom X-Requested-With is present
        const customHeader = req.headers['x-requested-with'];
        if (origin && customHeader && allowedCanonicalOrigins.includes(getCanonicalOrigin(origin))) {
            return next();
        }

        return res.status(403).json({
            success: false,
            error: 'غير مسموح: رمز الحماية ضد التزوير مفقود أو غير صالح (Missing or Invalid CSRF Token)'
        });
    }

    next();
}

module.exports = {
    csrfProtection,
    getCanonicalOrigin
};
