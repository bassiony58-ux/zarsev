/**
 * src/routes/shippingRoutes.js
 * 
 * Ocean Shipping, Reefer Cold-Chain Telemetry, and B/L Lifecycle API for ZARSEV.
 * Implements Phase 6.0-A, B, C, D:
 * - Shipping Gate check before shipment dispatch.
 * - Container tracking and live cold-chain telemetry ingestion.
 * - Temperature breach detection (> 1.5°C over 120 min).
 * - Shipping documents repository with SHA-256 integrity checks.
 * - B/L 5-stage status workflow.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const shippingService = require('../services/shippingService');
const { authMiddleware, optionalAuthMiddleware, requireRole } = require('../middlewares/auth');
const {
    validateHeaderIntegrity,
    earlyTransportGuard,
    rejectQueryParameters,
    contentTypeGuard,
    iotTelemetryRawParser,
    iotHmacAuthMiddleware
} = require('../middlewares/iotAuth');

/**
 * Resolves caller identity from either authenticated session/JWT or x-buyer-token header/param.
 * Returns { role, manufacturerId, buyerEmail, buyerName, subRole, userId } or null.
 */
async function resolveCallerAuth(req) {
    if (req.user) {
        return {
            role: req.user.role,
            subRole: req.user.sub_role,
            userId: req.user.id,
            manufacturerId: req.user.role === 'MANUFACTURER' ? req.user.manufacturer_id : (req.user.manufacturer_id || null),
            buyerEmail: req.user.role === 'BUYER' ? req.user.email : null
        };
    }

    const token = req.headers['x-buyer-token'] || req.query?.buyer_token;
    if (token && typeof token === 'string' && token.trim()) {
        const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const dbOpts = req.dbClientOptions || {};
        const rfq = await dbClient.queryOne(
            'SELECT buyer_name, business_email, company_name FROM rfqs WHERE buyer_access_token_hash = ?',
            [tokenHash],
            dbOpts
        );
        if (rfq) {
            return {
                role: 'BUYER',
                buyerEmail: rfq.business_email,
                buyerName: rfq.buyer_name,
                company: rfq.company_name
            };
        }
    }

    return null;
}

/**
 * 1. GET /api/shipping/shipments
 * Lists shipments based on caller role
 */
router.get('/shipments', authMiddleware, async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const manufacturerId = user.role === 'MANUFACTURER' ? user.manufacturer_id : null;
    const buyerEmail = user.role === 'BUYER' ? user.email : null;

    try {
        const shipments = await shippingService.listShipments({
            role: user.role,
            manufacturerId,
            buyerEmail,
            dbOpts
        });

        return res.json({
            success: true,
            count: shipments.length,
            shipments
        });
    } catch (err) {
        console.error('[shippingRoutes] GET /shipments error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. GET /api/shipping/shipments/:id
 * Fetches shipment details with telemetry series, breaches, and documents.
 * Strictly enforces authentication, multi-tenant RBAC, and field-level redactions (SEC-IDOR-01).
 */
router.get('/shipments/:id', optionalAuthMiddleware, async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};

    try {
        const authContext = await resolveCallerAuth(req);
        if (!authContext) {
            return res.status(401).json({
                success: false,
                code: 'UNAUTHORIZED',
                error: 'غير مصرح: يلزم تسجيل الدخول أو تقديم رمز تتبع المشتري المعتمد (x-buyer-token) للوصول إلى تفاصيل الشحنة'
            });
        }

        const data = await shippingService.getShipmentById(id, authContext, dbOpts);
        return res.json({
            success: true,
            ...data
        });
    } catch (err) {
        console.error('[shippingRoutes] GET /shipments/:id error:', err.message);
        const statusCode = err.statusCode || (err.message && err.message.includes('غير موجودة') ? 404 : 500);
        return res.status(statusCode).json({
            success: false,
            code: err.code || (statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR'),
            error: err.message
        });
    }
});

/**
 * 3. POST /api/shipping/shipments
 * Creates shipment guarded by the Shipping Gate
 */
router.post('/shipments', authMiddleware, async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        contract_id,
        batch_id,
        carrier_name,
        vessel_name,
        voyage_no,
        booking_reference,
        container_no,
        container_type,
        pol,
        pod,
        booking_date,
        loading_date,
        etd,
        eta,
        notes
    } = req.body || {};

    const manufacturerId = user.role === 'MANUFACTURER' ? user.manufacturer_id : req.body.manufacturer_id;

    try {
        const shipment = await shippingService.createShipment({
            contractId: contract_id,
            batchId: batch_id,
            manufacturerId,
            carrierName: carrier_name,
            vesselName: vessel_name,
            voyageNo: voyage_no,
            bookingReference: booking_reference,
            containerNo: container_no,
            containerType: container_type,
            pol,
            pod,
            bookingDate: booking_date,
            loadingDate: loading_date,
            etd,
            eta,
            notes,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم حجز وتأكيد الشحنة البحرية بنجاح بعد اجتياز بوابة الفحص (Shipping Gate)',
            shipment
        });
    } catch (err) {
        console.error('[shippingRoutes] POST /shipments error:', err);
        const statusCode = err.status || (err.code ? 400 : 400);
        return res.status(statusCode).json({
            success: false,
            code: err.code || 'SHIPMENT_GATE_BLOCKED',
            error: err.message
        });
    }
});

/**
 * 4. GET & POST Telemetry Ingress Endpoints (Guarded by 8-Step Security Pipeline)
 */
// GET requests to telemetry reject query parameters or return 405
router.get('/telemetry', rejectQueryParameters, (req, res) => {
    return res.status(405).json({
        success: false,
        code: 'METHOD_NOT_ALLOWED',
        error: 'Method Not Allowed: Telemetry endpoint accepts POST only'
    });
});

router.get('/shipments/:id/telemetry', rejectQueryParameters, (req, res) => {
    return res.status(405).json({
        success: false,
        code: 'METHOD_NOT_ALLOWED',
        error: 'Method Not Allowed: Telemetry endpoint accepts POST only'
    });
});

// Primary Ingestion by Shipment ID
router.post('/shipments/:id/telemetry',
    earlyTransportGuard,
    rejectQueryParameters,
    contentTypeGuard,
    validateHeaderIntegrity,
    iotTelemetryRawParser,
    iotHmacAuthMiddleware(),
    async (req, res) => {
        const { id } = req.params;
        const dbOpts = req.dbClientOptions || {};
        const {
            container_no,
            recorded_at_utc,
            setpoint_temp,
            supply_temp,
            return_temp,
            ambient_temp,
            humidity_pct,
            power_status,
            sensor_source
        } = req.body || {};

        try {
            const result = await shippingService.recordReeferTelemetry({
                shipmentId: id,
                containerNo: container_no,
                recordedAtUtc: recorded_at_utc,
                setpointTemp: setpoint_temp,
                supplyTemp: supply_temp,
                returnTemp: return_temp,
                ambientTemp: ambient_temp,
                humidityPct: humidity_pct,
                powerStatus: power_status,
                sensorSource: sensor_source,
                dbOpts
            });

            return res.status(201).json({
                success: true,
                message: result.breach_flag
                    ? 'تحذير: تم رصد تجاوز حراري في الحاوية وتسجيل إشعار حرج'
                    : 'تم تسجيل قراءة الحساس وتأكيد استقرار درجة الحرارة',
                telemetry: result
            });
        } catch (err) {
            console.error('[shippingRoutes] POST /shipments/:id/telemetry error:', err);
            return res.status(400).json({ success: false, error: err.message });
        }
    }
);

// Generic Telemetry Route (POST /api/shipping/telemetry)
router.post('/telemetry',
    earlyTransportGuard,
    rejectQueryParameters,
    contentTypeGuard,
    validateHeaderIntegrity,
    iotTelemetryRawParser,
    iotHmacAuthMiddleware(),
    async (req, res) => {
        const dbOpts = req.dbClientOptions || {};
        const {
            shipment_id,
            container_no,
            recorded_at_utc,
            setpoint_temp,
            supply_temp,
            return_temp,
            ambient_temp,
            humidity_pct,
            power_status,
            sensor_source
        } = req.body || {};

        try {
            const result = await shippingService.recordReeferTelemetry({
                shipmentId: shipment_id,
                containerNo: container_no,
                recordedAtUtc: recorded_at_utc,
                setpointTemp: setpoint_temp,
                supplyTemp: supply_temp,
                returnTemp: return_temp,
                ambientTemp: ambient_temp,
                humidityPct: humidity_pct,
                powerStatus: power_status,
                sensorSource: sensor_source,
                dbOpts
            });

            return res.status(201).json({
                success: true,
                message: result.breach_flag
                    ? 'تحذير: تم رصد تجاوز حراري في الحاوية وتسجيل إشعار حرج'
                    : 'تم تسجيل قراءة الحساس وتأكيد استقرار درجة الحرارة',
                telemetry: result
            });
        } catch (err) {
            console.error('[shippingRoutes] POST /telemetry error:', err);
            return res.status(400).json({ success: false, error: err.message });
        }
    }
);

/**
 * 5. POST /api/shipping/shipments/:id/documents
 * Uploads shipping documents with SHA-256 integrity hash
 */
router.post('/shipments/:id/documents', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const {
        contract_id,
        doc_type,
        doc_number,
        file_path,
        file_content
    } = req.body || {};

    try {
        const doc = await shippingService.uploadShippingDocument({
            shipmentId: id,
            contractId: contract_id,
            docType: doc_type,
            docNumber: doc_number,
            filePath: file_path || `/storage/docs/${doc_type.toLowerCase()}_${Date.now()}.pdf`,
            fileContent: file_content || `DUMMY_BINARY_DATA_${doc_number}`,
            uploadedBy: user.id,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم حفظ وتوثيق المستند التجاري بنجاح مع بصمة SHA-256 للتحقق من السلامة',
            document: doc
        });
    } catch (err) {
        console.error('[shippingRoutes] POST /shipments/:id/documents error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 6. PATCH /api/shipping/documents/:id/bl-status
 * Advances Bill of Lading (B/L) formal status with RBAC gating (DEF-05)
 */
router.patch('/documents/:id/bl-status', authMiddleware, requireRole(['SUPER_ADMIN', 'LOGISTICS_OFFICER']), async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const { bl_status, notes } = req.body || {};

    try {
        const updated = await shippingService.updateBillOfLadingStatus({
            docId: id,
            newStatus: bl_status,
            verifiedBy: user.id,
            notes,
            dbOpts
        });

        return res.json({
            success: true,
            message: `تم تحديث حالة بوليصة الشحن بنجاح إلى: (${bl_status})`,
            document: updated
        });
    } catch (err) {
        console.error('[shippingRoutes] PATCH /documents/:id/bl-status error:', err);
        const statusCode = err.status || (err.code === 'INVALID_STATE_TRANSITION' ? 409 : 400);
        return res.status(statusCode).json({
            success: false,
            code: err.code || 'BL_UPDATE_ERROR',
            error: err.message
        });
    }
});

module.exports = router;
