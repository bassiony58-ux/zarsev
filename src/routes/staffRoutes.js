/**
 * src/routes/staffRoutes.js
 * 
 * Central ZARSEV Admin & Logistics Staff Management API.
 * Implements Phase 4.0-A requirements:
 * - Invitations lifecycle (create, verify, accept, resend, revoke).
 * - Single-use token with SHA-256 hash storage.
 * - Password activation per user.
 * - Invariant: Protect last active SUPER_ADMIN.
 * - Strict RBAC: LOGISTICS_OFFICER cannot access or manage staff.
 */

const express = require('express');
const router = express.Router();
const staffService = require('../services/staffService');
const { authMiddleware, requireRole, requireSubRole } = require('../middlewares/auth');

/**
 * 1. GET /api/admin/staff
 * Lists all staff members and invitations (SUPER_ADMIN only)
 */
router.get('/', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    try {
        const dbOpts = req.dbClientOptions || {};
        const data = await staffService.listStaff(dbOpts);
        return res.json({
            success: true,
            ...data
        });
    } catch (err) {
        console.error('[staffRoutes] GET / error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. POST /api/admin/staff/invite
 * Invites a new staff member (SUPER_ADMIN only)
 */
router.post('/invite', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const { email, role, sub_role } = req.body || {};
    const dbOpts = req.dbClientOptions || {};
    const ipAddress = req.ip || req.connection?.remoteAddress;

    try {
        const result = await staffService.inviteStaff({
            email,
            role,
            subRole: sub_role,
            invitedBy: req.user.id,
            ipAddress,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم إرسال دعوة الانضمام لفريق العمل بنجاح',
            invitation: result
        });
    } catch (err) {
        console.error('[staffRoutes] POST /invite error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 3. GET /api/admin/staff/invitations/verify
 * Verifies invitation token validity (Public)
 */
router.get('/invitations/verify', async (req, res) => {
    const { token } = req.query || {};
    const dbOpts = req.dbClientOptions || {};

    try {
        const verification = await staffService.verifyStaffToken(token, dbOpts);
        if (!verification.valid) {
            return res.status(400).json({ success: false, error: verification.error });
        }

        return res.json({
            success: true,
            invitation: verification.invitation
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 4. POST /api/admin/staff/invitations/accept
 * Accepts invitation, sets password, and activates account (Public)
 */
router.post('/invitations/accept', async (req, res) => {
    const { token, full_name, password } = req.body || {};
    const dbOpts = req.dbClientOptions || {};
    const ipAddress = req.ip || req.connection?.remoteAddress;

    try {
        const user = await staffService.acceptStaffInvite({
            token,
            fullName: full_name,
            password,
            ipAddress,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم تفعيل حساب الموظف بنجاح! يمكنك الآن تسجيل الدخول.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                sub_role: user.sub_role
            }
        });
    } catch (err) {
        console.error('[staffRoutes] POST /invitations/accept error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 5. PATCH /api/admin/staff/:id
 * Updates staff user profile or active status (SUPER_ADMIN only)
 */
router.patch('/:id', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { is_active, name } = req.body || {};
    const dbOpts = req.dbClientOptions || {};
    const ipAddress = req.ip || req.connection?.remoteAddress;

    try {
        const updated = await staffService.updateStaffStatus({
            staffId: id,
            isActive: is_active,
            name,
            actorId: req.user.id,
            ipAddress,
            dbOpts
        });

        return res.json({
            success: true,
            message: 'تم تحديث بيانات الموظف بنجاح',
            staff: updated
        });
    } catch (err) {
        console.error('[staffRoutes] PATCH /:id error:', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 6. POST /api/admin/staff/invitations/:id/resend
 * Resends staff invitation with fresh expiry (SUPER_ADMIN only)
 */
router.post('/invitations/:id/resend', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};
    const ipAddress = req.ip || req.connection?.remoteAddress;

    try {
        const result = await staffService.resendInvitation({
            invitationId: id,
            actorId: req.user.id,
            ipAddress,
            dbOpts
        });

        return res.json({
            success: true,
            message: 'تم إعادة إصدار دعوة الموظف بنجاح',
            invitation: result
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 7. POST /api/admin/staff/invitations/:id/revoke
 * Revokes a pending staff invitation (SUPER_ADMIN only)
 */
router.post('/invitations/:id/revoke', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const { id } = req.params;
    const dbOpts = req.dbClientOptions || {};
    const ipAddress = req.ip || req.connection?.remoteAddress;

    try {
        const result = await staffService.revokeInvitation({
            invitationId: id,
            actorId: req.user.id,
            ipAddress,
            dbOpts
        });

        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
