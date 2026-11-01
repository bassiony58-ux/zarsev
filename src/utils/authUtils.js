const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const CURRENT_ALGO = 'sha512';
const CURRENT_ITERATIONS = 210000;
const CURRENT_KEYLEN = 64; // 64 bytes = 128 hex chars
const SALT_BYTES = 32;

/**
 * Hash password with PBKDF2-HMAC-SHA512 using versioned format and 210,000 iterations.
 * Format: pbkdf2:<digest>:<iterations>:<salt_hex>:<hash_hex>
 */
function hashPassword(password) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, CURRENT_ITERATIONS, CURRENT_KEYLEN, CURRENT_ALGO).toString('hex');
    return `pbkdf2:${CURRENT_ALGO}:${CURRENT_ITERATIONS}:${salt}:${hash}`;
}

/**
 * Timing-safe comparison of two Buffers
 */
function timingSafeCompare(bufA, bufB) {
    if (!Buffer.isBuffer(bufA) || !Buffer.isBuffer(bufB)) return false;
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify password against stored hash.
 * Supports both new versioned format (pbkdf2:sha512:...) and legacy format (<salt>:<hash>).
 * Strictly timing-safe hash comparison.
 */
function verifyPassword(password, storedHash) {
    if (!password || typeof password !== 'string' || !storedHash || typeof storedHash !== 'string') {
        return false;
    }

    // 1. New versioned format: pbkdf2:<digest>:<iterations>:<salt>:<hash>
    if (storedHash.startsWith('pbkdf2:')) {
        const parts = storedHash.split(':');
        if (parts.length !== 5) return false;
        const [, digest, iterStr, salt, originalHash] = parts;
        const iterations = parseInt(iterStr, 10);
        if (isNaN(iterations) || iterations <= 0 || !salt || !originalHash) return false;

        try {
            const originalHashBuf = Buffer.from(originalHash, 'hex');
            const derivedHash = crypto.pbkdf2Sync(password, salt, iterations, originalHashBuf.length, digest);
            return timingSafeCompare(derivedHash, originalHashBuf);
        } catch (err) {
            return false;
        }
    }

    // 2. Legacy fallback format: <salt_hex>:<hash_hex> (1,000 iterations, sha512)
    if (storedHash.includes(':')) {
        const parts = storedHash.split(':');
        if (parts.length !== 2) return false;
        const [salt, originalHash] = parts;
        if (!salt || !originalHash) return false;

        try {
            const originalHashBuf = Buffer.from(originalHash, 'hex');
            const derivedHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512');
            return timingSafeCompare(derivedHash, originalHashBuf);
        } catch (err) {
            return false;
        }
    }

    return false;
}

/**
 * Checks if a stored password hash requires rehashing to the latest security standard
 */
function needsRehash(storedHash) {
    if (!storedHash || typeof storedHash !== 'string') return true;
    if (!storedHash.startsWith('pbkdf2:')) return true; // Legacy format
    const parts = storedHash.split(':');
    if (parts.length !== 5) return true;
    const [, digest, iterStr] = parts;
    const iterations = parseInt(iterStr, 10);
    return digest !== CURRENT_ALGO || iterations < CURRENT_ITERATIONS;
}

/**
 * Precomputed dummy hash for timing-attack mitigation on non-existent users
 */
const DUMMY_HASH = `pbkdf2:${CURRENT_ALGO}:${CURRENT_ITERATIONS}:0000000000000000000000000000000000000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`;

/**
 * Generate signed JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email
        },
        config.JWT_SECRET,
        {
            expiresIn: config.JWT_EXPIRES_IN
        }
    );
}

/**
 * Verify signed JWT token
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, config.JWT_SECRET);
    } catch (err) {
        return null;
    }
}

/**
 * Generate a cryptographically secure CSRF token
 */
function generateCsrfToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Public Manufacturer Serializer
 */
function serializePublicManufacturer(mfg) {
    if (!mfg) return null;
    return {
        id: mfg.id,
        name_ar: mfg.name_ar,
        name_en: mfg.name_en,
        code: mfg.code,
        city: mfg.city,
        country: mfg.country,
        is_verified: mfg.is_verified
    };
}

/**
 * Administrative Manufacturer Serializer
 */
function serializeAdminManufacturer(mfg) {
    if (!mfg) return null;
    return {
        id: mfg.id,
        name_ar: mfg.name_ar,
        name_en: mfg.name_en,
        code: mfg.code,
        business_model: mfg.business_model,
        subscription_id: mfg.subscription_id,
        subscription_name: mfg.subscription_name,
        city: mfg.city,
        country: mfg.country,
        contact_email: mfg.contact_email,
        contact_phone: mfg.contact_phone,
        is_verified: mfg.is_verified,
        is_demo: mfg.is_demo,
        products_count: mfg.products_count,
        created_at: mfg.created_at
    };
}

/**
 * User Serializer
 */
function serializeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        manufacturer_id: user.manufacturer_id,
        is_active: user.is_active,
        is_demo: user.is_demo
    };
}

module.exports = {
    CURRENT_ITERATIONS,
    hashPassword,
    verifyPassword,
    needsRehash,
    timingSafeCompare,
    DUMMY_HASH,
    generateToken,
    verifyToken,
    generateCsrfToken,
    serializePublicManufacturer,
    serializeAdminManufacturer,
    serializeUser
};
