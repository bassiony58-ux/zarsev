/**
 * src/routes/qualityRoutes.js
 * 
 * Quality Control (QC), Quality Assurance (QA), Statutory MRL Engine,
 * and Conditional Release API for ZARSEV.
 * 
 * Implements Phase 5.0-C, D, E, F:
 * - 5 standardized inspection checkpoints.
 * - Separation of duties: Inspector != QA reviewer.
 * - Automated statutory MRL compliance checking.
 * - Strict Conditional Release policy with absolute prohibition on banned contaminants.
 */

const express = require('express');
const router = express.Router();
const qualityService = require('../services/qualityService');
const dbClient = require('../db/dbClient');
const { authMiddleware, requireRole } = require('../middlewares/auth');

/**
 * 1. GET /api/quality/inspections
 * Lists QC inspections
 */
router.get('/inspections', authMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const { contract_id, batch_id } = req.query || {};

    try {
        let sql = `
            SELECT qi.*, c.contract_no, pb.batch_no, pb.lot_number
            FROM qc_inspections qi
            JOIN commercial_contracts c ON qi.contract_id = c.id
            JOIN production_batches pb ON qi.batch_id = pb.id
            WHERE 1=1
        `;
        const params = [];

        if (contract_id) {
            sql += ' AND qi.contract_id = ?';
            params.push(contract_id);
        }
        if (batch_id) {
            sql += ' AND qi.batch_id = ?';
            params.push(batch_id);
        }

        sql += ' ORDER BY qi.inspected_at DESC';

        const inspections = await dbClient.queryAll(sql, params, dbOpts);
        return res.json({
            success: true,
            count: inspections.length,
            inspections
        });
    } catch (err) {
        console.error('[qualityRoutes] GET /inspections error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. POST /api/quality/inspections
 * Records a new Quality Control inspection
 */
router.post('/inspections', authMiddleware, async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        batch_id,
        contract_id,
        inspection_type,
        sample_size,
        inspected_quantity,
        defect_count,
        defect_details,
        notes
    } = req.body || {};

    try {
        const result = await qualityService.recordInspection({
            batchId: batch_id,
            contractId: contract_id,
            inspectionType: inspection_type,
            sampleSize: sample_size,
            inspectedQuantity: inspected_quantity,
            defectCount: defect_count,
            defectDetails: defect_details,
            inspectorId: user.id,
            inspectorName: user.name || 'Quality Inspector',
            notes,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: `تم تسجيل فحص الجودة بنجاح. النتيجة: (${result.verdict})، نسبة الرفض: ${result.rejection_rate}%`,
            inspection: result
        });
    } catch (err) {
        console.error('[qualityRoutes] POST /inspections error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 3. POST /api/quality/inspections/:id/qa-review
 * Records Quality Assurance (QA) sign-off with strict Separation of Duties
 */
router.post('/inspections/:id/qa-review', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        review_verdict,
        coa_verified,
        lab_accreditation,
        capa_notes
    } = req.body || {};

    try {
        const review = await qualityService.reviewInspectionQA({
            inspectionId: id,
            qaOfficerId: user.id,
            qaOfficerName: user.name || 'QA Director',
            reviewVerdict: review_verdict,
            coaVerified: coa_verified,
            labAccreditation: lab_accreditation,
            capaNotes: capa_notes,
            dbOpts
        });

        return res.json({
            success: true,
            message: `تم توثيق اعتماد توكيد الجودة (QA) بنجاح: (${review.review_verdict})`,
            review
        });
    } catch (err) {
        console.error('[qualityRoutes] POST /inspections/:id/qa-review error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 4. POST /api/quality/mrl-check
 * Evaluates laboratory chemical test results against target market statutory MRL limits
 */
router.post('/mrl-check', async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const { market_country, commodity, lab_results } = req.body || {};

    if (!market_country || !commodity || !Array.isArray(lab_results)) {
        return res.status(400).json({
            success: false,
            error: 'بيانات الفحص غير مكتملة (الدولة المستهدفة، المحصول، ونتائج التحليل المخبري مطلوبة)'
        });
    }

    try {
        const evaluation = await qualityService.evaluateMrlCompliance({
            marketCountry: market_country,
            commodity,
            labResults: lab_results,
            dbOpts
        });

        return res.json({
            success: true,
            ...evaluation
        });
    } catch (err) {
        console.error('[qualityRoutes] POST /mrl-check error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. GET /api/quality/mrl-limits
 * Queries statutory MRL rules database
 */
router.get('/mrl-limits', async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const { market_country, commodity } = req.query || {};

    try {
        await qualityService.ensureMrlLimitsSeeded(dbOpts.tx || null);

        let sql = 'SELECT * FROM mrl_limits WHERE 1=1';
        const params = [];
        if (market_country) {
            sql += ' AND market_country = ?';
            params.push(market_country);
        }
        if (commodity) {
            sql += ' AND commodity LIKE ?';
            params.push(`%${commodity}%`);
        }
        sql += ' ORDER BY market_country, commodity, active_substance ASC';

        const limits = await dbClient.queryAll(sql, params, dbOpts);
        return res.json({
            success: true,
            count: limits.length,
            limits
        });
    } catch (err) {
        console.error('[qualityRoutes] GET /mrl-limits error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 6. POST /api/quality/conditional-release
 * Evaluates and grants conditional release under strict safety boundaries
 */
router.post('/conditional-release', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    const {
        inspection_id,
        contract_id,
        reason,
        permitted_conditions,
        remedial_actions,
        target_market,
        lead_qc_signoff,
        ops_director_signoff,
        identified_defect_categories,
        deadline_days
    } = req.body || {};

    try {
        const release = await qualityService.requestConditionalRelease({
            inspectionId: inspection_id,
            contractId: contract_id,
            reason,
            permittedConditions: permitted_conditions,
            remedialActions: remedial_actions,
            targetMarket: target_market,
            leadQcSignoff: lead_qc_signoff,
            opsDirectorSignoff: ops_director_signoff,
            identifiedDefectCategories: identified_defect_categories || [],
            deadlineDays: deadline_days || 7,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم اعتماد الإفراج المشروط بنجاح بموجب التوقيع الثنائي المعتمد',
            release
        });
    } catch (err) {
        console.error('[qualityRoutes] POST /conditional-release error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
