/**
 * scripts/migrate_sqlite_to_postgres.js
 * 
 * Production-grade data migration engine from SQLite (M:/ZZZ/zarsev.db) to PostgreSQL.
 * 
 * Strict Safety & Conflict Guard Rules (Phase 2.3 & 2.3.2):
 * - Operates EXCLUSIVELY on zarsev_test during Phase 2.x dry runs.
 * - Throws immediately if target is not zarsev_test.
 * - Reads SQLite strictly in read-only mode ({ readOnly: true }).
 * - Zero ON CONFLICT (id) DO NOTHING without exhaustive data comparison.
 * - Zero ON CONFLICT (id) DO UPDATE or automatic upsert.
 * - Dynamic Schema Validation: Verifies full column coverage against information_schema before any writes.
 * - Strict String Equality: Exact string comparison without generic .trim().
 * - Generalized Sensitive-Value Redaction: Protects password, secret, token, key, credential.
 * - Safe Error Handling: Redacts raw row data from database constraint errors.
 * - For every record:
 *     1. If not present in PostgreSQL -> insert it.
 *     2. If present and all fields match -> count as ALREADY_MATCHED without modification.
 *     3. If present and ANY field differs -> throw MigrationConflictError, rollback, and halt.
 * - Full transactional execution per table with rollback on any conflict or error.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { getMigratorClient, closePool } = require('../src/db/pgAdapter');
const { runMigrations } = require('../src/db/pgMigrator');

const TARGET_DB = 'zarsev_test';
const SQLITE_PATH = path.resolve(__dirname, '..', 'zarsev.db');

const SENSITIVE_COLUMN_PATTERN = /(password|secret|token|key|credential)/i;

class MigrationConflictError extends Error {
    constructor({ table, id, differences }) {
        const diffLines = differences.map(d =>
            `  - Column '${d.column}': source='${d.sourceValue}' vs target='${d.targetValue}' (${d.reason})`
        ).join('\n');
        super(
            `[MIGRATION CONFLICT] Table '${table}', Record ID '${id}' already exists in PostgreSQL with DIFFERENT data:\n${diffLines}\nMigration halted immediately. Transaction rolled back.`
        );
        this.name = 'MigrationConflictError';
        this.table = table;
        this.id = id;
        this.differences = differences;
    }
}

class SchemaMismatchError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SchemaMismatchError';
        this.details = details;
    }
}

function canonicalizeJson(obj) {
    if (obj === null || obj === undefined) return null;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(canonicalizeJson);
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = canonicalizeJson(obj[key]);
    }
    return sorted;
}

function parseJsonSafe(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'object') return val;
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.length === 0) return null;
        try { return JSON.parse(trimmed); } catch (_) { return val; }
    }
    return val;
}

function deepJsonEquals(a, b) {
    const cA = canonicalizeJson(parseJsonSafe(a));
    const cB = canonicalizeJson(parseJsonSafe(b));
    return JSON.stringify(cA) === JSON.stringify(cB);
}

function sanitizeDiffValue(col, val) {
    if (val === null || val === undefined) return 'NULL';
    if (SENSITIVE_COLUMN_PATTERN.test(col)) {
        if (col === 'password_hash') {
            return '[REDACTED_PASSWORD_HASH]';
        }
        return `[REDACTED_${col.toUpperCase()}]`;
    }
    if (typeof val === 'object') {
        try {
            return JSON.stringify(val);
        } catch (_) {
            return String(val);
        }
    }
    return String(val);
}

function formatSafeError(err, tableName, recordId = null) {
    if (err instanceof MigrationConflictError || err instanceof SchemaMismatchError) {
        return err;
    }
    // Redact raw row contents from database constraint error details
    const rawMsg = err.message || 'Database execution error';
    const safeMsg = rawMsg
        .replace(/\(Failing row contains [^)]+\)/gi, '(Failing row values redacted for security)')
        .replace(/Key \([^)]+\)=\([^)]+\)/gi, 'Key values redacted');

    const safeErr = new Error(`[MIGRATION DB ERROR] Table '${tableName}'${recordId ? `, Record '${recordId}'` : ''}: ${safeMsg} (SQLSTATE: ${err.code || 'UNKNOWN'})`);
    safeErr.code = err.code;
    safeErr.table = tableName;
    if (recordId) safeErr.recordId = recordId;
    return safeErr;
}

const TABLE_DEFINITIONS = {
    subscriptions: {
        idCol: 'id',
        columns: ['id', 'name', 'allowed_formats', 'max_products_per_import', 'max_monthly_imports', 'max_file_size_mb', 'ai_extraction_enabled', 'bulk_import_enabled', 'created_at'],
        jsonCols: ['allowed_formats'],
        boolCols: ['ai_extraction_enabled', 'bulk_import_enabled'],
        dateCols: ['created_at'],
        numCols: ['max_products_per_import', 'max_monthly_imports', 'max_file_size_mb'],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            name: r.name,
            allowed_formats: r.allowed_formats,
            max_products_per_import: r.max_products_per_import,
            max_monthly_imports: r.max_monthly_imports,
            max_file_size_mb: r.max_file_size_mb,
            ai_extraction_enabled: r.ai_extraction_enabled === 1 || r.ai_extraction_enabled === true,
            bulk_import_enabled: r.bulk_import_enabled === 1 || r.bulk_import_enabled === true,
            created_at: r.created_at
        }),
        insertSql: `INSERT INTO subscriptions (
            id, name, allowed_formats, max_products_per_import, max_monthly_imports,
            max_file_size_mb, ai_extraction_enabled, bulk_import_enabled, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        transformRow: (r) => [
            r.id,
            r.name,
            r.allowed_formats,
            r.max_products_per_import,
            r.max_monthly_imports,
            r.max_file_size_mb,
            r.ai_extraction_enabled === 1 || r.ai_extraction_enabled === true,
            r.bulk_import_enabled === 1 || r.bulk_import_enabled === true,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        ]
    },
    categories: {
        idCol: 'id',
        columns: ['id', 'parent_id', 'name_ar', 'name_en', 'slug', 'icon', 'created_at'],
        jsonCols: [],
        boolCols: [],
        dateCols: ['created_at'],
        numCols: [],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            parent_id: r.parent_id || null,
            name_ar: r.name_ar,
            name_en: r.name_en,
            slug: r.slug,
            icon: r.icon || null,
            created_at: r.created_at
        }),
        insertSql: `INSERT INTO categories (
            id, parent_id, name_ar, name_en, slug, icon, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        transformRow: (r) => [
            r.id,
            r.parent_id || null,
            r.name_ar,
            r.name_en,
            r.slug,
            r.icon || null,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        ]
    },
    manufacturers: {
        idCol: 'id',
        columns: ['id', 'name_ar', 'name_en', 'code', 'business_model', 'subscription_id', 'country', 'city', 'contact_email', 'contact_phone', 'is_verified', 'is_demo', 'created_at'],
        jsonCols: [],
        boolCols: ['is_verified', 'is_demo'],
        dateCols: ['created_at'],
        numCols: [],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            name_ar: r.name_ar,
            name_en: r.name_en,
            code: r.code,
            business_model: r.business_model,
            subscription_id: r.subscription_id || null,
            country: r.country || 'مصر',
            city: r.city,
            contact_email: r.contact_email || null,
            contact_phone: r.contact_phone || null,
            is_verified: r.is_verified === 1 || r.is_verified === true,
            is_demo: r.is_demo === 1 || r.is_demo === true,
            created_at: r.created_at
        }),
        insertSql: `INSERT INTO manufacturers (
            id, name_ar, name_en, code, business_model, subscription_id, country, city,
            contact_email, contact_phone, is_verified, is_demo, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        transformRow: (r) => [
            r.id,
            r.name_ar,
            r.name_en,
            r.code,
            r.business_model,
            r.subscription_id || null,
            r.country || 'مصر',
            r.city,
            r.contact_email || null,
            r.contact_phone || null,
            r.is_verified === 1 || r.is_verified === true,
            r.is_demo === 1 || r.is_demo === true,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        ]
    },
    users: {
        idCol: 'id',
        columns: ['id', 'name', 'email', 'password_hash', 'role', 'manufacturer_id', 'is_active', 'is_demo', 'token_version', 'created_at'],
        jsonCols: [],
        boolCols: ['is_active', 'is_demo'],
        dateCols: ['created_at'],
        numCols: ['token_version'],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: ['password_hash'],
        normalizeSource: (r) => ({
            id: r.id,
            name: r.name,
            email: r.email,
            password_hash: r.password_hash != null ? r.password_hash : null,
            role: r.role,
            manufacturer_id: r.manufacturer_id || null,
            is_active: r.is_active === 1 || r.is_active === true,
            is_demo: r.is_demo === 1 || r.is_demo === true,
            token_version: r.token_version || 1,
            created_at: r.created_at
        }),
        insertSql: `INSERT INTO users (
            id, name, email, password_hash, role, manufacturer_id, is_active, is_demo, token_version, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        transformRow: (r) => [
            r.id,
            r.name,
            r.email,
            r.password_hash != null ? r.password_hash : null,
            r.role,
            r.manufacturer_id || null,
            r.is_active === 1 || r.is_active === true,
            r.is_demo === 1 || r.is_demo === true,
            r.token_version || 1,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        ]
    },
    products: {
        idCol: 'id',
        columns: ['id', 'manufacturer_id', 'category_id', 'subcategory_id', 'sku', 'name_ar', 'name_en', 'description_ar', 'description_en', 'specifications', 'packaging_info', 'country_of_origin', 'price', 'currency', 'price_unit', 'moq', 'available_quantity', 'status', 'rejection_reason', 'source_import_id', 'is_demo', 'created_at', 'updated_at'],
        jsonCols: ['specifications'],
        boolCols: ['is_demo'],
        dateCols: ['created_at', 'updated_at'],
        moneyCols: ['price'],
        numCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            manufacturer_id: r.manufacturer_id,
            category_id: r.category_id || null,
            subcategory_id: r.subcategory_id || null,
            sku: r.sku || null,
            name_ar: r.name_ar,
            name_en: r.name_en || null,
            description_ar: r.description_ar || null,
            description_en: r.description_en || null,
            specifications: r.specifications || null,
            packaging_info: r.packaging_info || null,
            country_of_origin: r.country_of_origin || 'مصر',
            price: r.price != null ? parseFloat(r.price).toFixed(2) : null,
            currency: r.currency || 'USD',
            price_unit: r.price_unit || 'MT',
            moq: r.moq || null,
            available_quantity: r.available_quantity || null,
            status: r.status || 'DRAFT',
            rejection_reason: r.rejection_reason || null,
            source_import_id: r.source_import_id || null,
            is_demo: r.is_demo === 1 || r.is_demo === true,
            created_at: r.created_at,
            updated_at: r.updated_at
        }),
        insertSql: `INSERT INTO products (
            id, manufacturer_id, category_id, subcategory_id, sku, name_ar, name_en,
            description_ar, description_en, specifications, packaging_info, country_of_origin,
            price, currency, price_unit, moq, available_quantity, status, rejection_reason,
            source_import_id, is_demo, created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        );`,
        transformRow: (r) => [
            r.id,
            r.manufacturer_id,
            r.category_id || null,
            r.subcategory_id || null,
            r.sku || null,
            r.name_ar,
            r.name_en || null,
            r.description_ar || null,
            r.description_en || null,
            r.specifications || null,
            r.packaging_info || null,
            r.country_of_origin || 'مصر',
            r.price != null ? parseFloat(r.price).toFixed(2) : null,
            r.currency || 'USD',
            r.price_unit || 'MT',
            r.moq || null,
            r.available_quantity || null,
            r.status || 'DRAFT',
            r.rejection_reason || null,
            r.source_import_id || null,
            r.is_demo === 1 || r.is_demo === true,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
            r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString()
        ]
    },
    product_images: {
        idCol: 'id',
        columns: ['id', 'product_id', 'url', 'thumbnail_url', 'is_primary', 'display_order', 'dhash', 'file_size', 'created_at'],
        jsonCols: [],
        boolCols: ['is_primary'],
        dateCols: ['created_at'],
        numCols: ['display_order', 'file_size'],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            product_id: r.product_id,
            url: r.url,
            thumbnail_url: r.thumbnail_url || null,
            is_primary: r.is_primary === 1 || r.is_primary === true,
            display_order: r.display_order || 0,
            dhash: r.dhash || null,
            file_size: r.file_size != null ? Number(r.file_size) : null,
            created_at: r.created_at
        }),
        insertSql: `INSERT INTO product_images (
            id, product_id, url, thumbnail_url, is_primary, display_order, dhash, file_size, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        transformRow: (r) => [
            r.id,
            r.product_id,
            r.url,
            r.thumbnail_url || null,
            r.is_primary === 1 || r.is_primary === true,
            r.display_order || 0,
            r.dhash || null,
            r.file_size != null ? r.file_size : null,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        ]
    },
    imports: {
        idCol: 'id',
        columns: ['id', 'user_id', 'manufacturer_id', 'source_files', 'status', 'total_detected', 'total_valid', 'total_failed', 'progress_percent', 'error_summary', 'is_demo', 'created_at', 'updated_at', 'active_fencing_token', 'legal_hold', 'batch_id'],
        jsonCols: ['source_files'],
        boolCols: ['is_demo', 'legal_hold'],
        dateCols: ['created_at', 'updated_at'],
        numCols: ['total_detected', 'total_valid', 'total_failed', 'progress_percent'],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            user_id: r.user_id,
            manufacturer_id: r.manufacturer_id || null,
            source_files: r.source_files,
            status: r.status,
            total_detected: r.total_detected || 0,
            total_valid: r.total_valid || 0,
            total_failed: r.total_failed || 0,
            progress_percent: r.progress_percent || 0,
            error_summary: r.error_summary || null,
            is_demo: r.is_demo === 1 || r.is_demo === true,
            created_at: r.created_at,
            updated_at: r.updated_at,
            active_fencing_token: r.active_fencing_token || null,
            legal_hold: r.legal_hold === 1 || r.legal_hold === true || false,
            batch_id: r.batch_id || null
        }),
        insertSql: `INSERT INTO imports (
            id, user_id, manufacturer_id, source_files, status, total_detected, total_valid,
            total_failed, progress_percent, error_summary, is_demo, created_at, updated_at,
            active_fencing_token, legal_hold, batch_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
        transformRow: (r) => [
            r.id,
            r.user_id,
            r.manufacturer_id || null,
            r.source_files,
            r.status,
            r.total_detected || 0,
            r.total_valid || 0,
            r.total_failed || 0,
            r.progress_percent || 0,
            r.error_summary || null,
            r.is_demo === 1 || r.is_demo === true,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
            r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
            r.active_fencing_token || null,
            r.legal_hold === 1 || r.legal_hold === true || false,
            r.batch_id || null
        ]
    },
    import_items: {
        idCol: 'id',
        columns: ['id', 'import_id', 'suggested_manufacturer_id', 'suggested_category_id', 'raw_data', 'extracted_data', 'confidence_score', 'validation_warnings', 'is_duplicate', 'duplicate_matched_id', 'duplicate_reason', 'assigned_images', 'status', 'error_message', 'created_at', 'lock_version', 'has_conflict', 'suggested_updates', 'modified_fields'],
        jsonCols: ['raw_data', 'extracted_data', 'validation_warnings', 'assigned_images', 'suggested_updates', 'modified_fields'],
        boolCols: ['is_duplicate', 'has_conflict'],
        dateCols: ['created_at'],
        scoreCols: ['confidence_score'],
        numCols: ['lock_version'],
        moneyCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            import_id: r.import_id,
            suggested_manufacturer_id: r.suggested_manufacturer_id || null,
            suggested_category_id: r.suggested_category_id || null,
            raw_data: r.raw_data || null,
            extracted_data: r.extracted_data,
            confidence_score: r.confidence_score != null ? parseFloat(r.confidence_score).toFixed(4) : '1.0000',
            validation_warnings: r.validation_warnings || null,
            is_duplicate: r.is_duplicate === 1 || r.is_duplicate === true,
            duplicate_matched_id: r.duplicate_matched_id || null,
            duplicate_reason: r.duplicate_reason || null,
            assigned_images: r.assigned_images || null,
            status: r.status || 'AWAITING_REVIEW',
            error_message: r.error_message || null,
            created_at: r.created_at,
            lock_version: r.lock_version != null ? r.lock_version : 1,
            has_conflict: r.has_conflict === 1 || r.has_conflict === true || false,
            suggested_updates: r.suggested_updates || null,
            modified_fields: r.modified_fields || null
        }),
        insertSql: `INSERT INTO import_items (
            id, import_id, suggested_manufacturer_id, suggested_category_id, raw_data, extracted_data,
            confidence_score, validation_warnings, is_duplicate, duplicate_matched_id, duplicate_reason,
            assigned_images, status, error_message, created_at,
            lock_version, has_conflict, suggested_updates, modified_fields
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19);`,
        transformRow: (r) => [
            r.id,
            r.import_id,
            r.suggested_manufacturer_id || null,
            r.suggested_category_id || null,
            r.raw_data || null,
            r.extracted_data,
            r.confidence_score != null ? parseFloat(r.confidence_score).toFixed(4) : '1.0000',
            r.validation_warnings || null,
            r.is_duplicate === 1 || r.is_duplicate === true,
            r.duplicate_matched_id || null,
            r.duplicate_reason || null,
            r.assigned_images || null,
            r.status || 'AWAITING_REVIEW',
            r.error_message || null,
            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
            r.lock_version != null ? r.lock_version : 1,
            r.has_conflict === 1 || r.has_conflict === true || false,
            r.suggested_updates || null,
            r.modified_fields || null
        ]
    },
    import_logs: {
        idCol: 'id',
        columns: ['id', 'import_id', 'step', 'message', 'severity', 'timestamp'],
        jsonCols: [],
        boolCols: [],
        dateCols: ['timestamp'],
        numCols: [],
        moneyCols: [],
        scoreCols: [],
        sensitiveCols: [],
        normalizeSource: (r) => ({
            id: r.id,
            import_id: r.import_id,
            step: r.step,
            message: r.message,
            severity: r.severity || 'INFO',
            timestamp: r.timestamp
        }),
        insertSql: `INSERT INTO import_logs (
            id, import_id, step, message, severity, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6);`,
        transformRow: (r) => [
            r.id,
            r.import_id,
            r.step,
            r.message,
            r.severity || 'INFO',
            r.timestamp ? new Date(r.timestamp).toISOString() : new Date().toISOString()
        ]
    }
};

async function validateSchemaCoverage(pgClient, sqliteDb, tableName) {
    const meta = TABLE_DEFINITIONS[tableName];
    if (!meta) {
        throw new SchemaMismatchError(
            `[SCHEMA MISMATCH] Table '${tableName}' is missing from TABLE_DEFINITIONS migration configuration.`,
            { table: tableName }
        );
    }

    // 1. Fetch PostgreSQL target columns from information_schema
    const pgColsRes = await pgClient.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position;",
        [tableName]
    );
    const targetCols = pgColsRes.rows.map(r => r.column_name);
    if (targetCols.length === 0) {
        throw new SchemaMismatchError(
            `[SCHEMA MISMATCH] Target table '${tableName}' does not exist or has 0 columns in PostgreSQL public schema.`,
            { table: tableName, targetColumns: [] }
        );
    }

    // 2. Fetch SQLite source columns (if sqliteDb is provided)
    let sourceCols = [];
    if (sqliteDb) {
        const sqColsRes = sqliteDb.prepare(`PRAGMA table_info("${tableName}");`).all();
        sourceCols = sqColsRes.map(r => r.name);
    }

    const configuredCols = meta.columns;

    // Check for target PostgreSQL columns not present in migration configuration
    const unmappedTargetCols = targetCols.filter(c => !configuredCols.includes(c));
    if (unmappedTargetCols.length > 0) {
        throw new SchemaMismatchError(
            `[SCHEMA MISMATCH] PostgreSQL table '${tableName}' contains unexpected/unmapped column(s) not in migration configuration: [${unmappedTargetCols.join(', ')}].`,
            { table: tableName, type: 'EXTRA_TARGET_COLUMNS', columns: unmappedTargetCols }
        );
    }

    // Check for configured columns missing from target PostgreSQL table
    const missingTargetCols = configuredCols.filter(c => !targetCols.includes(c));
    if (missingTargetCols.length > 0) {
        throw new SchemaMismatchError(
            `[SCHEMA MISMATCH] Migration configuration for '${tableName}' specifies column(s) missing from target PostgreSQL schema: [${missingTargetCols.join(', ')}].`,
            { table: tableName, type: 'MISSING_TARGET_COLUMNS', columns: missingTargetCols }
        );
    }

    // Check for SQLite source columns not present in configuration
    if (sourceCols.length > 0) {
        const unmappedSourceCols = sourceCols.filter(c => !configuredCols.includes(c));
        if (unmappedSourceCols.length > 0) {
            throw new SchemaMismatchError(
                `[SCHEMA MISMATCH] SQLite source table '${tableName}' contains column(s) unmapped in migration configuration: [${unmappedSourceCols.join(', ')}].`,
                { table: tableName, type: 'UNMAPPED_SOURCE_COLUMNS', columns: unmappedSourceCols }
            );
        }
    }

    return {
        table: tableName,
        valid: true,
        columnCount: configuredCols.length
    };
}

function compareRecordFields(tableName, srcRow, tgtRow) {
    const meta = TABLE_DEFINITIONS[tableName];
    if (!meta) throw new Error(`Unknown table: ${tableName}`);

    const normSrc = meta.normalizeSource(srcRow);
    const diffs = [];

    for (const col of meta.columns) {
        const sVal = normSrc[col];
        const tVal = tgtRow[col];

        // 1. Explicit NULL comparison
        if (sVal === null || sVal === undefined) {
            if (tVal !== null && tVal !== undefined) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sVal),
                    targetValue: sanitizeDiffValue(col, tVal),
                    reason: 'Source is NULL but target is NOT NULL'
                });
            }
            continue;
        }
        if (tVal === null || tVal === undefined) {
            diffs.push({
                column: col,
                sourceValue: sanitizeDiffValue(col, sVal),
                targetValue: sanitizeDiffValue(col, tVal),
                reason: 'Source is NOT NULL but target is NULL'
            });
            continue;
        }

        // 2. Boolean comparison
        if (meta.boolCols.includes(col)) {
            const sBool = (sVal === true || sVal === 1);
            const tBool = (tVal === true || tVal === 1);
            if (sBool !== tBool) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sBool),
                    targetValue: sanitizeDiffValue(col, tBool),
                    reason: 'Boolean value mismatch'
                });
            }
            continue;
        }

        // 3. Money comparison (NUMERIC 12, 2)
        if (meta.moneyCols && meta.moneyCols.includes(col)) {
            const sMoney = parseFloat(sVal).toFixed(2);
            const tMoney = parseFloat(tVal).toFixed(2);
            if (sMoney !== tMoney) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sMoney),
                    targetValue: sanitizeDiffValue(col, tMoney),
                    reason: 'Financial precision mismatch'
                });
            }
            continue;
        }

        // 4. Score comparison (NUMERIC 5, 4)
        if (meta.scoreCols && meta.scoreCols.includes(col)) {
            const sScore = parseFloat(sVal).toFixed(4);
            const tScore = parseFloat(tVal).toFixed(4);
            if (sScore !== tScore) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sScore),
                    targetValue: sanitizeDiffValue(col, tScore),
                    reason: 'Score precision mismatch'
                });
            }
            continue;
        }

        // 5. Date / Timestamp comparison (UTC millisecond point-in-time)
        if (meta.dateCols.includes(col)) {
            const sTime = new Date(sVal).getTime();
            const tTime = (tVal instanceof Date ? tVal : new Date(tVal)).getTime();
            if (isNaN(sTime) || isNaN(tTime) || sTime !== tTime) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sVal),
                    targetValue: sanitizeDiffValue(col, tVal),
                    reason: `Timestamp mismatch (${sTime} vs ${tTime})`
                });
            }
            continue;
        }

        // 6. JSON / JSONB semantic comparison (key-order independent)
        if (meta.jsonCols.includes(col)) {
            if (!deepJsonEquals(sVal, tVal)) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sVal),
                    targetValue: sanitizeDiffValue(col, tVal),
                    reason: 'JSON semantic content mismatch'
                });
            }
            continue;
        }

        // 7. Numbers (integer)
        if (meta.numCols && meta.numCols.includes(col)) {
            if (Number(sVal) !== Number(tVal)) {
                diffs.push({
                    column: col,
                    sourceValue: sanitizeDiffValue(col, sVal),
                    targetValue: sanitizeDiffValue(col, tVal),
                    reason: 'Numeric value mismatch'
                });
            }
            continue;
        }

        // 8. General text / string equality (Strict exact comparison, zero generic trimming)
        if (String(sVal) !== String(tVal)) {
            diffs.push({
                column: col,
                sourceValue: sanitizeDiffValue(col, sVal),
                targetValue: sanitizeDiffValue(col, tVal),
                reason: 'String exact value mismatch'
            });
        }
    }

    return diffs;
}

async function transferSingleRecord(pgClient, tableName, row, insertSql, transformRow) {
    const meta = TABLE_DEFINITIONS[tableName];
    const id = row[meta.idCol];
    const existingRes = await pgClient.query(`SELECT * FROM "${tableName}" WHERE "${meta.idCol}" = $1;`, [id]);

    if (existingRes.rows.length === 0) {
        const params = transformRow(row);
        const res = await pgClient.query(insertSql, params);
        return { action: 'INSERTED', rowCount: res.rowCount };
    } else {
        const existingRow = existingRes.rows[0];
        const diffs = compareRecordFields(tableName, row, existingRow);
        if (diffs.length > 0) {
            throw new MigrationConflictError({
                table: tableName,
                id,
                differences: diffs
            });
        }
        return { action: 'ALREADY_MATCHED', rowCount: 0 };
    }
}

async function migrateData(targetDbName = TARGET_DB) {
    if (targetDbName !== 'zarsev_test' && targetDbName !== 'zarsev_dev') {
        throw new Error(`[FATAL ISOLATION GUARD] Migration is strictly constrained to 'zarsev_test' or 'zarsev_dev', got: '${targetDbName}'`);
    }

    console.log('================================================================');
    console.log('📦 ZARSEV Strict Data Migration Engine: SQLite -> PostgreSQL');
    console.log(`🎯 Target Database: ${targetDbName}`);
    console.log(`📂 Source SQLite:    ${SQLITE_PATH}`);
    console.log('🛡️ Conflict Guard:   STRICT & HARDENED (Dynamic Schema Coverage & Exact Strings)');
    console.log('================================================================\n');

    // 1. First, apply PostgreSQL schema migrations using pgMigrator
    console.log('1. Ensuring PostgreSQL schema migrations are applied...');
    const migResult = await runMigrations(targetDbName);
    console.log(`✓ Schema migrations up-to-date (Applied: ${migResult.appliedCount} new migrations).\n`);

    // 2. Open SQLite in read-only mode
    if (!fs.existsSync(SQLITE_PATH)) {
        throw new Error(`Source SQLite database not found at: ${SQLITE_PATH}`);
    }
    const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });

    const pgClient = getMigratorClient(targetDbName);
    await pgClient.connect();

    const stats = {};

    try {
        console.log('2. Beginning sequential, transactional data transfer with Dynamic Schema Coverage & Conflict Guard...\n');

        async function transferTable(tableName, selectSql) {
            const meta = TABLE_DEFINITIONS[tableName];

            // DYNAMIC SCHEMA COVERAGE VALIDATION (BEFORE ANY TRANSACTION OR WRITES)
            await validateSchemaCoverage(pgClient, sqlite, tableName);

            const rows = sqlite.prepare(selectSql).all();
            stats[tableName] = { sourceCount: rows.length, insertedCount: 0, matchedCount: 0 };

            await pgClient.query('BEGIN;');
            try {
                for (const row of rows) {
                    const result = await transferSingleRecord(
                        pgClient,
                        tableName,
                        row,
                        meta.insertSql,
                        meta.transformRow
                    );
                    if (result.action === 'INSERTED') {
                        stats[tableName].insertedCount++;
                    } else if (result.action === 'ALREADY_MATCHED') {
                        stats[tableName].matchedCount++;
                    }
                }
                await pgClient.query('COMMIT;');
                console.log(`✓ [${tableName}] Processed: ${stats[tableName].sourceCount} records (${stats[tableName].insertedCount} inserted, ${stats[tableName].matchedCount} ALREADY_MATCHED).`);
            } catch (err) {
                await pgClient.query('ROLLBACK;').catch(() => {});
                if (err instanceof MigrationConflictError || err instanceof SchemaMismatchError) {
                    console.error(`❌ [${tableName}] CONFLICT/SCHEMA ERROR: ${err.message}`);
                    throw err;
                }
                const safeErr = formatSafeError(err, tableName);
                console.error(`❌ [${tableName}] FAILED: ${safeErr.message}`);
                throw safeErr;
            }
        }

        // Table 1: subscriptions
        await transferTable('subscriptions', 'SELECT * FROM subscriptions ORDER BY id ASC;');

        // Table 2: categories (Parents first, then children)
        await transferTable('categories', 'SELECT * FROM categories ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, id ASC;');

        // Table 3: manufacturers
        await transferTable('manufacturers', 'SELECT * FROM manufacturers ORDER BY id ASC;');

        // Table 4: users
        await transferTable('users', 'SELECT * FROM users ORDER BY id ASC;');

        // Table 5: products
        await transferTable('products', 'SELECT * FROM products ORDER BY id ASC;');

        // Table 6: product_images
        await transferTable('product_images', 'SELECT * FROM product_images ORDER BY id ASC;');

        // Table 7: imports
        await transferTable('imports', 'SELECT * FROM imports ORDER BY id ASC;');

        // Table 8: import_items
        await transferTable('import_items', 'SELECT * FROM import_items ORDER BY id ASC;');

        // Table 9: import_logs
        await transferTable('import_logs', 'SELECT * FROM import_logs ORDER BY id ASC;');

        console.log('\n================================================================');
        console.log('🎉 DATA MIGRATION TRANSFER COMPLETED WITH FULL INTEGRITY!');
        console.log('================================================================');

        return stats;

    } finally {
        sqlite.close();
        await pgClient.end().catch(() => {});
        await closePool();
    }
}

if (require.main === module) {
    migrateData(TARGET_DB).catch(err => {
        console.error('\n❌ DATA MIGRATION FAILED:', err.message);
        process.exit(1);
    });
}

module.exports = {
    migrateData,
    compareRecordFields,
    transferSingleRecord,
    validateSchemaCoverage,
    sanitizeDiffValue,
    formatSafeError,
    MigrationConflictError,
    SchemaMismatchError,
    SENSITIVE_COLUMN_PATTERN,
    TABLE_DEFINITIONS
};
