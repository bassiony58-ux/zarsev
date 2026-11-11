const express = require('express');
const router = express.Router();
const dbClient = require('../db/dbClient');
const { authMiddleware, optionalAuthMiddleware, isEntityActive } = require('../middlewares/auth');
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
const invitationService = require('../services/invitationService');

// In-memory dual rate limiting:
// 1. Per Email: max 5 failed attempts per 15 minutes
// 2. Per IP: max 20 failed attempts per 15 minutes across any email
const emailAttempts = new Map();
const ipAttempts = new Map();
const MAX_FAILED_PER_EMAIL = 5;
const MAX_FAILED_PER_IP = 20;
const LOCKOUT_PERIOD_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimitMap(map, key, maxAttempts) {
    const record = map.get(key);
    if (!record) return { blocked: false };
    if (record.lockUntil && Date.now() < record.lockUntil) {
        const remainingMinutes = Math.ceil((record.lockUntil - Date.now()) / 60000);
        return { blocked: true, remainingMinutes };
    }
    if (record.lockUntil && Date.now() >= record.lockUntil) {
        map.delete(key);
    }
    return { blocked: false };
}

function recordFailure(map, key, maxAttempts) {
    const record = map.get(key) || { count: 0 };
    record.count += 1;
    if (record.count >= maxAttempts) {
        record.lockUntil = Date.now() + LOCKOUT_PERIOD_MS;
    }
    map.set(key, record);
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
router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({
            success: false,
            error: 'يرجى تقديم البريد الإلكتروني وكلمة المرور'
        });
    }

    const clientIp = (req.ip || req.connection?.remoteAddress || '127.0.0.1').toString().trim();
    const normalizedEmail = email.trim().toLowerCase();

    // Check dual rate limits
    const ipStatus = checkRateLimitMap(ipAttempts, clientIp, MAX_FAILED_PER_IP);
    if (ipStatus.blocked) {
        return res.status(429).json({
            success: false,
            error: `تم حظر هذا العنوان مؤقتاً لتجاوز عدد المحاولات الفاشلة. يرجى المحاولة بعد ${ipStatus.remainingMinutes} دقيقة.`
        });
    }

    const emailStatus = checkRateLimitMap(emailAttempts, normalizedEmail, MAX_FAILED_PER_EMAIL);
    if (emailStatus.blocked) {
        return res.status(429).json({
            success: false,
            error: `تم تجاوز الحد الأقصى لمحاولات الدخول الفاشلة لهذا الحساب. يرجى المحاولة بعد ${emailStatus.remainingMinutes} دقيقة.`
        });
    }

    const dbOpts = req.dbClientOptions || {};
    let user = null;

    try {
        user = await dbClient.queryOne(
            'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
            [normalizedEmail],
            dbOpts
        );
    } catch (err) {
        console.error('[authRoutes] Database error during login query:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء التحقق من بيانات الدخول'
        });
    }

    if (!user || !isEntityActive(user.is_active)) {
        // Run dummy hash check to eliminate timing side-channel user enumeration
        verifyPassword(password, DUMMY_HASH);
        recordFailure(ipAttempts, clientIp, MAX_FAILED_PER_IP);
        recordFailure(emailAttempts, normalizedEmail, MAX_FAILED_PER_EMAIL);
        return res.status(401).json({
            success: false,
            error: 'بيانات الدخول غير صحيحة أو الحساب غير نشط'
        });
    }

    // Timing-safe password verification
    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
        recordFailure(ipAttempts, clientIp, MAX_FAILED_PER_IP);
        recordFailure(emailAttempts, normalizedEmail, MAX_FAILED_PER_EMAIL);
        return res.status(401).json({
            success: false,
            error: 'بيانات الدخول غير صحيحة أو الحساب غير نشط'
        });
    }

    // Successful login: clear failed attempts
    emailAttempts.delete(normalizedEmail);
    ipAttempts.delete(clientIp);

    // Verify manufacturer status if user has MANUFACTURER role
    if (user.role === 'MANUFACTURER') {
        if (!user.manufacturer_id) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_UNLINKED',
                error: 'غير مصرح: حساب المصنع غير مرتبط بمنشأة صالحة'
            });
        }
        let mfg = null;
        try {
            mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
        } catch (mfgErr) {
            console.error('[authRoutes] Error verifying manufacturer status during login:', mfgErr.message);
            return res.status(500).json({
                success: false,
                error: 'خطأ في خادم قاعدة البيانات أثناء التحقق من منشأة المصنع'
            });
        }
        if (!mfg) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_NOT_FOUND',
                error: 'غير مصرح: المنشأة غير مسجلة بالنظام'
            });
        }
        if (mfg.is_active !== undefined && !isEntityActive(mfg.is_active)) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_SUSPENDED',
                error: 'غير مصرح: تم تعليق أو تجميد منشأة المصنع'
            });
        }
    }

    // Concurrency-safe gradual rehash: If hash is legacy or under 210,000 iterations, upgrade seamlessly
    if (needsRehash(user.password_hash)) {
        try {
            const upgradedHash = hashPassword(password);
            // Optimistic concurrency check: only update if password_hash matches what was verified
            await dbClient.execute(
                'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?',
                [upgradedHash, user.id, user.password_hash],
                dbOpts
            );
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

    return res.json({
        success: true,
        token,
        csrf_token: csrfToken,
        user: serializeUser(user)
    });
});

// Dev-only authenticated test login mechanism (SEC-11)
// Strictly disabled and inaccessible unless NOT production AND explicitly enabled via ENABLE_DEV_LOGIN=true!
router.post('/dev-login', async (req, res) => {
    if (config.NODE_ENV === 'production' || process.env.ENABLE_DEV_LOGIN !== 'true') {
        return res.status(404).json({
            success: false,
            error: 'مسار تسجيل الدخول التجريبي غير متاح في هذه البيئة'
        });
    }

    const { user_id } = req.body || {};
    if (!user_id) {
        return res.status(400).json({
            success: false,
            error: 'يرجى تحديد معرف المستخدم'
        });
    }

    const dbOpts = req.dbClientOptions || {};
    let user = null;

    try {
        user = await dbClient.queryOne('SELECT * FROM users WHERE id = ?', [user_id], dbOpts);
    } catch (err) {
        console.error('[authRoutes] Database error during dev-login:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء تسجيل الدخول التجريبي'
        });
    }

    if (!user || !isEntityActive(user.is_active)) {
        return res.status(404).json({
            success: false,
            error: 'المستخدم غير موجود أو غير نشط'
        });
    }

    if (user.role === 'MANUFACTURER') {
        if (!user.manufacturer_id) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_UNLINKED',
                error: 'غير مصرح: حساب المصنع غير مرتبط بمنشأة صالحة'
            });
        }
        let mfg = null;
        try {
            mfg = await dbClient.queryOne('SELECT * FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
        } catch (mfgErr) {
            console.error('[authRoutes] Error verifying manufacturer status during dev-login:', mfgErr.message);
            return res.status(500).json({
                success: false,
                error: 'خطأ في خادم قاعدة البيانات أثناء التحقق من منشأة المصنع'
            });
        }
        if (!mfg) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_NOT_FOUND',
                error: 'غير مصرح: المنشأة غير مسجلة بالنظام'
            });
        }
        if (mfg.is_active !== undefined && !isEntityActive(mfg.is_active)) {
            return res.status(403).json({
                success: false,
                code: 'MANUFACTURER_SUSPENDED',
                error: 'غير مصرح: تم تعليق أو تجميد منشأة المصنع'
            });
        }
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

    return res.json({
        success: true,
        token,
        csrf_token: csrfToken,
        user: serializeUser(user)
    });
});

// Logout endpoint with stateful token invalidation (increments token_version)
router.post('/logout', optionalAuthMiddleware, async (req, res) => {
    if (req.user) {
        try {
            const dbOpts = req.dbClientOptions || {};
            await dbClient.execute(
                'UPDATE users SET token_version = token_version + 1 WHERE id = ?',
                [req.user.id],
                dbOpts
            );
        } catch (err) {
            console.error('Failed to increment token_version during logout:', err);
        }
    }

    res.clearCookie(config.AUTH_COOKIE_NAME);
    res.clearCookie(config.CSRF_COOKIE_NAME);
    return res.json({
        success: true,
        message: 'تم تسجيل الخروج وإبطال جميع الجلسات والرموز السابقة بنجاح'
    });
});

// List available demo personas (strictly dev-only, disabled unless ENABLE_DEV_LOGIN=true)
router.get('/personas', async (req, res) => {
    if (config.NODE_ENV === 'production' || process.env.ENABLE_DEV_LOGIN !== 'true') {
        return res.status(404).json({
            success: false,
            error: 'قائمة الحسابات التجريبية غير متاحة في هذه البيئة'
        });
    }

    const dbOpts = req.dbClientOptions || {};
    const personasQuery = {
        sqlite: `
            SELECT u.id, u.name, u.role, u.manufacturer_id, m.name_ar as mfg_name
            FROM users u
            LEFT JOIN manufacturers m ON u.manufacturer_id = m.id
            WHERE u.is_active = 1
        `,
        postgres: `
            SELECT u.id, u.name, u.role, u.manufacturer_id, m.name_ar as mfg_name
            FROM users u
            LEFT JOIN manufacturers m ON u.manufacturer_id = m.id
            WHERE u.is_active = true
        `
    };

    try {
        const users = await dbClient.queryAll(personasQuery, [], dbOpts);
        return res.json({
            success: true,
            personas: users
        });
    } catch (err) {
        console.error('[authRoutes] Database error during personas fetch:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء استرجاع الحسابات التجريبية'
        });
    }
});

// ==========================================
// INVITATION VERIFICATION & ACCEPTANCE
// ==========================================

// Verify invitation token
router.get('/invitations/verify', async (req, res) => {
    const { token } = req.query || {};
    if (!token) {
        return res.status(400).json({ success: false, error: 'رمز الدعوة مطلوب' });
    }
    const result = await invitationService.verifyInvitationToken(token, req.dbClientOptions || {});
    if (!result.valid) {
        return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({ success: true, invitation: result.invitation });
});

// Accept invitation and create user account
router.post('/invitations/accept', async (req, res) => {
    const { token, full_name, password } = req.body || {};
    const clientIp = req.ip || req.connection?.remoteAddress;
    try {
        const user = await invitationService.acceptInvitation({
            rawToken: token,
            fullName: full_name,
            password,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.status(201).json({
            success: true,
            message: 'تم تفعيل الحساب وقبول الدعوة بنجاح. يمكنك الآن تسجيل الدخول',
            user
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
