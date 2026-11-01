const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { authMiddleware, optionalAuthMiddleware, requireRole } = require('../middlewares/auth');
const { findMatchingManufacturer } = require('../services/duplicateDetectionService');
const { serializePublicManufacturer, serializeAdminManufacturer } = require('../utils/authUtils');

// List manufacturers (Privacy-aware serializer separating Public vs Admin)
router.get('/', optionalAuthMiddleware, (req, res) => {
    const db = getDb();
    const { business_model } = req.query;

    const isAdmin = req.user && ['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(req.user.role);
    const isMfgUser = req.user && req.user.role === 'MANUFACTURER';

    // If authenticated user is a Marketing Manufacturer, ONLY return their own manufacturer
    if (isMfgUser) {
        const mfg = db.prepare(`
            SELECT m.*, s.name as subscription_name
            FROM manufacturers m
            LEFT JOIN subscriptions s ON m.subscription_id = s.id
            WHERE m.id = ?
        `).get(req.user.manufacturer_id);

        return res.json({
            success: true,
            manufacturers: mfg ? [serializeAdminManufacturer(mfg)] : []
        });
    }

    // For Super Admin & Logistics Officers: return administrative serialization
    if (isAdmin) {
        let query = `
            SELECT m.*, s.name as subscription_name,
                   (SELECT COUNT(*) FROM products p WHERE p.manufacturer_id = m.id) as products_count
            FROM manufacturers m
            LEFT JOIN subscriptions s ON m.subscription_id = s.id
        `;
        const params = [];

        if (business_model) {
            query += ' WHERE m.business_model = ?';
            params.push(business_model);
        }
        query += ' ORDER BY m.created_at DESC';

        const manufacturers = db.prepare(query).all(...params);
        return res.json({
            success: true,
            manufacturers: manufacturers.map(serializeAdminManufacturer)
        });
    }

    // Public / Unauthenticated callers:
    // Strips business_model, subscription_id, email, phone, and excludes demo records
    const query = `
        SELECT m.*
        FROM manufacturers m
        WHERE (m.is_demo = 0 OR m.is_demo IS NULL)
        ORDER BY m.created_at DESC
    `;
    const manufacturers = db.prepare(query).all();

    res.json({
        success: true,
        manufacturers: manufacturers.map(serializePublicManufacturer)
    });
});

// Get single manufacturer by ID
router.get('/:id', optionalAuthMiddleware, (req, res) => {
    const db = getDb();
    const { id } = req.params;

    const mfg = db.prepare(`
        SELECT m.*, s.name as subscription_name,
               (SELECT COUNT(*) FROM products p WHERE p.manufacturer_id = m.id) as products_count
        FROM manufacturers m
        LEFT JOIN subscriptions s ON m.subscription_id = s.id
        WHERE m.id = ?
    `).get(id);

    if (!mfg) {
        return res.status(404).json({ success: false, error: 'المصنع غير موجود' });
    }

    const isAdmin = req.user && ['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(req.user.role);
    const isOwner = req.user && req.user.role === 'MANUFACTURER' && req.user.manufacturer_id === id;

    if (isAdmin || isOwner) {
        return res.json({
            success: true,
            manufacturer: serializeAdminManufacturer(mfg)
        });
    }

    // Public response: ensure demo records are not exposed to public
    if (mfg.is_demo === 1) {
        return res.status(404).json({ success: false, error: 'المصنع غير موجود' });
    }

    res.json({
        success: true,
        manufacturer: serializePublicManufacturer(mfg)
    });
});

// Suggest matching manufacturer based on document text
router.get('/match', authMiddleware, (req, res) => {
    const { name } = req.query;
    if (!name) {
        return res.json({ success: true, match: null });
    }
    const match = findMatchingManufacturer(name);
    res.json({
        success: true,
        match
    });
});

// Create new manufacturer profile during import (Super Admin / Logistics only)
router.post('/', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), (req, res) => {
    const db = getDb();
    const { name_ar, name_en, code, business_model, subscription_id, city, contact_email, contact_phone } = req.body;

    if (!name_ar || !city || !business_model) {
        return res.status(400).json({
            success: false,
            error: 'يرجى تقديم اسم المصنع بالعربية والمدينة ونموذج العمل'
        });
    }

    // Check duplicate name or code
    const existing = db.prepare(`
        SELECT id, name_ar, code FROM manufacturers 
        WHERE LOWER(name_ar) = LOWER(?) OR LOWER(code) = LOWER(?)
    `).get(name_ar.trim(), (code || '').trim());

    if (existing) {
        return res.status(409).json({
            success: false,
            error: `يوجد بالفعل مصنع مسجل بنفس الاسم أو الكود: "${existing.name_ar}" (كود: ${existing.code})`
        });
    }

    const mfgId = 'mfg_' + crypto.randomBytes(5).toString('hex');
    const autoCode = code ? code.trim().toUpperCase() : 'EGY-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    db.prepare(`
        INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, contact_phone, is_verified, is_demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `).run(
        mfgId,
        name_ar.trim(),
        name_en ? name_en.trim() : name_ar.trim(),
        autoCode,
        business_model,
        subscription_id || (business_model === 'DIRECT_CONTRACT' ? 'sub_enterprise' : 'sub_standard'),
        city.trim(),
        contact_email || null,
        contact_phone || null
    );

    const created = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(mfgId);
    res.status(201).json({
        success: true,
        message: 'تم إنشاء ملف المصنع بنجاح',
        manufacturer: serializeAdminManufacturer(created)
    });
});

module.exports = router;
