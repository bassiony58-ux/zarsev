/**
 * src/services/contractService.js
 * 
 * Commercial Export Contract Lifecycle Subsystem for ZARSEV.
 * Implements Phase 5.0-A requirements:
 * - Atomic contract generation on buyer quotation acceptance.
 * - Strict validity date verification (buyer_decision_at <= validity_date 23:59:59 UTC).
 * - Enforces commercial lineage integrity (RFQ.assigned_mfg == Quote.mfg == Contract.mfg).
 * - Enforces single contract per quotation invariant (uq_contract_quotation_id).
 * - Multi-tenant isolation for Admin, Manufacturer, and Buyer actors.
 * - Complete contract audit trail and transactional notification dispatch.
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const notificationService = require('./notificationService');
const { recordAuditLog } = require('./auditLogService');

/**
 * Checks if buyer decision occurred before the end of the validity date (23:59:59.999 UTC)
 */
function isDecisionWithinValidity(decisionTimestamp, validityDateStr) {
    if (!validityDateStr) return false;
    const decisionTime = new Date(decisionTimestamp).getTime();
    
    // Validity date evaluated at the very end of that day in UTC
    const validityParts = validityDateStr.split('-');
    if (validityParts.length !== 3) return false;
    const year = parseInt(validityParts[0], 10);
    const month = parseInt(validityParts[1], 10) - 1;
    const day = parseInt(validityParts[2], 10);
    const validityEndOfDay = Date.UTC(year, month, day, 23, 59, 59, 999);

    return decisionTime <= validityEndOfDay;
}

/**
 * Generates sequential formatted contract number
 */
async function generateContractNumber(client) {
    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const randSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `CTR-${yearMonth}-${randSuffix}`;
}

/**
 * Creates a formal commercial contract from an accepted quotation
 */
async function createContractFromQuotation({
    quotationId,
    buyerAccessToken,
    buyerNotes = '',
    actorId = 'SYSTEM',
    actorType = 'BUYER',
    dbOpts = {}
}) {
    let contractResult = null;

    await dbClient.transaction(async (tx) => {
        // 1. Fetch quotation with parent RFQ details
        const quote = await tx.queryOne(`
            SELECT q.*, r.buyer_name, r.business_email as buyer_email,
                   r.company_name as buyer_company, r.assigned_manufacturer_id as rfq_mfg_id,
                   r.reference_no as rfq_reference_no, r.status as rfq_status,
                   m.name_ar as mfg_name_ar, m.name_en as mfg_name_en, m.is_active as mfg_active
            FROM quotations q
            JOIN rfqs r ON q.rfq_id = r.id
            JOIN manufacturers m ON q.manufacturer_id = m.id
            WHERE q.id = ?
        `, [quotationId]);

        if (!quote) {
            throw new Error('عرض السعر التجاري غير موجود');
        }

        // 2. Prevent contract for expired, superseded, or rejected quotes
        if (quote.status !== 'ACCEPTED') {
            throw new Error(`لا يمكن إنشاء عقد لعرض سعر بحالة: ${quote.status}. يجب قبول العرض أولاً.`);
        }

        // 3. Prevent duplicate contract for the same quotation (Idempotency / Unique invariant)
        const existingContract = await tx.queryOne(
            'SELECT id, contract_no FROM commercial_contracts WHERE quotation_id = ?',
            [quotationId]
        );
        if (existingContract) {
            const err = new Error(`تم إنشاء العقد التجاري رقم (${existingContract.contract_no}) لهذا العرض مسبقاً.`);
            err.isDuplicate = true;
            err.contract = existingContract;
            throw err;
        }

        // 4. Commercial Lineage Verification: RFQ assigned mfg == Quote mfg
        if (quote.rfq_mfg_id && quote.rfq_mfg_id !== quote.manufacturer_id) {
            throw new Error('تعارض في النسب التجاري: المصنع المسند إليه الطلب لا يتطابق مع المصنع مقدم العرض');
        }

        // 5. Verification of Decision Time vs Validity Date
        const decisionTime = quote.buyer_decision_at || quote.updated_at || new Date().toISOString();
        const validityDateStr = typeof quote.validity_date === 'string'
            ? quote.validity_date.substring(0, 10)
            : new Date(quote.validity_date).toISOString().substring(0, 10);

        if (!isDecisionWithinValidity(decisionTime, validityDateStr)) {
            throw new Error(`انتهت صلاحية عرض السعر في ${validityDateStr} قبل اتخاذ قرار القبول (${decisionTime})`);
        }

        // 6. Generate Contract Identifier & Contract Number
        const contractId = 'ctr_' + crypto.randomBytes(12).toString('hex');
        const contractNo = await generateContractNumber(tx);
        const totalAmount = Number(quote.price_per_unit) * Number(quote.moq || 1);

        // 7. Insert Contract Record
        await tx.execute(`
            INSERT INTO commercial_contracts (
                id, contract_no, rfq_id, quotation_id, manufacturer_id,
                buyer_name, buyer_email, buyer_company,
                total_amount, currency, incoterm,
                port_of_loading, port_of_discharge,
                payment_terms, delivery_deadline,
                buyer_decision_at, quotation_validity_date,
                status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            contractId,
            contractNo,
            quote.rfq_id,
            quote.id,
            quote.manufacturer_id,
            quote.buyer_name,
            quote.buyer_email,
            quote.buyer_company,
            totalAmount,
            quote.currency,
            quote.incoterm,
            quote.port_of_loading || 'Alexandria Port',
            quote.port_of_discharge || 'Destination Port',
            quote.payment_terms || '30% Advance, 70% against B/L Copy',
            quote.validity_date,
            decisionTime,
            validityDateStr
        ]);

        // 8. Insert Contract Audit Log
        await tx.execute(`
            INSERT INTO contract_audit_logs (
                id, contract_id, action, actor_type, actor_id, notes, metadata, created_at
            ) VALUES (?, ?, 'CONTRACT_CREATED', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            'caud_' + crypto.randomBytes(8).toString('hex'),
            contractId,
            actorType,
            actorId,
            `تم إبرام العقد التجاري رقم ${contractNo} بناءً على قبول عرض السعر ${quote.reference_no}`,
            JSON.stringify({ quotation_id: quote.id, rfq_id: quote.rfq_id, totalAmount })
        ]);

        // 9. Enqueue In-App Notifications for Manufacturer and Admin
        await notificationService.enqueueNotification(tx, {
            recipientType: 'MANUFACTURER',
            recipientId: quote.manufacturer_id,
            eventType: 'CONTRACT_CREATED',
            titleAr: `تم إبرام العقد التجاري (${contractNo})`,
            titleEn: `Commercial Export Contract Executed (${contractNo})`,
            bodyAr: `تم إبرام العقد التجاري رقم ${contractNo} بقيمة إجمالية ${totalAmount} ${quote.currency}. يرجى الشروع في تجهيز خطة الإنتاج.`,
            bodyEn: `Export contract ${contractNo} executed for ${totalAmount} ${quote.currency}. Please proceed to production planning.`,
            payload: { contract_id: contractId, contract_no: contractNo },
            referenceType: 'CONTRACT',
            referenceId: contractId
        });

        contractResult = {
            id: contractId,
            contract_no: contractNo,
            rfq_id: quote.rfq_id,
            quotation_id: quote.id,
            manufacturer_id: quote.manufacturer_id,
            buyer_name: quote.buyer_name,
            buyer_company: quote.buyer_company,
            total_amount: totalAmount,
            currency: quote.currency,
            incoterm: quote.incoterm,
            status: 'CONFIRMED'
        };
    }, dbOpts);

    return contractResult;
}

/**
 * Lists contracts filtered by caller's role and identity
 */
async function listContracts({
    role,
    manufacturerId = null,
    buyerEmail = null,
    status = null,
    dbOpts = {}
}) {
    let sql = `
        SELECT c.*, m.name_ar as mfg_name_ar, m.name_en as mfg_name_en,
               r.reference_no as rfq_reference_no, q.reference_no as quote_reference_no
        FROM commercial_contracts c
        JOIN manufacturers m ON c.manufacturer_id = m.id
        JOIN rfqs r ON c.rfq_id = r.id
        JOIN quotations q ON c.quotation_id = q.id
        WHERE 1=1
    `;
    const params = [];

    if (role === 'MANUFACTURER') {
        if (!manufacturerId) throw new Error('معرف المصنع مطلوب');
        sql += ' AND c.manufacturer_id = ?';
        params.push(manufacturerId);
    } else if (role === 'BUYER') {
        if (!buyerEmail) throw new Error('البريد الإلكتروني للمشتري مطلوب');
        sql += ' AND LOWER(c.buyer_email) = ?';
        params.push(buyerEmail.trim().toLowerCase());
    }

    if (status) {
        sql += ' AND c.status = ?';
        params.push(status);
    }

    sql += ' ORDER BY c.created_at DESC';

    const contracts = await dbClient.queryAll(sql, params, dbOpts);
    return contracts;
}

/**
 * Gets detailed contract record with multi-tenant access check
 */
async function getContractById(contractId, {
    role,
    manufacturerId = null,
    buyerEmail = null,
    dbOpts = {}
} = {}) {
    const contract = await dbClient.queryOne(`
        SELECT c.*, m.name_ar as mfg_name_ar, m.name_en as mfg_name_en,
               r.reference_no as rfq_reference_no, q.reference_no as quote_reference_no,
               p.name_ar as product_name_ar, p.name_en as product_name_en
        FROM commercial_contracts c
        JOIN manufacturers m ON c.manufacturer_id = m.id
        JOIN rfqs r ON c.rfq_id = r.id
        JOIN quotations q ON c.quotation_id = q.id
        LEFT JOIN products p ON r.product_id = p.id
        WHERE c.id = ?
    `, [contractId], dbOpts);

    if (!contract) {
        throw new Error('العقد التجاري غير موجود');
    }

    // Role-based access enforcement
    if (role === 'MANUFACTURER' && contract.manufacturer_id !== manufacturerId) {
        throw new Error('غير مصرح بالوصول إلى بيانات هذا العقد');
    }
    if (role === 'BUYER' && contract.buyer_email.toLowerCase() !== buyerEmail.toLowerCase()) {
        throw new Error('غير مصرح بالوصول إلى بيانات هذا العقد');
    }

    // Fetch related audit logs
    const auditLogs = await dbClient.queryAll(`
        SELECT id, action, actor_type, actor_id, notes, created_at
        FROM contract_audit_logs
        WHERE contract_id = ?
        ORDER BY created_at ASC
    `, [contractId], dbOpts);

    return {
        contract,
        auditLogs
    };
}

module.exports = {
    isDecisionWithinValidity,
    generateContractNumber,
    createContractFromQuotation,
    listContracts,
    getContractById
};
