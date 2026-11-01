const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middlewares/auth');

// Get current user and active role
router.get('/me', authMiddleware, (req, res) => {
    res.json({
        success: true,
        user: req.user,
        manufacturer: req.manufacturer,
        subscription: req.subscription || null
    });
});

// List available demo personas for easy UI switching
router.get('/personas', (req, res) => {
    const db = getDb();
    const users = db.prepare(`
        SELECT u.id, u.name, u.email, u.role, u.manufacturer_id, m.name_ar as mfg_name, m.business_model
        FROM users u
        LEFT JOIN manufacturers m ON u.manufacturer_id = m.id
    `).all();

    res.json({
        success: true,
        personas: users
    });
});

module.exports = router;
