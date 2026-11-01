const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middlewares/auth');
const { generateToken, verifyPassword, serializeUser, serializeAdminManufacturer } = require('../utils/authUtils');
const config = require('../config');

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

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());

    if (!user || user.is_active !== 1) {
        return res.status(401).json({
            success: false,
            error: 'بيانات الدخول غير صحيحة أو الحساب غير نشط'
        });
    }

    // Check password
    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({
            success: false,
            error: 'بيانات الدخول غير صحيحة أو الحساب غير نشط'
        });
    }

    const token = generateToken(user);

    // Set secure HTTP-only cookie
    res.cookie(config.AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    res.json({
        success: true,
        token,
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

    res.cookie(config.AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    res.json({
        success: true,
        token,
        user: serializeUser(user)
    });
});

// Logout endpoint
router.post('/logout', (req, res) => {
    res.clearCookie(config.AUTH_COOKIE_NAME);
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
