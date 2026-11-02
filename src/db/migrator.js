const fs = require('fs');
const path = require('path');
const os = require('os');
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
 * Ensures the _migrations, _migration_failures, and _migration_lock tables exist.
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

        CREATE TABLE IF NOT EXISTS _migration_failures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            batch INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            error_message TEXT NOT NULL,
            error_stack TEXT NULL,
            failed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS _migration_lock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_locked INTEGER NOT NULL DEFAULT 0,
            locked_by TEXT NULL,
            locked_at DATETIME NULL,
            owner_pid INTEGER NULL,
            owner_token TEXT NULL
        );
        INSERT OR IGNORE INTO _migration_lock (id, is_locked) VALUES (1, 0);
    `);

    // Ensure columns exist if _migration_lock already existed with older schema
    try {
        const lockCols = db.prepare('PRAGMA table_info(_migration_lock);').all().map(c => c.name);
        if (!lockCols.includes('owner_pid')) {
            db.exec('ALTER TABLE _migration_lock ADD COLUMN owner_pid INTEGER NULL;');
        }
        if (!lockCols.includes('owner_token')) {
            db.exec('ALTER TABLE _migration_lock ADD COLUMN owner_token TEXT NULL;');
        }
    } catch (e) {
        // Table info check fallback
    }
}

/**
 * Acquires exclusive migration lock with atomic process isolation, PID liveness check,
 * and safe crash recovery.
 */
function acquireMigrationLock(db, options = {}) {
    ensureMigrationInfrastructure(db);

    const busyTimeoutMs = typeof options.busyTimeout === 'number' ? options.busyTimeout : 5000;
    try {
        db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    } catch (e) {}

    const ownerPid = process.pid;
    const ownerToken = crypto.randomBytes(16).toString('hex');
    const lockOwner = options.lockOwner || `${os.hostname()}_pid${ownerPid}_ts${Date.now()}_${ownerToken.substring(0, 8)}`;
    const staleGraceMs = typeof options.staleGraceMs === 'number' ? options.staleGraceMs : 10000;

    // 1. Attempt atomic acquisition
    const result = db.prepare(`
        UPDATE _migration_lock 
        SET is_locked = 1, locked_by = ?, locked_at = CURRENT_TIMESTAMP, owner_pid = ?, owner_token = ?
        WHERE id = 1 AND is_locked = 0
    `).run(lockOwner, ownerPid, ownerToken);

    if (result.changes === 1) {
        return { lockOwner, ownerPid, ownerToken };
    }

    // 2. Lock contention: inspect current holder
    const currentLock = db.prepare('SELECT locked_by, locked_at, owner_pid, owner_token FROM _migration_lock WHERE id = 1').get();

    // 3. Verify process liveness
    let isProcessAlive = false;
    if (currentLock && currentLock.owner_pid) {
        try {
            process.kill(currentLock.owner_pid, 0);
            isProcessAlive = true;
        } catch (err) {
            if (err.code === 'ESRCH') {
                isProcessAlive = false; // Process is dead
            } else {
                isProcessAlive = true; // EPERM means process exists but we lack permission to signal
            }
        }
    }

    // 4. Stale lock evaluation
    const lockTime = currentLock?.locked_at ? new Date(currentLock.locked_at + 'Z').getTime() : 0;
    const isStale = (Date.now() - lockTime) > staleGraceMs;

    // Safe crash recovery: Reclaim ONLY if owner PID is verified dead AND grace period elapsed
    if (!isProcessAlive && isStale) {
        const reclaimResult = db.prepare(`
            UPDATE _migration_lock
            SET is_locked = 1, locked_by = ?, locked_at = CURRENT_TIMESTAMP, owner_pid = ?, owner_token = ?
            WHERE id = 1 AND is_locked = 1 AND owner_token = ?
        `).run(lockOwner, ownerPid, ownerToken, currentLock.owner_token);

        if (reclaimResult.changes === 1) {
            console.warn(`[MIGRATION LOCK RECOVERED] Safely reclaimed orphaned lock from dead PID ${currentLock.owner_pid}.`);
            return { lockOwner, ownerPid, ownerToken, recovered: true };
        }
    } else if (options.forceUnlock === true) {
        db.prepare(`
            UPDATE _migration_lock
            SET is_locked = 1, locked_by = ?, locked_at = CURRENT_TIMESTAMP, owner_pid = ?, owner_token = ?
            WHERE id = 1
        `).run(lockOwner, ownerPid, ownerToken);
        console.warn(`[MIGRATION LOCK OVERRIDE] Administratively took over lock from ${currentLock?.locked_by}.`);
        return { lockOwner, ownerPid, ownerToken, forced: true };
    }

    throw new Error(
        `[MIGRATION LOCK CONFLICT] Migration lock is already held by '${currentLock?.locked_by}' ` +
        `(PID: ${currentLock?.owner_pid || 'unknown'}, Active: ${isProcessAlive}) since ${currentLock?.locked_at}. ` +
        `Concurrent migration runs are strictly prohibited.`
    );
}

/**
 * Releases exclusive migration lock. Restricted strictly to current owner token.
 */
function releaseMigrationLock(db, lockHandle) {
    if (!lockHandle) return;
    const token = typeof lockHandle === 'object' ? (lockHandle.ownerToken || lockHandle.lockOwner) : lockHandle;
    try {
        db.prepare(`
            UPDATE _migration_lock 
            SET is_locked = 0, locked_by = NULL, locked_at = NULL, owner_pid = NULL, owner_token = NULL
            WHERE id = 1 AND (owner_token = ? OR locked_by = ?)
        `).run(token, token);
    } catch (err) {
        console.error('Failed to release migration lock cleanly:', err.message);
    }
}

/**
 * Verifies lock ownership before committing a transaction (Fencing Token).
 */
function verifyLockOwnership(db, lockHandle) {
    if (!lockHandle || !lockHandle.ownerToken) return;
    const lock = db.prepare('SELECT owner_token, is_locked FROM _migration_lock WHERE id = 1').get();
    if (!lock || lock.is_locked !== 1 || lock.owner_token !== lockHandle.ownerToken) {
        throw new Error('[MIGRATION LOCK LOST] Fencing violation: Lock ownership was superseded. Execution halted.');
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
 * Executes the verified pre-migration backup protocol using Strategy B:
 * Snapshot-Internal Structural & Deep Integrity Verification with SQLite point-in-time ACID guarantees.
 *
 * Guaranteed Properties:
 * 1. Safe quiescence check via PRAGMA wal_checkpoint(TRUNCATE) with exponential backoff on busy.
 * 2. Atomic, non-torn point-in-time snapshot via SQLite VACUUM INTO.
 * 3. Deep internal integrity validation (PRAGMA integrity_check = 'ok').
 * 4. Relational integrity validation (PRAGMA foreign_key_check = 0 violations).
 * 5. Exhaustive table & column schema parity across all non-internal application tables.
 * 6. Index parity validation.
 * 7. Non-destructive promotion to permanent timestamped backup with zero file collisions.
 */
function createVerifiedPreMigrationBackup(db, dbPath, migrationName, backupDir = DEFAULT_BACKUP_DIR, options = {}) {
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    // Phase 1: WAL Checkpoint with busy retry to commit dirty memory pages
    let checkpointOk = false;
    const retryDelays = [500, 1000, 2000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        try {
            const checkpointResult = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
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

    // Baseline table counts before VACUUM INTO if strict quiescence is requested
    const preSnapshotCounts = {};
    if (options.requireWriteQuiescence === true) {
        const preTables = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type = 'table' 
              AND name NOT LIKE 'sqlite_%' 
              AND name NOT LIKE '_migration%'
        `).all().map(r => r.name);
        for (const t of preTables) {
            preSnapshotCounts[t] = db.prepare(`SELECT count(*) as c FROM ${t}`).get().c;
        }
    }

    // Phase 2: Live point-in-time snapshot via VACUUM INTO
    const tempBackupPath = path.join(backupDir, `temp_backup_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.db`);
    try {
        db.exec(`VACUUM INTO '${tempBackupPath.replace(/'/g, "''")}';`);
    } catch (err) {
        if (fs.existsSync(tempBackupPath)) {
            try { fs.unlinkSync(tempBackupPath); } catch (e) {}
        }
        throw new Error(`[CRITICAL BACKUP FAILURE] VACUUM INTO snapshot failed: ${err.message}`);
    }

    // Simulation hook for concurrency testing
    if (typeof options.beforeVerification === 'function') {
        options.beforeVerification();
    }

    // Phases 3 & 4: Deep Snapshot-Internal Verification
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

        // 3. Exhaustive Schema & Table Parity
        const liveTables = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type = 'table' 
              AND name NOT LIKE 'sqlite_%' 
              AND name NOT LIKE '_migration%'
        `).all().map(r => r.name);

        const tableAudit = {};
        for (const tableName of liveTables) {
            const backupTableExists = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
            if (!backupTableExists) {
                throw new Error(`Critical table '${tableName}' is missing from snapshot!`);
            }

            // Verify column definition parity
            const liveCols = db.prepare(`PRAGMA table_info(${tableName});`).all().map(c => `${c.name}:${c.type}:${c.notnull}`);
            const backupCols = backupDb.prepare(`PRAGMA table_info(${tableName});`).all().map(c => `${c.name}:${c.type}:${c.notnull}`);
            if (liveCols.join(',') !== backupCols.join(',')) {
                throw new Error(`Column schema mismatch on table '${tableName}' between live database and snapshot.`);
            }

            // Verify table is queryable in snapshot
            const snapshotCount = backupDb.prepare(`SELECT count(*) as c FROM ${tableName}`).get().c;
            tableAudit[tableName] = snapshotCount;
        }

        // 4. Verify Index Schema Parity
        const liveIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
        const backupIndexes = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
        for (const idx of liveIndexes) {
            if (!backupIndexes.includes(idx)) {
                throw new Error(`Index '${idx}' is missing from snapshot schema!`);
            }
        }

        // Optional strict write-quiescence mode (if required by caller)
        if (options.requireWriteQuiescence === true) {
            for (const tableName of liveTables) {
                const liveCount = db.prepare(`SELECT count(*) as c FROM ${tableName}`).get().c;
                if (preSnapshotCounts[tableName] !== liveCount) {
                    throw new Error(`Write quiescence violated: Concurrent write detected on table '${tableName}' during backup.`);
                }
            }
        }

        backupDb.close();
        backupDb = null;

        // Phase 5: Atomic Promotion to Permanent Verified Backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const cleanName = migrationName.replace(/[^a-zA-Z0-9_\-]/g, '_');
        const randomSuffix = crypto.randomBytes(4).toString('hex');
        const finalBackupPath = path.join(backupDir, `backup_pre_migration_${cleanName}_${timestamp}_${randomSuffix}.db`);
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
 * Reads, validates, and sorts available migration files from the migrations directory.
 * Strictly enforces name uniqueness, numeric ordering prefix uniqueness, and valid function exports.
 */
function loadMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
    if (!fs.existsSync(migrationsDir)) return [];

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.js') && !f.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const loaded = [];
    const seenNames = new Set();
    const seenPrefixes = new Set();

    for (const file of files) {
        const filePath = path.join(migrationsDir, file);

        // Enforce unambiguous numeric ordering prefix
        const prefixMatch = file.match(/^(\d+)_/);
        if (prefixMatch) {
            const prefix = prefixMatch[1];
            if (seenPrefixes.has(prefix)) {
                throw new Error(`[MIGRATION DISCOVERY ERROR] Ambiguous migration ordering: Prefix '${prefix}' is used by multiple migration files.`);
            }
            seenPrefixes.add(prefix);
        }

        let mod;
        try {
            try { delete require.cache[require.resolve(filePath)]; } catch (e) {}
            mod = require(filePath);
        } catch (err) {
            throw new Error(`[MIGRATION DISCOVERY ERROR] Failed to load migration file '${file}': ${err.message}`);
        }

        if (typeof mod !== 'object' || mod === null) {
            throw new Error(`[MIGRATION DISCOVERY ERROR] Migration file '${file}' must export an object.`);
        }

        const name = mod.name || path.basename(file, '.js');
        if (typeof name !== 'string' || !name.trim() || !/^[a-zA-Z0-9_\-]+$/.test(name)) {
            throw new Error(`[MIGRATION DISCOVERY ERROR] Migration '${file}' has invalid or missing name: '${name}'. Must match [a-zA-Z0-9_-]+.`);
        }

        if (seenNames.has(name)) {
            throw new Error(`[MIGRATION DISCOVERY ERROR] Duplicate migration name '${name}' detected in file '${file}'.`);
        }
        seenNames.add(name);

        if (typeof mod.up !== 'function') {
            throw new Error(`[MIGRATION DISCOVERY ERROR] Migration file '${file}' must export an 'up(db)' function.`);
        }

        if (typeof mod.down !== 'function') {
            throw new Error(`[MIGRATION DISCOVERY ERROR] Migration file '${file}' must export a 'down(db)' function.`);
        }

        const checksum = computeChecksum(filePath);

        loaded.push({
            fileName: file,
            filePath,
            name,
            checksum,
            up: mod.up,
            down: mod.down
        });
    }

    return loaded;
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
 * Returns migration status (applied vs pending) and recent migration failures.
 */
function getMigrationStatus(db, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
    ensureMigrationInfrastructure(db);
    const available = loadMigrationFiles(migrationsDir);
    const applied = verifyAppliedMigrationChecksums(db, available);
    const appliedNames = new Set(applied.map(a => a.name));

    const pending = available.filter(m => !appliedNames.has(m.name));

    const failures = db.prepare(`
        SELECT name, batch, error_message, failed_at 
        FROM _migration_failures 
        ORDER BY id DESC LIMIT 5
    `).all();

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
        failures,
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

    const lockHandle = acquireMigrationLock(db, options);
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
            // Verify lock fencing before each migration step
            verifyLockOwnership(db, lockHandle);

            // 1. Mandatory Pre-Migration Backup with Deep Verification
            const backupInfo = createVerifiedPreMigrationBackup(db, dbPath, migration.name, backupDir, options);

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

                // 3. Persist Failure Audit Record separately
                try {
                    db.exec('BEGIN TRANSACTION;');
                    db.prepare(`
                        INSERT INTO _migration_failures (name, batch, checksum, error_message, error_stack)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        migration.name,
                        currentBatch,
                        migration.checksum,
                        err.message.substring(0, 1000),
                        (err.stack || '').substring(0, 4000)
                    );
                    db.exec('COMMIT;');
                } catch (logErr) {
                    try { db.exec('ROLLBACK;'); } catch (e) {}
                    console.error('Failed to persist migration failure log:', logErr.message);
                }

                throw new Error(
                    `[MIGRATION FAILED] Error executing '${migration.name}': ${err.message}. ` +
                    `Transaction rolled back. Failure audit recorded in _migration_failures. ` +
                    `Verified pre-migration backup preserved at: ${backupInfo.backupPath}`
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
        releaseMigrationLock(db, lockHandle);
    }
}

/**
 * Rolls back the most recently applied batch of migrations.
 */
function migrateDown(db, dbPath, options = {}) {
    const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
    const backupDir = options.backupDir || DEFAULT_BACKUP_DIR;

    const lockHandle = acquireMigrationLock(db, options);
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
            verifyLockOwnership(db, lockHandle);

            const migration = availableMap.get(record.name);
            if (!migration) {
                throw new Error(`Migration file '${record.name}' not found for rollback.`);
            }

            // Create verified pre-rollback backup
            const backupInfo = createVerifiedPreMigrationBackup(db, dbPath, `revert_${migration.name}`, backupDir, options);

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
        releaseMigrationLock(db, lockHandle);
    }
}

/**
 * Restores a database safely from a verified backup snapshot.
 *
 * Implements hardened recovery protocol:
 * 1. Deep source backup validation (PRAGMA integrity_check + foreign_key_check).
 * 2. Active connection contention verification & clean WAL checkpointing on target.
 * 3. Mandatory verified pre-restore backup of current target before modification.
 * 4. Safe WAL & SHM sidecar isolation to prevent header salt mismatch corruption.
 * 5. Staging file creation in same directory with pre-promotion verification.
 * 6. Multi-step swap strategy with automated rollback if replacement fails.
 * 7. Post-restoration integrity and foreign key validation on final target.
 */
function restoreFromBackup(backupPath, targetDbPath, options = {}) {
    if (!fs.existsSync(backupPath)) {
        throw new Error(`[RESTORE ERROR] Backup file does not exist: ${backupPath}`);
    }

    const backupDir = options.backupDir || path.dirname(backupPath);
    const targetDir = path.dirname(targetDbPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // Phase 1: Validate Source Backup Integrity before touching target
    let sourceDb = null;
    try {
        sourceDb = new DatabaseSync(backupPath);
        const integrity = sourceDb.prepare('PRAGMA integrity_check;').get();
        if (!integrity || integrity.integrity_check !== 'ok') {
            throw new Error(`Source backup failed integrity check: ${JSON.stringify(integrity)}`);
        }
        const fkViolations = sourceDb.prepare('PRAGMA foreign_key_check;').all();
        if (fkViolations && fkViolations.length > 0) {
            throw new Error(`Source backup contains ${fkViolations.length} foreign key violations.`);
        }
    } catch (err) {
        throw new Error(`[RESTORE ERROR] Source backup is invalid or corrupt: ${err.message}`);
    } finally {
        if (sourceDb) {
            try { sourceDb.close(); } catch (e) {}
        }
    }

    // Phase 2: Check target database write-contention & checkpoint WAL
    let targetExists = fs.existsSync(targetDbPath);
    let preRestoreBackupPath = null;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const randomSuffix = crypto.randomBytes(4).toString('hex');

    if (targetExists) {
        let targetCheckDb = null;
        try {
            targetCheckDb = new DatabaseSync(targetDbPath);
            targetCheckDb.exec('PRAGMA busy_timeout = 1500;');
            const checkpointResult = targetCheckDb.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
            if (checkpointResult && checkpointResult.busy === 1) {
                throw new Error('Target database is actively in use by another process (WAL checkpoint returned busy).');
            }
        } finally {
            if (targetCheckDb) {
                try { targetCheckDb.close(); } catch (e) {}
            }
        }

        // Phase 3: Create and verify pre-restore backup of the current target database
        preRestoreBackupPath = path.join(
            backupDir,
            `pre_restore_${path.basename(targetDbPath, '.db')}_${timestamp}_${randomSuffix}.bak`
        );
        fs.copyFileSync(targetDbPath, preRestoreBackupPath);

        // Verify pre-restore backup integrity
        let preRestoreCheckDb = null;
        try {
            preRestoreCheckDb = new DatabaseSync(preRestoreBackupPath);
            const preCheck = preRestoreCheckDb.prepare('PRAGMA integrity_check;').get();
            if (!preCheck || preCheck.integrity_check !== 'ok') {
                throw new Error(`Failed to create verified pre-restore safety backup: ${JSON.stringify(preCheck)}`);
            }
        } finally {
            if (preRestoreCheckDb) {
                try { preRestoreCheckDb.close(); } catch (e) {}
            }
        }
    }

    // Phase 4: Stage restored file in same filesystem directory
    const stagingPath = path.join(targetDir, `restore_staging_${Date.now()}_${randomSuffix}.tmp`);
    fs.copyFileSync(backupPath, stagingPath);

    // Phase 5: Verify Staging Database
    let stagingDb = null;
    try {
        stagingDb = new DatabaseSync(stagingPath);
        const stagingIntegrity = stagingDb.prepare('PRAGMA integrity_check;').get();
        if (!stagingIntegrity || stagingIntegrity.integrity_check !== 'ok') {
            throw new Error(`Staged restore file failed integrity check: ${JSON.stringify(stagingIntegrity)}`);
        }
        const stagingFk = stagingDb.prepare('PRAGMA foreign_key_check;').all();
        if (stagingFk && stagingFk.length > 0) {
            throw new Error(`Staged restore file contains ${stagingFk.length} foreign key violations.`);
        }
    } finally {
        if (stagingDb) {
            try { stagingDb.close(); } catch (e) {}
        }
    }

    // Phase 6: Safe Replacement with Automated Rollback
    // On Windows, renameSync will fail if destination exists or is locked.
    // We isolate sidecars and use a swap-target approach to preserve recoverability.
    const swapTargetBackupPath = path.join(targetDir, `target_swap_${Date.now()}_${randomSuffix}.tmp`);
    const targetWalPath = `${targetDbPath}-wal`;
    const targetShmPath = `${targetDbPath}-shm`;
    let walArchived = null;
    let shmArchived = null;

    try {
        // Archive existing WAL/SHM sidecars to prevent WAL salt replay corruption
        if (fs.existsSync(targetWalPath)) {
            walArchived = `${targetWalPath}.archived_${timestamp}_${randomSuffix}`;
            fs.renameSync(targetWalPath, walArchived);
        }
        if (fs.existsSync(targetShmPath)) {
            shmArchived = `${targetShmPath}.archived_${timestamp}_${randomSuffix}`;
            fs.renameSync(targetShmPath, shmArchived);
        }

        if (targetExists) {
            // Move target to temporary swap
            fs.renameSync(targetDbPath, swapTargetBackupPath);
        }

        // Promote staged file
        fs.renameSync(stagingPath, targetDbPath);

        // Success: Clean up temporary swap file
        if (fs.existsSync(swapTargetBackupPath)) {
            try { fs.unlinkSync(swapTargetBackupPath); } catch (e) {}
        }

    } catch (swapErr) {
        // Rollback swap: Restore original files
        if (fs.existsSync(swapTargetBackupPath) && !fs.existsSync(targetDbPath)) {
            try { fs.renameSync(swapTargetBackupPath, targetDbPath); } catch (e) {}
        }
        if (walArchived && fs.existsSync(walArchived) && !fs.existsSync(targetWalPath)) {
            try { fs.renameSync(walArchived, targetWalPath); } catch (e) {}
        }
        if (shmArchived && fs.existsSync(shmArchived) && !fs.existsSync(targetShmPath)) {
            try { fs.renameSync(shmArchived, targetShmPath); } catch (e) {}
        }
        if (fs.existsSync(stagingPath)) {
            try { fs.unlinkSync(stagingPath); } catch (e) {}
        }
        throw new Error(`[RESTORE REPLACEMENT FAILED] ${swapErr.message}. Original database preserved.`);
    }

    // Phase 7: Post-Restoration Deep Verification
    let finalDb = null;
    try {
        finalDb = new DatabaseSync(targetDbPath);
        const postIntegrity = finalDb.prepare('PRAGMA integrity_check;').get();
        if (!postIntegrity || postIntegrity.integrity_check !== 'ok') {
            throw new Error(`Restored database failed final integrity check: ${JSON.stringify(postIntegrity)}`);
        }
        const postFk = finalDb.prepare('PRAGMA foreign_key_check;').all();
        if (postFk && postFk.length > 0) {
            throw new Error(`Restored database has ${postFk.length} foreign key violations.`);
        }
    } finally {
        if (finalDb) {
            try { finalDb.close(); } catch (e) {}
        }
    }

    return {
        restored: true,
        from: backupPath,
        to: targetDbPath,
        preRestoreBackupPath,
        timestamp
    };
}

module.exports = {
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
};
