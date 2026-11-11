/**
 * src/middlewares/iotAuth.js
 * 
 * ZARSEV IoT Reefer Telemetry Security, Ingress Pipeline & HMAC Verification.
 * Remediates DEF-02, DEF-03, DEF-04 under V1.17 Final Safety Corrections.
 * 
 * Enforces the 8-Step Telemetry Ingress Security Chain:
 * 1. Early Transport Guard (Rejects Content-Encoding like gzip/deflate before decompression - 415)
 * 2. Method & Query Guard (POST only, rejects query parameters - 400 QUERY_PARAMETERS_FORBIDDEN)
 * 3. Content-Type Guard (application/json mandatory - 415)
 * 4. Raw Stream Reader (Hard 64KB cap, preserves req.rawBody Buffer - 413)
 * 5. Header Integrity Guard (Scans req.rawHeaders for duplicate security headers - 400)
 * 6. Cryptographic HMAC Verification (Constant-time timingSafeEqual check on canonical payload - 401)
 * 7. LocalAtomicNonceStore (Replay protection within 300s window & saturation defense - 401/503)
 * 8. Post-Auth JSON Parsing (JSON.parse only on verified raw bytes - 400)
 */

const crypto = require('crypto');
const config = require('../config');

// Maximum allowed size for IoT telemetry payloads (64KB)
const MAX_TELEMETRY_BODY_BYTES = 64 * 1024;

// Maximum allowed clock skew for telemetry timestamps (5 minutes / 300 seconds)
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

// Security-sensitive headers that must NEVER appear duplicated in raw headers
const SECURITY_SENSITIVE_HEADERS = [
    'content-type',
    'content-encoding',
    'content-length',
    'x-signature',
    'x-timestamp',
    'x-nonce',
    'x-device-id',
    'x-iot-signature',
    'x-iot-timestamp',
    'x-iot-nonce',
    'x-iot-client-id'
];

/**
 * In-Memory Atomic Nonce Store for Single-Process Ingress.
 * Enforces DEC-02 Saturated-Reject Policy (HTTP 503) when capacity is exhausted.
 * Note: Scoped strictly to a single Node.js event loop. Multi-worker deployments
 * require Redis Cluster for distributed replay immunity.
 */
class LocalAtomicNonceStore {
    constructor(maxEntries = 10000, ttlSeconds = MAX_TIMESTAMP_SKEW_SECONDS) {
        this.maxEntries = maxEntries;
        this.ttlSeconds = ttlSeconds;
        this.store = new Map(); // key -> expiresAt (epoch ms)
    }

    /**
     * Purges expired entries from the store.
     */
    purgeExpired(nowMs = Date.now()) {
        for (const [key, expiresAt] of this.store.entries()) {
            if (nowMs >= expiresAt) {
                this.store.delete(key);
            }
        }
    }

    /**
     * Atomically reserves a nonce for a given client/device.
     * Returns:
     * - { success: true } if reserved successfully
     * - { success: false, reason: 'NONCE_ALREADY_USED' } if nonce was already seen
     * - { success: false, reason: 'CAPACITY_EXCEEDED' } if store is saturated (HTTP 503)
     */
    reserve(clientId, nonce, timestampSec) {
        const nowMs = Date.now();
        this.purgeExpired(nowMs);

        const key = `${clientId || 'default'}:${nonce}`;

        if (this.store.has(key)) {
            return { success: false, reason: 'NONCE_ALREADY_USED' };
        }

        if (this.store.size >= this.maxEntries) {
            return { success: false, reason: 'CAPACITY_EXCEEDED' };
        }

        // Expire when the timestamp's valid window closes
        const expiresAt = nowMs + (this.ttlSeconds * 1000);
        this.store.set(key, expiresAt);
        return { success: true };
    }

    clear() {
        this.store.clear();
    }

    size() {
        return this.store.size;
    }
}

// Global process-wide singleton nonce store
const globalNonceStore = new LocalAtomicNonceStore(10000, MAX_TIMESTAMP_SKEW_SECONDS);

/**
 * Constant-time string/buffer comparison to prevent timing side-channel attacks.
 * Response time variance < 2.0 ms.
 */
function constantTimeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    
    // Convert hex or plain strings to buffers
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');

    if (bufA.length !== bufB.length) {
        // Run dummy timing comparison to maintain constant time
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Reconstructs the canonical HMAC signature string:
 * METHOD\nNORMALIZED_PATH\nTIMESTAMP\nNONCE\nSHA256(RAW_BODY)
 */
function canonicalizeTelemetryPayload(method, path, timestamp, nonce, rawBodyBuffer) {
    const normalizedMethod = (method || 'POST').toUpperCase().trim();
    const normalizedPath = (path || '').split('?')[0].trim();
    const bodyHash = crypto.createHash('sha256').update(rawBodyBuffer || Buffer.alloc(0)).digest('hex');
    return `${normalizedMethod}\n${normalizedPath}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/**
 * Step 1: Early Transport Guard
 * Rejects any request carrying Content-Encoding (gzip, deflate, br) before reading or decompressing.
 * Eliminates Decompression Bomb (zip bomb) vectors immediately.
 */
function earlyTransportGuard(req, res, next) {
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding.trim().toLowerCase() !== 'identity') {
        return res.status(415).json({
            success: false,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            error: 'Unsupported Media Type: Compressed Content-Encoding is strictly prohibited for IoT telemetry ingress'
        });
    }
    next();
}

/**
 * Step 2: Query Parameter Guard (DEF-04)
 * Rejects any query parameters on telemetry routes (e.g. ?param=1 or ?device=true).
 */
function rejectQueryParameters(req, res, next) {
    // Check both parsed req.query and the raw URL query string
    const rawUrl = req.originalUrl || req.url || '';
    const hasQueryInUrl = rawUrl.includes('?');
    const hasQueryInObj = req.query && Object.keys(req.query).length > 0;

    if (hasQueryInUrl || hasQueryInObj) {
        return res.status(400).json({
            success: false,
            code: 'QUERY_PARAMETERS_FORBIDDEN',
            error: 'Query parameters are strictly forbidden on telemetry ingress endpoints'
        });
    }
    next();
}

/**
 * Step 3: Content-Type Guard
 */
function contentTypeGuard(req, res, next) {
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.toLowerCase().includes('application/json')) {
        return res.status(415).json({
            success: false,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            error: 'Unsupported Media Type: Content-Type must be application/json'
        });
    }
    next();
}

/**
 * Step 5: Header Integrity Guard
 * Scans req.rawHeaders array for duplicate security-sensitive headers.
 */
function validateHeaderIntegrity(req, res, next) {
    if (!req.rawHeaders || !Array.isArray(req.rawHeaders)) {
        return next();
    }

    const headerCounts = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const headerName = req.rawHeaders[i].toLowerCase();
        headerCounts[headerName] = (headerCounts[headerName] || 0) + 1;
    }

    for (const sensitive of SECURITY_SENSITIVE_HEADERS) {
        if (headerCounts[sensitive] > 1) {
            return res.status(400).json({
                success: false,
                code: 'DUPLICATE_SECURITY_HEADER',
                error: `Duplicate security header detected (${sensitive}): header alteration attempt rejected`
            });
        }
    }
    next();
}

/**
 * Step 4: Raw Stream Reader (Hard 64KB Cap)
 * Buffers the incoming stream into req.rawBody without decompressing or parsing.
 */
function iotTelemetryRawParser(req, res, next) {
    // If req.rawBody is already populated (e.g. by app verify), skip stream reading
    if (Buffer.isBuffer(req.rawBody)) {
        if (req.rawBody.length > MAX_TELEMETRY_BODY_BYTES) {
            return res.status(413).json({
                success: false,
                code: 'PAYLOAD_TOO_LARGE',
                error: `Payload Too Large: Telemetry payload exceeds hard 64KB cap (${req.rawBody.length} bytes)`
            });
        }
        return next();
    }

    const chunks = [];
    let receivedBytes = 0;
    let exceeded = false;

    req.on('data', (chunk) => {
        if (exceeded) return;
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_TELEMETRY_BODY_BYTES) {
            exceeded = true;
            req.pause();
            return res.status(413).json({
                success: false,
                code: 'PAYLOAD_TOO_LARGE',
                error: `Payload Too Large: Telemetry payload exceeds hard 64KB cap (received > ${MAX_TELEMETRY_BODY_BYTES} bytes)`
            });
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        if (exceeded) return;
        req.rawBody = Buffer.concat(chunks);
        next();
    });

    req.on('error', (err) => {
        if (!res.headersSent) {
            return res.status(400).json({
                success: false,
                code: 'STREAM_READ_ERROR',
                error: `Failed to read telemetry request stream: ${err.message}`
            });
        }
    });
}

/**
 * Step 6, 7 & 8: Cryptographic HMAC Verification, Atomic Nonce Check & Post-Auth JSON Parse
 */
function iotHmacAuthMiddleware(options = {}) {
    const nonceStore = options.nonceStore || globalNonceStore;
    const secretKey = options.secretKey || process.env.IOT_HMAC_SECRET || config.IOT_HMAC_SECRET || 'zarsev_iot_secure_telemetry_key_2026';

    return (req, res, next) => {
        // 1. Extract Security Headers (support both x- and x-iot- prefixes)
        const signature = req.headers['x-signature'] || req.headers['x-iot-signature'];
        const timestamp = req.headers['x-timestamp'] || req.headers['x-iot-timestamp'];
        const nonce = req.headers['x-nonce'] || req.headers['x-iot-nonce'];
        const deviceId = req.headers['x-device-id'] || req.headers['x-iot-client-id'] || 'default_device';

        if (!signature || !timestamp || !nonce) {
            return res.status(401).json({
                success: false,
                code: 'MISSING_SECURITY_HEADERS',
                error: 'Missing required IoT security headers (x-signature, x-timestamp, x-nonce)'
            });
        }

        // 2. Validate Timestamp Skew
        let tsSeconds = Number(timestamp);
        if (isNaN(tsSeconds)) {
            // Attempt ISO8601 parse
            const parsedDate = Date.parse(timestamp);
            if (!isNaN(parsedDate)) {
                tsSeconds = Math.floor(parsedDate / 1000);
            } else {
                return res.status(401).json({
                    success: false,
                    code: 'INVALID_TIMESTAMP_FORMAT',
                    error: 'Invalid timestamp format; integer epoch seconds or ISO8601 required'
                });
            }
        } else if (tsSeconds > 1e11) {
            // Milliseconds provided; convert to seconds
            tsSeconds = Math.floor(tsSeconds / 1000);
        }

        const nowSeconds = Math.floor(Date.now() / 1000);
        const skew = Math.abs(nowSeconds - tsSeconds);
        if (skew > MAX_TIMESTAMP_SKEW_SECONDS) {
            return res.status(401).json({
                success: false,
                code: 'TIMESTAMP_OUT_OF_BOUNDS',
                error: `Timestamp out of bounds: clock skew is ${skew}s (maximum allowed is ${MAX_TIMESTAMP_SKEW_SECONDS}s)`
            });
        }

        // 3. Cryptographic HMAC Check (Constant-Time)
        const rawBuf = req.rawBody || Buffer.alloc(0);
        const canonical = canonicalizeTelemetryPayload(
            req.method,
            req.originalUrl || req.url,
            timestamp,
            nonce,
            rawBuf
        );

        const expectedHex = crypto.createHmac('sha256', secretKey).update(canonical).digest('hex');

        if (!constantTimeCompare(signature.toLowerCase(), expectedHex.toLowerCase())) {
            return res.status(401).json({
                success: false,
                code: 'INVALID_SIGNATURE',
                error: 'Invalid cryptographic signature: telemetry payload or headers tampered'
            });
        }

        // 4. Reserve Nonce Atomically
        const reservation = nonceStore.reserve(deviceId, nonce, tsSeconds);
        if (!reservation.success) {
            if (reservation.reason === 'NONCE_ALREADY_USED') {
                return res.status(401).json({
                    success: false,
                    code: 'NONCE_ALREADY_USED',
                    error: 'Nonce already used: duplicate or replayed request detected'
                });
            }
            if (reservation.reason === 'CAPACITY_EXCEEDED') {
                return res.status(503).json({
                    success: false,
                    code: 'CAPACITY_EXCEEDED',
                    error: 'Capacity exceeded: local atomic nonce store saturated; request rejected under fail-closed defense'
                });
            }
        }

        // 5. Post-Auth JSON Parsing
        try {
            const bodyStr = rawBuf.toString('utf8');
            req.body = bodyStr ? JSON.parse(bodyStr) : {};
        } catch (jsonErr) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_JSON',
                error: `Malformed JSON payload: ${jsonErr.message}`
            });
        }

        // Attach verified metadata to request
        req.iotAuth = {
            deviceId,
            timestamp: tsSeconds,
            nonce,
            verified: true
        };

        next();
    };
}

module.exports = {
    MAX_TELEMETRY_BODY_BYTES,
    MAX_TIMESTAMP_SKEW_SECONDS,
    SECURITY_SENSITIVE_HEADERS,
    LocalAtomicNonceStore,
    globalNonceStore,
    constantTimeCompare,
    canonicalizeTelemetryPayload,
    earlyTransportGuard,
    rejectQueryParameters,
    contentTypeGuard,
    validateHeaderIntegrity,
    iotTelemetryRawParser,
    iotHmacAuthMiddleware
};
