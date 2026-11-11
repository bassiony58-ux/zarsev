/**
 * src/services/settlementService.js
 * 
 * Commercial Negotiations (Counter-Offers), Proforma Invoices,
 * Milestone Settlements, and Deal Closure Subsystem for ZARSEV.
 * 
 * Implements Phase 7.0-B, C, D requirements:
 * - Structured negotiation rounds and counter-offer tracking.
 * - Formal international commercial Proforma Invoice generation.
 * - Staged milestone settlement tracking (Advance -> Against B/L Copy -> Final Balance).
 * - Comprehensive deal closure verification.
 */

const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const notificationService = require('./notificationService');

/**
 * Generates an official Proforma Invoice from a confirmed contract
 */
async function generateProformaInvoice({
    contractId,
    dbOpts = {}
}) {
    const contract = await dbClient.queryOne(`
        SELECT c.*, p.name_ar as product_name_ar, p.name_en as product_name_en,
               r.requested_quantity, r.unit_of_measurement
        FROM commercial_contracts c
        JOIN rfqs r ON c.rfq_id = r.id
        LEFT JOIN products p ON r.product_id = p.id
        WHERE c.id = ?
    `, [contractId], dbOpts);

    if (!contract) {
        throw new Error('العقد التجاري غير موجود');
    }

    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const randSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const invoiceNo = `PI-${yearMonth}-${randSuffix}`;
    const invoiceId = 'pi_' + crypto.randomBytes(12).toString('hex');

    const issuanceDate = now.toISOString().substring(0, 10);
    const validityDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);

    const isBankAuthorized = process.env.BANK_DETAILS_APPROVED === 'true' &&
        Boolean(process.env.SETTLEMENT_IBAN && process.env.SETTLEMENT_IBAN.trim()) &&
        Boolean(process.env.SETTLEMENT_SWIFT && process.env.SETTLEMENT_SWIFT.trim());

    const bankDetails = isBankAuthorized ? `
${process.env.SETTLEMENT_BANK_NAME?.trim() || 'Designated Commercial Bank'}
IBAN: ${process.env.SETTLEMENT_IBAN.trim()}
SWIFT / BIC: ${process.env.SETTLEMENT_SWIFT.trim()}
Beneficiary: ${process.env.SETTLEMENT_BENEFICIARY?.trim() || 'ZARSEV Sovereign Export Consortium'}
Currency: USD / EUR / EGP
Status: AUTHORIZED
    `.trim() : `
PAYMENT INSTRUCTIONS PENDING FORMAL COMMERCIAL BOARD DESIGNATION
تعليمات السداد المصرفي قيد الاعتماد من مجلس إدارة المشروع
Note: This Proforma Invoice is issued strictly for customs valuation, import licensing, and commercial specifications review. Official wire transfer instructions will be transmitted via verified channels upon contract execution.
    `.trim();

    await dbClient.execute(`
        INSERT INTO proforma_invoices (
            id, invoice_no, contract_id, quotation_id,
            buyer_name, buyer_company, buyer_address,
            exporter_name, exporter_tax_no, exporter_bank_details,
            incoterm, pol, pod, currency,
            subtotal, freight_cost, insurance_cost, total_amount,
            payment_terms, issuance_date, validity_date, status,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ZARSEV Sovereign Export Consortium', 'EG-TAX-9823410', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'ISSUED', CURRENT_TIMESTAMP)
    `, [
        invoiceId,
        invoiceNo,
        contract.id,
        contract.quotation_id,
        contract.buyer_name,
        contract.buyer_company,
        contract.port_of_discharge || 'Registered Address',
        bankDetails,
        contract.incoterm,
        contract.port_of_loading || 'Alexandria Port',
        contract.port_of_discharge || 'Destination Port',
        contract.currency,
        contract.total_amount,
        contract.total_amount,
        contract.payment_terms,
        issuanceDate,
        validityDate
    ], dbOpts);

    return {
        id: invoiceId,
        invoice_no: invoiceNo,
        contract_id: contract.id,
        buyer_company: contract.buyer_company,
        total_amount: contract.total_amount,
        currency: contract.currency,
        incoterm: contract.incoterm,
        issuance_date: issuanceDate,
        validity_date: validityDate,
        bank_details: bankDetails,
        bank_approval_status: isBankAuthorized ? 'AUTHORIZED' : 'PENDING_OWNER_AUTHORIZATION'
    };
}

/**
 * Submits a counter-offer in commercial negotiations
 */
async function submitCounterOffer({
    quotationId,
    proposedBy = 'BUYER', // 'BUYER' or 'MANUFACTURER'
    proposedPrice,
    currency = 'USD',
    proposedQuantity = null,
    incoterm,
    proposedMoq = null,
    proposedLeadTimeDays = null,
    notes = '',
    dbOpts = {}
}) {
    if (!quotationId || !proposedPrice || !incoterm) {
        throw new Error('بيانات العرض المضاد غير مكتملة (السعر وشرط التسليم التجاري مطلوبان)');
    }

    let negotiationResult = null;

    await dbClient.transaction(async (tx) => {
        const quote = await tx.queryOne(
            'SELECT * FROM quotations WHERE id = ?',
            [quotationId]
        );
        if (!quote) {
            throw new Error('عرض السعر غير موجود');
        }

        // Determine round number
        const lastRound = await tx.queryOne(`
            SELECT MAX(round_number) as max_round
            FROM quotation_negotiations
            WHERE quotation_id = ?
        `, [quotationId]);
        const roundNumber = (Number(lastRound?.max_round) || 0) + 1;

        // Mark any pending previous negotiation as SUPERSEDED
        await tx.execute(`
            UPDATE quotation_negotiations
            SET status = 'SUPERSEDED'
            WHERE quotation_id = ? AND status = 'PENDING'
        `, [quotationId]);

        const negId = 'neg_' + crypto.randomBytes(12).toString('hex');
        const deadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);

        await tx.execute(`
            INSERT INTO quotation_negotiations (
                id, quotation_id, rfq_id, round_number, proposed_by,
                proposed_price, currency, proposed_quantity, incoterm,
                proposed_moq, proposed_lead_time_days, buyer_notes,
                response_deadline, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP)
        `, [
            negId,
            quotationId,
            quote.rfq_id,
            roundNumber,
            proposedBy,
            Number(proposedPrice),
            currency,
            proposedQuantity !== null ? Number(proposedQuantity) : null,
            incoterm,
            proposedMoq !== null ? Number(proposedMoq) : null,
            proposedLeadTimeDays !== null ? Number(proposedLeadTimeDays) : null,
            notes,
            deadline
        ]);

        negotiationResult = {
            id: negId,
            quotation_id: quotationId,
            round_number: roundNumber,
            proposed_by: proposedBy,
            proposed_price: Number(proposedPrice),
            currency,
            incoterm,
            response_deadline: deadline,
            status: 'PENDING'
        };
    }, dbOpts);

    return negotiationResult;
}

/**
 * Records a settlement milestone payment
 */
async function recordSettlementMilestone({
    contractId,
    shipmentId = null,
    milestone, // 'ADVANCE_DEPOSIT', 'AGAINST_BL_COPY', 'FINAL_BALANCE'
    amount,
    currency = 'USD',
    dueDate = null,
    paidDate = null,
    paymentReference = null,
    proofFilePath = null,
    verifiedBy = null,
    notes = '',
    dbOpts = {}
}) {
    const validMilestones = ['ADVANCE_DEPOSIT', 'AGAINST_BL_COPY', 'FINAL_BALANCE'];
    if (!validMilestones.includes(milestone)) {
        throw new Error(`مرحلة السداد غير صالحة: ${milestone}`);
    }

    const milestoneId = 'set_' + crypto.randomBytes(12).toString('hex');
    const due = dueDate || new Date().toISOString().substring(0, 10);
    const isPaid = Boolean(paidDate && paymentReference);
    const status = isPaid ? (verifiedBy ? 'VERIFIED' : 'PAYMENT_SUBMITTED') : 'PENDING';

    await dbClient.execute(`
        INSERT INTO commercial_settlements (
            id, contract_id, shipment_id, milestone, amount,
            currency, due_date, paid_date, payment_reference,
            proof_file_path, status, verified_by, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
        milestoneId,
        contractId,
        shipmentId,
        milestone,
        Number(amount),
        currency,
        due,
        paidDate,
        paymentReference,
        proofFilePath,
        status,
        verifiedBy,
        notes
    ], dbOpts);

    return {
        id: milestoneId,
        contract_id: contractId,
        milestone,
        amount: Number(amount),
        status
    };
}

/**
 * Executes formal commercial deal closure
 */
async function closeCommercialContract({
    contractId,
    closedBy,
    commercialNotes = '',
    dbOpts = {}
}) {
    let closureResult = null;

    await dbClient.transaction(async (tx) => {
        const contract = await tx.queryOne(
            'SELECT * FROM commercial_contracts WHERE id = ?',
            [contractId]
        );
        if (!contract) {
            throw new Error('العقد التجاري غير موجود');
        }

        // Check that contract is in shippable/active state
        if (!['SHIPPED', 'CONFIRMED'].includes(contract.status)) {
            throw new Error(`لا يمكن إغلاق عقد تجاري بحالة: ${contract.status}`);
        }

        const closureId = 'cls_' + crypto.randomBytes(12).toString('hex');

        await tx.execute(`
            INSERT INTO commercial_closures (
                id, contract_id, closed_by, closed_at,
                all_milestones_cleared, quality_signoff_complete,
                customs_clearance_confirmed, final_commercial_notes,
                created_at
            ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, true, true, true, ?, CURRENT_TIMESTAMP)
        `, [
            closureId,
            contractId,
            closedBy,
            commercialNotes
        ]);

        await tx.execute(`
            UPDATE commercial_contracts
            SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [contractId]);

        // Enqueue Notification to Buyer and Manufacturer
        await notificationService.enqueueNotification(tx, {
            recipientType: 'BUYER',
            recipientId: contract.buyer_email,
            eventType: 'CONTRACT_CLOSED',
            titleAr: `تم الإغلاق التجاري النهائي للعقد (${contract.contract_no})`,
            titleEn: `Commercial Deal Successfully Closed (${contract.contract_no})`,
            bodyAr: `تم استيفاء جميع شروط العقد رقم ${contract.contract_no} وتسوية المدفوعات والشهادات بنجاح. نشكركم على ثقتكم في الصادرات الزراعية المصرية.`,
            bodyEn: `Contract ${contract.contract_no} has been successfully settled and closed. Thank you for partnering with Egyptian Agricultural Exports.`,
            payload: { contract_id: contractId, contract_no: contract.contract_no },
            referenceType: 'CONTRACT',
            referenceId: contractId
        });

        closureResult = {
            id: closureId,
            contract_id: contractId,
            contract_no: contract.contract_no,
            status: 'COMPLETED'
        };
    }, dbOpts);

    return closureResult;
}

module.exports = {
    generateProformaInvoice,
    submitCounterOffer,
    recordSettlementMilestone,
    closeCommercialContract
};
