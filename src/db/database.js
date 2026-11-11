const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REAL_DB_PATH = path.join(PROJECT_ROOT, 'zarsev.db');

const PROTECTED_DB_FILES = Object.freeze([
    REAL_DB_PATH,
    path.join(PROJECT_ROOT, 'zarsev.db.bak'),
    path.join(PROJECT_ROOT, 'zarsev.db.phase1_2_prequarantine.bak')
]);

function canonicalizePath(targetPath) {
    if (!targetPath) return '';
    try {
        const resolved = path.resolve(targetPath);
        if (fs.existsSync(resolved)) {
            return (fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved)).toLowerCase();
        }
        return resolved.toLowerCase();
    } catch (_) {
        return path.resolve(targetPath).toLowerCase();
    }
}

const CANONICAL_PROTECTED_FILES = Object.freeze(PROTECTED_DB_FILES.map(canonicalizePath));

function getDbPath() {
    const rawPath = process.env.DB_PATH || REAL_DB_PATH;
    const resolved = path.resolve(rawPath);
    const canonical = canonicalizePath(resolved);
    const baseName = path.basename(resolved).toLowerCase();

    // Hard safety guard: reject test execution if pointing to real zarsev.db or backups
    const isTestExecution =
        process.env.NODE_ENV === 'test' ||
        process.env.ZARSEV_TEST_MODE === '1' ||
        (Array.isArray(process.argv) && process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('mocha') || arg.includes('jest'))));

    if (isTestExecution) {
        const matchesProtected = CANONICAL_PROTECTED_FILES.includes(canonical);
        const matchesName = baseName === 'zarsev.db' || baseName.endsWith('.bak');

        if (matchesProtected || matchesName) {
            throw new Error(
                `[FATAL TEST ISOLATION GUARD] Database operation aborted! ` +
                `Test execution attempted to connect to protected database: "${resolved}". ` +
                `All tests MUST set process.env.DB_PATH to an isolated test database file.`
            );
        }
    }

    return resolved;
}

let dbInstance = null;
let currentDbPath = null;

function getDb() {
    const targetPath = getDbPath();
    if (!dbInstance || currentDbPath !== targetPath) {
        if (dbInstance) {
            try { dbInstance.close(); } catch (e) {}
            dbInstance = null;
        }
        const dbDir = path.dirname(targetPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        dbInstance = new DatabaseSync(targetPath);
        dbInstance.exec('PRAGMA foreign_keys = ON;');
        currentDbPath = targetPath;
    }
    return dbInstance;
}

function closeDb() {
    if (dbInstance) {
        try { dbInstance.close(); } catch (e) {}
        dbInstance = null;
        currentDbPath = null;
    }
}

function ensureColumn(db, table, column, definition) {
    try {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!columns.includes(column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
        }
    } catch (err) {
        console.error(`Migration error on table ${table}, column ${column}:`, err.message);
    }
}

const crypto = require('crypto');

function computeMigration002Checksum() {
    const filePath = path.join(__dirname, 'migrations', 'pg', '002_zarsev_core_foundation.sql');
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        return crypto.createHash('sha256').update(content, 'utf8').digest('hex').toUpperCase();
    }
    return '002_ZARSEV_CORE_FOUNDATION_CHECKSUM';
}

function runStage1Migrations(db) {
    // 1. Ensure schema_migrations table exists and verify existence in catalog
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(64) PRIMARY KEY,
            filename VARCHAR(255) NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations';").get();
    if (!tableCheck) {
        throw new Error('FATAL: schema_migrations table could not be verified in SQLite catalog');
    }

    const expectedChecksum = computeMigration002Checksum();

    // 2. Dual check (version, checksum)
    const existing = db.prepare('SELECT version, checksum FROM schema_migrations WHERE version = ?').get('002');
    if (existing) {
        if (existing.checksum !== expectedChecksum) {
            throw new Error(`CRITICAL_MIGRATION_ERROR: Checksum mismatch for migration 002. Recorded: ${existing.checksum}, Expected: ${expectedChecksum}. Migration halted to prevent catalog corruption.`);
        }
        return; // Idempotent no-op
    }

    // 3. Transactional DDL execution
    db.exec('BEGIN IMMEDIATE;');
    try {
        // Create new Stage 1 tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS import_batches (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                manufacturer_id TEXT NULL,
                manifest_hash TEXT NOT NULL,
                canonical_manifest TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id),
                FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id)
            );

            CREATE TABLE IF NOT EXISTS batch_source_files (
                id TEXT PRIMARY KEY,
                batch_id TEXT NOT NULL,
                file_sha256 TEXT NOT NULL,
                storage_object_uuid TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                deletion_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(deletion_status IN ('ACTIVE', 'DELETING', 'PURGED')),
                deletion_operation_id TEXT NULL,
                deletion_started_at DATETIME NULL,
                purged_at DATETIME NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS import_idempotency_keys (
                key TEXT NOT NULL,
                user_id TEXT NOT NULL,
                manufacturer_id TEXT NULL,
                reservation_token TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                import_id TEXT NULL,
                status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED', 'COMMITTED', 'FAILED_QUOTA', 'RELEASED')),
                response_code INTEGER NULL,
                response_payload TEXT NULL,
                expires_at DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (key, user_id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id) ON DELETE SET NULL,
                FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS import_attempts (
                id TEXT PRIMARY KEY,
                import_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                fencing_token TEXT NOT NULL,
                attempt_token TEXT NOT NULL,
                final_status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(final_status IN ('RUNNING', 'COMMITTED', 'TERMINATED_ABORTED', 'OUTCOME_UNKNOWN')),
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                committed_at DATETIME NULL,
                terminated_at DATETIME NULL,
                UNIQUE(import_id, attempt_number),
                FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS import_item_revisions (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                editor_user_id TEXT NOT NULL,
                previous_data TEXT NOT NULL,
                applied_updates TEXT NOT NULL,
                lock_version INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(item_id) REFERENCES import_items(id) ON DELETE CASCADE,
                FOREIGN KEY(editor_user_id) REFERENCES users(id)
            );
        `);

        // Introspect and update existing tables
        ensureColumn(db, 'imports', 'active_fencing_token', 'TEXT NULL');
        ensureColumn(db, 'imports', 'legal_hold', 'INTEGER NOT NULL DEFAULT 0');
        ensureColumn(db, 'imports', 'batch_id', 'TEXT NULL');

        ensureColumn(db, 'import_items', 'lock_version', 'INTEGER NOT NULL DEFAULT 1');
        ensureColumn(db, 'import_items', 'has_conflict', 'INTEGER NOT NULL DEFAULT 0');
        ensureColumn(db, 'import_items', 'suggested_updates', 'TEXT NULL');
        ensureColumn(db, 'import_items', 'modified_fields', 'TEXT NULL');

        // Record in schema_migrations
        db.prepare('INSERT INTO schema_migrations (version, filename, checksum) VALUES (?, ?, ?)')
          .run('002', '002_zarsev_core_foundation.sql', expectedChecksum);

        db.exec('COMMIT;');
    } catch (err) {
        try { db.exec('ROLLBACK;'); } catch (_) {}
        throw err;
    }
}

function runMigrations(db) {
    // Users table additions
    ensureColumn(db, 'users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, 'users', 'password_hash', 'TEXT NULL');
    ensureColumn(db, 'users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');

    // Demo flags
    ensureColumn(db, 'manufacturers', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'products', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'imports', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');

    // Stage 1 ZARSEV Concurrency & Governance Migrations
    runStage1Migrations(db);
}

function initDb() {
    const db = getDb();
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schemaSql);
    runMigrations(db);
    return db;
}

module.exports = {
    getDb,
    initDb,
    closeDb,
    runMigrations,
    runStage1Migrations,
    getDbPath,
    REAL_DB_PATH,
    PROTECTED_DB_FILES,
    canonicalizePath,
    get DB_PATH() {
        return getDbPath();
    }
};
