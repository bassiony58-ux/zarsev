/**
 * src/routes/rfqRoutes.js
 * 
 * Commercial RFQ (Request for Quote) & Inquiry Management API for ZARSEV Global Trade Platform.
 * 
 * Features:
 * - Public Buyer RFQ Submission with Rate Limiting & Published Product Validation
 * - Role-Based Listing with Strict Tenant Isolation (Manufacturers cannot access unrelated RFQs)
 * - Workflow Status State Transitions & Auditing
 * - Contact Form Inquiries Management
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const { authMiddleware, requireRole, requireSubRole } = require('../middlewares/auth');
const notificationService = require('../services/notificationService');

// In-Memory Rate Limiting for Public Submissions: 15 submissions per 15 minutes per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 15;

function checkRateLimit(req) {
    const ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const clientData = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };

    if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    } else {
        clientData.count++;
    }

    rateLimitMap.set(ip, clientData);
    return clientData.count <= RATE_LIMIT_MAX_REQUESTS;
}

// In-Memory Rate Limiting for Buyer Tracking: 30 requests per 10 minutes per IP
const trackRateLimitMap = new Map();
const TRACK_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const TRACK_RATE_LIMIT_MAX = 30;

function checkTrackRateLimit(req) {
    const ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const clientData = trackRateLimitMap.get(ip) || { count: 0, resetTime: now + TRACK_RATE_LIMIT_WINDOW_MS };

    if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + TRACK_RATE_LIMIT_WINDOW_MS;
    } else {
        clientData.count++;
    }

    trackRateLimitMap.set(ip, clientData);
    return clientData.count <= TRACK_RATE_LIMIT_MAX;
}

/**
 * Constant-time cryptographic comparison of buyer token against stored SHA-256 hash.
 * Protects against timing side-channel attacks (SEC-06) and relies strictly on hashed storage.
 */
function safeCompareToken(inputToken, storedHash) {
    if (!inputToken || typeof inputToken !== 'string') return false;
    const cleanInput = inputToken.trim();
    if (!cleanInput) return false;

    if (!storedHash || typeof storedHash !== 'string' || storedHash.length !== 64) {
        return false;
    }

    try {
        const inputDigest = crypto.createHash('sha256').update(cleanInput).digest();
        const storedDigest = Buffer.from(storedHash, 'hex');
        if (storedDigest.length === inputDigest.length) {
            return crypto.timingSafeEqual(inputDigest, storedDigest);
        }
    } catch (_) {}

    return false;
}

function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/[<>]/g, '');
}

function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const ALLOWED_STATUSES = [
    'NEW',
    'UNDER_REVIEW',
    'SENT_TO_MANUFACTURER',
    'QUOTED',
    'ACCEPTED',
    'REJECTED',
    'CLOSED'
];

/**
 * 1. POST /api/rfqs
 * Public Buyer RFQ Submission Endpoint
 */
router.post('/', async (req, res) => {
    // 1. Rate Limiting Check
    if (!checkRateLimit(req)) {
        return res.status(429).json({
            success: false,
            error: 'تم تجاوز الحد المسموح به لإرسال الطلبات مؤقتاً. يرجى المحاولة بعد 15 دقيقة.'
        });
    }

    const {
        buyer_name,
        company_name,
        business_email,
        phone,
        country,
        product_id,
        requested_quantity,
        unit_of_measurement,
        destination_country,
        destination_port,
        required_specifications,
        additional_message
    } = req.body || {};

    // 2. Input Validation
    const cleanBuyerName = sanitizeText(buyer_name);
    const cleanCompanyName = sanitizeText(company_name);
    const cleanEmail = (business_email || '').trim().toLowerCase();
    const cleanPhone = sanitizeText(phone);
    const cleanCountry = sanitizeText(country);
    const cleanProductId = (product_id || '').trim();
    const cleanDestCountry = sanitizeText(destination_country);
    const cleanDestPort = sanitizeText(destination_port);
    const cleanUnit = sanitizeText(unit_of_measurement) || 'MT';
    const cleanMessage = sanitizeText(additional_message);
    const numQty = parseFloat(requested_quantity);

    if (!cleanBuyerName || cleanBuyerName.length < 2) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال اسم المشتري أو المسؤول التجاري بشكل صحيح' });
    }
    if (!cleanCompanyName || cleanCompanyName.length < 2) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال اسم الشركة أو المؤسسة المستوردة' });
    }
    if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال بريد إلكتروني رسمي صالح للتواصل التجاري' });
    }
    if (!cleanPhone || cleanPhone.length < 5) {
        return res.status(400).json({ success: false, error: 'يرجى تقديم رقم هاتف أو واتساب تجاري صحيح' });
    }
    if (!cleanCountry) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد دولة المشتري / المقر' });
    }
    if (!cleanProductId) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد المنتج المطلوب للاستيراد' });
    }
    if (isNaN(numQty) || numQty <= 0) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال كمية استيراد صحيحة أكبر من الصفر' });
    }
    if (!cleanDestCountry) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد دولة الوصول أو ميناء التفريغ المطلوب' });
    }

    const dbOpts = req.dbClientOptions || {};

    try {
        // 3. Product Validation: MUST exist and MUST be 'PUBLISHED'
        const product = await dbClient.queryOne(
            'SELECT id, name_ar, name_en, sku, manufacturer_id, status FROM products WHERE id = ?',
            [cleanProductId],
            dbOpts
        );

        if (!product) {
            return res.status(404).json({
                success: false,
                error: 'المنتج المطلوب غير موجود بالمنظومة'
            });
        }

        if (product.status !== 'PUBLISHED') {
            return res.status(400).json({
                success: false,
                error: 'عفواً، هذا الصنف غير متاح حالياً لطلبات التصدير أو قيد تدقيق المواصفات'
            });
        }

        // Fetch manufacturer
        const manufacturer = await dbClient.queryOne(
            'SELECT id, name_ar, name_en, code FROM manufacturers WHERE id = ?',
            [product.manufacturer_id],
            dbOpts
        );

        // 4. Generate Identifiers
        const rfqId = 'rfq_' + crypto.randomBytes(8).toString('hex');
        const refYear = new Date().getFullYear();
        const refCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        const referenceNo = `RFQ-${refYear}-${refCode}`;
        const buyerAccessToken = crypto.randomBytes(24).toString('hex');
        const buyerAccessTokenHash = crypto.createHash('sha256').update(buyerAccessToken).digest('hex');

        let specsJson = {};
        if (required_specifications && typeof required_specifications === 'object') {
            specsJson = required_specifications;
        } else if (typeof required_specifications === 'string' && required_specifications.trim()) {
            try {
                specsJson = JSON.parse(required_specifications);
            } catch (_) {
                specsJson = { raw_requirements: required_specifications.trim() };
            }
        }

        // 5. Database Transaction (Atomic Persistence)
        // Store only the cryptographic SHA-256 hash at rest (SEC-01).
        await dbClient.transaction(async (tx) => {
            const isPg = tx.engine === 'postgres';
            const specsVal = isPg ? specsJson : JSON.stringify(specsJson);

            await tx.execute(`
                INSERT INTO rfqs (
                    id, reference_no, buyer_access_token, buyer_access_token_hash, buyer_name, company_name, business_email,
                    phone, country, product_id, manufacturer_id, requested_quantity,
                    unit_of_measurement, destination_country, destination_port,
                    required_specifications, additional_message, status
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW')
            `, [
                rfqId,
                referenceNo,
                buyerAccessTokenHash,
                cleanBuyerName,
                cleanCompanyName,
                cleanEmail,
                cleanPhone,
                cleanCountry,
                product.id,
                product.manufacturer_id,
                numQty,
                cleanUnit,
                cleanDestCountry,
                cleanDestPort || null,
                specsVal,
                cleanMessage || null
            ]);

            const metaVal = isPg
                ? { source_ip: req.ip, user_agent: req.headers['user-agent'] }
                : JSON.stringify({ source_ip: req.ip, user_agent: req.headers['user-agent'] });

            await tx.execute(`
                INSERT INTO rfq_audit_logs (
                    rfq_id, action, from_status, to_status, notes, metadata
                ) VALUES (?, 'SUBMIT', NULL, 'NEW', 'تم استلام طلب التسعير وتوثيقه بالمنظومة', ?)
            `, [rfqId, metaVal]);
        }, dbOpts);

        // 6. Notification Service Trigger
        const rfqRecord = {
            id: rfqId,
            reference_no: referenceNo,
            buyer_name: cleanBuyerName,
            company_name: cleanCompanyName,
            business_email: cleanEmail,
            requested_quantity: numQty,
            unit_of_measurement: cleanUnit,
            destination_country: cleanDestCountry,
            destination_port: cleanDestPort
        };
        await notificationService.notifyRfqSubmitted(rfqRecord, product, manufacturer || {});

        return res.status(201).json({
            success: true,
            message: 'تم إرسال طلب عرض السعر بنجاح وتم تسجيله برقم مرجعي معتمد',
            reference_no: referenceNo,
            rfq_id: rfqId,
            buyer_access_token: buyerAccessToken,
            status: 'NEW'
        });

    } catch (err) {
        console.error('[rfqRoutes] POST / error:', err);
        return res.status(500).json({
            success: false,
            error: 'خطأ في خادم قاعدة البيانات أثناء تسجيل طلب عرض السعر'
        });
    }
});

/**
 * 1.5 GET /api/rfqs/track
 * Secure Buyer Tracking: Lookup an RFQ and its structured quotations.
 * Strictly secured by reference_no and mandatory cryptographic buyer_access_token (SEC-03, SEC-06, SEC-07).
 */
router.get('/track', async (req, res) => {
    // 1. Rate Limiting Check (SEC-07)
    if (!checkTrackRateLimit(req)) {
        return res.status(429).json({
            success: false,
            error: 'تم تجاوز الحد المسموح به لطلبات التتبع مؤقتاً. يرجى المحاولة بعد قليل.'
        });
    }

    const { ref, token, email } = req.query;
    const dbOpts = req.dbClientOptions || {};

    if (!ref || !ref.trim()) {
        return res.status(400).json({
            success: false,
            error: 'يلزم تقديم الرقم المرجعي (ref) للاستعلام عن الطلب'
        });
    }

    // Secret Token is MANDATORY (SEC-03: Email alone can never bypass token authentication)
    if (!token || !token.trim()) {
        return res.status(401).json({
            success: false,
            error: 'رمز التحقق الأمني الخاص بالمشتري (token) إلزامي للوصول إلى تفاصيل الطلب وعروض الأسعار'
        });
    }

    try {
        const rfq = await dbClient.queryOne(`
            SELECT r.id, r.reference_no, r.buyer_name, r.company_name, r.business_email, r.phone, r.country,
                   r.product_id, r.manufacturer_id, r.assigned_manufacturer_id, r.requested_quantity,
                   r.unit_of_measurement, r.destination_country, r.destination_port, r.required_specifications,
                   r.additional_message, r.status, r.created_at, r.updated_at,
                   r.buyer_access_token_hash,
                   p.name_ar as product_name_ar, p.name_en as product_name_en, p.sku as product_sku,
                   m.name_ar as manufacturer_name_ar, m.code as manufacturer_code
            FROM rfqs r
            JOIN products p ON r.product_id = p.id
            JOIN manufacturers m ON r.manufacturer_id = m.id
            WHERE r.reference_no = ?
        `, [ref.trim()], dbOpts);

        if (!rfq) {
            return res.status(404).json({ success: false, error: 'طلب عرض السعر غير موجود' });
        }

        // Timing-Safe Credential Verification against SHA-256 hash strictly (SEC-06)
        const tokenMatch = safeCompareToken(token, rfq.buyer_access_token_hash);
        if (!tokenMatch) {
            return res.status(403).json({
                success: false,
                error: 'رمز التحقق الأمني غير مطابق لهذا الطلب'
            });
        }

        // Optional secondary email verification if supplied
        if (email && rfq.business_email && email.trim().toLowerCase() !== rfq.business_email.toLowerCase()) {
            return res.status(403).json({
                success: false,
                error: 'البريد الإلكتروني غير مطابق لهذا الطلب'
            });
        }

        // Fetch any submitted quotations for this RFQ
        let quotations = [];
        try {
            quotations = await dbClient.queryAll(`
                SELECT q.id, q.reference_no, q.rfq_id, q.manufacturer_id, q.unit_price, q.currency,
                       q.incoterm, q.loading_port, q.destination_port, q.min_order_quantity, q.min_order_unit,
                       q.lead_time_days, q.packaging_details, q.payment_terms, q.validity_date,
                       q.additional_terms, q.status, q.buyer_decision_at, q.buyer_decision_notes,
                       q.created_at, q.updated_at,
                       m.name_ar as manufacturer_name_ar
                FROM quotations q
                JOIN manufacturers m ON q.manufacturer_id = m.id
                WHERE q.rfq_id = ?
                ORDER BY q.created_at DESC
            `, [rfq.id], dbOpts);
        } catch (_) {
            // quotations table may not exist in non-migrated engines
        }

        // Find active quotation (SUBMITTED, ACCEPTED, or REJECTED)
        const activeQuotation = quotations.find(q => ['SUBMITTED', 'ACCEPTED', 'REJECTED'].includes(q.status)) || null;

        // Strip sensitive internal fields before returning to buyer
        const buyerSafeRfq = {
            id: rfq.id,
            reference_no: rfq.reference_no,
            buyer_name: rfq.buyer_name,
            company_name: rfq.company_name,
            business_email: rfq.business_email,
            product_name_ar: rfq.product_name_ar,
            product_name_en: rfq.product_name_en,
            product_sku: rfq.product_sku,
            requested_quantity: rfq.requested_quantity,
            unit_of_measurement: rfq.unit_of_measurement,
            destination_country: rfq.destination_country,
            destination_port: rfq.destination_port,
            required_specifications: rfq.required_specifications,
            additional_message: rfq.additional_message,
            status: rfq.status,
            manufacturer_name_ar: rfq.manufacturer_name_ar,
            created_at: rfq.created_at,
            updated_at: rfq.updated_at
        };

        return res.json({
            success: true,
            rfq: buyerSafeRfq,
            quotation: activeQuotation,
            quotation_history: quotations
        });

    } catch (err) {
        console.error('[rfqRoutes] GET /track error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في قاعدة البيانات أثناء تتبع الطلب' });
    }
});

/**
 * 2. GET /api/rfqs
 * Authorized RFQ Listing with Strict Tenant Isolation
 */
router.get('/', authMiddleware, requireSubRole(['OWNER', 'SALES', 'EXPORT'], { allowRoles: ['SUPER_ADMIN', 'LOGISTICS_OFFICER'] }), async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const { status, country, product_id, manufacturer_id, search, limit = 50, page = 1 } = req.query;

    try {
        // Projection strictly excludes buyer_access_token and buyer_access_token_hash (SEC-02)
        let sql = `
            SELECT r.id, r.reference_no, r.buyer_name, r.company_name, r.business_email, r.phone, r.country,
                   r.product_id, r.manufacturer_id, r.assigned_manufacturer_id, r.requested_quantity,
                   r.unit_of_measurement, r.destination_country, r.destination_port, r.required_specifications,
                   r.additional_message, r.status, r.internal_notes, r.is_demo, r.created_at, r.updated_at,
                   p.name_ar as product_name_ar, p.name_en as product_name_en, p.sku as product_sku,
                   m.name_ar as manufacturer_name_ar, m.code as manufacturer_code,
                   am.name_ar as assigned_mfg_name_ar
            FROM rfqs r
            JOIN products p ON r.product_id = p.id
            JOIN manufacturers m ON r.manufacturer_id = m.id
            LEFT JOIN manufacturers am ON r.assigned_manufacturer_id = am.id
            WHERE 1=1
        `;
        const params = [];

        // STRICT TENANT ISOLATION GUARD:
        // MANUFACTURER role can ONLY view RFQs assigned to their own manufacturer profile!
        if (user.role === 'MANUFACTURER') {
            if (!user.manufacturer_id) {
                return res.json({ success: true, rfqs: [], total: 0 });
            }
            sql += ` AND (r.assigned_manufacturer_id = ? OR (r.manufacturer_id = ? AND r.assigned_manufacturer_id IS NULL))`;
            params.push(user.manufacturer_id, user.manufacturer_id);
        } else if (['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(user.role)) {
            // Administrative filters
            if (manufacturer_id) {
                sql += ` AND (r.manufacturer_id = ? OR r.assigned_manufacturer_id = ?)`;
                params.push(manufacturer_id, manufacturer_id);
            }
        } else {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بالوصول لطلبات التسعير' });
        }

        // Common Filters
        if (status && ALLOWED_STATUSES.includes(status)) {
            sql += ` AND r.status = ?`;
            params.push(status);
        }
        if (country) {
            sql += ` AND (LOWER(r.destination_country) = LOWER(?) OR LOWER(r.country) = LOWER(?))`;
            params.push(country.trim(), country.trim());
        }
        if (product_id) {
            sql += ` AND r.product_id = ?`;
            params.push(product_id.trim());
        }
        if (search && search.trim()) {
            const term = `%${search.trim().toLowerCase()}%`;
            sql += ` AND (LOWER(r.reference_no) LIKE ? OR LOWER(r.company_name) LIKE ? OR LOWER(r.buyer_name) LIKE ? OR LOWER(r.business_email) LIKE ?)`;
            params.push(term, term, term, term);
        }

        sql += ` ORDER BY r.created_at DESC`;

        const rfqs = await dbClient.queryAll(sql, params, dbOpts);

        // Sanitize for Manufacturer role:
        // If necessary, redact buyer direct contact phone or email if platform mediation is enforced,
        // or deliver complete details if manufacturer communicates directly.
        return res.json({
            success: true,
            total: rfqs.length,
            rfqs
        });

    } catch (err) {
        console.error('[rfqRoutes] GET / error:', err);
        return res.status(500).json({
            success: false,
            error: 'خطأ في قاعدة البيانات أثناء استرجاع طلبات التسعير'
        });
    }
});

/**
 * 3. GET /api/rfqs/:id
 * Retrieve Single RFQ with Permission Check and Complete Audit Trail
 */
router.get('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};

    try {
        // Projection strictly excludes buyer_access_token and buyer_access_token_hash (SEC-02)
        const sql = `
            SELECT r.id, r.reference_no, r.buyer_name, r.company_name, r.business_email, r.phone, r.country,
                   r.product_id, r.manufacturer_id, r.assigned_manufacturer_id, r.requested_quantity,
                   r.unit_of_measurement, r.destination_country, r.destination_port, r.required_specifications,
                   r.additional_message, r.status, r.internal_notes, r.is_demo, r.created_at, r.updated_at,
                   p.name_ar as product_name_ar, p.name_en as product_name_en, p.sku as product_sku, p.price as product_base_price, p.currency as product_currency,
                   m.name_ar as manufacturer_name_ar, m.city as manufacturer_city,
                   am.name_ar as assigned_mfg_name_ar
            FROM rfqs r
            JOIN products p ON r.product_id = p.id
            JOIN manufacturers m ON r.manufacturer_id = m.id
            LEFT JOIN manufacturers am ON r.assigned_manufacturer_id = am.id
            WHERE r.id = ? OR r.reference_no = ?
        `;
        const rfq = await dbClient.queryOne(sql, [id, id], dbOpts);

        if (!rfq) {
            return res.status(404).json({ success: false, error: 'طلب عرض السعر غير موجود' });
        }

        // TENANT ISOLATION CHECK
        if (user.role === 'MANUFACTURER') {
            const isAssigned = rfq.assigned_manufacturer_id === user.manufacturer_id;
            const isDirectMfg = rfq.manufacturer_id === user.manufacturer_id;
            if (!isAssigned && !isDirectMfg) {
                return res.status(403).json({
                    success: false,
                    error: 'غير مصرح: لا يمكنك استعراض طلب تسعير مخصص لمنشأة تصديرية أخرى'
                });
            }
        }

        // Fetch complete audit logs
        const auditLogs = await dbClient.queryAll(`
            SELECT al.*, u.name as user_name, u.role as user_role
            FROM rfq_audit_logs al
            LEFT JOIN users u ON al.changed_by_user_id = u.id
            WHERE al.rfq_id = ?
            ORDER BY al.created_at ASC
        `, [rfq.id], dbOpts);

        return res.json({
            success: true,
            rfq,
            audit_logs: auditLogs
        });

    } catch (err) {
        console.error('[rfqRoutes] GET /:id error:', err);
        return res.status(500).json({
            success: false,
            error: 'خطأ في قاعدة البيانات أثناء جلب تفاصيل الطلب'
        });
    }
});

/**
 * 4. PATCH /api/rfqs/:id/status
 * Update Workflow Status, Route to Manufacturer, and Record Audit Event
 */
router.patch('/:id/status', authMiddleware, requireSubRole(['OWNER', 'SALES'], { allowRoles: ['SUPER_ADMIN', 'LOGISTICS_OFFICER'] }), async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const { status, assigned_manufacturer_id, internal_notes, action_note, notes } = req.body || {};

    try {
        const rfq = await dbClient.queryOne('SELECT * FROM rfqs WHERE id = ? OR reference_no = ?', [id, id], dbOpts);
        if (!rfq) {
            return res.status(404).json({ success: false, error: 'طلب عرض السعر غير موجود' });
        }

        // Role Authorization Guard
        if (user.role === 'MANUFACTURER') {
            const isOwner = rfq.assigned_manufacturer_id === user.manufacturer_id || rfq.manufacturer_id === user.manufacturer_id;
            if (!isOwner) {
                return res.status(403).json({ success: false, error: 'غير مصرح بتعديل هذا الطلب' });
            }
            // Manufacturer can only set specific statuses
            const allowedMfgStatuses = ['UNDER_REVIEW', 'QUOTED', 'REJECTED'];
            if (status && !allowedMfgStatuses.includes(status)) {
                return res.status(403).json({
                    success: false,
                    error: `غير مصرح للمصنع بتحديد الحالة '${status}'. الحالات المسموحة: ${allowedMfgStatuses.join(', ')}`
                });
            }
            if (assigned_manufacturer_id && assigned_manufacturer_id !== user.manufacturer_id) {
                return res.status(403).json({ success: false, error: 'لا يمكن للمصنع إعادة توجيه الطلب لمنشأة أخرى' });
            }
        }

        const targetStatus = status || rfq.status;
        if (!ALLOWED_STATUSES.includes(targetStatus)) {
            return res.status(400).json({ success: false, error: 'حالة غير صالحة لطلب التسعير' });
        }

        let newAssignedMfg = rfq.assigned_manufacturer_id;
        if (['SUPER_ADMIN', 'LOGISTICS_OFFICER'].includes(user.role) && assigned_manufacturer_id !== undefined) {
            newAssignedMfg = assigned_manufacturer_id || null;
        }

        const updatedNotes = internal_notes !== undefined ? sanitizeText(internal_notes) : rfq.internal_notes;
        const noteText = sanitizeText(action_note || notes) || `تم تحديث الحالة من ${rfq.status} إلى ${targetStatus}`;

        await dbClient.transaction(async (tx) => {
            await tx.execute(`
                UPDATE rfqs
                SET status = ?,
                    assigned_manufacturer_id = ?,
                    internal_notes = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [targetStatus, newAssignedMfg, updatedNotes, rfq.id]);

            const metaVal = tx.engine === 'postgres'
                ? { changed_by: user.name, role: user.role }
                : JSON.stringify({ changed_by: user.name, role: user.role });

            await tx.execute(`
                INSERT INTO rfq_audit_logs (
                    rfq_id, changed_by_user_id, action, from_status, to_status, notes, metadata
                ) VALUES (?, ?, 'STATUS_UPDATE', ?, ?, ?, ?)
            `, [rfq.id, user.id, rfq.status, targetStatus, noteText, metaVal]);
        }, dbOpts);

        await notificationService.notifyRfqStatusChanged(rfq, rfq.status, targetStatus, noteText);

        return res.json({
            success: true,
            message: `تم تحديث حالة طلب التسعير (${rfq.reference_no}) إلى ${targetStatus} بنجاح`,
            status: targetStatus,
            assigned_manufacturer_id: newAssignedMfg
        });

    } catch (err) {
        console.error('[rfqRoutes] PATCH /:id/status error:', err);
        return res.status(500).json({
            success: false,
            error: 'خطأ في قاعدة البيانات أثناء تحديث حالة الطلب'
        });
    }
});

/**
 * 5. POST /api/inquiries (Contact Form Submissions)
 */
router.post('/inquiries', async (req, res) => {
    if (!checkRateLimit(req)) {
        return res.status(429).json({
            success: false,
            error: 'تم تجاوز الحد المسموح به لإرسال الاستفسارات مؤقتاً.'
        });
    }

    const {
        name, full_name,
        company, company_name,
        email, phone, country,
        service_type, product_id, message
    } = req.body || {};

    const cleanName = sanitizeText(name || full_name);
    const cleanCompany = sanitizeText(company || company_name);
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPhone = sanitizeText(phone);
    const cleanCountry = sanitizeText(country);
    const cleanService = sanitizeText(service_type) || 'supply';
    const cleanProductId = (product_id || '').trim() || null;
    const cleanMessage = sanitizeText(message);

    if (!cleanName || cleanName.length < 2) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال اسمك بشكل صحيح' });
    }
    if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال بريد إلكتروني صحيح' });
    }
    if (!cleanMessage || cleanMessage.length < 5) {
        return res.status(400).json({ success: false, error: 'يرجى توضيح استفسارك أو تفاصيل شحنتك' });
    }

    const dbOpts = req.dbClientOptions || {};
    const inqId = 'inq_' + crypto.randomBytes(8).toString('hex');
    const refYear = new Date().getFullYear();
    const refCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    const referenceNo = `INQ-${refYear}-${refCode}`;

    try {
        await dbClient.execute(`
            INSERT INTO contact_inquiries (
                id, reference_no, full_name, company_name, email, phone, country, product_id, message, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW')
        `, [
            inqId, referenceNo, cleanName, cleanCompany || 'N/A', cleanEmail, cleanPhone || 'N/A', cleanCountry || 'N/A',
            cleanProductId, cleanMessage
        ], dbOpts);

        await notificationService.notifyInquiryReceived({
            id: inqId,
            reference_no: referenceNo,
            email: cleanEmail,
            name: cleanName
        });

        return res.status(201).json({
            success: true,
            id: inqId,
            inquiry_id: inqId,
            message: 'تم استلام استفسارك بنجاح وسيتواصل معك فريق العمليات اللوجستية خلال 24 ساعة',
            reference_no: referenceNo
        });

    } catch (err) {
        console.error('[rfqRoutes] POST /inquiries error:', err);
        return res.status(500).json({
            success: false,
            error: 'خطأ في قاعدة البيانات أثناء تسجيل الاستفسار'
        });
    }
});

/**
 * 6. GET /api/inquiries (Admin Contact Inquiries Listing)
 * Enhanced with status filtering, date range, and search
 */
router.get('/inquiries/all', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const { status, search, from_date, to_date } = req.query || {};

    try {
        let sql = `
            SELECT ci.*, p.name_ar as product_name_ar
            FROM contact_inquiries ci
            LEFT JOIN products p ON ci.product_id = p.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            sql += ' AND ci.status = ?';
            params.push(status);
        }
        if (search) {
            sql += ' AND (ci.reference_no LIKE ? OR ci.full_name LIKE ? OR ci.company_name LIKE ? OR ci.email LIKE ?)';
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }
        if (from_date) {
            sql += ' AND ci.created_at >= ?';
            params.push(from_date);
        }
        if (to_date) {
            sql += ' AND ci.created_at <= ?';
            params.push(to_date);
        }

        sql += ' ORDER BY ci.created_at DESC LIMIT 100';

        const inquiries = await dbClient.queryAll(sql, params, dbOpts);
        return res.json({ success: true, inquiries });
    } catch (err) {
        console.error('[rfqRoutes] GET /inquiries/all error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في استرجاع استفسارات التواصل' });
    }
});

/**
 * 7. GET /api/inquiries/:id
 * Fetches inquiry details and chronological Proof-of-Contact logs
 */
router.get('/inquiries/:id', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const inquiry = await dbClient.queryOne(`
            SELECT ci.*, p.name_ar as product_name_ar
            FROM contact_inquiries ci
            LEFT JOIN products p ON ci.product_id = p.id
            WHERE ci.id = ?
        `, [id], dbOpts);

        if (!inquiry) {
            return res.status(404).json({ success: false, error: 'الاستفسار غير موجود' });
        }

        let contactLogs = [];
        try {
            contactLogs = await dbClient.queryAll(`
                SELECT * FROM contact_inquiry_logs
                WHERE inquiry_id = ?
                ORDER BY created_at DESC
            `, [id], dbOpts);
        } catch (_) {
            // Table might not exist yet before migration
        }

        return res.json({
            success: true,
            inquiry,
            contact_logs: contactLogs
        });
    } catch (err) {
        console.error('[rfqRoutes] GET /inquiries/:id error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في استرجاع تفاصيل الاستفسار' });
    }
});

/**
 * 8. POST /api/inquiries/:id/contact-log
 * Records Proof-of-Contact audit log entry
 */
router.post('/inquiries/:id/contact-log', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const { id } = req.params;
    const { contact_method, contact_date, notes, to_status } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    if (!contact_method || !notes) {
        return res.status(400).json({ success: false, error: 'وسيلة التواصل ومحضر الملاحظات مطلوبان' });
    }

    const validMethods = ['PHONE', 'EMAIL', 'WHATSAPP', 'IN_PERSON', 'OFFICIAL_LETTER'];
    if (!validMethods.includes(contact_method)) {
        return res.status(400).json({ success: false, error: 'وسيلة التواصل المحددة غير مدعومة' });
    }

    try {
        const inquiry = await dbClient.queryOne('SELECT * FROM contact_inquiries WHERE id = ?', [id], dbOpts);
        if (!inquiry) {
            return res.status(404).json({ success: false, error: 'الاستفسار غير موجود' });
        }

        const logId = 'clog_' + crypto.randomBytes(8).toString('hex');
        const contactTime = contact_date || new Date().toISOString();
        const targetStatus = to_status || inquiry.status;

        // Try inserting proof-of-contact log
        try {
            await dbClient.execute(`
                INSERT INTO contact_inquiry_logs (
                    id, inquiry_id, officer_id, officer_name,
                    contact_method, contact_date, notes, from_status,
                    to_status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                logId,
                id,
                req.user.id,
                req.user.name || 'Admin Officer',
                contact_method,
                contactTime,
                notes.trim(),
                inquiry.status,
                targetStatus
            ], dbOpts);
        } catch (tableErr) {
            console.warn('[rfqRoutes] contact_inquiry_logs insert fallback:', tableErr.message);
        }

        // If targetStatus is specified and different, update inquiry status
        if (targetStatus && targetStatus !== inquiry.status) {
            try {
                await dbClient.execute(`
                    UPDATE contact_inquiries
                    SET status = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [targetStatus, id], dbOpts);
            } catch (statusErr) {
                // If legacy DB check constraint rejects 'CONTACTED' or 'SPAM', map safely to 'IN_REVIEW'
                if (targetStatus === 'CONTACTED') {
                    await dbClient.execute(`
                        UPDATE contact_inquiries
                        SET status = 'IN_REVIEW', updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `, [id], dbOpts);
                }
            }
        }

        return res.json({
            success: true,
            message: 'تم تسجيل محضر التواصل بنجاح',
            log_id: logId
        });
    } catch (err) {
        console.error('[rfqRoutes] POST /inquiries/:id/contact-log error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في حفظ محضر التواصل' });
    }
});

/**
 * 9. PATCH /api/inquiries/:id/status
 * Updates inquiry status across the 6-state matrix with Proof-of-Contact enforcement
 */
router.patch('/inquiries/:id/status', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    const validStates = ['NEW', 'IN_REVIEW', 'CONTACTED', 'RESOLVED', 'CLOSED', 'SPAM'];
    if (!validStates.includes(status)) {
        return res.status(400).json({ success: false, error: `حالة الاستفسار غير مصرح بها: ${status}` });
    }

    try {
        const inquiry = await dbClient.queryOne('SELECT * FROM contact_inquiries WHERE id = ?', [id], dbOpts);
        if (!inquiry) {
            return res.status(404).json({ success: false, error: 'الاستفسار غير موجود' });
        }

        // Enforce Proof-of-Contact invariant before transitioning to CONTACTED or RESOLVED
        if (status === 'CONTACTED' || status === 'RESOLVED') {
            let logCount = 0;
            try {
                const countRes = await dbClient.queryOne(`
                    SELECT COUNT(*) as count FROM contact_inquiry_logs WHERE inquiry_id = ?
                `, [id], dbOpts);
                logCount = Number(countRes?.count || 0);
            } catch (_) {}

            if (logCount === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'لا يمكن نقل الاستفسار إلى (تم التواصل / تم الحل) دون تسجيل محضر إثبات تواصل مسبق (Proof-of-Contact) يوضح وسيلة وتاريخ وملخص التواصل.'
                });
            }
        }

        try {
            await dbClient.execute(`
                UPDATE contact_inquiries
                SET status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [status, id], dbOpts);
        } catch (dbCheckErr) {
            // Legacy DB check fallback
            if (status === 'CONTACTED') {
                await dbClient.execute(`
                    UPDATE contact_inquiries
                    SET status = 'IN_REVIEW', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [id], dbOpts);
            } else {
                throw dbCheckErr;
            }
        }

        return res.json({
            success: true,
            message: `تم تحديث حالة الاستفسار إلى (${status}) بنجاح`,
            status
        });
    } catch (err) {
        console.error('[rfqRoutes] PATCH /inquiries/:id/status error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في تحديث حالة الاستفسار' });
    }
});

module.exports = router;
