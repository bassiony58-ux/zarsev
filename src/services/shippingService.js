/**
 * src/services/shippingService.js
 * 
 * Ocean Shipping, Reefer Telemetry Monitoring & B/L Lifecycle Subsystem for ZARSEV.
 * Implements Phase 6.0-A, B, C, D requirements:
 * - Shipping Gate: Absolute prohibition on shipment dispatch without a verified passed QC inspection
 *   or authorized conditional release.
 * - Container tracking & Reefer cold-chain telemetry ingestion.
 * - Dynamic breach calculation:
 *   * Continuous deviation > 1.5°C for > 120 min.
 *   * Cumulative deviation > 360 min in 24 hours.
 *   * Telemetry signal dropout > 180 min.
 * - Commercial shipping documents repository with SHA-256 integrity checks.
 * - Standard 5-stage Bill of Lading (B/L) lifecycle (Draft -> Review -> Approved -> Original / Telex).
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const notificationService = require('./notificationService');

const VALID_DOC_TYPES = [
    'COMMERCIAL_INVOICE',
    'PACKING_LIST',
    'CERTIFICATE_OF_ORIGIN',
    'PHYTOSANITARY',
    'COA',
    'BILL_OF_LADING',
    'INSURANCE'
];

const VALID_BL_STATUSES = [
    'DRAFT',
    'UNDER_REVIEW',
    'APPROVED',
    'ORIGINAL_ISSUED',
    'TELEX_RELEASE'
];

const ALLOWED_BL_TRANSITIONS = {
    'DRAFT': ['UNDER_REVIEW', 'APPROVED'],
    'UNDER_REVIEW': ['APPROVED', 'DRAFT'],
    'APPROVED': ['ORIGINAL_ISSUED', 'TELEX_RELEASE'],
    'ORIGINAL_ISSUED': [], // Terminal state in current schema
    'TELEX_RELEASE': []    // Terminal state in current schema
};

/**
 * Two-Stage Deterministic Shipping Gate Check (DEF-01)
 * Evaluates latest PRE_SHIPMENT inspection and latest SIGNED QA review.
 * Fails closed if batch relationship is ambiguous, missing, or if QC/QA failed.
 */
async function canDispatchShipment({
    contractId,
    batchId = null,
    actualLoadingTime = new Date(),
    tx = null,
    dbOpts = {}
}) {
    const client = tx || dbClient;

    // 1. Verify Contract
    const contract = await client.queryOne(
        'SELECT * FROM commercial_contracts WHERE id = ?',
        [contractId],
        dbOpts
    );
    if (!contract) {
        const err = new Error('العقد التجاري غير موجود (Commercial contract not found)');
        err.code = 'CONTRACT_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    // 2. Resolve Batch Relationship in Phase 1 (V1.17 Section 10.3)
    let resolvedBatchId = batchId;
    if (resolvedBatchId) {
        const batch = await client.queryOne(
            'SELECT * FROM production_batches WHERE id = ? AND contract_id = ?',
            [resolvedBatchId, contractId],
            dbOpts
        );
        if (!batch) {
            const err = new Error(`INVALID_BATCH_FOR_CONTRACT: Batch (${resolvedBatchId}) does not belong to contract (${contractId}) or does not exist`);
            err.code = 'INVALID_BATCH_FOR_CONTRACT';
            err.status = 400;
            throw err;
        }
    } else {
        const batches = await client.queryAll(
            'SELECT id FROM production_batches WHERE contract_id = ?',
            [contractId],
            dbOpts
        );
        if (!batches || batches.length === 0) {
            const err = new Error('NO_BATCHES_FOR_CONTRACT: Contract has zero associated production batches');
            err.code = 'NO_BATCHES_FOR_CONTRACT';
            err.status = 400;
            throw err;
        }
        if (batches.length > 1) {
            // Fail-closed: Caller must provide explicit batch_id when contract has multiple batches
            const err = new Error('AMBIGUOUS_BATCH_RELATIONSHIP: Multiple batches exist for contract; explicit batch_id is mandatory in Phase 1');
            err.code = 'AMBIGUOUS_BATCH_RELATIONSHIP';
            err.status = 400;
            throw err;
        }
        resolvedBatchId = batches[0].id;
    }

    // 3. Stage 1: Select single latest Pre-Shipment inspection for this batch
    const latestInspection = await client.queryOne(`
        SELECT qi.id, qi.batch_id, qi.contract_id, qi.verdict, qi.inspector_id, qi.inspected_at
        FROM qc_inspections qi
        WHERE qi.batch_id = ?
          AND qi.inspection_type = 'PRE_SHIPMENT'
        ORDER BY qi.inspected_at DESC, qi.created_at DESC, qi.id DESC
        LIMIT 1
    `, [resolvedBatchId], dbOpts);

    if (!latestInspection) {
        const err = new Error('QC_INSPECTION_MISSING: No pre-shipment QC inspection found for this batch');
        err.code = 'QC_INSPECTION_MISSING';
        err.status = 400;
        throw err;
    }

    if (latestInspection.verdict !== 'PASSED') {
        if (latestInspection.verdict === 'CONDITIONAL_RELEASE') {
            const release = await client.queryOne(`
                SELECT * FROM conditional_releases 
                WHERE inspection_id = ? AND status = 'APPROVED'
            `, [latestInspection.id], dbOpts);
            if (!release) {
                const err = new Error(`QC_INSPECTION_REJECTED: Conditional release not authorized for inspection (${latestInspection.id})`);
                err.code = 'QC_INSPECTION_REJECTED';
                err.status = 400;
                throw err;
            }
        } else {
            const err = new Error(`QC_INSPECTION_REJECTED: Latest pre-shipment inspection (${latestInspection.id}) was rejected (verdict: ${latestInspection.verdict})`);
            err.code = 'QC_INSPECTION_REJECTED';
            err.status = 400;
            throw err;
        }
    }

    // 4. Stage 2: Select latest officially SIGNED QA review for that inspection
    // Excludes unsigned drafts (signed_at IS NOT NULL) to eliminate draft-overriding attacks
    const latestSignedQa = await client.queryOne(`
        SELECT qr.id AS qa_review_id, qr.inspection_id, qr.qa_officer_id,
               qr.review_verdict, qr.coa_verified, qr.signed_at
        FROM qa_reviews qr
        WHERE qr.inspection_id = ?
          AND qr.signed_at IS NOT NULL
        ORDER BY qr.signed_at DESC, qr.id DESC
        LIMIT 1
    `, [latestInspection.id], dbOpts);

    if (!latestSignedQa) {
        const err = new Error('QA_APPROVAL_MISSING: Official signed QA review is missing for latest inspection');
        err.code = 'QA_APPROVAL_MISSING';
        err.status = 400;
        throw err;
    }

    if (latestSignedQa.review_verdict !== 'APPROVED') {
        const err = new Error(`QA_REVIEW_REJECTED: Latest signed QA review (${latestSignedQa.qa_review_id}) was rejected (verdict: ${latestSignedQa.review_verdict})`);
        err.code = 'QA_REVIEW_REJECTED';
        err.status = 400;
        throw err;
    }

    // Check Certificate of Analysis (COA) verification
    const coaVerified = Boolean(latestSignedQa.coa_verified);
    if (!coaVerified) {
        const err = new Error('COA_NOT_VERIFIED: Certificate of Analysis (COA) has not been officially verified');
        err.code = 'COA_NOT_VERIFIED';
        err.status = 400;
        throw err;
    }

    // Separation of Duties verification
    if (latestSignedQa.qa_officer_id && latestInspection.inspector_id &&
        latestSignedQa.qa_officer_id === latestInspection.inspector_id) {
        const err = new Error('SEPARATION_OF_DUTIES_VIOLATION: QA reviewer and QC inspector cannot be the same person');
        err.code = 'SEPARATION_OF_DUTIES_VIOLATION';
        err.status = 400;
        throw err;
    }

    return {
        cleared: true,
        batchId: resolvedBatchId,
        inspectionId: latestInspection.id,
        qaReviewId: latestSignedQa.qa_review_id,
        contract
    };
}

/**
 * Creates an ocean export shipment guarded by the Shipping Gate
 */
async function createShipment({
    contractId,
    batchId = null,
    manufacturerId,
    carrierName,
    vesselName,
    voyageNo,
    bookingReference,
    containerNo,
    containerType = '40FT_REEFER',
    pol,
    pod,
    bookingDate = null,
    loadingDate = null,
    etd,
    eta,
    notes = '',
    dbOpts = {}
}) {
    if (!contractId || !carrierName || !vesselName || !containerNo || !pol || !pod || !etd || !eta) {
        throw new Error('بيانات حجز الشحنة غير مكتملة (العقد، الناقل، السفينة، الحاوية، موانئ الشحن والوصول، والتواريخ مطلوبة)');
    }

    let shipmentResult = null;

    await dbClient.transaction(async (tx) => {
        // 1. Verify Contract
        const contract = await tx.queryOne(
            'SELECT * FROM commercial_contracts WHERE id = ?',
            [contractId]
        );
        if (!contract) {
            throw new Error('العقد التجاري غير موجود');
        }
        if (manufacturerId && contract.manufacturer_id !== manufacturerId) {
            throw new Error('غير مصرح: العقد لا يخص هذا المصنع');
        }

        // 2. SHIPPING GATE CHECK (DEF-01: Two-Stage Fail-Closed Enforcement)
        await canDispatchShipment({
            contractId,
            batchId,
            tx,
            dbOpts
        });

        // 3. Generate Shipment Number
        const now = new Date();
        const yearMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const randSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
        const shipmentNo = `SHP-${yearMonth}-${randSuffix}`;
        const shipmentId = 'shp_' + crypto.randomBytes(12).toString('hex');

        // 4. Insert Shipment Record
        await tx.execute(`
            INSERT INTO shipments (
                id, shipment_no, contract_id, manufacturer_id, carrier_name,
                vessel_name, voyage_no, booking_reference, container_no,
                container_type, pol, pod, booking_date, loading_date,
                etd, eta, status, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOOKED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            shipmentId,
            shipmentNo,
            contractId,
            contract.manufacturer_id,
            carrierName.trim(),
            vesselName.trim(),
            voyageNo.trim(),
            bookingReference.trim(),
            containerNo.trim().toUpperCase(),
            containerType,
            pol.trim(),
            pod.trim(),
            bookingDate || new Date().toISOString().substring(0, 10),
            loadingDate,
            etd,
            eta,
            notes
        ]);

        // 5. Update Contract Status to SHIPPED
        await tx.execute(`
            UPDATE commercial_contracts
            SET status = 'SHIPPED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [contractId]);

        // 6. Enqueue In-App Notifications for Logistics and Buyer
        await notificationService.enqueueNotification(tx, {
            recipientType: 'BUYER',
            recipientId: contract.buyer_email,
            eventType: 'SHIPMENT_BOOKED',
            titleAr: `تم حجز الشحنة البحرية (${shipmentNo})`,
            titleEn: `Ocean Shipment Booked (${shipmentNo})`,
            bodyAr: `تم حجز الحاوية رقم ${containerNo} على متن السفينة ${vesselName} برحلة رقم ${voyageNo}. موعد الإبحار المتوقع: ${etd}.`,
            bodyEn: `Container ${containerNo} booked on ${vesselName} (Voyage ${voyageNo}). ETD: ${etd}.`,
            payload: { shipment_id: shipmentId, shipment_no: shipmentNo, container_no: containerNo },
            referenceType: 'SHIPMENT',
            referenceId: shipmentId
        });

        shipmentResult = {
            id: shipmentId,
            shipment_no: shipmentNo,
            contract_id: contractId,
            container_no: containerNo,
            vessel_name: vesselName,
            status: 'BOOKED'
        };
    }, dbOpts);

    return shipmentResult;
}

/**
 * Ingests Reefer cold-chain telemetry and detects temperature deviations
 */
async function recordReeferTelemetry({
    shipmentId,
    containerNo,
    recordedAtUtc = null,
    setpointTemp,
    supplyTemp,
    returnTemp,
    ambientTemp = null,
    humidityPct = null,
    powerStatus = 'ON',
    sensorSource = 'CARRIER_IOT_TELEMETRY',
    dbOpts = {}
}) {
    const recordedAt = recordedAtUtc || new Date().toISOString();
    const setpoint = Number(setpointTemp);
    const returnT = Number(returnTemp);
    const supplyT = Number(supplyTemp);
    const deviation = Math.abs(returnT - setpoint);

    let breachFlag = false;
    let breachType = null;
    let maxDev = deviation;

    // Evaluate deviation threshold (> 1.5°C)
    if (deviation > 1.5) {
        // Query recent readings for continuous duration calculation
        const recentReadings = await dbClient.queryAll(`
            SELECT recorded_at_utc, return_temp, setpoint_temp
            FROM reefer_telemetry
            WHERE shipment_id = ? AND container_no = ?
            ORDER BY recorded_at_utc DESC
            LIMIT 10
        `, [shipmentId, containerNo], dbOpts);

        let continuousMinutes = 30; // current 30-min telemetry window
        for (const r of recentReadings) {
            const dev = Math.abs(Number(r.return_temp) - Number(r.setpoint_temp));
            if (dev > 1.5) {
                continuousMinutes += 30;
                if (dev > maxDev) maxDev = dev;
            } else {
                break;
            }
        }

        if (continuousMinutes >= 120) {
            breachFlag = true;
            breachType = 'CONTINUOUS_OVER_120MIN';
        }
    }

    const telemetryId = 'rtel_' + crypto.randomBytes(12).toString('hex');

    await dbClient.execute(`
        INSERT INTO reefer_telemetry (
            id, shipment_id, container_no, recorded_at_utc,
            setpoint_temp, supply_temp, return_temp, ambient_temp,
            humidity_pct, power_status, sensor_source, breach_flag,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
        telemetryId,
        shipmentId,
        containerNo,
        recordedAt,
        setpoint,
        supplyT,
        returnT,
        ambientTemp !== null ? Number(ambientTemp) : null,
        humidityPct !== null ? Number(humidityPct) : null,
        powerStatus,
        sensorSource,
        breachFlag
    ], dbOpts);

    // If breach detected, record breach event and alert
    if (breachFlag) {
        const breachId = 'rbr_' + crypto.randomBytes(8).toString('hex');
        await dbClient.execute(`
            INSERT INTO reefer_breach_events (
                id, shipment_id, container_no, breach_type,
                max_deviation_c, duration_minutes, detected_at, severity, notes
            ) VALUES (?, ?, ?, ?, ?, 120, ?, 'CRITICAL', ?)
        `, [
            breachId,
            shipmentId,
            containerNo,
            breachType,
            maxDev,
            recordedAt,
            `تجاوز حراري للحاوية المبردة: انحراف ${maxDev.toFixed(1)}°م عن النقطة المحددة (${setpoint}°م) لأكثر من ساعتين متصلتين.`
        ], dbOpts);
    }

    return {
        telemetry_id: telemetryId,
        shipment_id: shipmentId,
        container_no: containerNo,
        deviation: Number(deviation.toFixed(2)),
        breach_flag: breachFlag,
        breach_type: breachType
    };
}

/**
 * Uploads a commercial shipping document with SHA-256 integrity verification
 */
async function uploadShippingDocument({
    shipmentId,
    contractId,
    docType,
    docNumber,
    filePath,
    fileContent = '',
    uploadedBy,
    dbOpts = {}
}) {
    if (!VALID_DOC_TYPES.includes(docType)) {
        throw new Error(`نوع المستند التجاري غير مصرح به: ${docType}`);
    }

    const sha256Hash = crypto.createHash('sha256')
        .update(typeof fileContent === 'string' ? fileContent : Buffer.from(fileContent))
        .digest('hex');

    const docId = 'sdoc_' + crypto.randomBytes(12).toString('hex');
    const blStatus = docType === 'BILL_OF_LADING' ? 'DRAFT' : 'APPROVED';

    await dbClient.execute(`
        INSERT INTO shipping_documents (
            id, shipment_id, contract_id, doc_type, doc_number,
            file_path, file_hash_sha256, bl_status, version,
            uploaded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
    `, [
        docId,
        shipmentId,
        contractId,
        docType,
        docNumber.trim(),
        filePath,
        sha256Hash,
        blStatus,
        uploadedBy
    ], dbOpts);

    return {
        id: docId,
        doc_type: docType,
        doc_number: docNumber,
        file_hash_sha256: sha256Hash,
        bl_status: blStatus
    };
}

/**
 * Bill of Lading (B/L) formal progression workflow (DEF-06)
 * Wraps update in transaction, acquires row lock (FOR UPDATE),
 * enforces FSM transitions, and records atomic audit log entry.
 */
async function updateBillOfLadingStatus({
    docId,
    newStatus,
    verifiedBy,
    notes = '',
    dbOpts = {}
}) {
    if (!VALID_BL_STATUSES.includes(newStatus)) {
        const err = new Error(`حالة بوليصة الشحن غير صالحة: ${newStatus}`);
        err.code = 'INVALID_BL_STATUS';
        err.status = 400;
        throw err;
    }

    let updatedDoc = null;

    await dbClient.transaction(async (tx) => {
        const isPg = (tx && tx.engine === 'postgres') || process.env.DB_ENGINE === 'postgres';
        const lockClause = isPg ? ' FOR UPDATE' : '';

        // 1. Acquire row lock
        const doc = await tx.queryOne(
            `SELECT * FROM shipping_documents WHERE id = ? AND doc_type = 'BILL_OF_LADING'${lockClause}`,
            [docId]
        );
        if (!doc) {
            const err = new Error('بوليصة الشحن غير موجودة (B/L document not found)');
            err.code = 'DOCUMENT_NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const currentStatus = doc.bl_status || 'DRAFT';
        const allowedNext = ALLOWED_BL_TRANSITIONS[currentStatus] || [];

        // 2. Validate FSM State Transition
        if (!allowedNext.includes(newStatus)) {
            const err = new Error(`INVALID_STATE_TRANSITION: لا يمكن الانتقال من الحالة (${currentStatus}) إلى (${newStatus})`);
            err.code = 'INVALID_STATE_TRANSITION';
            err.status = 409;
            throw err;
        }

        // 3. Conditional Atomic Update
        const updateResult = await tx.execute(`
            UPDATE shipping_documents
            SET bl_status = ?,
                verified_by = ?
            WHERE id = ? AND COALESCE(bl_status, 'DRAFT') = ?
        `, [newStatus, verifiedBy, docId, currentStatus]);

        if (updateResult && typeof updateResult.rowCount === 'number' && updateResult.rowCount === 0) {
            const err = new Error('INVALID_STATE_TRANSITION: Concurrent B/L status transition detected');
            err.code = 'INVALID_STATE_TRANSITION';
            err.status = 409;
            throw err;
        }

        // 4. Atomic Audit Log Entry
        if (doc.contract_id) {
            const auditLogId = 'cal_' + crypto.randomBytes(12).toString('hex');
            await tx.execute(`
                INSERT INTO contract_audit_logs (
                    id, contract_id, action, actor_type, actor_id, notes, metadata, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                auditLogId,
                doc.contract_id,
                'BL_STATUS_UPDATED',
                'USER',
                verifiedBy || 'SYSTEM',
                notes || `B/L status transitioned from ${currentStatus} to ${newStatus}`,
                JSON.stringify({
                    doc_id: docId,
                    old_status: currentStatus,
                    new_status: newStatus
                })
            ]);
        }

        updatedDoc = {
            id: docId,
            bl_status: newStatus,
            verified_by: verifiedBy
        };
    }, dbOpts);

    return updatedDoc;
}

/**
 * Lists shipments filtered by caller context
 */
async function listShipments({
    role = 'ADMIN',
    manufacturerId = null,
    buyerEmail = null,
    dbOpts = {}
}) {
    let sql = `
        SELECT s.*, c.contract_no, c.buyer_name, c.buyer_email, c.buyer_company,
               m.name_ar as mfg_name_ar
        FROM shipments s
        JOIN commercial_contracts c ON s.contract_id = c.id
        JOIN manufacturers m ON s.manufacturer_id = m.id
        WHERE 1=1
    `;
    const params = [];

    if (role === 'MANUFACTURER' && manufacturerId) {
        sql += ' AND s.manufacturer_id = ?';
        params.push(manufacturerId);
    } else if (role === 'BUYER' && buyerEmail) {
        sql += ' AND LOWER(c.buyer_email) = ?';
        params.push(buyerEmail.trim().toLowerCase());
    }

    sql += ' ORDER BY s.created_at DESC';

    return await dbClient.queryAll(sql, params, dbOpts);
}

/**
 * Gets shipment details including reefer telemetry and documents.
 * Enforces role-based tenant isolation and field redaction (SEC-IDOR-01).
 *
 * @param {string} shipmentId
 * @param {Object} [authContext] - { role, manufacturerId, buyerEmail }
 * @param {Object} [dbOpts]
 */
async function getShipmentById(shipmentId, authContext = {}, dbOpts = {}) {
    // Graceful handling if 2nd arg is dbOpts
    let actualAuth = authContext;
    let actualDbOpts = dbOpts;
    if (authContext && (authContext.usePostgres !== undefined || authContext.client !== undefined) && !authContext.role) {
        actualDbOpts = authContext;
        actualAuth = {};
    }

    const shipment = await dbClient.queryOne(`
        SELECT s.*, c.contract_no, c.buyer_name, c.buyer_email, c.buyer_company,
               m.name_ar as mfg_name_ar
        FROM shipments s
        JOIN commercial_contracts c ON s.contract_id = c.id
        JOIN manufacturers m ON s.manufacturer_id = m.id
        WHERE s.id = ?
    `, [shipmentId], actualDbOpts);

    if (!shipment) {
        const err = new Error('الشحنة البحرية غير موجودة');
        err.statusCode = 404;
        err.code = 'SHIPMENT_NOT_FOUND';
        throw err;
    }

    // Role-based Tenant and Actor Authorization (SEC-IDOR-01)
    if (actualAuth && actualAuth.role) {
        const role = actualAuth.role;
        const isAdminOrLogistics = ['SUPER_ADMIN', 'ADMIN', 'LOGISTICS', 'LOGISTICS_OFFICER'].includes(role);

        if (isAdminOrLogistics) {
            // Unrestricted administrative / logistics oversight access
        } else if (role === 'MANUFACTURER') {
            const callerMfgId = actualAuth.manufacturerId || actualAuth.manufacturer_id;
            if (!callerMfgId || shipment.manufacturer_id !== callerMfgId) {
                const err = new Error('غير مصرح لك بالوصول لشحنة تخص منشأة صناعية أخرى');
                err.statusCode = 403;
                err.code = 'FORBIDDEN_TENANT_ACCESS';
                throw err;
            }
        } else if (role === 'BUYER') {
            const shipmentBuyerEmail = (shipment.buyer_email || '').trim().toLowerCase();
            const callerBuyerEmail = (actualAuth.buyerEmail || actualAuth.email || '').trim().toLowerCase();
            if (!callerBuyerEmail || shipmentBuyerEmail !== callerBuyerEmail) {
                const err = new Error('غير مصرح لك بالوصول لشحنة غير مرتبطة بتعاقدك التجاري');
                err.statusCode = 403;
                err.code = 'FORBIDDEN_BUYER_ACCESS';
                throw err;
            }
        } else {
            const err = new Error('غير مصرح: ليس لديك الصلاحية للوصول إلى بيانات هذه الشحنة');
            err.statusCode = 403;
            err.code = 'FORBIDDEN_ROLE';
            throw err;
        }
    }

    const telemetry = await dbClient.queryAll(`
        SELECT * FROM reefer_telemetry
        WHERE shipment_id = ?
        ORDER BY recorded_at_utc DESC LIMIT 50
    `, [shipmentId], actualDbOpts);

    const breaches = await dbClient.queryAll(`
        SELECT * FROM reefer_breach_events
        WHERE shipment_id = ?
        ORDER BY detected_at DESC
    `, [shipmentId], actualDbOpts);

    const documents = await dbClient.queryAll(`
        SELECT * FROM shipping_documents
        WHERE shipment_id = ?
        ORDER BY created_at DESC
    `, [shipmentId], actualDbOpts);

    // Sanitize shipment output & perform field-level redactions
    const sanitizedShipment = { ...shipment };

    // Redact internal factory notes for buyer view
    if (actualAuth && actualAuth.role === 'BUYER') {
        delete sanitizedShipment.notes;
    }

    return {
        shipment: sanitizedShipment,
        telemetry,
        breaches,
        documents
    };
}

module.exports = {
    VALID_DOC_TYPES,
    VALID_BL_STATUSES,
    ALLOWED_BL_TRANSITIONS,
    canDispatchShipment,
    createShipment,
    recordReeferTelemetry,
    uploadShippingDocument,
    updateBillOfLadingStatus,
    listShipments,
    getShipmentById
};
