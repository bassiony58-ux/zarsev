/**
 * src/routes/settlementRoutes.js
 * 
 * Commercial Negotiations (Counter-Offers), Proforma Invoices,
 * Milestone Settlements, and Final Deal Closure API for ZARSEV.
 * 
 * Implements Phase 7.0-B, C, D:
 * - Structured negotiation rounds with deadlines.
 * - International standard Proforma Invoice generation.
 * - Staged milestone settlements.
 * - Verified commercial deal closure.
 */

const express = require('express');
const router = express.Router();
const settlementService = require('../services/settlementService');
const dbClient = require('../db/dbClient');
const { authMiddleware, optionalAuthMiddleware, requireRole } = require('../middlewares/auth');

/**
 * 1. POST /api/settlement/proforma/:contractId
 * Generates structured Proforma Invoice
 */
router.post('/proforma/:contractId', authMiddleware, async (req, res) => {
    const { contractId } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const invoice = await settlementService.generateProformaInvoice({
            contractId,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم إصدار الفاتورة الأولية الرسمية (Proforma Invoice) بنجاح',
            invoice
        });
    } catch (err) {
        console.error('[settlementRoutes] POST /proforma error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 2. GET /api/settlement/proforma/:contractId
 * Fetches latest proforma invoice for a contract
 */
router.get('/proforma/:contractId', optionalAuthMiddleware, async (req, res) => {
    const { contractId } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const invoice = await dbClient.queryOne(`
            SELECT * FROM proforma_invoices
            WHERE contract_id = ?
            ORDER BY created_at DESC LIMIT 1
        `, [contractId], dbOpts);

        if (!invoice) {
            return res.status(404).json({ success: false, error: 'لم يتم إصدار فاتورة أولية لهذا العقد بعد' });
        }

        return res.json({ success: true, invoice });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 3. POST /api/settlement/counter-offer
 * Submits a counter-offer in commercial negotiations
 */
router.post('/counter-offer', optionalAuthMiddleware, async (req, res) => {
    const {
        quotation_id,
        proposed_by = 'BUYER',
        proposed_price,
        currency,
        proposed_quantity,
        incoterm,
        proposed_moq,
        proposed_lead_time_days,
        notes
    } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    try {
        const negotiation = await settlementService.submitCounterOffer({
            quotationId: quotation_id,
            proposedBy: proposed_by,
            proposedPrice: proposed_price,
            currency,
            proposedQuantity: proposed_quantity,
            incoterm,
            proposedMoq: proposed_moq,
            proposedLeadTimeDays: proposed_lead_time_days,
            notes,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم إرسال العرض المضاد وتحديث جولة التفاوض التجاري بنجاح',
            negotiation
        });
    } catch (err) {
        console.error('[settlementRoutes] POST /counter-offer error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 4. GET /api/settlement/negotiations/:quotationId
 * Lists all negotiation rounds for a quotation
 */
router.get('/negotiations/:quotationId', optionalAuthMiddleware, async (req, res) => {
    const { quotationId } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const rounds = await dbClient.queryAll(`
            SELECT * FROM quotation_negotiations
            WHERE quotation_id = ?
            ORDER BY round_number ASC
        `, [quotationId], dbOpts);

        return res.json({
            success: true,
            count: rounds.length,
            negotiations: rounds
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. POST /api/settlement/milestones
 * Records milestone payment progress
 */
router.post('/milestones', authMiddleware, async (req, res) => {
    const {
        contract_id,
        shipment_id,
        milestone,
        amount,
        currency,
        due_date,
        paid_date,
        payment_reference,
        proof_file_path,
        notes
    } = req.body || {};
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};

    const verifiedBy = (user.role === 'ADMIN' && paid_date) ? user.id : null;

    try {
        const result = await settlementService.recordSettlementMilestone({
            contractId: contract_id,
            shipmentId: shipment_id,
            milestone,
            amount,
            currency,
            dueDate: due_date,
            paidDate: paid_date,
            paymentReference: payment_reference,
            proofFilePath: proof_file_path,
            verifiedBy,
            notes,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم تسجيل دفعة الاستحقاق التجاري بنجاح',
            milestone: result
        });
    } catch (err) {
        console.error('[settlementRoutes] POST /milestones error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 6. POST /api/settlement/contracts/:id/close
 * Executes final commercial deal closure
 */
router.post('/contracts/:id/close', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const { commercial_notes } = req.body || {};
    const dbOpts = req.dbClientOptions || {};

    try {
        const closure = await settlementService.closeCommercialContract({
            contractId: id,
            closedBy: user.id,
            commercialNotes: commercial_notes,
            dbOpts
        });

        return res.json({
            success: true,
            message: 'تم تنفيذ الإغلاق التجاري النهائي للصفقة وتوثيق مخالصة العقد بنجاح',
            closure
        });
    } catch (err) {
        console.error('[settlementRoutes] POST /contracts/:id/close error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
