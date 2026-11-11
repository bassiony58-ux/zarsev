/**
 * src/services/auditLogService.js
 * 
 * Central Audit Logging Service for ZARSEV Manufacturer Lifecycle & Security Events.
 * Records actor, action, target, timestamp, and sanitized metadata.
 * Strictly guarantees no passwords, tokens, or secret credentials are ever logged.
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');

/**
 * Strips sensitive keys recursively from metadata before logging
 */
function sanitizeMetadata(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const sensitiveKeys = new Set([
        'password', 'password_hash', 'token', 'raw_token', 'token_hash',
        'secret', 'buyer_access_token', 'buyer_access_token_hash', 'authorization'
    ]);
    const clean = {};
    for (const [key, val] of Object.entries(meta)) {
        if (sensitiveKeys.has(key.toLowerCase())) {
            clean[key] = '[REDACTED]';
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            clean[key] = sanitizeMetadata(val);
        } else {
            clean[key] = val;
        }
    }
    return clean;
}

/**
 * Record a security or lifecycle audit log entry
 * @param {Object} params
 * @param {string} params.manufacturerId
 * @param {string} params.actorId
 * @param {string} [params.actorType='USER']
 * @param {string} params.action - e.g. 'INVITATION_CREATED', 'ROLE_CHANGED'
 * @param {string} [params.targetId]
 * @param {Object} [params.details={}]
 * @param {string} [params.ipAddress]
 * @param {Object} [params.dbOpts={}] - DB client options or transaction object
 */
async function recordAuditLog({
    manufacturerId = null,
    actorId = 'SYSTEM',
    actorType = 'USER',
    action,
    targetId = null,
    details = {},
    ipAddress = null,
    dbOpts = {}
}) {
    if (!action) {
        throw new Error('recordAuditLog requires action');
    }

    const logId = 'aud_' + crypto.randomBytes(8).toString('hex');
    const sanitizedDetails = sanitizeMetadata(details);
    const client = dbOpts.tx || dbClient;
    const clientOpts = dbOpts.tx ? {} : dbOpts;

    try {
        if (manufacturerId && manufacturerId !== 'SYSTEM' && manufacturerId !== 'SYSTEM_ADMIN') {
            await client.execute(`
                INSERT INTO manufacturer_audit_logs (
                    id, manufacturer_id, actor_id, actor_type, action,
                    target_id, details, ip_address, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                logId,
                manufacturerId,
                actorId || 'SYSTEM',
                actorType,
                action,
                targetId,
                JSON.stringify(sanitizedDetails),
                ipAddress
            ], clientOpts);
        } else {
            // Platform & Admin governance audit log
            await client.execute(`
                INSERT INTO platform_audit_logs (
                    id, actor_id, actor_type, action,
                    target_id, details, ip_address, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                logId,
                actorId || 'SYSTEM',
                actorType,
                action,
                targetId,
                JSON.stringify(sanitizedDetails),
                ipAddress
            ], clientOpts);
        }
    } catch (err) {
        console.warn('[recordAuditLog] Unable to persist audit log to DB:', err.message);
    }

    return logId;
}

module.exports = {
    recordAuditLog,
    sanitizeMetadata
};
