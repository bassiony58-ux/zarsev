/**
 * src/routes/notificationRoutes.js
 * 
 * In-App Notification & Outbox API for ZARSEV.
 * Implements Phase 4.0-E requirements:
 * - Isolated recipient notification retrieval (User or Manufacturer context).
 * - Real-time unread counts and mark-as-read transitions.
 * - Outbox processor runner endpoint (guarded).
 */

const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');
const { authMiddleware, requireRole } = require('../middlewares/auth');

/**
 * Helper to determine recipient type and ID from authenticated user session
 */
function resolveRecipient(req) {
    const user = req.user;
    if (!user) return { type: null, id: null };

    if (user.role === 'MANUFACTURER' && user.manufacturer_id) {
        return { type: 'MANUFACTURER', id: user.manufacturer_id };
    }
    if (user.role === 'ADMIN') {
        return { type: 'ADMIN', id: user.id };
    }
    if (user.role === 'LOGISTICS') {
        return { type: 'LOGISTICS', id: user.id };
    }
    return { type: 'USER', id: user.id };
}

/**
 * 1. GET /api/notifications
 * Lists current user notifications
 */
router.get('/', authMiddleware, async (req, res) => {
    const { type, id } = resolveRecipient(req);
    if (!type || !id) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const dbOpts = req.dbClientOptions || {};

    try {
        const result = await notificationService.getUserNotifications(type, id, { limit, offset }, dbOpts);
        return res.json({
            success: true,
            ...result
        });
    } catch (err) {
        console.error('[notificationRoutes] GET / error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. GET /api/notifications/unread-count
 * Returns number of unread notifications
 */
router.get('/unread-count', authMiddleware, async (req, res) => {
    const { type, id } = resolveRecipient(req);
    if (!type || !id) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
    }

    const dbOpts = req.dbClientOptions || {};
    try {
        const count = await notificationService.getUnreadCount(type, id, dbOpts);
        return res.json({ success: true, unread_count: count });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 3. PATCH /api/notifications/:id/read
 * Marks single notification as read
 */
router.patch('/:id/read', authMiddleware, async (req, res) => {
    const { id: notifId } = req.params;
    const { type, id } = resolveRecipient(req);
    const dbOpts = req.dbClientOptions || {};

    try {
        const result = await notificationService.markAsRead(notifId, type, id, dbOpts);
        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 4. POST /api/notifications/mark-all-read
 * Marks all notifications as read for current recipient
 */
router.post('/mark-all-read', authMiddleware, async (req, res) => {
    const { type, id } = resolveRecipient(req);
    const dbOpts = req.dbClientOptions || {};

    try {
        const result = await notificationService.markAllAsRead(type, id, dbOpts);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. POST /api/notifications/process-outbox
 * Triggers processing of the Outbox queue (SUPER_ADMIN only)
 */
router.post('/process-outbox', authMiddleware, requireRole(['SUPER_ADMIN']), async (req, res) => {
    const dbOpts = req.dbClientOptions || {};
    try {
        const result = await notificationService.processOutbox(20, dbOpts);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
