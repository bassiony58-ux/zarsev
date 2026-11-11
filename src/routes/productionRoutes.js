/**
 * src/routes/productionRoutes.js
 * 
 * Production Lifecycle & Batch Traceability API for ZARSEV.
 * Implements Phase 5.0-B:
 * - Production plan creation tied to confirmed commercial contracts.
 * - Multi-tenant scoping for manufacturers.
 * - 6-stage operational pipeline execution.
 */

const express = require('express');
const router = express.Router();
const productionService = require('../services/productionService');
const { authMiddleware, requireRole, requireSubRole } = require('../middlewares/auth');

/**
 * 1. GET /api/production/batches
 * Lists production batches
 */
router.get('/batches', authMiddleware, async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const { contract_id } = req.query || {};

    const manufacturerId = user.role === 'MANUFACTURER' ? user.manufacturer_id : null;

    try {
        const batches = await productionService.listBatches({
            manufacturerId,
            contractId: contract_id,
            dbOpts
        });

        return res.json({
            success: true,
            count: batches.length,
            batches
        });
    } catch (err) {
        console.error('[productionRoutes] GET /batches error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. GET /api/production/batches/:id
 * Fetches batch details with stage logs
 */
router.get('/batches/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const manufacturerId = user.role === 'MANUFACTURER' ? user.manufacturer_id : null;

    try {
        const data = await productionService.getBatchById(id, {
            manufacturerId,
            dbOpts
        });

        return res.json({
            success: true,
            ...data
        });
    } catch (err) {
        console.error('[productionRoutes] GET /batches/:id error:', err);
        const status = err.message.includes('غير مصرح') ? 403 : 404;
        return res.status(status).json({ success: false, error: err.message });
    }
});

/**
 * 3. POST /api/production/batches
 * Creates a production plan for a contract
 */
router.post('/batches', authMiddleware, requireSubRole(['OWNER', 'PRODUCTION'], { allowRoles: ['SUPER_ADMIN'] }), async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        contract_id,
        lot_number,
        target_quantity,
        uom,
        start_date,
        end_date,
        notes
    } = req.body || {};

    const manufacturerId = user.role === 'MANUFACTURER' ? user.manufacturer_id : req.body.manufacturer_id;

    try {
        const batch = await productionService.createProductionPlan({
            contractId: contract_id,
            manufacturerId,
            lotNumber: lot_number,
            targetQuantity: target_quantity,
            uom,
            startDate: start_date,
            endDate: end_date,
            notes,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم اعتماد خطة الإنتاج وتسجيل رقم الدفعة بنجاح',
            batch
        });
    } catch (err) {
        console.error('[productionRoutes] POST /batches error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 4. POST /api/production/batches/:id/stages
 * Records progress and advances stage in the production pipeline
 */
router.post('/batches/:id/stages', authMiddleware, requireSubRole(['OWNER', 'PRODUCTION'], { allowRoles: ['SUPER_ADMIN'] }), async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        stage,
        quantity_in,
        quantity_out,
        rejected_qty,
        operator_name,
        notes
    } = req.body || {};

    const manufacturerId = user.role === 'MANUFACTURER' ? user.manufacturer_id : null;

    try {
        const updatedBatch = await productionService.recordStageProgress({
            batchId: id,
            manufacturerId,
            stage,
            quantityIn: quantity_in,
            quantityOut: quantity_out,
            rejectedQty: rejected_qty,
            operatorName: operator_name || user.name || 'Production Lead',
            notes,
            dbOpts
        });

        return res.json({
            success: true,
            message: `تم تحديث مرحلة التشغيل إلى (${stage}) بنجاح`,
            batch: updatedBatch
        });
    } catch (err) {
        console.error('[productionRoutes] POST /batches/:id/stages error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
