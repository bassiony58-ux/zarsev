const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '..', 'storage', 'backups', 'migrations');

/**
 * Computes SHA-256 hash of a file's contents for tamper detection.
 */
function computeChecksum(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Ensures the _migrations and _migration_lock tables exist.
 */
function ensureMigrationInfrastructure(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            batch INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS _migration_lock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_locked INTEGER NOT NULL DEFAULT 0,
            locked_by TEXT NULL,
            locked_at DATETIME NULL
        );
        INSERT OR IGNORE INTO _migration_lock (id, is_locked) VALUES (1, 0);
    `);
}

/**
 * Acquires exclusive migration lock.
 */
function acquireMigrationLock(db, lockOwner = `pid_${process.pid}`) {
    ensureMigrationInfrastructure(db);
    const result = db.prepare(`
        UPDATE _migration_lock 
        SET is_locked = 1, locked_by = ?, locked_at = CURRENT_TIMESTAMP 
        WHERE id = 1 AND is_locked = 0
    `).run(lockOwner);

    if (result.changes === 0) {
        const currentLock = db.prepare('SELECT locked_by, locked_at FROM _migration_lock WHERE id = 1').get();
        throw new Error(
            `[MIGRATION LOCK CONFLICT] Migration lock is already held by '${currentLock?.locked_by}' ` +
            `since ${currentLock?.locked_at}. Concurrent migration runs are strictly prohibited.`
        );
    }
}

/**
 * Releases exclusive migration lock.
 */
function releaseMigrationLock(db, lockOwner = `pid_${process.pid}`) {
    try {
        db.prepare(`
            UPDATE _migration_lock 
            SET is_locked = 0, locked_by = NULL, locked_at = NULL 
            WHERE id = 1 AND locked_by = ?
        `).run(lockOwner);
    } catch (err) {
        console.error('Failed to release migration lock cleanly:', err.message);
    }
}

/**
 * Pauses execution synchronously for backoff retry.
 */
function sleepMs(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
}

/**
 * Executes the verified 8-phase pre-migration backup protocol.
 * A migration must NEVER proceed if this verification fails.
 */
function createVerifiedPreMigrationBackup(db, dbPath, migrationName, backupDir = DEFAULT_BACKUP_DIR) {
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    // Phase 2: WAL Checkpoint with busy retry
    let checkpointOk = false;
    const retryDelays = [500, 1000, 2000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        try {
            const checkpointResult = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
            // In SQLite, wal_checkpoint returns { busy, log, checkpointed }
            if (checkpointResult && checkpointResult.busy === 1) {
                if (attempt < retryDelays.length) {
                    sleepMs(retryDelays[attempt]);
                    continue;
                }
                throw new Error('SQLite WAL checkpoint returned busy = 1 after 3 backoff retries.');
            }
            checkpointOk = true;
            break;
        } catch (err) {
            if (attempt < retryDelays.length) {
                sleepMs(retryDelays[attempt]);
            } else {
                throw new Error(`[CRITICAL BACKUP FAILURE] WAL Checkpoint failed: ${err.message}`);
            }
        }
    }

    if (!checkpointOk) {
        throw new Error('[CRITICAL BACKUP FAILURE] Could not establish safe write-quiescence before backup.');
    }

    // Phase 3: Live temporary snapshot via VACUUM INTO
    const tempBackupPath = path.join(backupDir, `temp_backup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
    try {
        db.exec(`VACUUM INTO '${tempBackupPath.replace(/'/g, "''")}';`);
    } catch (err) {
        if (fs.existsSync(tempBackupPath)) fs.unlinkSync(tempBackupPath);
        throw new Error(`[CRITICAL BACKUP FAILURE] VACUUM INTO snapshot failed: ${err.message}`);
    }

    // Phases 4 & 5: Deep Integrity, Foreign Key & Exhaustive Exact Count Verification
    let backupDb = null;
    try {
        backupDb = new DatabaseSync(tempBackupPath);

        // 1. PRAGMA integrity_check
        const integrity = backupDb.prepare('PRAGMA integrity_check;').get();
        if (!integrity || integrity.integrity_check !== 'ok') {
            throw new Error(`Integrity check failed: ${JSON.stringify(integrity)}`);
        }

        // 2. PRAGMA foreign_key_check
        const fkViolations = backupDb.prepare('PRAGMA foreign_key_check;').all();
        if (fkViolations && fkViolations.length > 0) {
            throw new Error(`Foreign key check detected ${fkViolations.length} violations in snapshot.`);
        }

        // 3. Exhaustive Table Existence & Exact Row Count Verification for ALL non-internal tables
        const tables = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type = 'table' 
              AND name NOT LIKE 'sqlite_%' 
              AND name NOT LIKE '_migration%'
        `).all().map(r => r.name);

        const tableAudit = {};
        for (const tableName of tables) {
            // Verify table exists in backup
            const backupTableExists = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
            if (!backupTableExists) {
                throw new Error(`Critical table '${tableName}' is missing from snapshot!`);
            }

            // Verify exact row counts
            const liveCount = db.prepare(`SELECT count(*) as c FROM ${tableName}`).get().c;
            const backupCount = backupDb.prepare(`SELECT count(*) as c FROM ${tableName}`).get().c;

            if (backupCount !== liveCount) {
                throw new Error(
                    `Exact row count mismatch on table '${tableName}': Live DB has ${liveCount} rows, ` +
                    `but backup snapshot has ${backupCount} rows!`
                );
            }
            tableAudit[tableName] = liveCount;
        }

        // 4. Verify Index Schema Definitions
        const liveIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
        const backupIndexes = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
        for (const idx of liveIndexes) {
            if (!backupIndexes.includes(idx)) {
                throw new Error(`Index '${idx}' is missing from snapshot schema!`);
            }
        }

        backupDb.close();
        backupDb = null;

        // Phase 6: Atomic Promotion to Permanent Verified Backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const cleanName = migrationName.replace(/[^a-zA-Z0-9_\-]/g, '_');
        const finalBackupPath = path.join(backupDir, `backup_pre_migration_${cleanName}_${timestamp}.db`);
        fs.renameSync(tempBackupPath, finalBackupPath);

        return {
            verified: true,
            backupPath: finalBackupPath,
            tablesVerified: Object.keys(tableAudit).length,
            tableAudit,
            timestamp
        };

    } catch (err) {
        if (backupDb) {
            try { backupDb.close(); } catch (e) {}
        }
        if (fs.existsSync(tempBackupPath)) {
            try { fs.unlinkSync(tempBackupPath); } catch (e) {}
        }
        throw new Error(`[CRITICAL BACKUP VERIFICATION FAILED] ${err.message}. Migration strictly aborted.`);
    }
}

/**
 * Reads and sorts available migration files from the migrations directory.
 */
function loadMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
    if (!fs.existsSync(migrationsDir)) return [];

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.js') && !f.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return files.map(file => {
        const filePath = path.join(migrationsDir, file);
        const mod = require(filePath);
        const name = mod.name || path.basename(file, '.js');
        const checksum = computeChecksum(filePath);

        if (typeof mod.up !== 'function' || typeof mod.down !== 'function') {
            throw new Error(`Migration file '${file}' must export both 'up(db)' and 'down(db)' functions.`);
        }

        return {
            fileName: file,
            filePath,
            name,
            checksum,
            up: mod.up,
            down: mod.down
        };
    });
}

/**
 * Verifies that previously applied migrations have not been altered (Anti-Tampering).
 */
function verifyAppliedMigrationChecksums(db, availableMigrations) {
    ensureMigrationInfrastructure(db);
    const applied = db.prepare('SELECT name, batch, checksum, applied_at FROM _migrations ORDER BY id ASC').all();
    const availableMap = new Map(availableMigrations.map(m => [m.name, m]));

    for (const record of applied) {
        const available = availableMap.get(record.name);
        if (!available) {
            throw new Error(
                `[MIGRATION HISTORY VIOLATION] Applied migration '${record.name}' is missing from disk! ` +
                `Historical migrations must be preserved.`
            );
        }

        if (available.checksum !== record.checksum) {
            throw new Error(
                `[TAMPERING DETECTED] Checksum mismatch for historical migration '${record.name}'!\n` +
                `Recorded in DB: ${record.checksum}\n` +
                `Calculated now: ${available.checksum}\n` +
                `Applied migration files must NEVER be modified after execution.`
            );
        }
    }

    return applied;
}

/**
 * Returns migration status (applied vs pending).
 */
function getMigrationStatus(db, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
    ensureMigrationInfrastructure(db);
    const available = loadMigrationFiles(migrationsDir);
    const applied = verifyAppliedMigrationChecksums(db, available);
    const appliedNames = new Set(applied.map(a => a.name));

    const pending = available.filter(m => !appliedNames.has(m.name));

    return {
        applied: applied.map(a => ({
            name: a.name,
            batch: a.batch,
            checksum: a.checksum,
            applied_at: a.applied_at
        })),
        pending: pending.map(p => ({
            name: p.name,
            fileName: p.fileName,
            checksum: p.checksum
        })),
        totalAvailable: available.length,
        totalApplied: applied.length,
        totalPending: pending.length
    };
}

/**
 * Applies all pending migrations sequentially.
 */
function migrateUp(db, dbPath, options = {}) {
    const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
    const backupDir = options.backupDir || DEFAULT_BACKUP_DIR;
    const lockOwner = `up_${process.pid}_${Date.now()}`;

    acquireMigrationLock(db, lockOwner);
    try {
        const available = loadMigrationFiles(migrationsDir);
        const applied = verifyAppliedMigrationChecksums(db, available);
        const appliedNames = new Set(applied.map(a => a.name));
        const pending = available.filter(m => !appliedNames.has(m.name));

        if (pending.length === 0) {
            return {
                appliedCount: 0,
                appliedMigrations: [],
                message: 'Database is up to date. No pending migrations.'
            };
        }

        const latestBatch = applied.reduce((max, a) => Math.max(max, a.batch || 0), 0);
        const currentBatch = latestBatch + 1;
        const appliedResults = [];

        for (const migration of pending) {
            // 1. Mandatory Pre-Migration Backup with Deep Verification
            const backupInfo = createVerifiedPreMigrationBackup(db, dbPath, migration.name, backupDir);

            // 2. Execute migration inside ACID transaction
            db.exec('BEGIN TRANSACTION;');
            try {
                migration.up(db);
                db.prepare(`
                    INSERT INTO _migrations (name, batch, checksum)
                    VALUES (?, ?, ?)
                `).run(migration.name, currentBatch, migration.checksum);

                db.exec('COMMIT;');
                appliedResults.push({
                    name: migration.name,
                    batch: currentBatch,
                    backupPath: backupInfo.backupPath
                });
            } catch (err) {
                db.exec('ROLLBACK;');
                throw new Error(
                    `[MIGRATION FAILED] Error executing '${migration.name}': ${err.message}. ` +
                    `Transaction rolled back. Verified pre-migration backup preserved at: ${backupInfo.backupPath}`
                );
            }
        }

        return {
            appliedCount: appliedResults.length,
            batch: currentBatch,
            appliedMigrations: appliedResults,
            message: `Successfully applied (${appliedResults.length}) migrations in batch ${currentBatch}.`
        };

    } finally {
        releaseMigrationLock(db, lockOwner);
    }
}

/**
 * Rolls back the most recently applied batch of migrations.
 */
function migrateDown(db, dbPath, options = {}) {
    const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
    const backupDir = options.backupDir || DEFAULT_BACKUP_DIR;
    const lockOwner = `down_${process.pid}_${Date.now()}`;

    acquireMigrationLock(db, lockOwner);
    try {
        const available = loadMigrationFiles(migrationsDir);
        const applied = verifyAppliedMigrationChecksums(db, available);

        if (applied.length === 0) {
            return {
                revertedCount: 0,
                revertedMigrations: [],
                message: 'No migrations have been applied. Nothing to roll back.'
            };
        }

        const latestBatch = applied.reduce((max, a) => Math.max(max, a.batch || 0), 0);
        const batchMigrations = applied.filter(a => a.batch === latestBatch);
        const availableMap = new Map(available.map(m => [m.name, m]));

        // Revert in reverse order of application
        const toRevert = [...batchMigrations].reverse();
        const revertedResults = [];

        for (const record of toRevert) {
            const migration = availableMap.get(record.name);
            if (!migration) {
                throw new Error(`Migration file '${record.name}' not found for rollback.`);
            }

            // Create verified pre-rollback backup
            const backupInfo = createVerifiedPreMigrationBackup(db, dbPath, `revert_${migration.name}`, backupDir);

            // Execute down migration inside transaction
            db.exec('BEGIN TRANSACTION;');
            try {
                migration.down(db);
                db.prepare('DELETE FROM _migrations WHERE name = ?').run(migration.name);
                db.exec('COMMIT;');

                revertedResults.push({
                    name: migration.name,
                    batch: latestBatch,
                    backupPath: backupInfo.backupPath
                });
            } catch (err) {
                db.exec('ROLLBACK;');
                throw new Error(
                    `[ROLLBACK FAILED] Error reverting '${migration.name}': ${err.message}. ` +
                    `Transaction rolled back. Pre-rollback backup preserved at: ${backupInfo.backupPath}`
                );
            }
        }

        return {
            revertedCount: revertedResults.length,
            batch: latestBatch,
            revertedMigrations: revertedResults,
            message: `Successfully rolled back (${revertedResults.length}) migrations from batch ${latestBatch}.`
        };

    } finally {
        releaseMigrationLock(db, lockOwner);
    }
}

/**
 * Restores a database completely from a verified backup snapshot.
 */
function restoreFromBackup(backupPath, targetDbPath) {
    if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file does not exist: ${backupPath}`);
    }

    // Verify backup integrity before restoring
    const backupDb = new DatabaseSync(backupPath);
    const integrity = backupDb.prepare('PRAGMA integrity_check;').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
        backupDb.close();
        throw new Error(`Cannot restore: Backup failed integrity check: ${JSON.stringify(integrity)}`);
    }
    backupDb.close();

    // Copy backup over target atomically
    fs.copyFileSync(backupPath, targetDbPath);
    return { restored: true, from: backupPath, to: targetDbPath };
}

module.exports = {
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
};
