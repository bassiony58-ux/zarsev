/**
 * src/services/secureDocumentService.js
 * 
 * Secure Isolated Document Storage & Access Control for Manufacturers
 * Features:
 * - Storage strictly outside public directory (`storage/secure_docs/manufacturers/<mfgId>/`)
 * - Path Traversal prevention via strict path.resolve boundary enforcement
 * - Magic Bytes verification (PDF, PNG, JPEG) to block disguised executables
 * - Document classification (LEGAL vs EXPORT) and sub-role access enforcement
 * - Audit logging for upload and download events
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbClient = require('../db/dbClient');
const { recordAuditLog } = require('./auditLogService');
const { SUB_ROLES } = require('../config/manufacturerPermissions');

const BASE_STORAGE_DIR = path.resolve('M:/ZZZ/storage/secure_docs/manufacturers');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

const DOC_TYPES = Object.freeze({
    LEGAL: 'LEGAL',
    EXPORT: 'EXPORT'
});

/**
 * Validates file magic bytes against real binary signatures
 */
function validateMagicBytes(buffer, ext) {
    if (!buffer || buffer.length < 8) return false;

    if (ext === '.pdf') {
        // PDF magic bytes: %PDF (0x25 0x50 0x44 0x46)
        return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
    }

    if (ext === '.png') {
        // PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
        return (
            buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
            buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
        );
    }

    if (ext === '.jpg' || ext === '.jpeg') {
        // JPEG magic bytes: 0xFF 0xD8 0xFF
        return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    }

    return false;
}

/**
 * Returns safe isolated directory for manufacturer
 */
function getManufacturerStorageDir(manufacturerId) {
    if (!manufacturerId || typeof manufacturerId !== 'string') {
        throw new Error('معرف المنشأة مطلوب');
    }
    if (manufacturerId.includes('..') || manufacturerId.includes('/') || manufacturerId.includes('\\')) {
        throw new Error('محاولة اختراق مسار التخزين (Path Traversal Detected)');
    }
    const sanitizedMfgId = manufacturerId.replace(/[^a-zA-Z0-9_-]/g, '');
    const mfgDir = path.resolve(BASE_STORAGE_DIR, sanitizedMfgId);

    // Verify resolved path is strictly inside BASE_STORAGE_DIR
    if (!mfgDir.startsWith(BASE_STORAGE_DIR)) {
        throw new Error('محاولة اختراق مسار التخزين (Path Traversal Detected)');
    }

    if (!fs.existsSync(mfgDir)) {
        fs.mkdirSync(mfgDir, { recursive: true });
    }

    return mfgDir;
}

/**
 * Upload and securely store a manufacturer document
 */
async function uploadDocument({
    manufacturerId,
    userId,
    userSubRole,
    docType,
    title,
    originalName,
    mimeType,
    fileBuffer,
    ipAddress = null,
    dbOpts = {}
}) {
    if (!title || typeof title !== 'string' || !title.trim()) {
        throw new Error('عنوان المستند مطلوب');
    }

    if (![DOC_TYPES.LEGAL, DOC_TYPES.EXPORT].includes(docType)) {
        throw new Error('نوع المستند غير صالح. الأنواع المسموحة: LEGAL أو EXPORT');
    }

    // Role verification
    if (docType === DOC_TYPES.LEGAL && userSubRole !== SUB_ROLES.OWNER) {
        throw new Error('غير مصرح: إدارة المستندات القانونية تقتصر على المالك OWNER فقط');
    }
    if (docType === DOC_TYPES.EXPORT && ![SUB_ROLES.OWNER, SUB_ROLES.EXPORT].includes(userSubRole)) {
        throw new Error('غير مصرح: رفع مستندات التصدير يقتصر على OWNER أو EXPORT');
    }

    if (!fileBuffer || fileBuffer.length === 0) {
        throw new Error('الملف فارغ أو غير موجود');
    }

    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
        throw new Error(`حجم الملف يتجاوز الحد الأقصى المسموح به (${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB)`);
    }

    const rawExt = path.extname(originalName || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(rawExt)) {
        throw new Error(`صيغة الملف غير مسموح بها. الصيغ المسموحة: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`);
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new Error(`نوع الوسائط MIME غير صالح: ${mimeType}`);
    }

    // Magic Bytes Verification
    const magicValid = validateMagicBytes(fileBuffer, rawExt);
    if (!magicValid) {
        throw new Error('فشل فحص البصمة الثنائية (Magic Bytes): محتوى الملف لا يطابق امتداده المصرح به');
    }

    // Generate random UUID storage filename
    const fileUuid = crypto.randomUUID();
    const storedFilename = `${fileUuid}${rawExt}`;
    const mfgDir = getManufacturerStorageDir(manufacturerId);
    const targetFilePath = path.resolve(mfgDir, storedFilename);

    // Strict path traversal double check
    if (!targetFilePath.startsWith(mfgDir)) {
        throw new Error('محاولة اختراق مسار التخزين (Path Traversal Detected)');
    }

    // Write file securely
    fs.writeFileSync(targetFilePath, fileBuffer);

    // Save document record to DB
    const docId = 'doc_' + crypto.randomBytes(8).toString('hex');

    await dbClient.execute(`
        INSERT INTO manufacturer_documents (
            id, manufacturer_id, doc_type, title, filename, original_name,
            mime_type, file_size, uploaded_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
        docId,
        manufacturerId,
        docType,
        title.trim(),
        storedFilename,
        path.basename(originalName),
        mimeType,
        fileBuffer.length,
        userId
    ], dbOpts);

    await recordAuditLog({
        manufacturerId,
        actorId: userId,
        action: 'DOCUMENT_UPLOADED',
        targetId: docId,
        details: { doc_type: docType, title: title.trim(), file_size: fileBuffer.length },
        ipAddress,
        dbOpts
    });

    return {
        id: docId,
        manufacturer_id: manufacturerId,
        doc_type: docType,
        title: title.trim(),
        original_name: path.basename(originalName),
        file_size: fileBuffer.length,
        created_at: new Date().toISOString()
    };
}

/**
 * List documents for a manufacturer filtered by sub-role visibility
 */
async function listDocuments(manufacturerId, userSubRole, dbOpts = {}) {
    let allowedTypes = [];
    if (userSubRole === SUB_ROLES.OWNER) {
        allowedTypes = [DOC_TYPES.LEGAL, DOC_TYPES.EXPORT];
    } else if (userSubRole === SUB_ROLES.EXPORT) {
        allowedTypes = [DOC_TYPES.EXPORT];
    } else {
        return [];
    }

    try {
        const docs = await dbClient.queryAll(`
            SELECT id, manufacturer_id, doc_type, title, original_name, mime_type, file_size, created_at
            FROM manufacturer_documents
            WHERE manufacturer_id = ?
            ORDER BY created_at DESC
        `, [manufacturerId], dbOpts);

        return docs.filter(d => allowedTypes.includes(d.doc_type));
    } catch (err) {
        // Return empty array if table not created yet
        return [];
    }
}

/**
 * Retrieve document metadata and verify access for download
 */
async function getDocumentForDownload({
    docId,
    manufacturerId,
    userSubRole,
    userId,
    ipAddress = null,
    dbOpts = {}
}) {
    const doc = await dbClient.queryOne(`
        SELECT * FROM manufacturer_documents WHERE id = ?
    `, [docId], dbOpts);

    if (!doc) {
        throw new Error('المستند غير موجود');
    }

    // Strict multi-tenant isolation: document MUST belong to the user's manufacturer
    if (doc.manufacturer_id !== manufacturerId) {
        throw new Error('غير مصرح: لا يمكنك الوصول إلى مستندات تخص منشأة أخرى');
    }

    // Access control based on document type
    if (doc.doc_type === DOC_TYPES.LEGAL && userSubRole !== SUB_ROLES.OWNER) {
        throw new Error('غير مصرح: الاطلاع على المستندات القانونية مخصص للمالك OWNER فقط');
    }
    if (doc.doc_type === DOC_TYPES.EXPORT && ![SUB_ROLES.OWNER, SUB_ROLES.EXPORT].includes(userSubRole)) {
        throw new Error('غير مصرح: الاطلاع على مستندات التصدير مخصص لـ OWNER و EXPORT فقط');
    }

    const mfgDir = getManufacturerStorageDir(manufacturerId);
    const filePath = path.resolve(mfgDir, doc.filename);

    // Path traversal check
    if (!filePath.startsWith(mfgDir)) {
        throw new Error('مسار المستند غير آمن');
    }

    if (!fs.existsSync(filePath)) {
        throw new Error('ملف المستند غير موجود على خادم التخزين');
    }

    await recordAuditLog({
        manufacturerId,
        actorId: userId,
        action: 'DOCUMENT_DOWNLOADED',
        targetId: docId,
        details: { doc_type: doc.doc_type, title: doc.title },
        ipAddress,
        dbOpts
    });

    return {
        filePath,
        originalName: doc.original_name,
        mimeType: doc.mime_type,
        fileSize: doc.file_size
    };
}

module.exports = {
    DOC_TYPES,
    ALLOWED_EXTENSIONS,
    ALLOWED_MIME_TYPES,
    validateMagicBytes,
    getManufacturerStorageDir,
    uploadDocument,
    listDocuments,
    getDocumentForDownload
};
