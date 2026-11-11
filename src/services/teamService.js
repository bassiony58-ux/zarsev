/**
 * src/services/teamService.js
 * 
 * Manufacturer Team Management & Ownership Governance
 * Enforces single active owner invariant, role delegation, seat monitoring, and atomic ownership transfer.
 */

const dbClient = require('../db/dbClient');
const { verifyPassword } = require('../utils/authUtils');
const { recordAuditLog } = require('./auditLogService');
const { calculateSeatUsage } = require('./invitationService');
const { SUB_ROLES, ALL_SUB_ROLES } = require('../config/manufacturerPermissions');

/**
 * List team members, pending invitations, and seat statistics for a manufacturer
 */
async function listTeamMembers(manufacturerId, dbOpts = {}) {
    const seatStats = await calculateSeatUsage(manufacturerId, null, dbOpts);

    let members = [];
    try {
        members = await dbClient.queryAll(`
            SELECT id, name, email, role, sub_role, is_active, created_at, token_version
            FROM users
            WHERE manufacturer_id = ? AND role = 'MANUFACTURER'
            ORDER BY 
                CASE WHEN sub_role = 'OWNER' THEN 1 ELSE 2 END,
                created_at ASC
        `, [manufacturerId], dbOpts);
    } catch (err) {
        console.error('[listTeamMembers] Error querying members:', err.message);
        throw err;
    }

    let invitations = [];
    try {
        invitations = await dbClient.queryAll(`
            SELECT id, email, sub_role, status, expires_at, created_at, invited_by AS invited_by_user_id
            FROM manufacturer_invitations
            WHERE manufacturer_id = ?
            ORDER BY created_at DESC
        `, [manufacturerId], dbOpts);
    } catch (err) {
        console.error('[listTeamMembers] Error querying invitations:', err.message);
        throw err;
    }

    return {
        members,
        invitations,
        seatStats,
        seats: {
            max: seatStats.maxSeats,
            used: seatStats.totalAllocated,
            active_members: seatStats.activeMembers,
            pending_invites: seatStats.pendingInvites,
            remaining: seatStats.remainingSeats
        }
    };
}

/**
 * Change a team member's sub-role
 */
async function changeMemberSubRole({
    manufacturerId,
    actorId,
    targetUserId,
    newSubRole,
    ipAddress = null,
    dbOpts = {}
}) {
    if (!newSubRole || !ALL_SUB_ROLES.includes(newSubRole)) {
        throw new Error(`الدور الفرعي غير صالح. الخيارات المتاحة: ${ALL_SUB_ROLES.join(', ')}`);
    }

    let updatedUser = null;

    await dbClient.transaction(async (tx) => {
        const isPg = dbOpts.engine === 'postgres' || (process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres';
        if (isPg) {
            await tx.queryOne('SELECT id FROM manufacturers WHERE id = ? FOR UPDATE', [manufacturerId]);
        }

        const targetUser = await tx.queryOne(
            'SELECT * FROM users WHERE id = ? AND manufacturer_id = ?',
            [targetUserId, manufacturerId]
        );

        if (!targetUser) {
            throw new Error('المستخدم غير موجود ضمن فريق المنشأة');
        }

        // Sole Owner Protection: Cannot demote the sole active owner directly via role change
        if (targetUser.sub_role === SUB_ROLES.OWNER && newSubRole !== SUB_ROLES.OWNER) {
            const activeOwners = await tx.queryOne(`
                SELECT COUNT(*) as count 
                FROM users 
                WHERE manufacturer_id = ? AND sub_role = 'OWNER' AND is_active = true
            `, [manufacturerId]);

            if (Number(activeOwners?.count || 0) <= 1) {
                throw new Error('لا يمكن تغيير دور المالك الوحيد للمنشأة مباشرة؛ يرجى استخدام بروتوكول نقل الملكية أولاً');
            }
        }

        // Single Active Owner Protection: Cannot promote to OWNER if an active owner already exists
        if (newSubRole === SUB_ROLES.OWNER && targetUser.sub_role !== SUB_ROLES.OWNER) {
            const activeOwners = await tx.queryOne(`
                SELECT COUNT(*) as count 
                FROM users 
                WHERE manufacturer_id = ? AND sub_role = 'OWNER' AND is_active = true
            `, [manufacturerId]);

            if (Number(activeOwners?.count || 0) >= 1) {
                throw new Error('المنشأة تمتلك مالكاً نشطاً بالفعل؛ لا يمكن تعيين مالك ثانٍ');
            }
        }

        const newVersion = (targetUser.token_version || 1) + 1;

        await tx.execute(`
            UPDATE users
            SET sub_role = ?, token_version = ?
            WHERE id = ?
        `, [newSubRole, newVersion, targetUserId]);

        await recordAuditLog({
            manufacturerId,
            actorId,
            action: 'ROLE_CHANGED',
            targetId: targetUserId,
            details: {
                previous_role: targetUser.sub_role,
                new_role: newSubRole,
                email: targetUser.email
            },
            ipAddress,
            dbOpts: { tx }
        });

        updatedUser = {
            id: targetUser.id,
            name: targetUser.name,
            email: targetUser.email,
            sub_role: newSubRole,
            token_version: newVersion
        };
    }, dbOpts);

    return updatedUser;
}

/**
 * Toggle a team member's active status (Deactivate / Reactivate)
 */
async function setMemberStatus({
    manufacturerId,
    actorId,
    targetUserId,
    isActive,
    ipAddress = null,
    dbOpts = {}
}) {
    let result = null;

    await dbClient.transaction(async (tx) => {
        const isPg = dbOpts.engine === 'postgres' || (process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres';
        if (isPg) {
            await tx.queryOne('SELECT id FROM manufacturers WHERE id = ? FOR UPDATE', [manufacturerId]);
        }

        const targetUser = await tx.queryOne(
            'SELECT * FROM users WHERE id = ? AND manufacturer_id = ?',
            [targetUserId, manufacturerId]
        );

        if (!targetUser) {
            throw new Error('المستخدم غير موجود ضمن فريق المنشأة');
        }

        // Sole Owner Protection: Cannot deactivate the sole active OWNER
        if (!isActive && targetUser.sub_role === SUB_ROLES.OWNER) {
            const activeOwners = await tx.queryOne(`
                SELECT COUNT(*) as count 
                FROM users 
                WHERE manufacturer_id = ? AND sub_role = 'OWNER' AND is_active = true
            `, [manufacturerId]);

            if (Number(activeOwners?.count || 0) <= 1) {
                throw new Error('غير مصرح: لا يمكن تجميد أو تعطيل المالك الوحيد للمنشأة. يلزم نقل الملكية أولاً');
            }
        }

        // If reactivating, check seat quota
        if (isActive && !targetUser.is_active) {
            const seatStats = await calculateSeatUsage(manufacturerId, tx);
            if (!seatStats.isQuotaAvailable) {
                throw new Error(`لا يمكن إعادة تفعيل المستخدم: تم استنفاد مقاعد الاشتراك (${seatStats.maxSeats} مقاعد)`);
            }
        }

        const newVersion = (targetUser.token_version || 1) + 1;
        const activeVal = isPg ? Boolean(isActive) : (isActive ? 1 : 0);

        await tx.execute(`
            UPDATE users
            SET is_active = ?, token_version = ?
            WHERE id = ?
        `, [activeVal, newVersion, targetUserId]);

        const actionName = isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED';
        await recordAuditLog({
            manufacturerId,
            actorId,
            action: actionName,
            targetId: targetUserId,
            details: { email: targetUser.email, is_active: isActive },
            ipAddress,
            dbOpts: { tx }
        });

        result = {
            id: targetUser.id,
            name: targetUser.name,
            email: targetUser.email,
            is_active: isActive,
            token_version: newVersion
        };
    }, dbOpts);

    return result;
}

/**
 * Atomic Ownership Transfer Protocol
 * Safely swaps OWNER status from current owner to target user within single atomic transaction.
 */
async function transferOwnership({
    manufacturerId,
    currentOwnerId,
    targetUserId,
    currentOwnerPassword,
    demotedRole = SUB_ROLES.SALES,
    ipAddress = null,
    dbOpts = {}
}) {
    if (!currentOwnerPassword || typeof currentOwnerPassword !== 'string') {
        throw new Error('تأكيد كلمة مرور المالك الحالي مطلوب لتنفيذ هذا الإجراء الحساس');
    }

    if (currentOwnerId === targetUserId) {
        throw new Error('لا يمكن نقل الملكية إلى نفس المستخدم الحالي');
    }

    let transferResult = null;

    await dbClient.transaction(async (tx) => {
        const isPg = dbOpts.engine === 'postgres' || (process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres';
        if (isPg) {
            await tx.queryOne('SELECT id FROM manufacturers WHERE id = ? FOR UPDATE', [manufacturerId]);
        }

        // 1. Verify current owner identity and password
        const currentOwner = await tx.queryOne(
            'SELECT * FROM users WHERE id = ? AND manufacturer_id = ?',
            [currentOwnerId, manufacturerId]
        );
        if (!currentOwner || currentOwner.sub_role !== SUB_ROLES.OWNER) {
            throw new Error('المستخدم الحالي ليس المالك المعتمد لهذه المنشأة');
        }

        const isPasswordValid = verifyPassword(currentOwnerPassword, currentOwner.password_hash);
        if (!isPasswordValid) {
            throw new Error('كلمة المرور غير صحيحة. تم رفض نقل الملكية');
        }

        // 2. Verify target user
        const targetUser = await tx.queryOne(
            'SELECT * FROM users WHERE id = ? AND manufacturer_id = ?',
            [targetUserId, manufacturerId]
        );
        if (!targetUser) {
            throw new Error('المستخدم المستهدف لنقل الملكية غير موجود ضمن فريق المنشأة');
        }
        if (!targetUser.is_active) {
            throw new Error('لا يمكن نقل الملكية إلى مستخدم معطل أو غير نشط');
        }

        // 3. Atomically update both users: Demote current, Promote target, invalidate tokens
        const newOwnerVersion = (targetUser.token_version || 1) + 1;
        const oldOwnerVersion = (currentOwner.token_version || 1) + 1;

        // Demote previous owner
        await tx.execute(`
            UPDATE users
            SET sub_role = ?, token_version = ?
            WHERE id = ?
        `, [demotedRole, oldOwnerVersion, currentOwnerId]);

        // Promote new owner
        await tx.execute(`
            UPDATE users
            SET sub_role = 'OWNER', token_version = ?
            WHERE id = ?
        `, [newOwnerVersion, targetUserId]);

        // 4. Audit Log
        await recordAuditLog({
            manufacturerId,
            actorId: currentOwnerId,
            action: 'OWNERSHIP_TRANSFERRED',
            targetId: targetUserId,
            details: {
                previous_owner: { id: currentOwner.id, email: currentOwner.email, demoted_to: demotedRole },
                new_owner: { id: targetUser.id, email: targetUser.email }
            },
            ipAddress,
            dbOpts: { tx }
        });

        transferResult = {
            success: true,
            previous_owner_id: currentOwner.id,
            previous_owner_new_role: demotedRole,
            new_owner_id: targetUser.id,
            new_owner_email: targetUser.email
        };
    }, dbOpts);

    return transferResult;
}

module.exports = {
    listTeamMembers,
    changeMemberSubRole,
    setMemberStatus,
    transferOwnership
};
