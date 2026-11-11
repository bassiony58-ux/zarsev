/**
 * src/db/pgMigrator.js
 * 
 * PostgreSQL Migration Framework for ZARSEV.
 * 
 * Enforces:
 * - Session-level advisory lock using decimal string '6503569854498753863' ($1::bigint)
 * - Standalone dedicated Client authenticated as zarsev_migrator (never pooled)
 * - Migration tracking via _pg_migrations and _pg_migration_failures
 * - Checksum verification preventing altered migration tampering
 * - Atomic transactional migrations with support for -- no-transaction directive
 * - Automatic rollback and sanitized failure recording on error
 * - Zero SUPERUSER privileges required (runs strictly under zarsev_migrator least privilege)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMigratorClient } = require('./pgAdapter');

const MIGRATION_LOCK_ID = '6503569854498753863'; // BigInt('0x5A41525345564D47').toString()
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations', 'pg');

function computeSha256(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex').toUpperCase();
}

function sanitizeSqlError(msg) {
    if (!msg) return 'Unknown migration error';
    return msg
        .replace(/:[^:@/\s]+@/g, ':***@')
        .replace(/(PASSWORD\s*['"])([^'"]+)(['"])/gi, '$1***$3')
        .replace(/password\s*:\s*['"][^'"]+['"]/gi, 'password: "***"');
}

/**
 * Ensures migration metadata tracking tables exist in schema public
 * and enforces strict metadata protection:
 * - zarsev_migrator retains full management ownership (ALL PRIVILEGES)
 * - zarsev_app has SELECT-only permission (read-only for health/version checks)
 * - zarsev_app is strictly revoked of INSERT, UPDATE, DELETE, TRUNCATE
 * - PUBLIC has zero access
 */
async function ensureMetadataTables(client) {
    const rawAppUser = (process.env.PG_APP_USER || 'zarsev_app').trim();
    if (!/^[a-zA-Z0-9_]+$/.test(rawAppUser)) {
        throw new Error(`Invalid PG_APP_USER identifier: '${rawAppUser}'`);
    }
    const appUser = `"${rawAppUser}"`;

    await client.query(`
        CREATE TABLE IF NOT EXISTS _pg_migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            checksum VARCHAR(64) NOT NULL,
            execution_time_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS _pg_migration_failures (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            error_code VARCHAR(32),
            error_message TEXT,
            sanitized_sql TEXT
        );

        -- Strict metadata table permission hardening:
        -- Strip write permissions granted by schema default privileges
        REVOKE ALL ON _pg_migrations, _pg_migration_failures FROM PUBLIC;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON _pg_migrations, _pg_migration_failures FROM ${appUser};
        GRANT SELECT ON _pg_migrations, _pg_migration_failures TO ${appUser};

        -- Restrict metadata sequences
        REVOKE ALL ON SEQUENCE _pg_migrations_id_seq, _pg_migration_failures_id_seq FROM PUBLIC;
        REVOKE UPDATE, USAGE ON SEQUENCE _pg_migrations_id_seq, _pg_migration_failures_id_seq FROM ${appUser};
        GRANT SELECT ON SEQUENCE _pg_migrations_id_seq, _pg_migration_failures_id_seq TO ${appUser};
    `);
}

/**
 * Discovers and parses migration SQL files from the designated directory
 */
function discoverMigrationFiles(migrationsDir) {
    const dir = migrationsDir || DEFAULT_MIGRATIONS_DIR;
    if (!fs.existsSync(dir)) {
        return [];
    }

    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .sort((a, b) => {
            if (a.includes('006A_provisioning') && b.includes('006A_finalize')) return -1;
            if (a.includes('006A_finalize') && b.includes('006A_provisioning')) return 1;
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });

    return files.map(file => {
        const fullPath = path.join(dir, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const checksum = computeSha256(content);
        const isNoTransaction = content.split(/\r?\n/).slice(0, 5).some(line => line.trim().toLowerCase() === '-- no-transaction');

        return {
            name: file,
            fullPath,
            content,
            checksum,
            isNoTransaction
        };
    });
}

/**
 * Returns current status of migrations: applied vs pending
 */
async function getMigrationStatus(dbName, migrationsDir) {
    const client = getMigratorClient(dbName);
    await client.connect();

    try {
        await ensureMetadataTables(client);

        const appliedRes = await client.query('SELECT name, applied_at, checksum, execution_time_ms FROM _pg_migrations ORDER BY id ASC;');
        const appliedMap = new Map(appliedRes.rows.map(r => [r.name, r]));

        const discovered = discoverMigrationFiles(migrationsDir);
        const pending = [];
        const applied = [];

        for (const file of discovered) {
            if (appliedMap.has(file.name)) {
                applied.push({
                    ...appliedMap.get(file.name),
                    fileChecksum: file.checksum,
                    checksumMatch: appliedMap.get(file.name).checksum === file.checksum
                });
            } else {
                pending.push(file);
            }
        }

        return { applied, pending, totalDiscovered: discovered.length };
    } finally {
        await client.end().catch(() => {});
    }
}

/**
 * Runs all pending migrations sequentially with advisory lock protection
 * 
 * @param {string} [dbName] - Target database name
 * @param {string} [migrationsDir] - Directory holding migration SQL files
 * @returns {Promise<{ appliedCount: number, applied: Array<string> }>}
 */
async function runMigrations(dbName, migrationsDir) {
    const client = getMigratorClient(dbName);
    await client.connect();

    let lockAcquired = false;

    try {
        // 1. Acquire session-level advisory lock
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [MIGRATION_LOCK_ID]);
        if (!lockRes.rows[0].locked) {
            const err = new Error(`MIGRATION_LOCKED: Could not acquire migration advisory lock '${MIGRATION_LOCK_ID}'. Another migration process is active.`);
            err.code = 'MIGRATION_LOCKED';
            throw err;
        }
        lockAcquired = true;

        // 2. Ensure tracking tables exist
        await ensureMetadataTables(client);

        // 3. Retrieve applied migrations
        const appliedRes = await client.query('SELECT name, checksum FROM _pg_migrations ORDER BY id ASC;');
        const appliedMap = new Map(appliedRes.rows.map(r => [r.name, r.checksum]));

        // 4. Discover migration files
        const discovered = discoverMigrationFiles(migrationsDir);

        // 5. Verify checksums of already applied migrations (Anti-tampering check)
        for (const file of discovered) {
            if (appliedMap.has(file.name)) {
                const storedChecksum = appliedMap.get(file.name);
                if (storedChecksum !== file.checksum) {
                    const checksumErr = new Error(`CHECKSUM_MISMATCH: Applied migration '${file.name}' has been modified on disk! Stored: ${storedChecksum}, Disk: ${file.checksum}`);
                    checksumErr.code = 'CHECKSUM_MISMATCH';
                    throw checksumErr;
                }
            }
        }

        // 6. Filter pending migrations
        const pending = discovered.filter(f => !appliedMap.has(f.name));
        const appliedResults = [];

        // 7. Execute pending migrations sequentially
        for (const migration of pending) {
            const startTime = Date.now();

            if (migration.isNoTransaction) {
                // Non-transactional DDL (e.g. CREATE INDEX CONCURRENTLY, VACUUM)
                try {
                    await client.query(migration.content);
                    const duration = Date.now() - startTime;
                    await client.query(
                        'INSERT INTO _pg_migrations (name, checksum, execution_time_ms) VALUES ($1, $2, $3);',
                        [migration.name, migration.checksum, duration]
                    );
                    appliedResults.push(migration.name);
                } catch (err) {
                    await recordFailure(client, migration.name, err, migration.content);
                    throw err;
                }
            } else {
                // Default atomic transactional migration
                try {
                    await client.query('BEGIN;');
                    await client.query(migration.content);
                    const duration = Date.now() - startTime;
                    await client.query(
                        'INSERT INTO _pg_migrations (name, checksum, execution_time_ms) VALUES ($1, $2, $3);',
                        [migration.name, migration.checksum, duration]
                    );
                    await client.query('COMMIT;');
                    appliedResults.push(migration.name);
                } catch (err) {
                    try {
                        await client.query('ROLLBACK;');
                    } catch (_) {}
                    await recordFailure(client, migration.name, err, migration.content);
                    throw err;
                }
            }
        }

        return {
            appliedCount: appliedResults.length,
            applied: appliedResults
        };

    } finally {
        if (lockAcquired) {
            try {
                await client.query('SELECT pg_advisory_unlock($1::bigint);', [MIGRATION_LOCK_ID]);
            } catch (_) {}
        }
        await client.end().catch(() => {});
    }
}

/**
 * Records migration failure in _pg_migration_failures with sanitized data
 */
async function recordFailure(client, migrationName, err, rawSql) {
    try {
        const sanitizedErr = sanitizeSqlError(err.message || String(err));
        const sanitizedSnippet = sanitizeSqlError((rawSql || '').substring(0, 500));
        await client.query(
            'INSERT INTO _pg_migration_failures (name, error_code, error_message, sanitized_sql) VALUES ($1, $2, $3, $4);',
            [migrationName, err.code || 'UNKNOWN', sanitizedErr, sanitizedSnippet]
        );
    } catch (_) {
        // Silently prevent failure recording from masking the primary error
    }
}

module.exports = {
    MIGRATION_LOCK_ID,
    DEFAULT_MIGRATIONS_DIR,
    runMigrations,
    getMigrationStatus,
    discoverMigrationFiles,
    computeSha256
};
