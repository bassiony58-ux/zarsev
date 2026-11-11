/**
 * src/services/qualityService.js
 * 
 * Quality Control (QC), Quality Assurance (QA), Statutory MRL Engine,
 * and Strict Conditional Release Policy Subsystem for ZARSEV.
 * 
 * Implements Phase 5.0-C, D, E, F requirements:
 * - 5 standardized inspection checkpoints.
 * - QA review with strict separation of duties (Inspector != QA Signoff).
 * - Multi-market statutory MRL compliance engine (EU Reg 396/2005, GSO 382/383, UK HSE).
 * - Distinguishes statutory MRLs (mandatory legal limits) from toxicological metrics (ADI/ARfD).
 * - Strict conditional release policy: ABSOLUTE PROHIBITION on banned substances,
 *   live quarantine pests, and human pathogens. Dual sign-off required (Lead QC + Ops Director).
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const notificationService = require('./notificationService');

const VALID_INSPECTION_TYPES = [
    'RAW_INTAKE',
    'SORTING',
    'IN_LINE',
    'PACKING',
    'PRE_SHIPMENT'
];

// Absolute bans for conditional release (Never permitted under any condition)
const ABSOLUTE_BANNED_DEFECT_CATEGORIES = [
    'BANNED_PESTICIDE_SUBSTANCE',
    'LIVE_QUARANTINE_PEST',
    'PATHOGENIC_MICROORGANISM', // e.g. Salmonella, Listeria, E. coli O157
    'HEAVY_METAL_CONTAMINATION',
    'EXCEEDS_LEGAL_MRL_TARGET_MARKET'
];

/**
 * Seed default statutory MRL limits if empty (e.g. fresh test cluster)
 */
async function ensureMrlLimitsSeeded(client) {
    const db = client || dbClient;
    try {
        const countRes = await db.queryOne('SELECT COUNT(*) as count FROM mrl_limits');
        if (Number(countRes?.count || 0) > 0) return;

        const defaultLimits = [
            // Valencia Oranges / Citrus
            { market: 'EU', commodity: 'Citrus (Valencia Oranges)', substance: 'Imazalil', limit: 4.0, source: 'EU Reg 396/2005 (Amended 2024)', effDate: '2024-01-01', adi: 'ADI: 0.025 mg/kg bw/day' },
            { market: 'EU', commodity: 'Citrus (Valencia Oranges)', substance: 'Chlorpyrifos', limit: 0.01, source: 'EU Reg 2020/1085 (Banned LOD)', effDate: '2020-11-13', adi: 'Banned in EU (Toxicological alert)' },
            { market: 'GCC', commodity: 'Citrus (Valencia Oranges)', substance: 'Imazalil', limit: 5.0, source: 'GSO 382/383:2021', effDate: '2021-06-01', adi: 'ADI: 0.03 mg/kg bw/day' },
            { market: 'GCC', commodity: 'Citrus (Valencia Oranges)', substance: 'Chlorpyrifos', limit: 0.01, source: 'GSO Standardization Council 2023', effDate: '2023-01-01', adi: 'Banned in GCC' },
            { market: 'UK', commodity: 'Citrus (Valencia Oranges)', substance: 'Imazalil', limit: 4.0, source: 'UK HSE GB MRL Statutory Register', effDate: '2024-01-01', adi: 'ADI: 0.025 mg/kg bw/day' },

            // IQF Strawberries
            { market: 'EU', commodity: 'IQF Strawberries', substance: 'Boscalid', limit: 10.0, source: 'EU Reg 396/2005 (Annex II)', effDate: '2023-01-01', adi: 'ADI: 0.04 mg/kg bw/day' },
            { market: 'EU', commodity: 'IQF Strawberries', substance: 'Cyprodinil', limit: 5.0, source: 'EU Reg 396/2005 (Annex II)', effDate: '2023-01-01', adi: 'ADI: 0.03 mg/kg bw/day' },
            { market: 'GCC', commodity: 'IQF Strawberries', substance: 'Boscalid', limit: 10.0, source: 'GSO 382/383:2021', effDate: '2021-06-01', adi: 'ADI: 0.04 mg/kg bw/day' },
            { market: 'UK', commodity: 'IQF Strawberries', substance: 'Boscalid', limit: 10.0, source: 'UK HSE GB MRL Statutory Register', effDate: '2023-01-01', adi: 'ADI: 0.04 mg/kg bw/day' }
        ];

        for (const item of defaultLimits) {
            const id = 'mrl_' + crypto.randomBytes(8).toString('hex');
            await db.execute(`
                INSERT INTO mrl_limits (
                    id, market_country, commodity, active_substance, limit_mg_kg,
                    statutory_source, effective_date, verification_status, toxicological_adi_note, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, CURRENT_TIMESTAMP)
            `, [
                id, item.market, item.commodity, item.substance, item.limit,
                item.source, item.effDate, item.adi
            ]);
        }
    } catch (err) {
        console.warn('[ensureMrlLimitsSeeded] Non-fatal seeding warning:', err.message);
    }
}

/**
 * Records a Quality Control inspection
 */
async function recordInspection({
    batchId,
    contractId,
    inspectionType,
    sampleSize,
    inspectedQuantity,
    defectCount = 0,
    defectDetails = [],
    inspectorId,
    inspectorName,
    notes = '',
    dbOpts = {}
}) {
    if (!VALID_INSPECTION_TYPES.includes(inspectionType)) {
        throw new Error(`نوع الفحص غير مصرح به: ${inspectionType}`);
    }
    if (!sampleSize || Number(sampleSize) <= 0) {
        throw new Error('حجم العينة المفحوصة يجب أن يكون أكبر من صفر');
    }

    const rejectionRate = ((Number(defectCount) / Number(sampleSize)) * 100).toFixed(2);
    let verdict = 'PASSED';

    // Standard agricultural export threshold: > 3.0% defects fails standard pre-shipment
    if (Number(rejectionRate) > 3.0) {
        verdict = 'REJECTED';
    }

    const inspectionId = 'insp_' + crypto.randomBytes(12).toString('hex');
    const inspectionNo = `QC-${new Date().getUTCFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const isPg = dbClient.engine === 'postgres';
    const defectJson = isPg ? defectDetails : JSON.stringify(defectDetails);

    await dbClient.execute(`
        INSERT INTO qc_inspections (
            id, inspection_no, batch_id, contract_id, inspection_type,
            sample_size, inspected_quantity, defect_count, rejection_rate,
            verdict, defect_details, inspector_id, inspector_name,
            inspected_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
        inspectionId,
        inspectionNo,
        batchId,
        contractId,
        inspectionType,
        Number(sampleSize),
        Number(inspectedQuantity),
        Number(defectCount),
        Number(rejectionRate),
        verdict,
        defectJson,
        inspectorId,
        inspectorName
    ], dbOpts);

    return {
        id: inspectionId,
        inspection_no: inspectionNo,
        batch_id: batchId,
        contract_id: contractId,
        inspection_type: inspectionType,
        rejection_rate: Number(rejectionRate),
        verdict
    };
}

/**
 * Quality Assurance review with strict Separation of Duties
 */
async function reviewInspectionQA({
    inspectionId,
    qaOfficerId,
    qaOfficerName,
    reviewVerdict,
    coaVerified = false,
    labAccreditation = null,
    capaNotes = '',
    dbOpts = {}
}) {
    const inspection = await dbClient.queryOne(
        'SELECT * FROM qc_inspections WHERE id = ?',
        [inspectionId],
        dbOpts
    );
    if (!inspection) {
        throw new Error('تقرير فحص الجودة غير موجود');
    }

    // STRICT SEPARATION OF DUTIES: QA signoff cannot be the inspector
    if (inspection.inspector_id === qaOfficerId) {
        throw new Error('مخالفة فصل الصلاحيات (Separation of Duties): لا يجوز لمفتش الجودة اعتماد تقريره كمسؤول توكيد جودة (QA)');
    }

    const validVerdicts = ['APPROVED', 'REVISE_REQUIRED', 'REJECTED'];
    if (!validVerdicts.includes(reviewVerdict)) {
        throw new Error(`قرار مراجعة الجودة غير صالح: ${reviewVerdict}`);
    }

    const reviewId = 'qar_' + crypto.randomBytes(12).toString('hex');

    await dbClient.execute(`
        INSERT INTO qa_reviews (
            id, inspection_id, qa_officer_id, qa_officer_name,
            review_verdict, coa_verified, lab_accreditation,
            capa_notes, signed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
        reviewId,
        inspectionId,
        qaOfficerId,
        qaOfficerName,
        reviewVerdict,
        Boolean(coaVerified),
        labAccreditation,
        capaNotes
    ], dbOpts);

    return {
        id: reviewId,
        inspection_id: inspectionId,
        review_verdict: reviewVerdict,
        coa_verified: Boolean(coaVerified),
        qa_officer_name: qaOfficerName
    };
}

/**
 * Evaluates chemical residue lab results against statutory MRL limits
 */
async function evaluateMrlCompliance({
    marketCountry,
    commodity,
    labResults = [], // array of { active_substance, detected_value_mg_kg, lod_mg_kg }
    dbOpts = {}
}) {
    await ensureMrlLimitsSeeded(dbOpts.tx || null);

    const complianceResults = [];
    let isFullyCompliant = true;
    let criticalBreachCount = 0;

    for (const test of labResults) {
        const substance = test.active_substance?.trim();
        const detected = Number(test.detected_value_mg_kg || 0);

        // Fetch statutory limit
        const limitRecord = await dbClient.queryOne(`
            SELECT * FROM mrl_limits
            WHERE market_country = ? AND commodity = ? AND LOWER(active_substance) = ?
        `, [marketCountry, commodity, substance.toLowerCase()], dbOpts);

        if (!limitRecord || limitRecord.verification_status !== 'VERIFIED' || !limitRecord.statutory_source || !limitRecord.effective_date) {
            // Unregistered active substance or unverified statutory rule: STRICT PROHIBITION on automated compliance pass
            isFullyCompliant = false;

            complianceResults.push({
                active_substance: substance,
                detected_value: detected,
                statutory_limit: limitRecord?.limit_mg_kg ? Number(limitRecord.limit_mg_kg) : null,
                statutory_source: limitRecord?.statutory_source || 'UNVERIFIED_RULE',
                effective_date: limitRecord?.effective_date || null,
                verification_status: 'UNVERIFIED',
                is_compliant: false,
                status: 'BLOCKED_UNVERIFIED_STATUTORY_RULE',
                toxicological_note: 'قاعدة غير معتمدة تشريعياً: لا يسمح بقرار مطابقة آلي دون توثيق قانوني رسمي للمادة والسلعة والسوق وتاريخ السريان'
            });
            continue;
        }

        const legalLimit = Number(limitRecord.limit_mg_kg);
        const isCompliant = detected <= legalLimit;

        if (!isCompliant) {
            isFullyCompliant = false;
            // Check if substance is banned (e.g. Chlorpyrifos)
            if (legalLimit <= 0.01 && limitRecord.statutory_source.includes('Banned')) {
                criticalBreachCount++;
            }
        }

        complianceResults.push({
            active_substance: substance,
            detected_value: detected,
            statutory_limit: legalLimit,
            statutory_source: limitRecord.statutory_source,
            effective_date: limitRecord.effective_date,
            is_compliant: isCompliant,
            status: isCompliant ? 'COMPLIANT' : 'STATUTORY_MRL_EXCEEDED',
            toxicological_note: limitRecord.toxicological_adi_note || 'Statutory MRL enforced'
        });
    }

    return {
        market_country: marketCountry,
        commodity,
        is_compliant: isFullyCompliant,
        critical_breaches: criticalBreachCount,
        verdict: isFullyCompliant 
            ? 'PASSED_MRL' 
            : (criticalBreachCount > 0 
                ? 'CRITICAL_BANNED_SUBSTANCE' 
                : (complianceResults.some(r => r.status === 'BLOCKED_UNVERIFIED_STATUTORY_RULE') 
                    ? 'BLOCKED_UNVERIFIED_RULE' 
                    : 'REJECTED_MRL_EXCEEDED')),
        results: complianceResults
    };
}

/**
 * Requests or signs off Conditional Release under strict safety policy
 */
async function requestConditionalRelease({
    inspectionId,
    contractId,
    reason,
    permittedConditions,
    remedialActions,
    targetMarket,
    leadQcSignoff,
    opsDirectorSignoff,
    identifiedDefectCategories = [],
    deadlineDays = 7,
    dbOpts = {}
}) {
    // 1. Strict Policy Check: Absolute prohibition on dangerous defect categories
    for (const defect of identifiedDefectCategories) {
        if (ABSOLUTE_BANNED_DEFECT_CATEGORIES.includes(defect)) {
            throw new Error(`حظر قاطع (Absolute Ban): لا يجوز منح إفراج مشروط في حالة (${defect}). الإفراج مرفوض قطعياً.`);
        }
    }

    // 2. Dual sign-off check
    if (!leadQcSignoff || !opsDirectorSignoff) {
        throw new Error('الإفراج المشروط يتطلب اعتماداً مزدوجاً إلزامياً من: رئيس قسم الجودة (Lead QC) ومدير العمليات (Operations Director)');
    }

    const releaseId = 'cr_' + crypto.randomBytes(12).toString('hex');
    const deadline = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString();

    await dbClient.execute(`
        INSERT INTO conditional_releases (
            id, inspection_id, contract_id, reason, permitted_conditions,
            remedial_actions, target_market, lead_qc_signoff, ops_director_signoff,
            status, deadline, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, CURRENT_TIMESTAMP)
    `, [
        releaseId,
        inspectionId,
        contractId,
        reason,
        permittedConditions,
        remedialActions,
        targetMarket,
        leadQcSignoff,
        opsDirectorSignoff,
        deadline
    ], dbOpts);

    // Update inspection verdict to CONDITIONAL_RELEASE
    await dbClient.execute(`
        UPDATE qc_inspections
        SET verdict = 'CONDITIONAL_RELEASE'
        WHERE id = ?
    `, [inspectionId], dbOpts);

    return {
        id: releaseId,
        inspection_id: inspectionId,
        contract_id: contractId,
        status: 'APPROVED',
        deadline,
        dual_signoff: {
            lead_qc: leadQcSignoff,
            operations_director: opsDirectorSignoff
        }
    };
}

module.exports = {
    VALID_INSPECTION_TYPES,
    ABSOLUTE_BANNED_DEFECT_CATEGORIES,
    ensureMrlLimitsSeeded,
    recordInspection,
    reviewInspectionQA,
    evaluateMrlCompliance,
    requestConditionalRelease
};
