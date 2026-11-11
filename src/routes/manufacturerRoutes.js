const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const dbClient = require('../db/dbClient');
const { authMiddleware, optionalAuthMiddleware, requireRole, requireSubRole } = require('../middlewares/auth');
const { jaccardSimilarity, tokenize } = require('../services/duplicateDetectionService');
const { serializePublicManufacturer, serializeAdminManufacturer } = require('../utils/authUtils');
const invitationService = require('../services/invitationService');
const teamService = require('../services/teamService');
const secureDocumentService = require('../services/secureDocumentService');

const docUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

/**
 * Searches existing manufacturers to suggest matching profiles for extracted names.
 * Pure in-memory matcher using tokenization and Jaccard similarity.
 */
function matchManufacturerFromList(extractedName, manufacturers) {
    if (!extractedName || extractedName.length < 2) return null;
    const tokensNew = tokenize(extractedName);

    let bestMatch = null;
    let highestScore = 0;

    for (const mfg of manufacturers) {
        const tokensAr = tokenize(mfg.name_ar || '');
        const tokensEn = tokenize(mfg.name_en || '');
        const simAr = jaccardSimilarity(tokensNew, tokensAr);
        const simEn = jaccardSimilarity(tokensNew, tokensEn);
        const score = Math.max(simAr, simEn);

        // Check if distinctive root tokens match (e.g. 'بستان', 'نيل', 'دمياط')
        const hasDistinctiveKeyword = Array.from(tokensNew).some(t => t.length >= 4 && (tokensAr.has(t) || tokensEn.has(t)));

        const effectiveScore = Math.max(score, hasDistinctiveKeyword ? 0.65 : score);

        if (effectiveScore > highestScore && effectiveScore >= 0.25) {
            highestScore = effectiveScore;
            bestMatch = {
                ...mfg,
                match_confidence: effectiveScore
            };
        }
    }

    return bestMatch;
}

// List manufacturers (Privacy-aware serializer separating Public vs Admin)
router.get('/', optionalAuthMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const { business_model } = req.query || {};

    const isAdmin = req.user && ['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(req.user.role);
    const isMfgUser = req.user && req.user.role === 'MANUFACTURER';

    try {
        // If authenticated user is a Marketing Manufacturer, ONLY return their own manufacturer
        if (isMfgUser) {
            // Missing manufacturer_id must fail closed; never fall back to unrestricted listing
            if (!req.user.manufacturer_id) {
                return res.json({
                    success: true,
                    manufacturers: []
                });
            }

            const mfg = await dbClient.queryOne(`
                SELECT m.*, s.name as subscription_name
                FROM manufacturers m
                LEFT JOIN subscriptions s ON m.subscription_id = s.id
                WHERE m.id = ?
            `, [req.user.manufacturer_id], dbOpts);

            return res.json({
                success: true,
                manufacturers: mfg ? [serializeAdminManufacturer(mfg)] : []
            });
        }

        // For Super Admin & Logistics Officers: return administrative serialization
        if (isAdmin) {
            const adminQuery = {
                sqlite: `
                    SELECT m.*, s.name as subscription_name,
                           (SELECT COUNT(*) FROM products p WHERE p.manufacturer_id = m.id) as products_count
                    FROM manufacturers m
                    LEFT JOIN subscriptions s ON m.subscription_id = s.id
                    ${business_model ? 'WHERE m.business_model = ?' : ''}
                    ORDER BY m.created_at DESC
                `,
                postgres: `
                    SELECT m.*, s.name as subscription_name,
                           (SELECT COUNT(*)::int FROM products p WHERE p.manufacturer_id = m.id) as products_count
                    FROM manufacturers m
                    LEFT JOIN subscriptions s ON m.subscription_id = s.id
                    ${business_model ? 'WHERE m.business_model = $1' : ''}
                    ORDER BY m.created_at DESC
                `
            };
            const params = business_model ? [business_model] : [];
            const manufacturers = await dbClient.queryAll(adminQuery, params, dbOpts);

            return res.json({
                success: true,
                manufacturers: manufacturers.map(serializeAdminManufacturer)
            });
        }

        // Public / Unauthenticated callers:
        // Strips business_model, subscription_id, email, phone, and excludes demo records
        const publicQuery = {
            sqlite: `
                SELECT m.*
                FROM manufacturers m
                WHERE (m.is_demo = 0 OR m.is_demo IS NULL)
                ORDER BY m.created_at DESC
            `,
            postgres: `
                SELECT m.*
                FROM manufacturers m
                WHERE (m.is_demo = false OR m.is_demo IS NULL)
                ORDER BY m.created_at DESC
            `
        };
        const manufacturers = await dbClient.queryAll(publicQuery, [], dbOpts);

        return res.json({
            success: true,
            manufacturers: manufacturers.map(serializePublicManufacturer)
        });
    } catch (err) {
        console.error('[manufacturerRoutes] GET / error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء استرجاع قائمة المصانع'
        });
    }
});

// Suggest matching manufacturer based on document text (Must be defined BEFORE /:id route)
router.get('/match', authMiddleware, async (req, res) => {
    const { name } = req.query || {};
    if (!name) {
        return res.json({ success: true, match: null });
    }
    const dbOpts = req.dbClientOptions || {};

    try {
        const matchQuery = {
            sqlite: `
                SELECT id, name_ar, name_en, code, business_model 
                FROM manufacturers 
                WHERE (is_demo = 0 OR is_demo IS NULL)
            `,
            postgres: `
                SELECT id, name_ar, name_en, code, business_model 
                FROM manufacturers 
                WHERE (is_demo = false OR is_demo IS NULL)
            `
        };
        const manufacturers = await dbClient.queryAll(matchQuery, [], dbOpts);
        const match = matchManufacturerFromList(name, manufacturers);

        if (!match) {
            return res.json({
                success: true,
                match: null
            });
        }

        // Role-based field sanitization:
        // SUPER_ADMIN and LOGISTICS_OFFICER may receive business_model for administrative workflows.
        // MANUFACTURER role must strictly NOT receive business_model or any other private field.
        const isAdmin = req.user && ['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(req.user.role);
        const sanitizedMatch = {
            id: match.id,
            name_ar: match.name_ar,
            name_en: match.name_en,
            code: match.code,
            match_confidence: match.match_confidence
        };

        if (isAdmin) {
            sanitizedMatch.business_model = match.business_model;
        }

        return res.json({
            success: true,
            match: sanitizedMatch
        });
    } catch (err) {
        console.error('[manufacturerRoutes] GET /match error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء البحث عن المصنع المطابق'
        });
    }
});

// ==========================================
// MANUFACTURER TEAM MANAGEMENT ENDPOINTS
// ==========================================

// 1. GET /api/manufacturer/team
router.get('/team', authMiddleware, requireSubRole(['OWNER']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const data = await teamService.listTeamMembers(mfgId, req.dbClientOptions || {});
        return res.json({ success: true, ...data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 2. POST /api/manufacturer/team/invite
router.post('/team/invite', authMiddleware, requireSubRole(['OWNER']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const { email, sub_role } = req.body || {};
        const clientIp = req.ip || req.connection?.remoteAddress;
        const invite = await invitationService.createInvitation({
            manufacturerId: mfgId,
            invitedByUserId: req.user.id,
            email,
            subRole: sub_role,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.status(201).json({
            success: true,
            message: 'تم إنشاء وإرسال الدعوة بنجاح',
            invitation: invite
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 3. DELETE /api/manufacturer/team/invitations/:id
router.delete('/team/invitations/:id', authMiddleware, requireSubRole(['OWNER']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const clientIp = req.ip || req.connection?.remoteAddress;
        await invitationService.revokeInvitation({
            invitationId: req.params.id,
            manufacturerId: mfgId,
            actorId: req.user.id,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.json({ success: true, message: 'تم إلغاء الدعوة بنجاح' });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 4. PATCH /api/manufacturer/team/users/:id/role
router.patch('/team/users/:id/role', authMiddleware, requireSubRole(['OWNER']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const { sub_role } = req.body || {};
        const clientIp = req.ip || req.connection?.remoteAddress;
        const updated = await teamService.changeMemberSubRole({
            manufacturerId: mfgId,
            actorId: req.user.id,
            targetUserId: req.params.id,
            newSubRole: sub_role,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.json({ success: true, message: 'تم تحديث الدور الفرعي بنجاح', user: updated });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 5. PATCH /api/manufacturer/team/users/:id/status
router.patch('/team/users/:id/status', authMiddleware, requireSubRole(['OWNER']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const { is_active } = req.body || {};
        const clientIp = req.ip || req.connection?.remoteAddress;
        const updated = await teamService.setMemberStatus({
            manufacturerId: mfgId,
            actorId: req.user.id,
            targetUserId: req.params.id,
            isActive: Boolean(is_active),
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.json({ success: true, message: 'تم تحديث حالة المستخدم بنجاح', user: updated });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 6. POST /api/manufacturer/team/transfer-ownership
router.post('/team/transfer-ownership', authMiddleware, requireSubRole(['OWNER']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const { target_user_id, password, demoted_role } = req.body || {};
        const clientIp = req.ip || req.connection?.remoteAddress;
        const result = await teamService.transferOwnership({
            manufacturerId: mfgId,
            currentOwnerId: req.user.id,
            targetUserId: target_user_id,
            currentOwnerPassword: password,
            demotedRole: demoted_role,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.json({ success: true, message: 'تم نقل ملكية المنشأة بنجاح', ...result });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// ==========================================
// SECURE DOCUMENT MANAGEMENT ENDPOINTS
// ==========================================

// 7. GET /api/manufacturer/documents
router.get('/documents', authMiddleware, requireSubRole(['OWNER', 'EXPORT']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const docs = await secureDocumentService.listDocuments(mfgId, req.user.sub_role, req.dbClientOptions || {});
        return res.json({ success: true, documents: docs });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 8. POST /api/manufacturer/documents
router.post('/documents', authMiddleware, requireSubRole(['OWNER', 'EXPORT']), docUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'لم يتم إرسال أي ملف للرفع' });
        }
        const mfgId = req.user.manufacturer_id;
        const { doc_type, title } = req.body || {};
        const clientIp = req.ip || req.connection?.remoteAddress;
        const doc = await secureDocumentService.uploadDocument({
            manufacturerId: mfgId,
            userId: req.user.id,
            userSubRole: req.user.sub_role,
            docType: doc_type,
            title,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            fileBuffer: req.file.buffer,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });
        return res.status(201).json({ success: true, message: 'تم رفع المستند وتأمينه بنجاح', document: doc });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 9. GET /api/manufacturer/documents/:id/download
router.get('/documents/:id/download', authMiddleware, requireSubRole(['OWNER', 'EXPORT']), async (req, res) => {
    try {
        const mfgId = req.user.manufacturer_id;
        const clientIp = req.ip || req.connection?.remoteAddress;
        const docInfo = await secureDocumentService.getDocumentForDownload({
            docId: req.params.id,
            manufacturerId: mfgId,
            userSubRole: req.user.sub_role,
            userId: req.user.id,
            ipAddress: clientIp,
            dbOpts: req.dbClientOptions || {}
        });

        // Set hardened security headers
        res.setHeader('Content-Type', docInfo.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(docInfo.originalName)}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

        const stream = fs.createReadStream(docInfo.filePath);
        stream.pipe(res);
    } catch (err) {
        return res.status(403).json({ success: false, error: err.message });
    }
});


// Get single manufacturer by ID
router.get('/:id', optionalAuthMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const singleQuery = {
            sqlite: `
                SELECT m.*, s.name as subscription_name,
                       (SELECT COUNT(*) FROM products p WHERE p.manufacturer_id = m.id) as products_count
                FROM manufacturers m
                LEFT JOIN subscriptions s ON m.subscription_id = s.id
                WHERE m.id = ?
            `,
            postgres: `
                SELECT m.*, s.name as subscription_name,
                       (SELECT COUNT(*)::int FROM products p WHERE p.manufacturer_id = m.id) as products_count
                FROM manufacturers m
                LEFT JOIN subscriptions s ON m.subscription_id = s.id
                WHERE m.id = $1
            `
        };
        const mfg = await dbClient.queryOne(singleQuery, [id], dbOpts);

        if (!mfg) {
            return res.status(404).json({ success: false, error: 'المصنع غير موجود' });
        }

        const isAdmin = req.user && ['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(req.user.role);
        const isOwner = req.user && req.user.role === 'MANUFACTURER' && Boolean(req.user.manufacturer_id) && req.user.manufacturer_id === id;

        if (isAdmin || isOwner) {
            return res.json({
                success: true,
                manufacturer: serializeAdminManufacturer(mfg)
            });
        }

        // Public response: ensure demo records are not exposed to public
        const isDemo = typeof mfg.is_demo === 'boolean'
            ? mfg.is_demo === true
            : Number(mfg.is_demo) === 1;

        if (isDemo) {
            return res.status(404).json({ success: false, error: 'المصنع غير موجود' });
        }

        return res.json({
            success: true,
            manufacturer: serializePublicManufacturer(mfg)
        });
    } catch (err) {
        console.error('[manufacturerRoutes] GET /:id error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء استرجاع بيانات المصنع'
        });
    }
});

// Create new manufacturer profile during import (Super Admin / Logistics only)
router.post('/', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const { name_ar, name_en, code, business_model, subscription_id, city, contact_email, contact_phone } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    if (!name_ar || !city || !business_model) {
        return res.status(400).json({
            success: false,
            error: 'يرجى تقديم اسم المصنع بالعربية والمدينة ونموذج العمل'
        });
    }

    try {
        // Check duplicate name or code
        const existing = await dbClient.queryOne(`
            SELECT id, name_ar, code FROM manufacturers 
            WHERE LOWER(name_ar) = LOWER(?) OR LOWER(code) = LOWER(?)
        `, [name_ar.trim(), (code || '').trim()], dbOpts);

        if (existing) {
            return res.status(409).json({
                success: false,
                error: `يوجد بالفعل مصنع مسجل بنفس الاسم أو الكود: "${existing.name_ar}" (كود: ${existing.code})`
            });
        }

        const mfgId = 'mfg_' + crypto.randomBytes(5).toString('hex');
        const autoCode = code ? code.trim().toUpperCase() : 'EGY-' + crypto.randomBytes(3).toString('hex').toUpperCase();

        const insertSql = `
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, city, contact_email, contact_phone, is_verified, is_demo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, true, false)
        `;

        let created = null;
        await dbClient.transaction(async (tx) => {
            await tx.execute(insertSql, [
                mfgId,
                name_ar.trim(),
                name_en ? name_en.trim() : name_ar.trim(),
                autoCode,
                business_model,
                subscription_id || (business_model === 'DIRECT_CONTRACT' ? 'sub_enterprise' : 'sub_standard'),
                city.trim(),
                contact_email || null,
                contact_phone || null
            ]);
            created = await tx.queryOne('SELECT * FROM manufacturers WHERE id = ?', [mfgId]);
        }, dbOpts);

        return res.status(201).json({
            success: true,
            message: 'تم إنشاء ملف المصنع بنجاح',
            manufacturer: serializeAdminManufacturer(created)
        });
    } catch (err) {
        console.error('[manufacturerRoutes] POST / error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء إنشاء ملف المصنع'
        });
    }
});

router.matchManufacturerFromList = matchManufacturerFromList;
module.exports = router;
