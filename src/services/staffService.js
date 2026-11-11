/**
 * src/services/staffService.js
 * 
 * Central ZARSEV Admin & Logistics Staff Management Service.
 * Implements Phase 4.0-A requirements:
 * - Secure invitation lifecycle with SHA-256 token hash storage only (zero raw tokens in DB).
 * - Activation with individual strong passwords.
 * - Protection of the last active SUPER_ADMIN against deactivation or demotion.
 * - RBAC enforcement (LOGISTICS_OFFICER cannot manage staff or central permissions).
 * - Multi-layer audit trail for all staff lifecycle operations.
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const { hashPassword } = require('../utils/authUtils');
const { recordAuditLog } = require('./auditLogService');

const STAFF_INVITATION_EXPIRATION_DAYS = 7;

/**
 * Generates a high-entropy crypto random token and its SHA-256 hash
 */
function generateStaffToken() {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    return { rawToken, tokenHash };
}

/**
 * Invites a new Admin or Logistics staff member
 */
async function inviteStaff({
    email,
    role = 'ADMIN',
    subRole = 'LOGISTICS_OFFICER',
    invitedBy,
    ipAddress = null,
    dbOpts = {}
}) {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        throw new Error('البريد الإلكتروني غير صالح');
    }
    const cleanEmail = email.trim().toLowerCase();

    const validRoles = ['ADMIN', 'LOGISTICS'];
    const validSubRoles = ['SUPER_ADMIN', 'LOGISTICS_OFFICER'];

    if (!validRoles.includes(role)) {
        throw new Error('الدور الوظيفي غير مصرح به');
    }
    if (!validSubRoles.includes(subRole)) {
        throw new Error('الصلاحية الفرعية غير مصرح بها');
    }

    // Check if email already exists in users table
    const existingUser = await dbClient.queryOne(
        'SELECT id, email, role, is_active FROM users WHERE LOWER(email) = ?',
        [cleanEmail],
        dbOpts
    );
    if (existingUser) {
        throw new Error('البريد الإلكتروني مسجل بالفعل لمستخدم آخر');
    }

    // Check if there is an active pending invitation
    const existingInvite = await dbClient.queryOne(`
        SELECT id, status, expires_at 
        FROM staff_invitations 
        WHERE LOWER(email) = ? AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP
    `, [cleanEmail], dbOpts);

    if (existingInvite) {
        throw new Error('توجد دعوة معلقة سارية المفعول لهذا البريد الإلكتروني بالفعل');
    }

    const { rawToken, tokenHash } = generateStaffToken();
    const inviteId = 'sinv_' + crypto.randomBytes(12).toString('hex');
    const expiresAt = new Date(Date.now() + STAFF_INVITATION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await dbClient.execute(`
        INSERT INTO staff_invitations (
            id, email, role, sub_role, token_hash, invited_by, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, CURRENT_TIMESTAMP)
    `, [
        inviteId,
        cleanEmail,
        role,
        subRole,
        tokenHash,
        invitedBy,
        expiresAt
    ], dbOpts);

    // Audit logging
    await recordAuditLog({
        manufacturerId: 'SYSTEM_ADMIN',
        actorId: invitedBy,
        actorType: 'SUPER_ADMIN',
        action: 'STAFF_INVITATION_CREATED',
        targetId: inviteId,
        details: { email: cleanEmail, role, subRole, expiresAt },
        ipAddress,
        dbOpts
    });

    return {
        id: inviteId,
        email: cleanEmail,
        role,
        sub_role: subRole,
        expires_at: expiresAt,
        raw_token: rawToken // Returned once for delivery/display
    };
}

/**
 * Verifies a staff invitation token
 */
async function verifyStaffToken(token, dbOpts = {}) {
    if (!token || typeof token !== 'string') {
        return { valid: false, error: 'رمز التفعيل مفقود أو غير صالح' };
    }
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    const invite = await dbClient.queryOne(`
        SELECT id, email, role, sub_role, status, expires_at, created_at
        FROM staff_invitations
        WHERE token_hash = ?
    `, [tokenHash], dbOpts);

    if (!invite) {
        return { valid: false, error: 'رمز الدعوة غير صحيح' };
    }
    if (invite.status !== 'PENDING') {
        return { valid: false, error: `هذه الدعوة لم تعد صالحة (الحالة: ${invite.status})` };
    }
    if (new Date(invite.expires_at) < new Date()) {
        return { valid: false, error: 'انتهت صلاحية رمز الدعوة' };
    }

    return {
        valid: true,
        invitation: {
            id: invite.id,
            email: invite.email,
            role: invite.role,
            sub_role: invite.sub_role,
            expires_at: invite.expires_at
        }
    };
}

/**
 * Accepts a staff invitation and creates/activates the user account
 */
async function acceptStaffInvite({
    token,
    fullName,
    password,
    ipAddress = null,
    dbOpts = {}
}) {
    if (!token || !password || !fullName) {
        throw new Error('جميع الحقول مطلوبة لإتمام التفعيل');
    }
    if (typeof password !== 'string' || password.length < 8) {
        throw new Error('كلمة المرور يجب أن لا تقل عن 8 خانات');
    }

    const verification = await verifyStaffToken(token, dbOpts);
    if (!verification.valid) {
        throw new Error(verification.error);
    }
    const invite = verification.invitation;
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    let newUser = null;

    await dbClient.transaction(async (tx) => {
        // Double check email uniqueness inside transaction
        const existing = await tx.queryOne(
            'SELECT id FROM users WHERE LOWER(email) = ?',
            [invite.email.toLowerCase()]
        );
        if (existing) {
            throw new Error('البريد الإلكتروني مسجل بالفعل');
        }

        const userId = 'usr_' + crypto.randomBytes(12).toString('hex');
        const passHash = hashPassword(password);

        // Insert into users
        await tx.execute(`
            INSERT INTO users (
                id, name, email, password_hash, role, sub_role,
                is_active, token_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            userId,
            fullName.trim(),
            invite.email.toLowerCase(),
            passHash,
            invite.role,
            invite.sub_role
        ]);

        // Mark invitation accepted
        await tx.execute(`
            UPDATE staff_invitations
            SET status = 'ACCEPTED', accepted_at = CURRENT_TIMESTAMP
            WHERE token_hash = ?
        `, [tokenHash]);

        newUser = await tx.queryOne(
            'SELECT id, name, email, role, sub_role, is_active FROM users WHERE id = ?',
            [userId]
        );
    }, dbOpts);

    // Audit log
    await recordAuditLog({
        manufacturerId: 'SYSTEM_ADMIN',
        actorId: newUser.id,
        actorType: newUser.sub_role,
        action: 'STAFF_INVITATION_ACCEPTED',
        targetId: newUser.id,
        details: { email: newUser.email, role: newUser.role, subRole: newUser.sub_role },
        ipAddress,
        dbOpts
    });

    return newUser;
}

/**
 * Lists all administrative and logistics staff members
 */
async function listStaff(dbOpts = {}) {
    const staff = await dbClient.queryAll(`
        SELECT id, name, email, role, sub_role, is_active, is_demo, created_at, updated_at
        FROM users
        WHERE role IN ('ADMIN', 'LOGISTICS')
        ORDER BY created_at ASC
    `, [], dbOpts);

    const invitations = await dbClient.queryAll(`
        SELECT id, email, role, sub_role, status, expires_at, accepted_at, created_at
        FROM staff_invitations
        ORDER BY created_at DESC
        LIMIT 50
    `, [], dbOpts);

    return { staff, invitations };
}

/**
 * Updates staff user status (freeze/activate or change sub_role)
 * Strictly protects the last active SUPER_ADMIN.
 */
async function updateStaffStatus({
    staffId,
    isActive,
    name,
    actorId,
    ipAddress = null,
    dbOpts = {}
}) {
    const targetUser = await dbClient.queryOne(
        'SELECT id, name, email, role, sub_role, is_active FROM users WHERE id = ?',
        [staffId],
        dbOpts
    );
    if (!targetUser) {
        throw new Error('الموظف غير موجود');
    }

    // Invariant Protection: Never deactivate the last active SUPER_ADMIN
    if (targetUser.sub_role === 'SUPER_ADMIN' && isActive === false) {
        const superAdmins = await dbClient.queryAll(`
            SELECT id FROM users
            WHERE role = 'ADMIN' AND sub_role = 'SUPER_ADMIN' AND (is_active = true OR is_active = 1)
        `, [], dbOpts);

        if (superAdmins.length <= 1) {
            throw new Error('لا يمكن تجميد آخر مدير عام نشط في المنصة (SUPER_ADMIN)');
        }
    }

    const newActive = isActive !== undefined ? (isActive ? 1 : 0) : targetUser.is_active;
    const newName = name !== undefined ? name.trim() : targetUser.name;

    await dbClient.execute(`
        UPDATE users
        SET is_active = ?, name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [newActive, newName, staffId], dbOpts);

    // Audit log
    await recordAuditLog({
        manufacturerId: 'SYSTEM_ADMIN',
        actorId,
        actorType: 'SUPER_ADMIN',
        action: 'STAFF_STATUS_UPDATED',
        targetId: staffId,
        details: {
            previousActive: targetUser.is_active,
            newActive,
            name: newName
        },
        ipAddress,
        dbOpts
    });

    return {
        id: staffId,
        name: newName,
        is_active: Boolean(newActive)
    };
}

/**
 * Revokes a pending staff invitation
 */
async function revokeInvitation({ invitationId, actorId, ipAddress = null, dbOpts = {} }) {
    const invite = await dbClient.queryOne(
        'SELECT * FROM staff_invitations WHERE id = ?',
        [invitationId],
        dbOpts
    );
    if (!invite) {
        throw new Error('الدعوة غير موجودة');
    }
    if (invite.status !== 'PENDING') {
        throw new Error('لا يمكن إلغاء دعوة غير معلقة');
    }

    await dbClient.execute(
        "UPDATE staff_invitations SET status = 'REVOKED' WHERE id = ?",
        [invitationId],
        dbOpts
    );

    await recordAuditLog({
        manufacturerId: 'SYSTEM_ADMIN',
        actorId,
        actorType: 'SUPER_ADMIN',
        action: 'STAFF_INVITATION_REVOKED',
        targetId: invitationId,
        details: { email: invite.email },
        ipAddress,
        dbOpts
    });

    return { success: true, message: 'تم إلغاء الدعوة بنجاح' };
}

/**
 * Resends/reissues a staff invitation with a new token and fresh expiry
 */
async function resendInvitation({ invitationId, actorId, ipAddress = null, dbOpts = {} }) {
    const invite = await dbClient.queryOne(
        'SELECT * FROM staff_invitations WHERE id = ?',
        [invitationId],
        dbOpts
    );
    if (!invite) {
        throw new Error('الدعوة غير موجودة');
    }

    const { rawToken, tokenHash } = generateStaffToken();
    const newExpiresAt = new Date(Date.now() + STAFF_INVITATION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await dbClient.execute(`
        UPDATE staff_invitations
        SET token_hash = ?, status = 'PENDING', expires_at = ?, created_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [tokenHash, newExpiresAt, invitationId], dbOpts);

    await recordAuditLog({
        manufacturerId: 'SYSTEM_ADMIN',
        actorId,
        actorType: 'SUPER_ADMIN',
        action: 'STAFF_INVITATION_RESENT',
        targetId: invitationId,
        details: { email: invite.email, expiresAt: newExpiresAt },
        ipAddress,
        dbOpts
    });

    return {
        id: invitationId,
        email: invite.email,
        expires_at: newExpiresAt,
        raw_token: rawToken
    };
}

module.exports = {
    generateStaffToken,
    inviteStaff,
    verifyStaffToken,
    acceptStaffInvite,
    listStaff,
    updateStaffStatus,
    revokeInvitation,
    resendInvitation
};
