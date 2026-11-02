const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
    ensureMigrationInfrastructure,
    acquireMigrationLock,
    releaseMigrationLock,
    createVerifiedPreMigrationBackup,
    loadMigrationFiles,
    verifyAppliedMigrationChecksums,
    getMigrationStatus,
    migrateUp,
    migrateDown,
    restoreFromBackup,
    computeChecksum
} = require('../src/db/migrator');

// Paths for isolated test environments
const TEST_DIR = path.join(__dirname, 'migration_sandbox');
const TEST_DB_PATH = path.join(TEST_DIR, 'isolated_test.db');
const TEST_BACKUP_DIR = path.join(TEST_DIR, 'backups');
const TEST_MIGRATIONS_DIR = path.join(TEST_DIR, 'migrations');

function setupSandbox() {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
    fs.mkdirSync(TEST_MIGRATIONS_DIR, { recursive: true });
}

function cleanupSandbox() {
    if (fs.existsSync(TEST_DIR)) {
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        } catch (e) {
            // Windows file lock delay fallback
        }
    }
}

/**
 * Creates sample schema with data for testing backup & exact count verification.
 */
function createSyntheticAppDatabase(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL
        );

        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            sku TEXT UNIQUE NOT NULL,
            name_ar TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE INDEX idx_products_sku ON products(sku);

        INSERT INTO users (id, name, email) VALUES 
            ('usr_1', 'مدير النظام', 'admin@test.gov'),
            ('usr_2', 'تاجر الفواكه', 'fruit@test.gov'),
            ('usr_3', 'مسؤول التصدير', 'export@test.gov');

        INSERT INTO products (id, user_id, sku, name_ar) VALUES
            ('prod_1', 'usr_2', 'SKU-001', 'برتقال صيفي فاخر'),
            ('prod_2', 'usr_2', 'SKU-002', 'رمان منفلوطي درجة أولى');
    `);
    db.close();
}

/**
 * Creates sample synthetic migration files for testing up/down.
 */
function createSyntheticMigrationFiles() {
    // Migration 1: Add categories table
    fs.writeFileSync(
        path.join(TEST_MIGRATIONS_DIR, '001_create_categories.js'),
        `
        module.exports = {
            name: '001_create_categories',
            up: (db) => {
                db.exec(\`
                    CREATE TABLE categories (
                        id TEXT PRIMARY KEY,
                        name_ar TEXT NOT NULL,
                        slug TEXT UNIQUE NOT NULL
                    );
                    INSERT INTO categories (id, name_ar, slug) VALUES ('cat_citrus', 'موالح', 'citrus');
                \`);
            },
            down: (db) => {
                db.exec('DROP TABLE categories;');
            }
        };
        `
    );

    // Migration 2: Add category_id to products
    fs.writeFileSync(
        path.join(TEST_MIGRATIONS_DIR, '002_add_category_to_products.js'),
        `
        module.exports = {
            name: '002_add_category_to_products',
            up: (db) => {
                db.exec(\`
                    ALTER TABLE products ADD COLUMN category_id TEXT NULL;
                    UPDATE products SET category_id = 'cat_citrus' WHERE sku = 'SKU-001';
                \`);
            },
            down: (db) => {
                // SQLite 12-step rebuild demonstration for safe down migration
                db.exec(\`
                    CREATE TABLE products_temp (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        sku TEXT UNIQUE NOT NULL,
                        name_ar TEXT NOT NULL,
                        FOREIGN KEY(user_id) REFERENCES users(id)
                    );
                    INSERT INTO products_temp SELECT id, user_id, sku, name_ar FROM products;
                    DROP TABLE products;
                    ALTER TABLE products_temp RENAME TO products;
                    CREATE INDEX idx_products_sku ON products(sku);
                \`);
            }
        };
        `
    );
}

async function runMigrationTests() {
    console.log('================================================================');
    console.log('🛡️  ZARSEV Milestone 2: Versioned Migration Framework Test Suite');
    console.log('================================================================\n');

    setupSandbox();

    try {
        // -------------------------------------------------------------
        // Test 1: Synthetic Database Creation & Verified Pre-Migration Backup Protocol
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 1: Comprehensive 8-Phase Backup Protocol ---');
        createSyntheticAppDatabase(TEST_DB_PATH);
        const db = new DatabaseSync(TEST_DB_PATH);
        db.exec('PRAGMA foreign_keys = ON;');

        const backupInfo = createVerifiedPreMigrationBackup(db, TEST_DB_PATH, 'test_initial', TEST_BACKUP_DIR);
        assert.strictEqual(backupInfo.verified, true, 'Backup verification must return verified: true');
        assert.ok(fs.existsSync(backupInfo.backupPath), 'Promoted backup file must exist on disk');
        assert.strictEqual(backupInfo.tablesVerified, 2, 'Exactly 2 application tables must be audited');
        assert.strictEqual(backupInfo.tableAudit.users, 3, 'Users table exact row count must be 3');
        assert.strictEqual(backupInfo.tableAudit.products, 2, 'Products table exact row count must be 2');

        // Verify the created backup file directly with independent connection
        const verifyDb = new DatabaseSync(backupInfo.backupPath);
        const integrity = verifyDb.prepare('PRAGMA integrity_check;').get();
        assert.strictEqual(integrity.integrity_check, 'ok', 'Backup snapshot must pass PRAGMA integrity_check');
        const fkViolations = verifyDb.prepare('PRAGMA foreign_key_check;').all();
        assert.strictEqual(fkViolations.length, 0, 'Backup snapshot must have 0 foreign key violations');
        verifyDb.close();
        console.log('✓ Comprehensive 8-Phase Backup Protocol verified (Integrity, FK check, exact row counts).\n');

        // -------------------------------------------------------------
        // Test 2: Migration Status (Pending Detection)
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 2: Migration Discovery & Status ---');
        createSyntheticMigrationFiles();

        const initialStatus = getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        assert.strictEqual(initialStatus.totalAvailable, 2, 'Should discover 2 synthetic migration files');
        assert.strictEqual(initialStatus.totalApplied, 0, 'Initially 0 migrations applied');
        assert.strictEqual(initialStatus.totalPending, 2, 'Initially 2 migrations pending');
        console.log('✓ Migration discovery & pending status verified.\n');

        // -------------------------------------------------------------
        // Test 3: Migrate Up (Sequential Application & Checksums)
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 3: Sequential Migrate Up & ACID Transactions ---');
        const upResult = migrateUp(db, TEST_DB_PATH, {
            migrationsDir: TEST_MIGRATIONS_DIR,
            backupDir: TEST_BACKUP_DIR
        });

        assert.strictEqual(upResult.appliedCount, 2, 'Both pending migrations must be applied');
        assert.strictEqual(upResult.batch, 1, 'Batch number must be 1');

        const postUpStatus = getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        assert.strictEqual(postUpStatus.totalApplied, 2, 'Total applied should now be 2');
        assert.strictEqual(postUpStatus.totalPending, 0, 'Total pending should now be 0');

        // Verify migration schema alterations took effect in DB
        const catRow = db.prepare('SELECT name_ar FROM categories WHERE id = ?').get('cat_citrus');
        assert.strictEqual(catRow.name_ar, 'موالح', 'Data created by migration 1 must exist');

        const prodRow = db.prepare('SELECT category_id FROM products WHERE sku = ?').get('SKU-001');
        assert.strictEqual(prodRow.category_id, 'cat_citrus', 'Column added by migration 2 must exist with updated value');
        console.log('✓ Migrate up sequentially applied, tracked in _migrations, and pre-migration backups created.\n');

        // -------------------------------------------------------------
        // Test 4: Anti-Tampering Checksum Detection
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 4: Anti-Tamper Checksum Verification ---');
        // Manually tamper with migration 1 on disk
        const mig1Path = path.join(TEST_MIGRATIONS_DIR, '001_create_categories.js');
        const originalContent = fs.readFileSync(mig1Path, 'utf8');
        fs.writeFileSync(mig1Path, originalContent + '\n// Tampered comment malicious edit');

        assert.throws(() => {
            getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        }, /TAMPERING DETECTED/i, 'Tampered migration file must be detected and rejected immediately');

        // Restore original content
        fs.writeFileSync(mig1Path, originalContent);
        const restoredStatus = getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        assert.strictEqual(restoredStatus.totalApplied, 2, 'Status passes once checksum matches original');
        console.log('✓ Anti-tamper checksum detection verified.\n');

        // -------------------------------------------------------------
        // Test 5: Migrate Down (Safe Rollback)
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 5: Safe Migrate Down & Rollback ---');
        const downResult = migrateDown(db, TEST_DB_PATH, {
            migrationsDir: TEST_MIGRATIONS_DIR,
            backupDir: TEST_BACKUP_DIR
        });

        assert.strictEqual(downResult.revertedCount, 2, 'Both migrations from batch 1 must be reverted');
        const postDownStatus = getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        assert.strictEqual(postDownStatus.totalApplied, 0, 'Applied count must return to 0');
        assert.strictEqual(postDownStatus.totalPending, 2, 'Pending count must return to 2');

        // Verify categories table was dropped by down migration
        const catTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'categories'").get();
        assert.strictEqual(catTableExists, undefined, 'Categories table must be dropped after rollback');

        // Verify products table had category_id removed via 12-step rebuild
        const prodCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
        assert.strictEqual(prodCols.includes('category_id'), false, 'category_id must be removed after rollback');
        assert.strictEqual(db.prepare('SELECT count(*) as c FROM products').get().c, 2, 'Product data must remain intact');
        console.log('✓ Safe migrate down verified with reversible DDL & intact data.\n');

        // -------------------------------------------------------------
        // Test 6: Backup Restoration from Snapshot
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 6: Complete Database Restoration from Verified Backup ---');
        // Re-apply migrations so we have a target state
        migrateUp(db, TEST_DB_PATH, {
            migrationsDir: TEST_MIGRATIONS_DIR,
            backupDir: TEST_BACKUP_DIR
        });
        db.close();

        // Simulate catastrophic corruption or table drop
        const corruptDb = new DatabaseSync(TEST_DB_PATH);
        corruptDb.exec('DROP TABLE products; DROP TABLE categories;');
        corruptDb.close();

        // Restore using the pre-migration backup taken before migration 1
        restoreFromBackup(backupInfo.backupPath, TEST_DB_PATH);

        const restoredDb = new DatabaseSync(TEST_DB_PATH);
        restoredDb.exec('PRAGMA foreign_keys = ON;');
        const checkRestored = restoredDb.prepare('PRAGMA integrity_check;').get();
        assert.strictEqual(checkRestored.integrity_check, 'ok');
        const restoredUserCount = restoredDb.prepare('SELECT count(*) as c FROM users').get().c;
        const restoredProdCount = restoredDb.prepare('SELECT count(*) as c FROM products').get().c;
        assert.strictEqual(restoredUserCount, 3, 'Restored users count must equal 3');
        assert.strictEqual(restoredProdCount, 2, 'Restored products count must equal 2');
        console.log('✓ Full database restoration from verified pre-migration backup verified.\n');

        // -------------------------------------------------------------
        // Test 7: Concurrency & Migration Lock Invariant
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 7: Migration Concurrency Lock ---');
        acquireMigrationLock(restoredDb, 'test_worker_1');

        assert.throws(() => {
            acquireMigrationLock(restoredDb, 'test_worker_2');
        }, /MIGRATION LOCK CONFLICT/i, 'Second worker must be refused lock with conflict error');

        releaseMigrationLock(restoredDb, 'test_worker_1');

        // Should now be able to acquire lock
        acquireMigrationLock(restoredDb, 'test_worker_2');
        releaseMigrationLock(restoredDb, 'test_worker_2');
        restoredDb.close();
        console.log('✓ Migration lock mutex & conflict rejection verified.\n');

        // -------------------------------------------------------------
        // Test 8: Deterministic Partial Unique Index & SQLite Limitation
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 8: Deterministic Partial Index vs Non-Deterministic SQLite Limitation ---');
        const indexDb = new DatabaseSync(':memory:');
        indexDb.exec('CREATE TABLE product_prices (id TEXT PRIMARY KEY, product_id TEXT, currency TEXT, incoterm TEXT, is_primary INTEGER, valid_to DATETIME);');

        // 1. Assert SQLite rejects CURRENT_TIMESTAMP in partial index
        assert.throws(() => {
            indexDb.exec('CREATE UNIQUE INDEX uidx_invalid ON product_prices(product_id) WHERE is_primary = 1 AND valid_to > CURRENT_TIMESTAMP;');
        }, /non-deterministic functions prohibited/i, 'SQLite must reject non-deterministic functions in partial index');

        // 2. Assert deterministic partial unique index succeeds
        indexDb.exec('CREATE UNIQUE INDEX uidx_valid ON product_prices(product_id, currency, incoterm) WHERE is_primary = 1;');
        indexDb.prepare("INSERT INTO product_prices VALUES ('pr_1', 'prod_1', 'USD', 'FOB', 1, NULL);").run();

        // 3. Second insert with is_primary = 1 for same context must fail with UNIQUE constraint
        assert.throws(() => {
            indexDb.prepare("INSERT INTO product_prices VALUES ('pr_2', 'prod_1', 'USD', 'FOB', 1, NULL);").run();
        }, /UNIQUE constraint failed/i, 'Duplicate primary price must violate deterministic unique constraint');

        // 4. Insert with is_primary = 0 (historical/secondary) succeeds
        indexDb.prepare("INSERT INTO product_prices VALUES ('pr_3', 'prod_1', 'USD', 'FOB', 0, '2026-11-01');").run();
        indexDb.close();
        console.log('✓ Deterministic partial unique index verified.\n');

        console.log('================================================================');
        console.log('🎉 ALL MILESTONE 2 MIGRATION FRAMEWORK TESTS PASSED (100% SUCCESS)!');
        console.log('================================================================\n');

    } finally {
        cleanupSandbox();
    }
}

if (require.main === module) {
    runMigrationTests().catch(err => {
        console.error('❌ Migration test runner failure:', err);
        cleanupSandbox();
        process.exit(1);
    });
}

module.exports = { runMigrationTests };
