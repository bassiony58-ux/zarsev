const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Hash password with PBKDF2
 */
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

/**
 * Verify password against salt:hash
 */
function verifyPassword(password, storedHash) {
    if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
        return false;
    }
    const [salt, originalHash] = storedHash.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === originalHash;
}

/**
 * Generate signed JWT token
 * Note: Payload contains only trusted minimal identifiers.
 * Roles and permissions are strictly resolved server-side from DB.
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
 * Public Manufacturer Serializer
 * Strips internal business models, subscriptions, admin emails, phone numbers, and financial data.
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
 * For authorized staff (Super Admin, Logistics Officer)
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
 * Removes password hashes and internal security metadata.
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
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    serializePublicManufacturer,
    serializeAdminManufacturer,
    serializeUser
};
