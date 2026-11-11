/**
 * src/routes/quotationRoutes.js
 * 
 * Structured Commercial Quotations Subsystem for ZARSEV Global Trade Platform.
 * 
 * Compliant with Incoterms 2020 international trade standards.
 * 
 * Features:
 * - Structured quotation creation with validation (Price, Currency, Incoterms, Ports, MOQ, Lead Time, Validity)
 * - Multi-tenant isolation: Only assigned/origin manufacturer or Super Admin can submit quotations
 * - Superseding of older quotations on revision
 * - Secure buyer access and response (Accept / Reject) guarded by buyer_access_token
 * - Chronological quotation audit trail
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const { authMiddleware, requireRole, requireSubRole } = require('../middlewares/auth');
const notificationService = require('../services/notificationService');

// Official Incoterms 2020: Complete 11 standard commercial rules
const VALID_INCOTERMS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];
const VALID_CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'EGP'];

// In-Memory Rate Limiting for Buyer Decisions: 15 requests per 10 minutes per IP (SEC-07)
const decisionRateLimitMap = new Map();
const DECISION_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DECISION_RATE_LIMIT_MAX = 15;

function checkDecisionRateLimit(req) {
    const ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const clientData = decisionRateLimitMap.get(ip) || { count: 0, resetTime: now + DECISION_RATE_LIMIT_WINDOW_MS };

    if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + DECISION_RATE_LIMIT_WINDOW_MS;
    } else {
        clientData.count++;
    }

    decisionRateLimitMap.set(ip, clientData);
    return clientData.count <= DECISION_RATE_LIMIT_MAX;
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

/**
 * Checks whether a quotation validity date has passed (SEC-04 / COM-G01).
 * Returns true if validity_date < today (in UTC YYYY-MM-DD).
 */
function isQuotationExpired(validityDate) {
    if (!validityDate) return false;
    let vDateStr = '';
    if (validityDate instanceof Date) {
        vDateStr = validityDate.toISOString().substring(0, 10);
    } else if (typeof validityDate === 'string') {
        vDateStr = validityDate.substring(0, 10);
    } else {
        vDateStr = new Date(validityDate).toISOString().substring(0, 10);
    }
    const todayStr = new Date().toISOString().substring(0, 10);
    return vDateStr < todayStr;
}

function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/[<>]/g, '');
}

/**
 * 1. POST /api/quotations
 * Submit a Structured Commercial Quotation for an RFQ
 * Access: Assigned MANUFACTURER or SUPER_ADMIN
 */
router.post('/', authMiddleware, requireSubRole(['OWNER', 'SALES']), async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        rfq_id,
        unit_price,
        currency = 'USD',
        incoterm,
        loading_port,
        destination_port,
        min_order_quantity = 1,
        min_order_unit = 'MT',
        lead_time_days,
        packaging_details,
        payment_terms,
        validity_date,
        additional_terms
    } = req.body || {};

    // 1. Validation
    if (!rfq_id) {
        return res.status(400).json({ success: false, error: 'معرف طلب عرض السعر (rfq_id) مطلوب' });
    }

    const priceNum = parseFloat(unit_price);
    if (isNaN(priceNum) || priceNum <= 0) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال سعر وحدة تجاري صحيح أكبر من الصفر' });
    }

    const cleanCurrency = (currency || 'USD').trim().toUpperCase();
    if (!VALID_CURRENCIES.includes(cleanCurrency)) {
        return res.status(400).json({ success: false, error: `العملة '${cleanCurrency}' غير مدعومة. العملات المدعومة: ${VALID_CURRENCIES.join(', ')}` });
    }

    const cleanIncoterm = (incoterm || '').trim().toUpperCase();
    if (!VALID_INCOTERMS.includes(cleanIncoterm)) {
        return res.status(400).json({ success: false, error: `شرط الشحن (Incoterm) غير صالح. الشروط المدعومة: ${VALID_INCOTERMS.join(', ')}` });
    }

    const cleanLoadingPort = sanitizeText(loading_port);
    if (!cleanLoadingPort || cleanLoadingPort.length < 2) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد ميناء الشحن / التحميل (Loading Port)' });
    }

    const moqNum = parseFloat(min_order_quantity);
    if (isNaN(moqNum) || moqNum <= 0) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال حد أدنى للطلب (MOQ) أكبر من الصفر' });
    }

    const leadTimeNum = parseInt(lead_time_days, 10);
    if (isNaN(leadTimeNum) || leadTimeNum <= 0) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد مدة التجهيز والتسليم المقدرة بالأيام' });
    }

    const cleanPackaging = sanitizeText(packaging_details);
    if (!cleanPackaging || cleanPackaging.length < 3) {
        return res.status(400).json({ success: false, error: 'يرجى توضيح مواصفات التعبئة والتغليف التصديرية' });
    }

    const cleanPayment = sanitizeText(payment_terms);
    if (!cleanPayment || cleanPayment.length < 3) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد شروط الدفع والتحصيل التجاري' });
    }

    if (!validity_date) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد تاريخ صلاحية عرض السعر' });
    }

    const parsedValidity = new Date(validity_date);
    if (isNaN(parsedValidity.getTime())) {
        return res.status(400).json({ success: false, error: 'تاريخ صلاحية العرض غير صالح' });
    }

    try {
        // 2. Fetch and Authorize RFQ
        const rfq = await dbClient.queryOne('SELECT * FROM rfqs WHERE id = ? OR reference_no = ?', [rfq_id, rfq_id], dbOpts);
        if (!rfq) {
            return res.status(404).json({ success: false, error: 'طلب عرض السعر غير موجود' });
        }

        // Strict Tenant Isolation Guard
        if (user.role === 'MANUFACTURER') {
            const isAssigned = rfq.assigned_manufacturer_id === user.manufacturer_id;
            const isDirectOwner = rfq.manufacturer_id === user.manufacturer_id && !rfq.assigned_manufacturer_id;
            if (!isAssigned && !isDirectOwner) {
                return res.status(403).json({
                    success: false,
                    error: 'غير مصرح: لا يمكنك تقديم عرض أسعار لطلب غير محال إلى منشأتك'
                });
            }
        }

        const effectiveMfgId = user.role === 'MANUFACTURER' ? user.manufacturer_id : (rfq.assigned_manufacturer_id || rfq.manufacturer_id);

        // 3. Generate Identifiers
        const quotId = 'quot_' + crypto.randomBytes(8).toString('hex');
        const refYear = new Date().getFullYear();
        const refCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        const referenceNo = `QUOT-${refYear}-${refCode}`;

        // 4. Atomic Database Transaction
        await dbClient.transaction(async (tx) => {
            // Supersede previous active quotations for this RFQ
            await tx.execute(`
                UPDATE quotations
                SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
                WHERE rfq_id = ? AND status = 'SUBMITTED'
            `, [rfq.id]);

            // Insert new quotation
            await tx.execute(`
                INSERT INTO quotations (
                    id, reference_no, rfq_id, manufacturer_id, created_by_user_id,
                    unit_price, currency, incoterm, loading_port, destination_port,
                    min_order_quantity, min_order_unit, lead_time_days, packaging_details,
                    payment_terms, validity_date, additional_terms, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED')
            `, [
                quotId, referenceNo, rfq.id, effectiveMfgId, user.id,
                priceNum, cleanCurrency, cleanIncoterm, cleanLoadingPort,
                sanitizeText(destination_port) || rfq.destination_port || null,
                moqNum, sanitizeText(min_order_unit) || 'MT', leadTimeNum,
                cleanPackaging, cleanPayment, validity_date,
                sanitizeText(additional_terms) || null
            ]);

            // Quotation audit log
            const metaVal = tx.engine === 'postgres'
                ? { user_id: user.id, role: user.role, ip: req.ip }
                : JSON.stringify({ user_id: user.id, role: user.role, ip: req.ip });

            await tx.execute(`
                INSERT INTO quotation_audit_logs (
                    quotation_id, action, actor_type, actor_id, notes, metadata
                ) VALUES (?, 'SUBMITTED', ?, ?, ?, ?)
            `, [
                quotId, user.role, user.id,
                `تم تقديم عرض أسعار تجاري معتمد بقيمة ${priceNum} ${cleanCurrency} (${cleanIncoterm})`,
                metaVal
            ]);

            // Update parent RFQ status to 'QUOTED'
            await tx.execute(`
                UPDATE rfqs
                SET status = 'QUOTED', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [rfq.id]);

            // RFQ audit log
            await tx.execute(`
                INSERT INTO rfq_audit_logs (
                    rfq_id, changed_by_user_id, action, from_status, to_status, notes, metadata
                ) VALUES (?, ?, 'STATUS_UPDATE', ?, 'QUOTED', ?, ?)
            `, [
                rfq.id, user.id, rfq.status,
                `تم إصدار عرض السعر التجاري الرسمي رقم ${referenceNo}`,
                metaVal
            ]);
        }, dbOpts);

        const newQuotation = {
            id: quotId,
            reference_no: referenceNo,
            rfq_id: rfq.id,
            unit_price: priceNum,
            currency: cleanCurrency,
            incoterm: cleanIncoterm,
            min_order_unit: min_order_unit || 'MT'
        };

        await notificationService.notifyQuotationSubmitted(newQuotation, rfq);

        return res.status(201).json({
            success: true,
            message: 'تم تقديم عرض الأسعار التجاري بنجاح وتم تسجيله برقم معتمد',
            quotation_id: quotId,
            reference_no: referenceNo,
            status: 'SUBMITTED'
        });

    } catch (err) {
        console.error('[quotationRoutes] POST / error:', err);
        return res.status(500).json({
            success: false,
            error: 'خطأ في قاعدة البيانات أثناء حفظ عرض الأسعار'
        });
    }
});

/**
 * 2. GET /api/quotations/rfq/:rfqId
 * Get all quotations and revision history for a specific RFQ
 * Access: Super Admin or assigned Manufacturer
 */
router.get('/rfq/:rfqId', authMiddleware, requireSubRole(['OWNER', 'SALES', 'EXPORT'], { allowRoles: ['SUPER_ADMIN', 'LOGISTICS_OFFICER'] }), async (req, res) => {
    const { rfqId } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};

    try {
        const rfq = await dbClient.queryOne('SELECT * FROM rfqs WHERE id = ? OR reference_no = ?', [rfqId, rfqId], dbOpts);
        if (!rfq) {
            return res.status(404).json({ success: false, error: 'طلب عرض السعر غير موجود' });
        }

        // Tenant Isolation
        if (user.role === 'MANUFACTURER') {
            const isAssigned = rfq.assigned_manufacturer_id === user.manufacturer_id;
            const isOwner = rfq.manufacturer_id === user.manufacturer_id;
            if (!isAssigned && !isOwner) {
                return res.status(403).json({ success: false, error: 'غير مصرح باستعراض عروض أسعار هذا الطلب' });
            }
        }

        const quotations = await dbClient.queryAll(`
            SELECT q.*, m.name_ar as manufacturer_name_ar, m.code as manufacturer_code
            FROM quotations q
            JOIN manufacturers m ON q.manufacturer_id = m.id
            WHERE q.rfq_id = ?
            ORDER BY q.created_at DESC
        `, [rfq.id], dbOpts);

        return res.json({
            success: true,
            rfq_id: rfq.id,
            rfq_reference: rfq.reference_no,
            total: quotations.length,
            quotations
        });
    } catch (err) {
        console.error('[quotationRoutes] GET /rfq/:rfqId error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في قاعدة البيانات' });
    }
});

/**
 * 3. GET /api/quotations/:id
 * Get single quotation details with audit logs
 */
router.get('/:id', authMiddleware, requireSubRole(['OWNER', 'SALES', 'EXPORT'], { allowRoles: ['SUPER_ADMIN', 'LOGISTICS_OFFICER'] }), async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};

    try {
        const quotation = await dbClient.queryOne(`
            SELECT q.*, r.reference_no as rfq_reference_no, r.buyer_name, r.company_name as buyer_company,
                   p.name_ar as product_name_ar, p.name_en as product_name_en, p.sku as product_sku,
                   m.name_ar as manufacturer_name_ar
            FROM quotations q
            JOIN rfqs r ON q.rfq_id = r.id
            JOIN products p ON r.product_id = p.id
            JOIN manufacturers m ON q.manufacturer_id = m.id
            WHERE q.id = ? OR q.reference_no = ?
        `, [id, id], dbOpts);

        if (!quotation) {
            return res.status(404).json({ success: false, error: 'عرض السعر غير موجود' });
        }

        // Isolation
        if (user.role === 'MANUFACTURER' && quotation.manufacturer_id !== user.manufacturer_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح باستعراض هذا العرض' });
        }

        const auditLogs = await dbClient.queryAll(`
            SELECT * FROM quotation_audit_logs WHERE quotation_id = ? ORDER BY created_at ASC
        `, [quotation.id], dbOpts);

        return res.json({
            success: true,
            quotation,
            audit_logs: auditLogs
        });
    } catch (err) {
        console.error('[quotationRoutes] GET /:id error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في قاعدة البيانات' });
    }
});

/**
 * 4. POST /api/quotations/:id/decision
 * Buyer Acceptance or Rejection of a Commercial Quotation
 * Protected by cryptographic token comparison, expiration check, and concurrency locks (SEC-04, SEC-05, SEC-06, SEC-07).
 */
router.post('/:id/decision', async (req, res) => {
    // 1. Rate Limiting Check (SEC-07)
    if (!checkDecisionRateLimit(req)) {
        return res.status(429).json({
            success: false,
            error: 'تم تجاوز الحد المسموح به لاتخاذ القرارات مؤقتاً. يرجى المحاولة بعد قليل.'
        });
    }

    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};
    const buyerToken = req.headers['x-buyer-token'] || req.body?.buyer_token;
    const { decision, notes } = req.body || {};

    if (!buyerToken || typeof buyerToken !== 'string' || !buyerToken.trim()) {
        return res.status(401).json({
            success: false,
            error: 'رمز التحقق الأمني للمشتري (buyer_token) مطلوب لتنفيذ هذا الإجراء'
        });
    }

    const cleanDecision = (decision || '').trim().toUpperCase();
    if (!['ACCEPTED', 'REJECTED'].includes(cleanDecision)) {
        return res.status(400).json({
            success: false,
            error: 'القرار التجاري يجب أن يكون ACCEPTED أو REJECTED'
        });
    }

    try {
        const quotation = await dbClient.queryOne(`
            SELECT q.*, r.buyer_access_token_hash, r.business_email, r.reference_no as rfq_reference_no
            FROM quotations q
            JOIN rfqs r ON q.rfq_id = r.id
            WHERE q.id = ? OR q.reference_no = ?
        `, [id, id], dbOpts);

        if (!quotation) {
            return res.status(404).json({ success: false, error: 'عرض السعر غير موجود' });
        }

        // 2. Timing-Safe Credential Verification against SHA-256 hash strictly (SEC-06)
        const tokenMatch = safeCompareToken(buyerToken, quotation.buyer_access_token_hash);
        if (!tokenMatch) {
            return res.status(403).json({
                success: false,
                error: 'رمز التحقق الأمني غير مطابق. غير مصرح بتسجيل قرار على هذا العرض'
            });
        }

        // 3. Status Pre-Check
        if (quotation.status !== 'SUBMITTED') {
            return res.status(400).json({
                success: false,
                error: `لا يمكن تغيير قرار العرض الراهن لأن حالته الحالية هي: ${quotation.status}`
            });
        }

        // 4. Commercial Validity & Expiration Check (SEC-04 / COM-G01)
        if (isQuotationExpired(quotation.validity_date)) {
            return res.status(400).json({
                success: false,
                error: 'انتهت صلاحية هذا العرض التجاري، ولا يمكن اتخاذ قرار بشأنه. يرجى طلب تحديث عرض السعر من المصنع.'
            });
        }

        const cleanNotes = sanitizeText(notes);

        // 5. Atomic Conditional Decision Update (SEC-05 / COM-G02)
        await dbClient.transaction(async (tx) => {
            const updateRes = await tx.execute(`
                UPDATE quotations
                SET status = ?,
                    buyer_decision_at = CURRENT_TIMESTAMP,
                    buyer_decision_notes = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'SUBMITTED'
            `, [cleanDecision, cleanNotes || null, quotation.id]);

            const affected = updateRes?.rowCount ?? updateRes?.changes ?? 0;
            if (affected === 0) {
                const conflictErr = new Error('CONFLICT_ALREADY_DECIDED');
                conflictErr.isConflict = true;
                throw conflictErr;
            }

            const metaVal = tx.engine === 'postgres'
                ? { decision: cleanDecision, source_ip: req.ip }
                : JSON.stringify({ decision: cleanDecision, source_ip: req.ip });

            await tx.execute(`
                INSERT INTO quotation_audit_logs (
                    quotation_id, action, actor_type, actor_id, notes, metadata
                ) VALUES (?, ?, 'BUYER', 'buyer', ?, ?)
            `, [
                quotation.id, cleanDecision,
                cleanNotes || (cleanDecision === 'ACCEPTED' ? 'تم قبول العرض التجاري من قِبل المشتري' : 'تم الاعتذار عن قبول العرض التجاري'),
                metaVal
            ]);

            // Synchronize parent RFQ status in the same atomic transaction
            await tx.execute(`
                UPDATE rfqs
                SET status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [cleanDecision, quotation.rfq_id]);

            await tx.execute(`
                INSERT INTO rfq_audit_logs (
                    rfq_id, action, from_status, to_status, notes, metadata
                ) VALUES (?, 'STATUS_UPDATE', 'QUOTED', ?, ?, ?)
            `, [
                quotation.rfq_id, cleanDecision,
                `قام المشتري بـ ${cleanDecision === 'ACCEPTED' ? 'قبول' : 'رفض'} عرض السعر رقم ${quotation.reference_no}`,
                metaVal
            ]);
        }, dbOpts);

        await notificationService.notifyQuotationDecision(
            quotation,
            { reference_no: quotation.rfq_reference_no, business_email: quotation.business_email },
            cleanDecision,
            cleanNotes
        );

        return res.json({
            success: true,
            message: cleanDecision === 'ACCEPTED'
                ? 'تم تسجيل قبولك لعرض السعر بنجاح. سيتواصل معك فريق العمليات لإتمام إجراءات التعاقد والشحن.'
                : 'تم تسجيل رفض العرض التجاري. شكراً لاهتمامك.',
            quotation_id: quotation.id,
            status: cleanDecision
        });

    } catch (err) {
        if (err.isConflict || err.message === 'CONFLICT_ALREADY_DECIDED') {
            return res.status(409).json({
                success: false,
                error: 'عذراً، لم يعد هذا العرض متاحاً لاتخاذ قرار (ربما تم اتخاذ قرار مسبقاً أو تعديل العرض).'
            });
        }
        console.error('[quotationRoutes] POST /:id/decision error:', err);
        return res.status(500).json({ success: false, error: 'خطأ في خادم قاعدة البيانات أثناء حفظ القرار' });
    }
});

module.exports = router;
