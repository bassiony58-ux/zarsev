/**
 * src/routes/contractRoutes.js
 * 
 * Commercial Contracts API for ZARSEV.
 * Implements Phase 5.0-A:
 * - Scoped contract listing for Admin, Manufacturer, and Buyer.
 * - Single contract per quotation invariant.
 * - Validity date compliance check.
 * - Closed commercial lineage.
 */

const express = require('express');
const router = express.Router();
const contractService = require('../services/contractService');
const { authMiddleware, optionalAuthMiddleware } = require('../middlewares/auth');

/**
 * 1. GET /api/contracts
 * Lists commercial contracts according to caller's role
 */
router.get('/', authMiddleware, async (req, res) => {
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};
    const { status } = req.query || {};

    try {
        const contracts = await contractService.listContracts({
            role: user.role,
            manufacturerId: user.manufacturer_id,
            buyerEmail: user.role === 'BUYER' ? user.email : null,
            status,
            dbOpts
        });

        return res.json({
            success: true,
            count: contracts.length,
            contracts
        });
    } catch (err) {
        console.error('[contractRoutes] GET / error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 2. GET /api/contracts/:id
 * Fetches single contract details
 */
router.get('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const dbOpts = req.dbClientOptions || {};

    try {
        const data = await contractService.getContractById(id, {
            role: user.role,
            manufacturerId: user.manufacturer_id,
            buyerEmail: user.role === 'BUYER' ? user.email : null,
            dbOpts
        });

        return res.json({
            success: true,
            ...data
        });
    } catch (err) {
        console.error('[contractRoutes] GET /:id error:', err);
        const status = err.message.includes('غير مصرح') ? 403 : 404;
        return res.status(status).json({ success: false, error: err.message });
    }
});

/**
 * 3. POST /api/contracts/from-quotation/:quotationId
 * Creates a formal contract from an accepted quotation
 */
router.post('/from-quotation/:quotationId', optionalAuthMiddleware, async (req, res) => {
    const { quotationId } = req.params;
    const { buyer_notes, buyer_token } = req.body || {};
    const buyerHeaderToken = req.headers['x-buyer-token'];
    const activeToken = buyerHeaderToken || buyer_token;
    const dbOpts = req.dbClientOptions || {};

    const actorId = req.user ? req.user.id : 'BUYER';
    const actorType = req.user ? req.user.role : 'BUYER';

    try {
        const contract = await contractService.createContractFromQuotation({
            quotationId,
            buyerAccessToken: activeToken,
            buyerNotes: buyer_notes,
            actorId,
            actorType,
            dbOpts
        });

        return res.status(201).json({
            success: true,
            message: 'تم إبرام وتوثيق العقد التجاري بنجاح',
            contract
        });
    } catch (err) {
        console.error('[contractRoutes] POST /from-quotation error:', err);
        const statusCode = err.isDuplicate ? 409 : 400;
        return res.status(statusCode).json({ success: false, error: err.message });
    }
});

module.exports = router;
