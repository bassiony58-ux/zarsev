/**
 * src/routes/buyerPortalRoutes.js
 * 
 * Dedicated Buyer Portal API for ZARSEV Sovereign Export Platform.
 * Implements Phase 7.0-A:
 * - Multi-tenant buyer overview.
 * - Access to RFQs, quotations, active contracts, shipments, and documents.
 * - Secure access guarded by buyer token or session.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const { optionalAuthMiddleware } = require('../middlewares/auth');

/**
 * Resolves buyer email from either authenticated session or x-buyer-token header
 */
async function resolveBuyer(req) {
    if (req.user && req.user.role === 'BUYER') {
        return { email: req.user.email, name: req.user.name };
    }

    const token = req.headers['x-buyer-token'] || req.query.buyer_token;
    if (token && typeof token === 'string') {
        const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const dbOpts = req.dbClientOptions || {};
        
        // Find matching RFQ by buyer token hash
        const rfq = await dbClient.queryOne(
            'SELECT buyer_name, business_email, company_name FROM rfqs WHERE buyer_access_token_hash = ?',
            [tokenHash],
            dbOpts
        );
        if (rfq) {
            return { email: rfq.business_email, name: rfq.buyer_name, company: rfq.company_name };
        }
    }

    return null;
}

/**
 * 1. GET /api/buyer/overview
 * Comprehensive data payload for the Buyer Portal Dashboard
 */
router.get('/overview', optionalAuthMiddleware, async (req, res) => {
    const dbOpts = req.dbClientOptions || {};

    try {
        const buyer = await resolveBuyer(req);
        if (!buyer) {
            return res.status(401).json({
                success: false,
                error: 'الوصول غير مصرح: يرجى تقديم رمز وصول المشتري (x-buyer-token) أو تسجيل الدخول'
            });
        }

        const buyerEmail = buyer.email.trim().toLowerCase();

        // 1. Fetch Buyer RFQs
        const rfqs = await dbClient.queryAll(`
            SELECT r.*, p.name_ar as product_name_ar, p.name_en as product_name_en,
                   m.name_ar as mfg_name_ar
            FROM rfqs r
            LEFT JOIN products p ON r.product_id = p.id
            LEFT JOIN manufacturers m ON r.assigned_manufacturer_id = m.id
            WHERE LOWER(r.business_email) = ?
            ORDER BY r.created_at DESC
        `, [buyerEmail], dbOpts);

        // 2. Fetch Received Quotations
        const quotes = await dbClient.queryAll(`
            SELECT q.*, r.reference_no as rfq_reference_no,
                   p.name_ar as product_name_ar, p.name_en as product_name_en,
                   m.name_ar as mfg_name_ar
            FROM quotations q
            JOIN rfqs r ON q.rfq_id = r.id
            JOIN products p ON q.product_id = p.id
            JOIN manufacturers m ON q.manufacturer_id = m.id
            WHERE LOWER(r.business_email) = ?
            ORDER BY q.created_at DESC
        `, [buyerEmail], dbOpts);

        // 3. Fetch Active Contracts
        const contracts = await dbClient.queryAll(`
            SELECT c.*, m.name_ar as mfg_name_ar
            FROM commercial_contracts c
            JOIN manufacturers m ON c.manufacturer_id = m.id
            WHERE LOWER(c.buyer_email) = ?
            ORDER BY c.created_at DESC
        `, [buyerEmail], dbOpts);

        // 4. Fetch Active Shipments
        const shipments = await dbClient.queryAll(`
            SELECT s.*, c.contract_no, m.name_ar as mfg_name_ar
            FROM shipments s
            JOIN commercial_contracts c ON s.contract_id = c.id
            JOIN manufacturers m ON s.manufacturer_id = m.id
            WHERE LOWER(c.buyer_email) = ?
            ORDER BY s.created_at DESC
        `, [buyerEmail], dbOpts);

        const stats = {
            total_rfqs: rfqs.length,
            total_quotations: quotes.length,
            active_contracts: contracts.length,
            active_shipments: shipments.length
        };

        return res.json({
            success: true,
            buyer,
            stats,
            overview: stats,
            rfqs,
            quotations: quotes,
            contracts,
            shipments
        });
    } catch (err) {
        console.error('[buyerPortalRoutes] GET /overview error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
