const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const {
    ensureMigrationInfrastructure,
    acquireMigrationLock,
    releaseMigrationLock,
    verifyLockOwnership,
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
    cleanupSandbox();
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
 * Creates sample schema with data for testing backup & parity verification.
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
 * Creates valid synthetic migration files for testing up/down.
 */
function createSyntheticMigrationFiles(dir = TEST_MIGRATIONS_DIR) {
    // Migration 1: Add categories table
    fs.writeFileSync(
        path.join(dir, '001_create_categories.js'),
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
        path.join(dir, '002_add_category_to_products.js'),
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
    console.log('🛡️  ZARSEV Milestone 2.1: Hardened Migration Safety Test Suite');
    console.log('================================================================\n');

    setupSandbox();
    let db = null;

    try {
        // -------------------------------------------------------------
        // Test 1: Strategy B Pre-Migration Backup Protocol
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 1: Strategy B Pre-Migration Backup Protocol ---');
        createSyntheticAppDatabase(TEST_DB_PATH);
        db = new DatabaseSync(TEST_DB_PATH);
        db.exec('PRAGMA foreign_keys = ON;');

        const backupInfo = createVerifiedPreMigrationBackup(db, TEST_DB_PATH, 'test_initial', TEST_BACKUP_DIR);
        assert.strictEqual(backupInfo.verified, true, 'Backup verification must return verified: true');
        assert.ok(fs.existsSync(backupInfo.backupPath), 'Promoted backup file must exist on disk');
        assert.strictEqual(backupInfo.tablesVerified, 2, 'Exactly 2 application tables must be audited');
        assert.strictEqual(backupInfo.tableAudit.users, 3, 'Users table exact snapshot count must be 3');
        assert.strictEqual(backupInfo.tableAudit.products, 2, 'Products table exact snapshot count must be 2');

        // Verify the created backup file directly with independent connection
        const verifyDb = new DatabaseSync(backupInfo.backupPath);
        const integrity = verifyDb.prepare('PRAGMA integrity_check;').get();
        assert.strictEqual(integrity.integrity_check, 'ok', 'Backup snapshot must pass PRAGMA integrity_check');
        const fkViolations = verifyDb.prepare('PRAGMA foreign_key_check;').all();
        assert.strictEqual(fkViolations.length, 0, 'Backup snapshot must have 0 foreign key violations');
        verifyDb.close();
        console.log('✓ Strategy B pre-migration backup verified (Internal integrity, FK check, schema parity).\n');

        // -------------------------------------------------------------
        // Test 2: Concurrent Write Simulation During Backup
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 2: Concurrent Write Simulation During Backup ---');
        // Under Strategy B, VACUUM INTO produces an atomic point-in-time snapshot.
        // Even if live DB receives a concurrent write immediately after VACUUM INTO, Strategy B
        // validates snapshot-internal integrity and schema parity without false row-count aborts.
        const backupInfo2 = createVerifiedPreMigrationBackup(db, TEST_DB_PATH, 'test_concurrent', TEST_BACKUP_DIR, {
            beforeVerification: () => {
                db.prepare("INSERT INTO users VALUES ('usr_4', 'كاتب متزامن', 'writer@test.gov');").run();
            }
        });
        assert.strictEqual(backupInfo2.verified, true);
        assert.ok(fs.existsSync(backupInfo2.backupPath));

        // When requireWriteQuiescence is explicitly requested, concurrent modification is detected and aborted
        assert.throws(() => {
            createVerifiedPreMigrationBackup(db, TEST_DB_PATH, 'test_quiescence_fail', TEST_BACKUP_DIR, {
                requireWriteQuiescence: true,
                beforeVerification: () => {
                    db.prepare("INSERT INTO users VALUES ('usr_5', 'كاتب متزامن آخر', 'writer2@test.gov');").run();
                }
            });
        }, /Write quiescence violated/i, 'Strict write quiescence mode must detect active writes');
        console.log('✓ Concurrent write handling & deterministic quiescence modes verified.\n');

        // -------------------------------------------------------------
        // Test 3: Abort on Failed Backup Verification
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 3: Abort on Corrupt Source / FK Violation ---');
        const corruptDbPath = path.join(TEST_DIR, 'corrupt_test.db');
        const corruptDb = new DatabaseSync(corruptDbPath);
        // Turn foreign keys off temporarily to insert an orphan record
        corruptDb.exec('PRAGMA foreign_keys = OFF;');
        corruptDb.exec(`
            CREATE TABLE parent (id TEXT PRIMARY KEY);
            CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT, FOREIGN KEY(parent_id) REFERENCES parent(id));
            INSERT INTO child VALUES ('c1', 'nonexistent_parent');
        `);
        corruptDb.exec('PRAGMA foreign_keys = ON;');

        assert.throws(() => {
            createVerifiedPreMigrationBackup(corruptDb, corruptDbPath, 'fail_migration', TEST_BACKUP_DIR);
        }, /foreign key check detected/i, 'Snapshot with foreign key violations must strictly abort backup');
        corruptDb.close();
        console.log('✓ Backup verification abort on foreign key violation verified.\n');

        // -------------------------------------------------------------
        // Test 4: Migration Discovery Validation
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 4: Migration Discovery Validation ---');
        const invalidDir = path.join(TEST_DIR, 'invalid_migrations');
        fs.mkdirSync(invalidDir, { recursive: true });

        // 1. Duplicate migration names
        fs.writeFileSync(path.join(invalidDir, '001_dup.js'), 'module.exports = { name: "same_name", up: () => {}, down: () => {} };');
        fs.writeFileSync(path.join(invalidDir, '002_dup.js'), 'module.exports = { name: "same_name", up: () => {}, down: () => {} };');
        assert.throws(() => {
            loadMigrationFiles(invalidDir);
        }, /Duplicate migration name/i, 'Must reject duplicate migration names');

        // 2. Ambiguous numeric ordering prefixes
        fs.unlinkSync(path.join(invalidDir, '002_dup.js'));
        fs.writeFileSync(path.join(invalidDir, '001_another.js'), 'module.exports = { name: "different_name", up: () => {}, down: () => {} };');
        assert.throws(() => {
            loadMigrationFiles(invalidDir);
        }, /Ambiguous migration ordering/i, 'Must reject duplicate numeric prefix 001');

        // 3. Missing up() function
        fs.unlinkSync(path.join(invalidDir, '001_another.js'));
        fs.writeFileSync(path.join(invalidDir, '001_dup.js'), 'module.exports = { name: "no_up", down: () => {} };');
        assert.throws(() => {
            loadMigrationFiles(invalidDir);
        }, /export an 'up\(db\)' function/i, 'Must reject missing up() function');

        // 4. Missing down() function
        fs.writeFileSync(path.join(invalidDir, '001_dup.js'), 'module.exports = { name: "no_down", up: () => {} };');
        assert.throws(() => {
            loadMigrationFiles(invalidDir);
        }, /export a 'down\(db\)' function/i, 'Must reject missing down() function');

        // 5. Malformed module export
        fs.writeFileSync(path.join(invalidDir, '001_dup.js'), 'module.exports = "invalid";');
        assert.throws(() => {
            loadMigrationFiles(invalidDir);
        }, /must export an object/i, 'Must reject non-object export');

        // Clean up invalid test dir
        fs.rmSync(invalidDir, { recursive: true, force: true });
        console.log('✓ Migration discovery validation verified (duplicates, ordering, missing up/down, malformed).\n');

        // -------------------------------------------------------------
        // Test 5: Sequential Migrate Up & ACID Transactions
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 5: Sequential Migrate Up & ACID Transactions ---');
        createSyntheticMigrationFiles(TEST_MIGRATIONS_DIR);

        const initialStatus = getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        assert.strictEqual(initialStatus.totalAvailable, 2);
        assert.strictEqual(initialStatus.totalApplied, 0);

        const upResult = migrateUp(db, TEST_DB_PATH, {
            migrationsDir: TEST_MIGRATIONS_DIR,
            backupDir: TEST_BACKUP_DIR
        });
        assert.strictEqual(upResult.appliedCount, 2);
        assert.strictEqual(upResult.batch, 1);

        const catRow = db.prepare('SELECT name_ar FROM categories WHERE id = ?').get('cat_citrus');
        assert.strictEqual(catRow.name_ar, 'موالح');
        console.log('✓ Sequential migrate up applied cleanly with verified backups.\n');

        // -------------------------------------------------------------
        // Test 6: Persistent Migration Failure Audit (_migration_failures Ledger)
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 6: Persistent Migration Failure Audit ---');
        // Add a failing migration 003
        fs.writeFileSync(
            path.join(TEST_MIGRATIONS_DIR, '003_failing_migration.js'),
            `
            module.exports = {
                name: '003_failing_migration',
                up: (db) => {
                    db.exec('CREATE TABLE temp_test (id TEXT);');
                    // Intentionally throw a SQL syntax error
                    db.exec('SYNTAX ERROR CAUSING IMMEDIATE ROLLBACK;');
                },
                down: (db) => {}
            };
            `
        );

        assert.throws(() => {
            migrateUp(db, TEST_DB_PATH, {
                migrationsDir: TEST_MIGRATIONS_DIR,
                backupDir: TEST_BACKUP_DIR
            });
        }, /MIGRATION FAILED/i, 'Failing migration must throw error');

        // Verify transaction rolled back: temp_test table must NOT exist!
        const tempTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'temp_test'").get();
        assert.strictEqual(tempTable, undefined, 'Table created inside failed migration must be rolled back');

        // Verify failure was NOT recorded in _migrations
        const appliedCheck = db.prepare("SELECT * FROM _migrations WHERE name = '003_failing_migration'").get();
        assert.strictEqual(appliedCheck, undefined, 'Failed migration must NEVER be recorded in _migrations');

        // Verify failure WAS persisted in _migration_failures audit ledger
        const failureRecord = db.prepare("SELECT * FROM _migration_failures WHERE name = '003_failing_migration' ORDER BY id DESC LIMIT 1").get();
        assert.ok(failureRecord, 'Failure record must exist in _migration_failures');
        assert.strictEqual(failureRecord.name, '003_failing_migration');
        assert.ok(failureRecord.error_message.includes('syntax error') || failureRecord.error_message.length > 0);

        // Remove failing migration file
        fs.unlinkSync(path.join(TEST_MIGRATIONS_DIR, '003_failing_migration.js'));
        console.log('✓ Persistent migration failure audit ledger verified.\n');

        // -------------------------------------------------------------
        // Test 7: Anti-Tamper Checksum Detection
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 7: Anti-Tamper Checksum Verification ---');
        const mig1Path = path.join(TEST_MIGRATIONS_DIR, '001_create_categories.js');
        const originalContent = fs.readFileSync(mig1Path, 'utf8');
        fs.writeFileSync(mig1Path, originalContent + '\n// Tampered comment malicious edit');

        assert.throws(() => {
            getMigrationStatus(db, TEST_MIGRATIONS_DIR);
        }, /TAMPERING DETECTED/i, 'Tampered migration file must be detected and rejected immediately');

        fs.writeFileSync(mig1Path, originalContent);
        console.log('✓ Anti-tamper checksum detection verified.\n');

        // -------------------------------------------------------------
        // Test 8: Safe Migrate Down & Reversible DDL
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 8: Safe Migrate Down & Reversible DDL ---');
        const downResult = migrateDown(db, TEST_DB_PATH, {
            migrationsDir: TEST_MIGRATIONS_DIR,
            backupDir: TEST_BACKUP_DIR
        });
        assert.strictEqual(downResult.revertedCount, 2);

        const catCheck = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'categories'").get();
        assert.strictEqual(catCheck, undefined, 'Categories table dropped on rollback');
        console.log('✓ Safe rollback with pre-rollback backup verified.\n');

        // -------------------------------------------------------------
        // Test 9: Real Multi-Process Concurrency & Mutex Isolation
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 9: Real Multi-Process Concurrency (Independent Child Processes) ---');
        // Spawn two independent Node.js processes targeting the same database simultaneously
        const workerScript = path.join(__dirname, 'lock_worker.js');
        const child1 = spawnSync(process.execPath, [workerScript, TEST_DB_PATH, 'process_alpha', '1000'], { encoding: 'utf8' });
        // Start second process right after while child1 is executing (holdMs = 1000)
        const child2 = spawnSync(process.execPath, [workerScript, TEST_DB_PATH, 'process_beta', '500'], { encoding: 'utf8' });

        // Since child1 held the lock for 1000ms, child2 competing for the lock will receive CONFLICT (code 2)
        // Or if run sequentially, both exit 0 cleanly. Let's test explicit lock contention:
        const lockHandle1 = acquireMigrationLock(db, { lockOwner: 'parent_lock', busyTimeout: 200 });
        const conflictingChild = spawnSync(process.execPath, [workerScript, TEST_DB_PATH, 'contending_process', '500'], { encoding: 'utf8' });
        assert.strictEqual(conflictingChild.status, 2, 'Contending child process must exit with code 2 on lock conflict');
        assert.ok(conflictingChild.stdout.includes('CONFLICT'), 'Contending child process must output CONFLICT');

        releaseMigrationLock(db, lockHandle1);

        // Child process can now acquire and release without conflict
        const cleanChild = spawnSync(process.execPath, [workerScript, TEST_DB_PATH, 'independent_process', '200'], { encoding: 'utf8' });
        assert.strictEqual(cleanChild.status, 0, 'Child process must acquire and release cleanly when uncontended');
        console.log('✓ Real multi-process lock contention and conflict rejection verified.\n');

        // -------------------------------------------------------------
        // Test 10: Safe Crash Recovery for Orphaned Locks
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 10: Safe Crash Recovery for Orphaned Locks ---');
        // Simulate a dead process crash: insert a lock with a non-existent PID and elapsed time
        const DEAD_PID = 99999999;
        const DEAD_TOKEN = 'token_crashed_process_dead_state';
        db.prepare(`
            UPDATE _migration_lock 
            SET is_locked = 1, locked_by = 'crashed_worker', locked_at = datetime('now', '-20 seconds'), owner_pid = ?, owner_token = ?
            WHERE id = 1
        `).run(DEAD_PID, DEAD_TOKEN);

        // Next acquireMigrationLock should detect PID is dead, check stale grace period, and recover!
        const recoveredHandle = acquireMigrationLock(db, {
            lockOwner: 'recovery_worker',
            staleGraceMs: 5000 // 5s grace period
        });
        assert.strictEqual(recoveredHandle.recovered, true, 'Lock must be recovered from confirmed dead process');
        assert.notStrictEqual(recoveredHandle.ownerToken, DEAD_TOKEN, 'New owner token must be generated');

        releaseMigrationLock(db, recoveredHandle);
        console.log('✓ Safe crash recovery of orphaned locks from dead processes verified.\n');

        // -------------------------------------------------------------
        // Test 11: Fencing Token & Protection Against Old Owner
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 11: Fencing Token Protection ---');
        const activeHandle = acquireMigrationLock(db, { lockOwner: 'worker_primary' });

        // Simulate stale worker attempting to release after takeover
        const fakeStaleHandle = { ownerToken: 'fake_stale_token_from_old_worker' };
        releaseMigrationLock(db, fakeStaleHandle);

        // Lock must STILL be held by worker_primary!
        const lockCheck = db.prepare('SELECT is_locked, owner_token FROM _migration_lock WHERE id = 1').get();
        assert.strictEqual(lockCheck.is_locked, 1, 'Stale token must not be able to release active lock');
        assert.strictEqual(lockCheck.owner_token, activeHandle.ownerToken);

        // Fencing check passes for legitimate owner
        assert.doesNotThrow(() => {
            verifyLockOwnership(db, activeHandle);
        });

        // Fencing check fails for stale owner
        assert.throws(() => {
            verifyLockOwnership(db, fakeStaleHandle);
        }, /Fencing violation/i, 'Stale owner must be rejected by fencing gate');

        releaseMigrationLock(db, activeHandle);
        console.log('✓ Fencing token integrity & old-owner lockout verified.\n');

        // -------------------------------------------------------------
        // Test 12: Safe Restore in WAL-Mode Database with Sidecars
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 12: Safe Restore in WAL-Mode Database with Sidecars ---');
        // Setup a database in explicit WAL mode
        const walDbPath = path.join(TEST_DIR, 'wal_target.db');
        createSyntheticAppDatabase(walDbPath);

        const walDb = new DatabaseSync(walDbPath);
        walDb.exec('PRAGMA journal_mode = WAL;');
        // Perform an insert to populate the WAL file
        walDb.prepare("INSERT INTO users VALUES ('usr_wal', 'مستخدم وال', 'wal@test.gov');").run();
        walDb.close();

        // Simulate leftover uncheckpointed WAL and SHM sidecars from an interrupted session
        const walFilePath = `${walDbPath}-wal`;
        const shmFilePath = `${walDbPath}-shm`;
        fs.writeFileSync(walFilePath, Buffer.alloc(64));
        fs.writeFileSync(shmFilePath, Buffer.alloc(64));
        assert.ok(fs.existsSync(walFilePath), 'WAL sidecar file must exist on disk before restore');
        assert.ok(fs.existsSync(shmFilePath), 'SHM sidecar file must exist on disk before restore');

        // Restore using the verified initial backup
        const restoreResult = restoreFromBackup(backupInfo.backupPath, walDbPath, {
            backupDir: TEST_BACKUP_DIR
        });
        assert.strictEqual(restoreResult.restored, true);
        assert.ok(fs.existsSync(restoreResult.preRestoreBackupPath), 'Pre-restore backup must be created');

        // Assert that old WAL & SHM sidecars were safely isolated and not left to corrupt the new DB
        assert.strictEqual(fs.existsSync(walFilePath), false, 'Old WAL sidecar must be removed from target');
        assert.strictEqual(fs.existsSync(shmFilePath), false, 'Old SHM sidecar must be removed from target');

        // Open restored database and verify integrity
        const restoredDb = new DatabaseSync(walDbPath);
        restoredDb.exec('PRAGMA foreign_keys = ON;');
        const integrityCheck = restoredDb.prepare('PRAGMA integrity_check;').get();
        assert.strictEqual(integrityCheck.integrity_check, 'ok', 'Restored database must pass integrity check');
        const fkCheck = restoredDb.prepare('PRAGMA foreign_key_check;').all();
        assert.strictEqual(fkCheck.length, 0, 'Restored database must have 0 FK violations');

        // Verify data reflects the backup (initial backup had 3 users, not usr_wal)
        const userCount = restoredDb.prepare('SELECT count(*) as c FROM users').get().c;
        assert.strictEqual(userCount, 3, 'Restored DB has original 3 users without WAL contamination');
        restoredDb.close();
        console.log('✓ Safe restore in WAL-mode database with sidecar isolation verified.\n');

        // -------------------------------------------------------------
        // Test 13: Refusal to Restore Corrupted Backup
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 13: Refusal to Restore Corrupted Backup ---');
        const corruptBackupPath = path.join(TEST_DIR, 'corrupt_backup.db');
        fs.writeFileSync(corruptBackupPath, 'CORRUPTED FILE NOT A SQLITE DATABASE');

        assert.throws(() => {
            restoreFromBackup(corruptBackupPath, walDbPath, { backupDir: TEST_BACKUP_DIR });
        }, /Source backup failed integrity check|RESTORE ERROR/i, 'Corrupt backup must be rejected before touching target');

        // Verify walDbPath is still intact and queryable
        const checkUntouchedDb = new DatabaseSync(walDbPath);
        assert.strictEqual(checkUntouchedDb.prepare('SELECT count(*) as c FROM users').get().c, 3);
        checkUntouchedDb.close();
        console.log('✓ Rejection of corrupted backup and target preservation verified.\n');

        // -------------------------------------------------------------
        // Test 14: Recoverability on Staging Failure
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 14: Target Preservation on Failed Promotion ---');
        // Verify original target remains valid if non-existent backup is passed
        assert.throws(() => {
            restoreFromBackup(path.join(TEST_DIR, 'non_existent.db'), walDbPath);
        }, /does not exist/i);

        const checkStillIntact = new DatabaseSync(walDbPath);
        assert.strictEqual(checkStillIntact.prepare('PRAGMA integrity_check;').get().integrity_check, 'ok');
        checkStillIntact.close();
        console.log('✓ Target database preservation on failure verified.\n');

        // -------------------------------------------------------------
        // Test 15: Deterministic Partial Unique Index
        // -------------------------------------------------------------
        console.log('--- 🧪 Test 15: Deterministic Partial Index vs SQLite Limitation ---');
        const indexDb = new DatabaseSync(':memory:');
        indexDb.exec('CREATE TABLE product_prices (id TEXT PRIMARY KEY, product_id TEXT, currency TEXT, incoterm TEXT, is_primary INTEGER, valid_to DATETIME);');

        assert.throws(() => {
            indexDb.exec('CREATE UNIQUE INDEX uidx_invalid ON product_prices(product_id) WHERE is_primary = 1 AND valid_to > CURRENT_TIMESTAMP;');
        }, /non-deterministic functions prohibited/i, 'SQLite must reject non-deterministic functions in partial index');

        indexDb.exec('CREATE UNIQUE INDEX uidx_valid ON product_prices(product_id, currency, incoterm) WHERE is_primary = 1;');
        indexDb.prepare("INSERT INTO product_prices VALUES ('pr_1', 'prod_1', 'USD', 'FOB', 1, NULL);").run();

        assert.throws(() => {
            indexDb.prepare("INSERT INTO product_prices VALUES ('pr_2', 'prod_1', 'USD', 'FOB', 1, NULL);").run();
        }, /UNIQUE constraint failed/i, 'Duplicate primary price must violate deterministic unique constraint');

        indexDb.prepare("INSERT INTO product_prices VALUES ('pr_3', 'prod_1', 'USD', 'FOB', 0, '2026-11-01');").run();
        indexDb.close();
        console.log('✓ Deterministic partial unique index verified.\n');

        console.log('================================================================');
        console.log('🎉 ALL 15 MILESTONE 2.1 MIGRATION SAFETY TESTS PASSED (100%)!');
        console.log('================================================================\n');

    } finally {
        if (db) {
            try { db.close(); } catch (e) {}
        }
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
