/**
 * src/services/productionService.js
 * 
 * Production Lifecycle & Batch Traceability Subsystem for ZARSEV.
 * Implements Phase 5.0-B requirements:
 * - Production plan creation tied to confirmed commercial contracts.
 * - Strict multi-tenant isolation by manufacturer.
 * - End-to-end batch & lot number traceability.
 * - 6-stage operational pipeline:
 *   RAW_MATERIAL_INTAKE -> SORTING_GRADING -> PROCESSING -> PACKING -> STORAGE -> DISPATCH_READY.
 * - Quantitative tracking of produced vs rejected output with stage audit logging.
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const notificationService = require('./notificationService');

const VALID_STAGES = [
    'RAW_MATERIAL_INTAKE',
    'SORTING_GRADING',
    'PROCESSING',
    'PACKING',
    'STORAGE',
    'DISPATCH_READY'
];

// Pipeline A: Fresh Horticultural Packhouse Profile (Citrus, Grapes, Garlic, Onions)
// Fresh produce is never processed; moves directly from sorting to packing
const FRESH_PIPELINE = [
    'RAW_MATERIAL_INTAKE',
    'SORTING_GRADING',
    'PACKING',
    'STORAGE',
    'DISPATCH_READY'
];

// Pipeline B: Processed / IQF Frozen Profile (IQF Strawberries, Vegetables, Purees)
const PROCESSED_PIPELINE = [
    'RAW_MATERIAL_INTAKE',
    'SORTING_GRADING',
    'PROCESSING',
    'PACKING',
    'STORAGE',
    'DISPATCH_READY'
];

/**
 * Resolves the commodity pipeline type for a given product or batch.
 */
async function getBatchCommodityPipeline(client, productId, dbOpts = {}) {
    if (!productId) return FRESH_PIPELINE;
    const product = await client.queryOne(
        'SELECT id, name_ar, name_en, category_id, specifications FROM products WHERE id = ?',
        [productId],
        dbOpts
    );
    if (!product) return FRESH_PIPELINE;

    let isProcessed = false;
    if (product.specifications) {
        let specs = product.specifications;
        if (typeof specs === 'string') {
            try { specs = JSON.parse(specs); } catch (_) {}
        }
        if (specs && (specs.pipeline_type === 'PROCESSED' || specs.pipeline_type === 'IQF' || specs.is_iqf)) {
            isProcessed = true;
        }
    }

    const catId = (product.category_id || '').toLowerCase();
    const nameEn = (product.name_en || '').toLowerCase();
    const nameAr = product.name_ar || '';

    if (catId.includes('iqf') || catId.includes('process') || catId.includes('frozen') ||
        nameEn.includes('iqf') || nameEn.includes('frozen') || nameEn.includes('processed') ||
        nameAr.includes('مجمد') || nameAr.includes('تجميد') || nameAr.includes('معالجة')) {
        isProcessed = true;
    }

    return isProcessed ? PROCESSED_PIPELINE : FRESH_PIPELINE;
}

/**
 * Calculates percentage completion based on pipeline stage and commodity type
 */
function calculateStageReadiness(stage, pipeline = PROCESSED_PIPELINE) {
    if (pipeline === FRESH_PIPELINE) {
        const stageMap = {
            'RAW_MATERIAL_INTAKE': 20,
            'SORTING_GRADING': 45,
            'PACKING': 70,
            'STORAGE': 90,
            'DISPATCH_READY': 100
        };
        return stageMap[stage] || 0;
    }
    const stageMap = {
        'RAW_MATERIAL_INTAKE': 15,
        'SORTING_GRADING': 35,
        'PROCESSING': 60,
        'PACKING': 80,
        'STORAGE': 95,
        'DISPATCH_READY': 100
    };
    return stageMap[stage] || 0;
}

/**
 * Creates a new production batch under a confirmed commercial contract
 */
async function createProductionPlan({
    contractId,
    manufacturerId,
    lotNumber,
    targetQuantity,
    uom = 'KG',
    startDate = null,
    endDate = null,
    notes = '',
    dbOpts = {}
}) {
    if (!contractId || !manufacturerId || !lotNumber || !targetQuantity) {
        throw new Error('بيانات خطة الإنتاج غير مكتملة (رقم العقد، الدفعة، والكمية المستهدفة مطلوبة)');
    }

    let batchResult = null;

    await dbClient.transaction(async (tx) => {
        // 1. Verify contract belongs to manufacturer and is active
        const contract = await tx.queryOne(`
            SELECT id, contract_no, manufacturer_id, rfq_id, status
            FROM commercial_contracts
            WHERE id = ?
        `, [contractId]);

        if (!contract) {
            throw new Error('العقد التجاري غير موجود');
        }
        if (contract.manufacturer_id !== manufacturerId) {
            throw new Error('غير مصرح: العقد التجاري لا يخص هذه المنشأة المصنعة');
        }
        if (!['CONFIRMED', 'IN_PRODUCTION'].includes(contract.status)) {
            throw new Error(`لا يمكن بدء الإنتاج لعقد بحالة: ${contract.status}`);
        }

        // Get product_id from RFQ
        const rfq = await tx.queryOne('SELECT product_id FROM rfqs WHERE id = ?', [contract.rfq_id]);
        const productId = rfq?.product_id;
        if (!productId) {
            throw new Error('تعذر تحديد المنتج المرتبط بالعقد');
        }

        // 2. Generate batch number
        const now = new Date();
        const yearMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const randSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
        const batchNo = `BATCH-${yearMonth}-${randSuffix}`;
        const batchId = 'btch_' + crypto.randomBytes(12).toString('hex');

        // 3. Insert Production Batch
        await tx.execute(`
            INSERT INTO production_batches (
                id, batch_no, contract_id, manufacturer_id, product_id,
                lot_number, target_quantity, produced_quantity, rejected_quantity,
                uom, start_date, end_date, stage, readiness_pct, notes,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'RAW_MATERIAL_INTAKE', 15, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            batchId,
            batchNo,
            contractId,
            manufacturerId,
            productId,
            lotNumber.trim(),
            Number(targetQuantity),
            uom,
            startDate || new Date().toISOString().substring(0, 10),
            endDate,
            notes
        ]);

        // 4. Update contract status to IN_PRODUCTION
        await tx.execute(`
            UPDATE commercial_contracts
            SET status = 'IN_PRODUCTION', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [contractId]);

        // 5. Initial stage log
        await tx.execute(`
            INSERT INTO production_stage_logs (
                id, batch_id, stage, quantity_in, quantity_out, rejected_qty, operator_name, notes, recorded_at
            ) VALUES (?, ?, 'RAW_MATERIAL_INTAKE', ?, 0, 0, 'Production Supervisor', 'بدء استلام وتجهيز المواد الخام لتشغيل الدفعة', CURRENT_TIMESTAMP)
        `, [
            'plog_' + crypto.randomBytes(8).toString('hex'),
            batchId,
            Number(targetQuantity)
        ]);

        batchResult = {
            id: batchId,
            batch_no: batchNo,
            contract_id: contractId,
            lot_number: lotNumber,
            target_quantity: Number(targetQuantity),
            uom,
            stage: 'RAW_MATERIAL_INTAKE',
            readiness_pct: 15
        };
    }, dbOpts);

    return batchResult;
}

/**
 * Records stage advancement and output metrics for a batch (DEF-10)
 * Enforces commodity-specific stage progression (Fresh vs Processed IQF)
 * and prevents unauthorized stage skipping without schema DDL changes.
 */
async function recordStageProgress({
    batchId,
    manufacturerId,
    stage,
    quantityIn,
    quantityOut,
    rejectedQty = 0,
    operatorName = 'Production Line Lead',
    notes = '',
    dbOpts = {}
}) {
    if (!VALID_STAGES.includes(stage)) {
        const err = new Error(`مرحلة التصنيع غير صالحة: ${stage}`);
        err.code = 'INVALID_STAGE';
        err.status = 400;
        throw err;
    }

    let updatedBatch = null;

    await dbClient.transaction(async (tx) => {
        const batch = await tx.queryOne(
            'SELECT * FROM production_batches WHERE id = ?',
            [batchId]
        );
        if (!batch) {
            const err = new Error('دفعة الإنتاج غير موجودة');
            err.code = 'BATCH_NOT_FOUND';
            err.status = 404;
            throw err;
        }
        if (manufacturerId && batch.manufacturer_id !== manufacturerId) {
            const err = new Error('غير مصرح بتعديل بيانات هذه الدفعة');
            err.code = 'FORBIDDEN';
            err.status = 403;
            throw err;
        }

        // 1. Resolve Commodity-Specific Pipeline
        const pipeline = await getBatchCommodityPipeline(tx, batch.product_id, dbOpts);

        // 2. Validate Stage Applicability to this Pipeline
        if (!pipeline.includes(stage)) {
            const pipelineName = pipeline === FRESH_PIPELINE ? 'Fresh Horticultural' : 'Processed IQF';
            const err = new Error(`STAGE_NOT_APPLICABLE: Stage (${stage}) is not applicable for ${pipelineName} pipeline`);
            err.code = 'STAGE_NOT_APPLICABLE';
            err.status = 400;
            throw err;
        }

        // 3. Prevent Unauthorized Stage Skipping
        const currentStage = batch.stage || 'RAW_MATERIAL_INTAKE';
        const currIdx = pipeline.indexOf(currentStage);
        const targetIdx = pipeline.indexOf(stage);

        if (targetIdx > currIdx + 1) {
            const skippedStages = pipeline.slice(currIdx + 1, targetIdx);
            const err = new Error(`STAGE_SKIPPED: Cannot jump from (${currentStage}) directly to (${stage}) without completing intermediate stages: [${skippedStages.join(', ')}]`);
            err.code = 'STAGE_SKIPPED';
            err.status = 400;
            throw err;
        }

        // 4. Pre-condition Verification for DISPATCH_READY
        if (stage === 'DISPATCH_READY') {
            const mandatoryStages = pipeline === FRESH_PIPELINE
                ? ['RAW_MATERIAL_INTAKE', 'SORTING_GRADING', 'PACKING']
                : ['RAW_MATERIAL_INTAKE', 'SORTING_GRADING', 'PROCESSING', 'PACKING'];

            const existingLogs = await tx.queryAll(
                'SELECT stage, quantity_out FROM production_stage_logs WHERE batch_id = ?',
                [batchId],
                dbOpts
            );

            const completedStages = new Set();
            for (const log of (existingLogs || [])) {
                if (Number(log.quantity_out || 0) > 0) {
                    completedStages.add(log.stage);
                }
            }

            // Include current transaction if it produces output
            if (Number(quantityOut || 0) > 0) {
                completedStages.add(stage);
            }

            const missingStages = mandatoryStages.filter(s => !completedStages.has(s));
            if (missingStages.length > 0) {
                const err = new Error(`STAGE_COMPLETION_MISSING: Cannot advance to DISPATCH_READY; upstream mandatory stages lack completed logs with quantity_out > 0: [${missingStages.join(', ')}]`);
                err.code = 'STAGE_COMPLETION_MISSING';
                err.status = 400;
                throw err;
            }
        }

        const readiness = calculateStageReadiness(stage, pipeline);
        const cumProduced = Number(batch.produced_quantity || 0) + Number(quantityOut || 0);
        const cumRejected = Number(batch.rejected_quantity || 0) + Number(rejectedQty || 0);

        await tx.execute(`
            UPDATE production_batches
            SET stage = ?,
                readiness_pct = ?,
                produced_quantity = ?,
                rejected_quantity = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            stage,
            readiness,
            cumProduced,
            cumRejected,
            batchId
        ]);

        await tx.execute(`
            INSERT INTO production_stage_logs (
                id, batch_id, stage, quantity_in, quantity_out, rejected_qty, operator_name, notes, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            'plog_' + crypto.randomBytes(8).toString('hex'),
            batchId,
            stage,
            Number(quantityIn || 0),
            Number(quantityOut || 0),
            Number(rejectedQty || 0),
            operatorName,
            notes
        ]);

        updatedBatch = await tx.queryOne('SELECT * FROM production_batches WHERE id = ?', [batchId]);
    }, dbOpts);

    return updatedBatch;
}

/**
 * Lists production batches with multi-tenant filtering
 */
async function listBatches({
    manufacturerId = null,
    contractId = null,
    dbOpts = {}
}) {
    let sql = `
        SELECT pb.*, c.contract_no, c.buyer_company, p.name_ar as product_name_ar, p.name_en as product_name_en
        FROM production_batches pb
        JOIN commercial_contracts c ON pb.contract_id = c.id
        JOIN products p ON pb.product_id = p.id
        WHERE 1=1
    `;
    const params = [];

    if (manufacturerId) {
        sql += ' AND pb.manufacturer_id = ?';
        params.push(manufacturerId);
    }
    if (contractId) {
        sql += ' AND pb.contract_id = ?';
        params.push(contractId);
    }

    sql += ' ORDER BY pb.created_at DESC';

    const batches = await dbClient.queryAll(sql, params, dbOpts);
    return batches;
}

/**
 * Gets production batch details including chronological stage logs
 */
async function getBatchById(batchId, { manufacturerId = null, dbOpts = {} } = {}) {
    const batch = await dbClient.queryOne(`
        SELECT pb.*, c.contract_no, c.buyer_company, p.name_ar as product_name_ar, p.name_en as product_name_en
        FROM production_batches pb
        JOIN commercial_contracts c ON pb.contract_id = c.id
        JOIN products p ON pb.product_id = p.id
        WHERE pb.id = ?
    `, [batchId], dbOpts);

    if (!batch) {
        throw new Error('دفعة الإنتاج غير موجودة');
    }
    if (manufacturerId && batch.manufacturer_id !== manufacturerId) {
        throw new Error('غير مصرح بالوصول إلى بيانات هذه الدفعة');
    }

    const stageLogs = await dbClient.queryAll(`
        SELECT * FROM production_stage_logs
        WHERE batch_id = ?
        ORDER BY recorded_at ASC
    `, [batchId], dbOpts);

    return {
        batch,
        stageLogs
    };
}

module.exports = {
    VALID_STAGES,
    FRESH_PIPELINE,
    PROCESSED_PIPELINE,
    getBatchCommodityPipeline,
    calculateStageReadiness,
    createProductionPlan,
    recordStageProgress,
    listBatches,
    getBatchById
};
