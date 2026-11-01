const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middlewares/auth');
const {
    generateToken,
    verifyPassword,
    needsRehash,
    hashPassword,
    DUMMY_HASH,
    generateCsrfToken,
    serializeUser,
    serializeAdminManufacturer
} = require('../utils/authUtils');
const config = require('../config');

// In-memory rate limiting map for login attempts: ip/email -> { count, lockUntil }
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_PERIOD_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(key) {
    const record = loginAttempts.get(key);
    if (!record) return { blocked: false };
    if (record.lockUntil && Date.now() < record.lockUntil) {
        const remainingMinutes = Math.ceil((record.lockUntil - Date.now()) / 60000);
        return { blocked: true, remainingMinutes };
    }
    if (record.lockUntil && Date.now() >= record.lockUntil) {
        loginAttempts.delete(key);
    }
    return { blocked: false };
}

function recordFailedAttempt(key) {
    const record = loginAttempts.get(key) || { count: 0 };
    record.count += 1;
    if (record.count >= MAX_FAILED_ATTEMPTS) {
        record.lockUntil = Date.now() + LOCKOUT_PERIOD_MS;
    }
    loginAttempts.set(key, record);
}

function clearFailedAttempts(key) {
    loginAttempts.delete(key);
}

// Get current user and active role
router.get('/me', authMiddleware, (req, res) => {
    res.json({
        success: true,
        user: serializeUser(req.user),
        manufacturer: serializeAdminManufacturer(req.manufacturer),
        subscription: req.subscription || null
    });
});

// Standard production login endpoint
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({
            success: false,
            error: 'يرجى تقديم البريد الإلكتروني وكلمة المرور'
        });
    }

    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const rateLimitKey = `${clientIp}:${email.trim().toLowerCase()}`;
    const limitStatus = checkRateLimit(rateLimitKey);

    if (limitStatus.blocked) {
        return res.status(429).json({
            success: false,
            error: `تم تجاوز الحد الأقصى لمحاولات الدخول الفاشلة. يرجى المحاولة بعد ${limitStatus.remainingMinutes} دقيقة.`
        });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());

    if (!user || user.is_active !== 1) {
        // Run dummy hash check to mitigate timing side-channel user enumeration
        verifyPassword(password, DUMMY_HASH);
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({
            success: false,
            error: 'بيانات الدخول غير صحيحة أو الحساب غير نشط'
        });
    }

    // Timing-safe password verification
    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({
            success: false,
            error: 'بيانات الدخول غير صحيحة أو الحساب غير نشط'
        });
    }

    // Successful login: clear failed attempts
    clearFailedAttempts(rateLimitKey);

    // Gradual rehash: If hash is legacy or under 210,000 iterations, upgrade seamlessly
    if (needsRehash(user.password_hash)) {
        try {
            const upgradedHash = hashPassword(password);
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgradedHash, user.id);
        } catch (rehashErr) {
            console.error('Failed to automatically upgrade password hash:', rehashErr);
        }
    }

    const token = generateToken(user);
    const csrfToken = generateCsrfToken();

    // Set secure HTTP-only auth cookie
    res.cookie(config.AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    // Set CSRF token cookie readable by client JS
    res.cookie(config.CSRF_COOKIE_NAME, csrfToken, {
        httpOnly: false,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    res.json({
        success: true,
        token,
        csrf_token: csrfToken,
        user: serializeUser(user)
    });
});

// Dev-only authenticated test login mechanism
// Strictly disabled and inaccessible in production mode!
router.post('/dev-login', (req, res) => {
    if (config.NODE_ENV === 'production') {
        return res.status(404).json({
            success: false,
            error: 'غير متاح في بيئة الإنتاج'
        });
    }

    const { user_id } = req.body;
    if (!user_id) {
        return res.status(400).json({
            success: false,
            error: 'يرجى تحديد معرف المستخدم'
        });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);

    if (!user || user.is_active !== 1) {
        return res.status(404).json({
            success: false,
            error: 'المستخدم غير موجود أو غير نشط'
        });
    }

    const token = generateToken(user);
    const csrfToken = generateCsrfToken();

    res.cookie(config.AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    res.cookie(config.CSRF_COOKIE_NAME, csrfToken, {
        httpOnly: false,
        secure: false,
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    res.json({
        success: true,
        token,
        csrf_token: csrfToken,
        user: serializeUser(user)
    });
});

// Logout endpoint
router.post('/logout', (req, res) => {
    res.clearCookie(config.AUTH_COOKIE_NAME);
    res.clearCookie(config.CSRF_COOKIE_NAME);
    res.json({
        success: true,
        message: 'تم تسجيل الخروج بنجاح'
    });
});

// List available demo personas (strictly dev-only, disabled in production)
router.get('/personas', (req, res) => {
    if (config.NODE_ENV === 'production') {
        return res.status(404).json({
            success: false,
            error: 'غير متاح في بيئة الإنتاج'
        });
    }

    const db = getDb();
    const users = db.prepare(`
        SELECT u.id, u.name, u.role, u.manufacturer_id, m.name_ar as mfg_name
        FROM users u
        LEFT JOIN manufacturers m ON u.manufacturer_id = m.id
        WHERE u.is_active = 1
    `).all();

    res.json({
        success: true,
        personas: users
    });
});

module.exports = router;
