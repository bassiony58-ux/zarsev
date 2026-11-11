/**
 * src/services/invitationService.js
 * 
 * Secure Manufacturer Invitation Lifecycle Management
 * Handles cryptographically secure invitation creation, validation, expiration, and atomic acceptance.
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const { hashPassword } = require('../utils/authUtils');
const { recordAuditLog } = require('./auditLogService');
const { SUB_ROLES, ALL_SUB_ROLES } = require('../config/manufacturerPermissions');

const INVITATION_EXPIRATION_HOURS = 48;

// Tier default seat allowances if max_team_seats is null in database
const DEFAULT_SEATS_BY_TIER = {
    sub_enterprise: 50,
    sub_pro: 5,
    sub_standard: 2
};

/**
 * Calculates current team seat usage and quota for a manufacturer
 */
async function calculateSeatUsage(manufacturerId, client, dbOpts = {}) {
    const isTx = Boolean(client && client.execute && client !== dbClient);
    const db = client || dbClient;
    const opts = isTx ? {} : dbOpts;

    // Fetch manufacturer and subscription
    const mfg = await db.queryOne(
        'SELECT id, name_ar, subscription_id, max_team_seats, is_active FROM manufacturers WHERE id = ?',
        [manufacturerId],
        opts
    );

    if (!mfg) {
        throw new Error('المنشأة غير موجودة');
    }

    let maxSeats = mfg.max_team_seats;
    if (!maxSeats || Number(maxSeats) <= 0) {
        maxSeats = DEFAULT_SEATS_BY_TIER[mfg.subscription_id] || 2;
    }
    maxSeats = Number(maxSeats);

    // Active members count
    let activeMembers = 0;
    try {
        const activeRes = await db.queryOne(`
            SELECT COUNT(*) as count 
            FROM users 
            WHERE manufacturer_id = ? AND role = 'MANUFACTURER' AND is_active = true
        `, [manufacturerId], opts);
        activeMembers = Number(activeRes?.count || 0);
    } catch (err) {
        console.warn('[calculateSeatUsage] Active members count query error:', err.message);
    }

    // Pending, non-expired invitations count
    let pendingInvites = 0;
    try {
        const pendingRes = await db.queryOne(`
            SELECT COUNT(*) as count 
            FROM manufacturer_invitations 
            WHERE manufacturer_id = ? AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP
        `, [manufacturerId], opts);
        pendingInvites = Number(pendingRes?.count || 0);
    } catch (err) {
        // Table might not exist yet before migration
        pendingInvites = 0;
    }

    const totalAllocated = activeMembers + pendingInvites;
    const remainingSeats = Math.max(0, maxSeats - totalAllocated);

    return {
        maxSeats,
        activeMembers,
        pendingInvites,
        totalAllocated,
        remainingSeats,
        isQuotaAvailable: totalAllocated < maxSeats,
        manufacturer: mfg
    };
}

/**
 * Create a new team invitation
 */
async function createInvitation({
    manufacturerId,
    invitedByUserId,
    email,
    subRole,
    ipAddress = null,
    dbOpts = {}
}) {
    if (!email || typeof email !== 'string') {
        throw new Error('البريد الإلكتروني مطلوب');
    }
    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
        throw new Error('صيغة البريد الإلكتروني غير صالحة');
    }

    if (!subRole || !ALL_SUB_ROLES.includes(subRole)) {
        throw new Error(`الدور الفرعي غير صالح. الأدوار المتاحة: ${ALL_SUB_ROLES.join(', ')}`);
    }

    // Check if an existing active user already uses this email
    const existingUser = await dbClient.queryOne(
        'SELECT id, role, is_active FROM users WHERE LOWER(email) = LOWER(?)',
        [normalizedEmail],
        dbOpts
    );
    if (existingUser) {
        throw new Error('البريد الإلكتروني مسجل بالفعل لمستخدم آخر في المنظومة');
    }

    // Execute within transaction with row locking
    let result = null;
    await dbClient.transaction(async (tx) => {
        // Lock manufacturer row for serializing quota calculation
        const isPg = dbOpts.engine === 'postgres' || (process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres';
        if (isPg) {
            await tx.queryOne('SELECT id FROM manufacturers WHERE id = ? FOR UPDATE', [manufacturerId]);
        }

        const seatStats = await calculateSeatUsage(manufacturerId, tx);
        if (!seatStats.isQuotaAvailable) {
            throw new Error(`تم بلوغ الحد الأقصى للمقاعد المتاحة لاشتراك المنشأة (${seatStats.maxSeats} مقاعد)`);
        }

        // If inviting as OWNER, check if there is already an active OWNER
        if (subRole === SUB_ROLES.OWNER) {
            const activeOwner = await tx.queryOne(`
                SELECT id FROM users 
                WHERE manufacturer_id = ? AND role = 'MANUFACTURER' AND sub_role = 'OWNER' AND is_active = true
            `, [manufacturerId]);
            if (activeOwner) {
                throw new Error('المنشأة تمتلك مالكاً نشطاً بالفعل. لنقل الملكية يرجى استخدام بروتوكول نقل الملكية المخصص');
            }
        }

        // Check if an unexpired pending invitation already exists for this email
        const activeInvite = await tx.queryOne(`
            SELECT id, status, expires_at 
            FROM manufacturer_invitations 
            WHERE manufacturer_id = ? AND LOWER(email) = LOWER(?) AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP
        `, [manufacturerId, normalizedEmail]);

        if (activeInvite) {
            throw new Error('توجد دعوة معلقة سارية المفعول لهذا البريد الإلكتروني بالفعل');
        }

        // Generate CSPRNG token (32 bytes = 64 hex chars)
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const invitationId = 'inv_' + crypto.randomBytes(8).toString('hex');

        // Insert invitation record with 48h expiration
        await tx.execute(`
            INSERT INTO manufacturer_invitations (
                id, manufacturer_id, email, sub_role, token_hash, status,
                invited_by, expires_at, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, 'PENDING',
                ?, CURRENT_TIMESTAMP + INTERVAL '48 hours', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `, [
            invitationId,
            manufacturerId,
            normalizedEmail,
            subRole,
            tokenHash,
            invitedByUserId
        ]);

        await recordAuditLog({
            manufacturerId,
            actorId: invitedByUserId,
            action: 'INVITATION_CREATED',
            targetId: invitationId,
            details: { email: normalizedEmail, sub_role: subRole },
            ipAddress,
            dbOpts: { tx }
        });

        result = {
            invitationId,
            email: normalizedEmail,
            subRole,
            rawToken,
            expiresInHours: INVITATION_EXPIRATION_HOURS
        };
    }, dbOpts);

    return result;
}

/**
 * Revoke a pending invitation
 */
async function revokeInvitation({ invitationId, manufacturerId, actorId, ipAddress = null, dbOpts = {} }) {
    let result = false;
    await dbClient.transaction(async (tx) => {
        const invite = await tx.queryOne(
            'SELECT id, email, status FROM manufacturer_invitations WHERE id = ? AND manufacturer_id = ?',
            [invitationId, manufacturerId]
        );

        if (!invite) {
            throw new Error('الدعوة غير موجودة');
        }
        if (invite.status !== 'PENDING') {
            throw new Error(`لا يمكن إلغاء هذه الدعوة لأن حالتها الحالية هي: ${invite.status}`);
        }

        await tx.execute(`
            UPDATE manufacturer_invitations
            SET status = 'REVOKED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [invitationId]);

        await recordAuditLog({
            manufacturerId,
            actorId,
            action: 'INVITATION_REVOKED',
            targetId: invitationId,
            details: { email: invite.email },
            ipAddress,
            dbOpts: { tx }
        });

        result = true;
    }, dbOpts);

    return result;
}

/**
 * Verify an invitation by raw token
 */
async function verifyInvitationToken(rawToken, dbOpts = {}) {
    if (!rawToken || typeof rawToken !== 'string') {
        return { valid: false, error: 'رمز الدعوة مطلوب' };
    }
    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');

    const invite = await dbClient.queryOne(`
        SELECT i.*, m.name_ar as manufacturer_name_ar, m.is_active as mfg_is_active
        FROM manufacturer_invitations i
        JOIN manufacturers m ON i.manufacturer_id = m.id
        WHERE i.token_hash = ?
    `, [tokenHash], dbOpts);

    if (!invite) {
        return { valid: false, error: 'رمز الدعوة غير صالح أو غير موجود' };
    }

    if (invite.status !== 'PENDING') {
        return { valid: false, error: `هذه الدعوة لم تعد صالحة (الحالة: ${invite.status})`, status: invite.status };
    }

    // Expiration check
    const expiresAt = new Date(invite.expires_at).getTime();
    if (Date.now() > expiresAt) {
        // Mark as EXPIRED asynchronously
        dbClient.execute(
            "UPDATE manufacturer_invitations SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [invite.id],
            dbOpts
        ).catch(() => {});
        return { valid: false, error: 'انتهت صلاحية هذه الدعوة (أكثر من 48 ساعة)' };
    }

    // Check manufacturer activity
    if (invite.mfg_is_active === false || invite.mfg_is_active === 0 || invite.mfg_is_active === 'false') {
        return { valid: false, error: 'منشأة المصنع معلقة أو غير نشطة حالياً' };
    }

    return {
        valid: true,
        invitation: {
            id: invite.id,
            manufacturer_id: invite.manufacturer_id,
            manufacturer_name: invite.manufacturer_name_ar,
            email: invite.email,
            sub_role: invite.sub_role,
            expires_at: invite.expires_at
        }
    };
}

/**
 * Atomically accept an invitation and provision user account
 */
async function acceptInvitation({ rawToken, fullName, password, ipAddress = null, dbOpts = {} }) {
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
        throw new Error('الاسم الكامل مطلوب');
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
        throw new Error('كلمة المرور يجب أن لا تقل عن 8 أحرف');
    }

    const verification = await verifyInvitationToken(rawToken, dbOpts);
    if (!verification.valid) {
        throw new Error(verification.error);
    }

    const invite = verification.invitation;
    let createdUser = null;

    await dbClient.transaction(async (tx) => {
        const isPg = dbOpts.engine === 'postgres' || (process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres';
        if (isPg) {
            await tx.queryOne('SELECT id FROM manufacturers WHERE id = ? FOR UPDATE', [invite.manufacturer_id]);
        }

        // Re-check seat capacity under lock
        const seatStats = await calculateSeatUsage(invite.manufacturer_id, tx);
        if (seatStats.activeMembers >= seatStats.maxSeats) {
            throw new Error('عذراً، تم استنفاد مقاعد الاشتراك المتاحة للمنشأة بالكامل');
        }

        // Re-check email uniqueness
        const existingUser = await tx.queryOne(
            'SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
            [invite.email]
        );
        if (existingUser) {
            throw new Error('البريد الإلكتروني مسجل بالفعل لمستخدم آخر');
        }

        // If subRole is OWNER, enforce single active owner constraint
        if (invite.sub_role === SUB_ROLES.OWNER) {
            const activeOwner = await tx.queryOne(`
                SELECT id FROM users 
                WHERE manufacturer_id = ? AND role = 'MANUFACTURER' AND sub_role = 'OWNER' AND is_active = true
            `, [invite.manufacturer_id]);
            if (activeOwner) {
                throw new Error('المنشأة تمتلك مالكاً نشطاً بالفعل');
            }
        }

        // Hash password securely with PBKDF2-HMAC-SHA512 (210,000 iterations)
        const passwordHash = hashPassword(password);
        const userId = 'usr_' + crypto.randomBytes(8).toString('hex');

        // Insert new user
        await tx.execute(`
            INSERT INTO users (
                id, name, email, password_hash, role, sub_role,
                manufacturer_id, is_active, is_demo, token_version, created_at
            ) VALUES (
                ?, ?, ?, ?, 'MANUFACTURER', ?,
                ?, true, false, 1, CURRENT_TIMESTAMP
            )
        `, [
            userId,
            fullName.trim(),
            invite.email,
            passwordHash,
            invite.sub_role,
            invite.manufacturer_id
        ]);

        // Mark invitation as ACCEPTED
        await tx.execute(`
            UPDATE manufacturer_invitations
            SET status = 'ACCEPTED', accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [invite.id]);

        await recordAuditLog({
            manufacturerId: invite.manufacturer_id,
            actorId: userId,
            action: 'INVITATION_ACCEPTED',
            targetId: invite.id,
            details: { user_id: userId, email: invite.email, sub_role: invite.sub_role },
            ipAddress,
            dbOpts: { tx }
        });

        createdUser = {
            id: userId,
            name: fullName.trim(),
            email: invite.email,
            role: 'MANUFACTURER',
            sub_role: invite.sub_role,
            manufacturer_id: invite.manufacturer_id
        };
    }, dbOpts);

    return createdUser;
}

module.exports = {
    calculateSeatUsage,
    createInvitation,
    revokeInvitation,
    verifyInvitationToken,
    acceptInvitation,
    DEFAULT_SEATS_BY_TIER
};
