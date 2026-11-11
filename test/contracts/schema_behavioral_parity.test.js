/**
 * test/contracts/schema_behavioral_parity.test.js
 * 
 * ZARSEV Stage 1 Behavioral Parity & Schema Hardening Contract Test Suite.
 * 
 * Remediated & Hardened Implementation:
 * 1. Strict RUN_ID governance and isolated ephemeral PostgreSQL database binding (never targets zarsev_test).
 * 2. Preflight verification of canonical directory, DBA CreationLedger, and database comment manifest.
 * 3. Pre-rollback audit of all 7 Stage 1 columns and 5 Stage 1 tables (fails closed on non-default/active data).
 * 4. Preservation of baseline row counts (users, products, imports, import_items) across migration rollbacks.
 * 5. Full Canary lifecycle with pg_class OID/owner verification, transactional DROP, and post-drop catalog checks.
 * 6. Conditional forensic retention: Canary table and external registry preserved on any non-PASS outcome.
 * 7. Verified SQLite physical snapshot cloning (SHA-256 validation) and disciplined handle/WAL/SHM lifecycle.
 * 8. Comprehensive connection tracking across standalone clients, internal migrators, and pg pools.
 * 9. Non-swallowing cleanup error propagation ensuring PASS cannot be claimed on partial cleanup failure.
 * 10. Self-contained execution guarantees cleanup whether run as a script or imported as a module.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

const dbClient = require('../../src/db/dbClient');
const pgAdapter = require('../../src/db/pgAdapter');
const pgMigrator = require('../../src/db/pgMigrator');
const { runMigrations, closeDb } = require('../../src/db/database');

const RUN_ID_REGEX = /^run_[0-9]{8}_[0-9]{6}_[a-z0-9]{6}$/;
const EXPECTED_SNAPSHOT_SHA256 = 'FB3EFBF27362C65F36BDF47F4F88D3544C8D01D004D64C7E25A45A7F13A1F175';

function computeSha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}

function generateRunId() {
    const now = new Date();
    const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '');
    const rand = crypto.randomBytes(3).toString('hex');
    return `run_${yyyymmdd}_${hhmmss}_${rand}`;
}

async function runStage1ParityTests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Stage 1: Schema Hardening & Behavioral Parity Test Suite');
    console.log('================================================================\n');

    process.env.NODE_ENV = 'test';

    const activePgClients = new Set();
    const cleanupErrors = [];
    let outcome = 'INCONCLUSIVE';
    let outcomeReason = 'Test suite execution initialized but did not complete';

    let canonicalTempDir = null;
    let RUN_ID = null;
    let TARGET_TEST_DB = null;
    let ledger = null;
    let ephemeralDbOid = null;
    let expectedOwner = null;

    let canaryUuid = null;
    let CANARY_TABLE_NAME = null;
    let CANARY_REGISTRY_PATH = null;
    let canaryTableOid = null;
    let canaryTableOwner = null;

    let isolatedSqliteDbPath = null;
    let migratorClient = null;

    try {
        // =================================================================
        // PHASE 0: Preflight, RUN_ID, Directory & CreationLedger Verification
        // =================================================================
        console.log('--- Phase 0: Preflight Security & CreationLedger Verification ---');

        // 0.1 Canonical Directory Inspection (Must pre-exist, never auto-create)
        const testTempDir = path.resolve(__dirname, '../temp');
        if (!fs.existsSync(testTempDir)) {
            outcome = 'HALTED';
            outcomeReason = `[PREFLIGHT ERROR] test/temp directory does not exist at ${testTempDir}. Automated creation is prohibited.`;
            return { outcome, reason: outcomeReason };
        }

        canonicalTempDir = fs.realpathSync.native(testTempDir);
        const tempStat = fs.lstatSync(testTempDir);
        if (tempStat.isSymbolicLink()) {
            outcome = 'HALTED';
            outcomeReason = `[PREFLIGHT ERROR] test/temp is a symbolic link or junction, violating path security.`;
            return { outcome, reason: outcomeReason };
        }

        // 0.2 RUN_ID Verification & Generation
        const rawRunId = process.env.STAGE1_RUN_ID;
        if (rawRunId) {
            if (!RUN_ID_REGEX.test(rawRunId)) {
                outcome = 'HALTED';
                outcomeReason = `[PREFLIGHT ERROR] STAGE1_RUN_ID '${rawRunId}' does not match required format ^run_[0-9]{8}_[0-9]{6}_[a-z0-9]{6}$`;
                return { outcome, reason: outcomeReason };
            }
            RUN_ID = rawRunId;
        } else {
            RUN_ID = generateRunId();
        }
        console.log(`✓ Phase 0.1: RUN_ID established: ${RUN_ID}`);

        // 0.3 Target Ephemeral Database Identification & Boundary Protection
        const EXPECTED_TARGET_DB = `zarsev_test_stage1_parity_${RUN_ID}`;
        if (process.env.STAGE1_TARGET_DB !== undefined) {
            if (process.env.STAGE1_TARGET_DB !== EXPECTED_TARGET_DB) {
                outcome = 'HALTED';
                outcomeReason = `[ISOLATION VIOLATION] STAGE1_TARGET_DB ('${process.env.STAGE1_TARGET_DB}') does not match required deterministic name '${EXPECTED_TARGET_DB}'. Overrides that diverge from RUN_ID derivation are strictly prohibited.`;
                return { outcome, reason: outcomeReason };
            }
        }
        TARGET_TEST_DB = EXPECTED_TARGET_DB;

        const PROTECTED_DATABASES = new Set(['zarsev_test', 'zarsev_dev', 'postgres', 'template0', 'template1']);
        if (PROTECTED_DATABASES.has(TARGET_TEST_DB)) {
            outcome = 'HALTED';
            outcomeReason = `[ISOLATION VIOLATION] Target database cannot be protected cluster database '${TARGET_TEST_DB}'. Ephemeral isolation is mandatory.`;
            return { outcome, reason: outcomeReason };
        }

        const targetDbByteLength = Buffer.byteLength(TARGET_TEST_DB, 'utf8');
        if (targetDbByteLength > 63) {
            outcome = 'HALTED';
            outcomeReason = `[SECURITY ERROR] TARGET_TEST_DB length (${targetDbByteLength} bytes) exceeds PostgreSQL 63-byte identifier limit.`;
            return { outcome, reason: outcomeReason };
        }

        if (!/^[a-z0-9_]+$/.test(TARGET_TEST_DB)) {
            outcome = 'HALTED';
            outcomeReason = `[SECURITY ERROR] TARGET_TEST_DB contains invalid characters: ${TARGET_TEST_DB}. Must match ^[a-z0-9_]+$`;
            return { outcome, reason: outcomeReason };
        }
        console.log(`✓ Phase 0.2: Isolated Ephemeral Database Target: ${TARGET_TEST_DB}`);

        // 0.4 CreationLedger File Verification on Disk
        const ledgerPath = path.join(canonicalTempDir, `creation_ledger_${RUN_ID}.json`);
        if (!fs.existsSync(ledgerPath)) {
            outcome = 'HALTED';
            outcomeReason = `[PREFLIGHT HALT] DBA CreationLedger file not found at ${ledgerPath}. Test database must be provisioned out-of-band by DBA.`;
            return { outcome, reason: outcomeReason };
        }

        try {
            ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        } catch (err) {
            outcome = 'HALTED';
            outcomeReason = `[PREFLIGHT HALT] CreationLedger file is corrupt or unparseable: ${err.message}`;
            return { outcome, reason: outcomeReason };
        }

        // Strict CreationLedger schema and active run parameter validation (Finding NB-01 remediation)
        const ISO_8601_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

        if (
            ledger.run_id !== RUN_ID ||
            ledger.target_db_name !== TARGET_TEST_DB ||
            typeof ledger.database_oid !== 'number' ||
            !Number.isSafeInteger(ledger.database_oid) ||
            ledger.database_oid <= 0 ||
            ledger.owner !== 'zarsev_migrator' ||
            typeof ledger.structural_checksum !== 'string' ||
            !HEX_64_REGEX.test(ledger.structural_checksum) ||
            typeof ledger.created_at !== 'string' ||
            !ISO_8601_UTC_REGEX.test(ledger.created_at) ||
            isNaN(Date.parse(ledger.created_at)) ||
            new Date(Date.parse(ledger.created_at)).toISOString() !== ledger.created_at
        ) {
            outcome = 'HALTED';
            outcomeReason = `[PREFLIGHT HALT] CreationLedger metadata mismatch with active run parameters.`;
            return { outcome, reason: outcomeReason };
        }
        ephemeralDbOid = ledger.database_oid;
        expectedOwner = ledger.owner;
        console.log(`✓ Phase 0.3: CreationLedger validated on disk (DB OID: ${ephemeralDbOid}, Owner: ${expectedOwner}).`);

        // 0.5 PostgreSQL Catalog & Database Manifest Direct Preflight Verification (Option D)
        let preflightClient = null;
        try {
            preflightClient = pgAdapter.getMigratorClient(TARGET_TEST_DB);
            activePgClients.add(preflightClient);

            try {
                await preflightClient.connect();
            } catch (connErr) {
                if (connErr.code === '3D000') {
                    outcome = 'HALTED';
                    outcomeReason = `[PREFLIGHT HALT] Target database '${TARGET_TEST_DB}' does not exist on PostgreSQL cluster (SQLSTATE 3D000). Out-of-band DBA provisioning required.`;
                    return { outcome, reason: outcomeReason };
                }
                if (connErr.code === '42501') {
                    outcome = 'HALTED';
                    outcomeReason = `[SECURITY ERROR] Permission denied connecting to target database '${TARGET_TEST_DB}' as migrator role (SQLSTATE 42501).`;
                    return { outcome, reason: outcomeReason };
                }
                outcome = 'FAILED';
                outcomeReason = `[PREFLIGHT ERROR] Failed to connect to target database '${TARGET_TEST_DB}': ${connErr.message}`;
                return { outcome, reason: outcomeReason };
            }

            const selfDbRes = await preflightClient.query('SELECT current_database() AS db;');
            if (selfDbRes.rows[0].db !== TARGET_TEST_DB) {
                outcome = 'HALTED';
                outcomeReason = `[ISOLATION ERROR] Preflight client connected to unexpected database: ${selfDbRes.rows[0].db}, expected: ${TARGET_TEST_DB}`;
                return { outcome, reason: outcomeReason };
            }

            let dbCatalogRes;
            try {
                dbCatalogRes = await preflightClient.query(`
                    SELECT d.oid, pg_get_userbyid(d.datdba) AS owner_name, shobj_description(d.oid, 'pg_database') AS db_manifest
                    FROM pg_database d WHERE d.datname = current_database();
                `);
            } catch (catErr) {
                if (catErr.code === '42501') {
                    outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                    outcomeReason = `[SECURITY ERROR] Permission denied reading pg_database or shobj_description (SQLSTATE 42501): ${catErr.message}`;
                    return { outcome, reason: outcomeReason };
                }
                throw catErr;
            }

            if (dbCatalogRes.rows.length === 0) {
                outcome = 'HALTED';
                outcomeReason = `[PREFLIGHT HALT] Target database '${TARGET_TEST_DB}' not found in pg_database catalog.`;
                return { outcome, reason: outcomeReason };
            }

            const catRow = dbCatalogRes.rows[0];
            if (Number(catRow.oid) !== ephemeralDbOid) {
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `[SECURITY AUDIT] Catalog OID (${catRow.oid}) does not match CreationLedger OID (${ephemeralDbOid}).`;
                return { outcome, reason: outcomeReason };
            }
            if (catRow.owner_name !== expectedOwner) {
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `[SECURITY AUDIT] Catalog owner (${catRow.owner_name}) does not match CreationLedger owner (${expectedOwner}).`;
                return { outcome, reason: outcomeReason };
            }

            if (!catRow.db_manifest) {
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `[SECURITY AUDIT] Database manifest description missing in pg_database catalog (shobj_description).`;
                return { outcome, reason: outcomeReason };
            }

            let catalogManifest;
            try {
                catalogManifest = JSON.parse(catRow.db_manifest);
            } catch (err) {
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `[SECURITY AUDIT] Database catalog manifest is corrupt JSON: ${err.message}`;
                return { outcome, reason: outcomeReason };
            }

            if (catalogManifest.run_id !== RUN_ID || Number(catalogManifest.database_oid) !== ephemeralDbOid || catalogManifest.target_db_name !== TARGET_TEST_DB || catalogManifest.owner !== expectedOwner) {
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `[SECURITY AUDIT] Database manifest fields do not match ledger parameters.`;
                return { outcome, reason: outcomeReason };
            }

            // Consistency Digest Checksum Verification
            const rawFingerprint = `${RUN_ID}:${TARGET_TEST_DB}:${catRow.oid}:${catRow.owner_name}:${ledger.created_at}`;
            const recalculatedChecksum = crypto.createHash('sha256').update(rawFingerprint, 'utf8').digest('hex').toUpperCase();

            if (ledger.structural_checksum !== recalculatedChecksum || catalogManifest.structural_checksum !== recalculatedChecksum) {
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `[SECURITY AUDIT] Deterministic consistency checksum mismatch across ledger and catalog manifest.`;
                return { outcome, reason: outcomeReason };
            }
            console.log('✓ Phase 0.4: Database identity, catalog manifest, and structural checksum verified directly via ephemeral target.');

        } finally {
            if (preflightClient) {
                try {
                    await preflightClient.end();
                    activePgClients.delete(preflightClient);
                } catch (e) {
                    cleanupErrors.push(`Failed to end preflightClient: ${e.message}`);
                }
            }
        }

        // =================================================================
        // PART 1: SQLite Schema Governance & Versioned Migration Tests
        // =================================================================
        console.log('\n--- 1. Testing SQLite Schema Governance & Versioned Migrations ---');

        // Test 1.1: Fresh In-Memory DB from schema.sql
        const freshDb = new DatabaseSync(':memory:');
        freshDb.exec('PRAGMA foreign_keys = ON;');
        const freshSchemaSql = fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8');
        freshDb.exec(freshSchemaSql);

        const freshTables = freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").all().map(r => r.name);
        assert(freshTables.includes('import_batches'), 'Fresh SQLite DB must contain import_batches');
        assert(freshTables.includes('batch_source_files'), 'Fresh SQLite DB must contain batch_source_files');
        assert(freshTables.includes('import_idempotency_keys'), 'Fresh SQLite DB must contain import_idempotency_keys');
        assert(freshTables.includes('import_attempts'), 'Fresh SQLite DB must contain import_attempts');
        assert(freshTables.includes('import_item_revisions'), 'Fresh SQLite DB must contain import_item_revisions');
        console.log('✓ Test 1.1: Fresh SQLite database initializes all Stage 1 tables.');

        // Test 1.2: Existing Database Programmatic Migration via database.js
        const existingDb = new DatabaseSync(':memory:');
        existingDb.exec('PRAGMA foreign_keys = ON;');
        const initialSql = fs.readFileSync(path.join(__dirname, '../../.backups/pre_stage1_20261103/schema.sql.bak'), 'utf8');
        existingDb.exec(initialSql);

        runMigrations(existingDb);

        const migratedTables = existingDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").all().map(r => r.name);
        assert(migratedTables.includes('schema_migrations'), 'SQLite must have schema_migrations table');
        assert(migratedTables.includes('import_batches'), 'Migrated SQLite DB must contain import_batches');
        assert(migratedTables.includes('import_attempts'), 'Migrated SQLite DB must contain import_attempts');

        const importColumns = existingDb.prepare("PRAGMA table_info(imports);").all().map(c => c.name);
        assert(importColumns.includes('active_fencing_token'), 'imports table must have active_fencing_token');
        assert(importColumns.includes('legal_hold'), 'imports table must have legal_hold');
        assert(importColumns.includes('batch_id'), 'imports table must have batch_id');

        const itemColumns = existingDb.prepare("PRAGMA table_info(import_items);").all().map(c => c.name);
        assert(itemColumns.includes('lock_version'), 'import_items table must have lock_version');
        assert(itemColumns.includes('has_conflict'), 'import_items table must have has_conflict');
        assert(itemColumns.includes('suggested_updates'), 'import_items table must have suggested_updates');
        assert(itemColumns.includes('modified_fields'), 'import_items table must have modified_fields');
        console.log('✓ Test 1.2: Existing SQLite database successfully upgraded to Stage 1 schema.');

        // Test 1.3: SQLite Migration Idempotency
        const migrationRecordBefore = existingDb.prepare("SELECT version, checksum FROM schema_migrations WHERE version = '002';").get();
        assert(migrationRecordBefore, 'Migration 002 must be recorded in schema_migrations');
        runMigrations(existingDb);
        const migrationRecordAfter = existingDb.prepare("SELECT version, checksum FROM schema_migrations WHERE version = '002';").get();
        assert.strictEqual(migrationRecordBefore.checksum, migrationRecordAfter.checksum, 'Idempotent migration must not alter checksum');
        console.log('✓ Test 1.3: SQLite migration is strictly idempotent (No-op on re-run).');

        // Test 1.4: SQLite Tamper Detection (Checksum Mismatch Abort)
        existingDb.exec("UPDATE schema_migrations SET checksum = 'TAMPERED_CHECKSUM_VALUE' WHERE version = '002';");
        assert.throws(() => {
            runMigrations(existingDb);
        }, /CRITICAL_MIGRATION_ERROR: Checksum mismatch for migration 002/, 'Must throw fatal error on checksum mismatch');
        console.log('✓ Test 1.4: SQLite detects checksum tampering and halts execution safely.');

        freshDb.close();
        existingDb.close();

        // =================================================================
        // PART 2: PostgreSQL Dual-Canary Isolation & Migration Lifecycle
        // =================================================================
        console.log('\n--- 2. Testing PostgreSQL Migration 002 & Non-Destructive Rollback ---');

        migratorClient = pgAdapter.getMigratorClient(TARGET_TEST_DB);
        activePgClients.add(migratorClient);
        await migratorClient.connect();

        // 2.1 Verify Client Connection Target Identity
        const connIdentityRes = await migratorClient.query('SELECT current_database() AS db, d.oid FROM pg_database d WHERE d.datname = current_database();');
        if (connIdentityRes.rows[0].db !== TARGET_TEST_DB || Number(connIdentityRes.rows[0].oid) !== ephemeralDbOid) {
            outcome = 'HALTED';
            outcomeReason = `[ISOLATION VIOLATION] Migrator client connected to ${connIdentityRes.rows[0].db} (OID: ${connIdentityRes.rows[0].oid}), expected ${TARGET_TEST_DB} (OID: ${ephemeralDbOid})`;
            return { outcome, reason: outcomeReason };
        }

        // 2.2 Setup Dual-Canary Table & External Registry
        canaryUuid = crypto.randomUUID();
        CANARY_TABLE_NAME = `zarsev_canary_${RUN_ID}`;
        CANARY_REGISTRY_PATH = path.join(canonicalTempDir, `canary_registry_${RUN_ID}.json`);

        await migratorClient.query('BEGIN;');
        await migratorClient.query(`
            CREATE TABLE "${CANARY_TABLE_NAME}" (
                marker_uuid VARCHAR(64) PRIMARY KEY,
                database_name VARCHAR(128) NOT NULL,
                run_id VARCHAR(64) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await migratorClient.query(`
            INSERT INTO "${CANARY_TABLE_NAME}" (marker_uuid, database_name, run_id)
            VALUES ($1, $2, $3);
        `, [canaryUuid, TARGET_TEST_DB, RUN_ID]);
        await migratorClient.query('COMMIT;');

        const canaryClassRes = await migratorClient.query(`
            SELECT c.oid AS table_oid, pg_get_userbyid(c.relowner) AS table_owner
            FROM pg_class c
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = 'public' AND c.relname = $1;
        `, [CANARY_TABLE_NAME]);

        if (canaryClassRes.rows.length === 0) {
            throw new Error(`Canary table ${CANARY_TABLE_NAME} could not be resolved in catalog`);
        }
        canaryTableOid = Number(canaryClassRes.rows[0].table_oid);
        canaryTableOwner = canaryClassRes.rows[0].table_owner;

        const registryData = {
            canary_uuid: canaryUuid,
            table_name: CANARY_TABLE_NAME,
            table_oid: canaryTableOid,
            table_owner: canaryTableOwner,
            database_name: TARGET_TEST_DB,
            database_oid: ephemeralDbOid,
            run_id: RUN_ID,
            created_at: new Date().toISOString(),
            pid: process.pid,
            status: 'ACTIVE'
        };
        fs.writeFileSync(CANARY_REGISTRY_PATH, JSON.stringify(registryData, null, 2), { mode: 0o600 });
        console.log(`✓ Test 2.0: Dual-Canary setup complete (Table: ${CANARY_TABLE_NAME}, OID: ${canaryTableOid}).`);

        // 2.3 Apply PostgreSQL Migrations 001 and 002
        const migDir = path.join(__dirname, '../../src/db/migrations/pg');
        await pgMigrator.runMigrations(TARGET_TEST_DB, migDir);

        const catalog002Res = await migratorClient.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public';
        `);
        const tables002 = new Set(catalog002Res.rows.map(r => r.table_name));
        assert(tables002.has('import_idempotency_keys'), 'Postgres must contain import_idempotency_keys');
        assert(tables002.has('import_batches'), 'Postgres must contain import_batches');
        assert(tables002.has('batch_source_files'), 'Postgres must contain batch_source_files');
        assert(tables002.has('import_attempts'), 'Postgres must contain import_attempts');
        assert(tables002.has('import_item_revisions'), 'Postgres must contain import_item_revisions');
        console.log('✓ Test 2.1: PostgreSQL Migration 002 applied and verified via catalog.');

        // 2.4 Pre-Rollback Data Audit (Seven Columns + Five Tables + Baseline Row Counts)
        console.log('  >> Performing Comprehensive Pre-Rollback Data Audit <<');

        // Audit the 5 newly added Stage 1 tables
        const stage1TablesAudit = await migratorClient.query(`
            SELECT 
                (SELECT COUNT(*) FROM import_idempotency_keys) AS cnt_keys,
                (SELECT COUNT(*) FROM import_batches) AS cnt_batches,
                (SELECT COUNT(*) FROM batch_source_files) AS cnt_files,
                (SELECT COUNT(*) FROM import_attempts) AS cnt_attempts,
                (SELECT COUNT(*) FROM import_item_revisions) AS cnt_revs;
        `);
        const s1Row = stage1TablesAudit.rows[0];
        const dirtyStage1Count = Number(s1Row.cnt_keys) + Number(s1Row.cnt_batches) + Number(s1Row.cnt_files) + Number(s1Row.cnt_attempts) + Number(s1Row.cnt_revs);
        if (dirtyStage1Count !== 0) {
            outcome = 'HALTED';
            outcomeReason = `[PRE-ROLLBACK AUDIT HALT] Stage 1 tables contain active data (${dirtyStage1Count} rows). Destructive rollback halted.`;
            return { outcome, reason: outcomeReason };
        }

        // Audit the 7 dropped columns on pre-existing tables for non-default or active data
        const importsColAudit = await migratorClient.query(`
            SELECT
                COUNT(*) FILTER (WHERE active_fencing_token IS NOT NULL) AS cnt_fencing,
                COUNT(*) FILTER (WHERE legal_hold IS NOT FALSE) AS cnt_legal_hold,
                COUNT(*) FILTER (WHERE batch_id IS NOT NULL) AS cnt_batch_id
            FROM imports;
        `);
        const impAudit = importsColAudit.rows[0];
        const dirtyImportsCols = Number(impAudit.cnt_fencing) + Number(impAudit.cnt_legal_hold) + Number(impAudit.cnt_batch_id);
        if (dirtyImportsCols !== 0) {
            outcome = 'HALTED';
            outcomeReason = `[PRE-ROLLBACK AUDIT HALT] imports table contains active non-default data in Stage 1 columns. Destructive rollback halted.`;
            return { outcome, reason: outcomeReason };
        }

        const itemsColAudit = await migratorClient.query(`
            SELECT
                COUNT(*) FILTER (WHERE lock_version != 1) AS cnt_lock_version,
                COUNT(*) FILTER (WHERE has_conflict IS NOT FALSE) AS cnt_conflict,
                COUNT(*) FILTER (WHERE suggested_updates IS NOT NULL) AS cnt_suggested,
                COUNT(*) FILTER (WHERE modified_fields IS NOT NULL) AS cnt_modified
            FROM import_items;
        `);
        const itemAudit = itemsColAudit.rows[0];
        const dirtyItemsCols = Number(itemAudit.cnt_lock_version) + Number(itemAudit.cnt_conflict) + Number(itemAudit.cnt_suggested) + Number(itemAudit.cnt_modified);
        if (dirtyItemsCols !== 0) {
            outcome = 'HALTED';
            outcomeReason = `[PRE-ROLLBACK AUDIT HALT] import_items table contains active non-default data in Stage 1 columns. Destructive rollback halted.`;
            return { outcome, reason: outcomeReason };
        }

        // Capture baseline row counts for pre-existing tables
        const baselineCountsRes = await migratorClient.query(`
            SELECT
                (SELECT COUNT(*) FROM users) AS cnt_users,
                (SELECT COUNT(*) FROM products) AS cnt_products,
                (SELECT COUNT(*) FROM imports) AS cnt_imports,
                (SELECT COUNT(*) FROM import_items) AS cnt_items;
        `);
        const baselineUsers = Number(baselineCountsRes.rows[0].cnt_users);
        const baselineProducts = Number(baselineCountsRes.rows[0].cnt_products);
        const baselineImports = Number(baselineCountsRes.rows[0].cnt_imports);
        const baselineItems = Number(baselineCountsRes.rows[0].cnt_items);
        console.log(`  ✓ Pre-rollback data audit passed: 0 dirty rows. Baseline: users=${baselineUsers}, products=${baselineProducts}, imports=${baselineImports}, items=${baselineItems}`);

        // 2.5 Execute Rollback 002
        const rollbackSqlPath = path.join(migDir, 'rollback', 'rollback_002_zarsev_core_foundation.sql');
        assert(fs.existsSync(rollbackSqlPath), 'Rollback SQL file must exist');
        const rollbackSql = fs.readFileSync(rollbackSqlPath, 'utf8');

        await migratorClient.query(rollbackSql);

        // 2.6 Post-Rollback Integrity & Preservation Verification
        const postRollbackCounts = await migratorClient.query(`
            SELECT
                (SELECT COUNT(*) FROM users) AS cnt_users,
                (SELECT COUNT(*) FROM products) AS cnt_products,
                (SELECT COUNT(*) FROM imports) AS cnt_imports,
                (SELECT COUNT(*) FROM import_items) AS cnt_items;
        `);
        assert.strictEqual(Number(postRollbackCounts.rows[0].cnt_users), baselineUsers, 'users table row count must be preserved across rollback');
        assert.strictEqual(Number(postRollbackCounts.rows[0].cnt_products), baselineProducts, 'products table row count must be preserved across rollback');
        assert.strictEqual(Number(postRollbackCounts.rows[0].cnt_imports), baselineImports, 'imports table row count must be preserved across rollback');
        assert.strictEqual(Number(postRollbackCounts.rows[0].cnt_items), baselineItems, 'import_items table row count must be preserved across rollback');

        const catalogAfterRollback = await migratorClient.query(`
            SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
        `);
        const tablesAfterRollback = new Set(catalogAfterRollback.rows.map(r => r.table_name));
        assert(!tablesAfterRollback.has('import_batches'), 'import_batches must be removed after rollback');
        assert(!tablesAfterRollback.has('import_attempts'), 'import_attempts must be removed after rollback');
        assert(!tablesAfterRollback.has('import_idempotency_keys'), 'import_idempotency_keys must be removed after rollback');
        assert(!tablesAfterRollback.has('batch_source_files'), 'batch_source_files must be removed after rollback');
        assert(!tablesAfterRollback.has('import_item_revisions'), 'import_item_revisions must be removed after rollback');

        const columnsAfterRollback = await migratorClient.query(`
            SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('imports', 'import_items');
        `);
        const colsAfter = new Set(columnsAfterRollback.rows.map(r => r.column_name));
        assert(!colsAfter.has('active_fencing_token'), 'active_fencing_token must be dropped from imports');
        assert(!colsAfter.has('legal_hold'), 'legal_hold must be dropped from imports');
        assert(!colsAfter.has('batch_id'), 'batch_id must be dropped from imports');
        assert(!colsAfter.has('lock_version'), 'lock_version must be dropped from import_items');
        assert(!colsAfter.has('has_conflict'), 'has_conflict must be dropped from import_items');
        assert(!colsAfter.has('suggested_updates'), 'suggested_updates must be dropped from import_items');
        assert(!colsAfter.has('modified_fields'), 'modified_fields must be dropped from import_items');

        console.log('✓ Test 2.2: Non-destructive rollback verified with row-count preservation across all base tables.');

        // 2.7 Re-apply Migration 002 for Behavioral Parity Tests
        await pgMigrator.runMigrations(TARGET_TEST_DB, migDir);
        console.log('✓ Test 2.3: Re-applied Migration 002 cleanly.');

        // =================================================================
        // PART 3: SQLite Snapshot Isolation & Parity Invariants
        // =================================================================
        console.log('\n--- 3. Testing Dual-Engine Behavioral Parity Invariants ---');

        // 3.1 Verify Physical Snapshot Integrity
        const snapshotSourcePath = path.resolve(__dirname, '../../.backups/pre_stage1_20261103/sqlite_snapshot_stage1.db');
        if (!fs.existsSync(snapshotSourcePath)) {
            outcome = 'HALTED';
            outcomeReason = `[SNAPSHOT HALT] Physical snapshot missing at ${snapshotSourcePath}`;
            return { outcome, reason: outcomeReason };
        }

        const snapshotBytes = fs.readFileSync(snapshotSourcePath);
        const actualSnapshotSha256 = crypto.createHash('sha256').update(snapshotBytes).digest('hex').toUpperCase();
        if (actualSnapshotSha256 !== EXPECTED_SNAPSHOT_SHA256) {
            outcome = 'HALTED';
            outcomeReason = `[SNAPSHOT CHECKSUM MISMATCH] Expected ${EXPECTED_SNAPSHOT_SHA256}, got ${actualSnapshotSha256}`;
            return { outcome, reason: outcomeReason };
        }
        console.log(`✓ Phase 3.1: SQLite physical snapshot integrity verified (SHA-256: ${actualSnapshotSha256}).`);

        // 3.2 Create Isolated Working Replica in test/temp
        isolatedSqliteDbPath = path.join(canonicalTempDir, `sqlite_stage1_replica_${RUN_ID}.db`);
        fs.copyFileSync(snapshotSourcePath, isolatedSqliteDbPath);

        // 3.3 Apply SQLite Stage 1 Migrations to Isolated Replica
        const isolatedSetupDb = new DatabaseSync(isolatedSqliteDbPath);
        isolatedSetupDb.exec('PRAGMA foreign_keys = ON;');
        runMigrations(isolatedSetupDb);
        const replicaMigCheck = isolatedSetupDb.prepare("SELECT version FROM schema_migrations WHERE version = '002';").get();
        assert(replicaMigCheck, 'Replica must have migration 002 applied');
        isolatedSetupDb.close();
        console.log('✓ Phase 3.2: SQLite isolated replica created and migrated to Stage 1.');

        // 3.4 Bind Engine Environment to Replica
        process.env.DB_PATH = isolatedSqliteDbPath;

        const engines = ['sqlite', 'postgres'];

        for (const engine of engines) {
            console.log(`\n  >> Running Parity Invariants on [${engine.toUpperCase()}] <<`);
            const dbOpts = engine === 'postgres' ? { engine: 'postgres', dbNameOverride: TARGET_TEST_DB } : { engine: 'sqlite' };

            // Test 3.1: Data Types & Explicit NULL preservation in JSON
            const testUserId = `usr_${engine}_${crypto.randomBytes(4).toString('hex')}`;
            await dbClient.execute(`
                INSERT INTO users (id, name, email, role)
                VALUES (?, ?, ?, 'LOGISTICS_OFFICER');
            `, [testUserId, `Test User ${engine}`, `${testUserId}@example.com`], dbOpts);

            const testBatchId = `batch_${engine}_${crypto.randomBytes(4).toString('hex')}`;
            const canonicalManifest = {
                batch_id: testBatchId,
                items: [{ id: 1, name: 'Sample Item', explicit_null_field: null }],
                total: 1
            };

            await dbClient.execute(`
                INSERT INTO import_batches (id, user_id, manifest_hash, canonical_manifest)
                VALUES (?, ?, ?, ?);
            `, [testBatchId, testUserId, computeSha256(JSON.stringify(canonicalManifest)), JSON.stringify(canonicalManifest)], dbOpts);

            const fetchedBatch = await dbClient.queryOne('SELECT * FROM import_batches WHERE id = ?;', [testBatchId], dbOpts);
            assert(fetchedBatch, 'Must fetch created batch');
            const parsedManifest = typeof fetchedBatch.canonical_manifest === 'string'
                ? JSON.parse(fetchedBatch.canonical_manifest)
                : fetchedBatch.canonical_manifest;
            assert.strictEqual(parsedManifest.items[0].explicit_null_field, null, 'Explicit null in JSON must be preserved as null');
            console.log(`  ✓ [${engine}] Data Types & Explicit NULL in JSON verified.`);

            // Test 3.2: CHECK Constraints Enforcement
            let checkViolated = false;
            try {
                await dbClient.execute(`
                    INSERT INTO import_attempts (id, import_id, attempt_number, fencing_token, attempt_token, final_status)
                    VALUES (?, ?, 1, 'f_tok', 'a_tok', 'INVALID_STATUS_ENUM');
                `, [`att_${engine}_inv`, 'imp_dummy'], dbOpts);
            } catch (err) {
                checkViolated = true;
            }
            assert(checkViolated, `CHECK constraint on final_status must reject invalid enum on ${engine}`);
            console.log(`  ✓ [${engine}] CHECK constraint on status enums enforced.`);

            // Test 3.3: FOREIGN KEY Constraint Enforcement
            let fkViolated = false;
            try {
                await dbClient.execute(`
                    INSERT INTO import_attempts (id, import_id, attempt_number, fencing_token, attempt_token, final_status)
                    VALUES (?, 'nonexistent_import_id_123', 1, 'f_tok', 'a_tok', 'RUNNING');
                `, [`att_${engine}_fk`], dbOpts);
            } catch (err) {
                fkViolated = true;
            }
            assert(fkViolated, `FOREIGN KEY constraint must reject non-existent import on ${engine}`);
            console.log(`  ✓ [${engine}] FOREIGN KEY constraint enforced.`);

            // Test 3.4: ON DELETE CASCADE
            const testFileId = `file_${engine}_${crypto.randomBytes(4).toString('hex')}`;
            await dbClient.execute(`
                INSERT INTO batch_source_files (
                    id, batch_id, file_sha256, storage_object_uuid, storage_path, file_size, deletion_status
                ) VALUES (?, ?, 'dummy_hash', 'uuid_1', '/storage/file.dat', 1024, 'ACTIVE');
            `, [testFileId, testBatchId], dbOpts);

            await dbClient.execute('DELETE FROM import_batches WHERE id = ?;', [testBatchId], dbOpts);
            const childFile = await dbClient.queryOne('SELECT * FROM batch_source_files WHERE id = ?;', [testFileId], dbOpts);
            assert(!childFile, `Child file must be cascaded on parent batch deletion on ${engine}`);
            console.log(`  ✓ [${engine}] ON DELETE CASCADE verified.`);

            // Test 3.5: PROOF-SAVEPOINT-PARITY (Deterministic Savepoint Resiliency)
            console.log(`  >> Testing PROOF-SAVEPOINT-PARITY on [${engine}] <<`);
            const opA_importId = `imp_sp_a_${engine}_${crypto.randomBytes(4).toString('hex')}`;
            const opB_attemptId = `att_sp_b_${engine}_${crypto.randomBytes(4).toString('hex')}`;
            const opC_logId = `log_sp_c_${engine}_${crypto.randomBytes(4).toString('hex')}`;

            await dbClient.transaction(async (tx) => {
                await tx.execute(`
                    INSERT INTO imports (id, user_id, source_files, status)
                    VALUES (?, ?, '[]', 'PENDING');
                `, [opA_importId, testUserId]);

                let nestedFailed = false;
                try {
                    await tx.transaction(async (nestedTx) => {
                        await nestedTx.execute(`
                            INSERT INTO import_attempts (id, import_id, attempt_number, fencing_token, attempt_token, final_status)
                            VALUES (?, ?, 1, 'tok', 'sec_tok', 'ILLEGAL_STATUS_FAIL');
                        `, [opB_attemptId, opA_importId]);
                    });
                } catch (err) {
                    nestedFailed = true;
                }
                assert(nestedFailed, 'Operation B inside savepoint must fail');

                await tx.execute(`
                    INSERT INTO import_logs (id, import_id, step, message, severity)
                    VALUES (?, ?, 'SAVEPOINT_TEST', 'Outer tx survives nested savepoint rollback', 'INFO');
                `, [opC_logId, opA_importId]);
            }, dbOpts);

            const recA = await dbClient.queryOne('SELECT * FROM imports WHERE id = ?;', [opA_importId], dbOpts);
            const recB = await dbClient.queryOne('SELECT * FROM import_attempts WHERE id = ?;', [opB_attemptId], dbOpts);
            const recC = await dbClient.queryOne('SELECT * FROM import_logs WHERE id = ?;', [opC_logId], dbOpts);

            assert(recA, `Operation A (imports) must be committed and present on ${engine}`);
            assert(!recB, `Operation B (failed import_attempt) must be rolled back by savepoint on ${engine}`);
            assert(recC, `Operation C (import_logs) must be committed and present on ${engine}`);

            console.log(`  ✓ [${engine}] PROOF-SAVEPOINT-PARITY: Outer transaction survived nested failure; Record A & C exist, Record B rolled back.`);
        }

        outcome = 'PASS';
        outcomeReason = 'All Stage 1 contract, schema hardening, and behavioral parity tests passed 100%';

    } catch (err) {
        outcome = 'FAILED';
        outcomeReason = `Assertion or runtime error encountered: ${err.message}`;
        console.error('\n❌ ERROR ENCOUNTERED DURING TEST SUITE:', err);
    } finally {
        // =================================================================
        // CLEANUP & FORENSIC SAFEGUARD PHASE
        // =================================================================
        console.log('\n--- Finalizing Lifecycle: Resource Closure & Canary Cleanup ---');

        // Close primary migrator client if open
        if (migratorClient) {
            try {
                await migratorClient.end();
                activePgClients.delete(migratorClient);
            } catch (e) {
                cleanupErrors.push(`Failed to end migratorClient: ${e.message}`);
            }
        }

        // Close SQLite engine handles
        try {
            closeDb();
        } catch (e) {
            cleanupErrors.push(`closeDb failed: ${e.message}`);
        }

        // Close PostgreSQL application pool
        try {
            await pgAdapter.closePool();
        } catch (e) {
            cleanupErrors.push(`closePool failed: ${e.message}`);
        }

        // Destructive Canary Table cleanup (Strictly gated by outcome === 'PASS')
        if (outcome === 'PASS' && canaryUuid && canaryTableOid && TARGET_TEST_DB) {
            let cleanupClient = null;
            try {
                cleanupClient = pgAdapter.getMigratorClient(TARGET_TEST_DB);
                activePgClients.add(cleanupClient);
                await cleanupClient.connect();

                // Re-verify Target Database Identity
                const dbIdent = await cleanupClient.query('SELECT current_database() AS db, d.oid FROM pg_database d WHERE d.datname = current_database();');
                if (dbIdent.rows[0].db !== TARGET_TEST_DB || Number(dbIdent.rows[0].oid) !== ephemeralDbOid) {
                    throw new Error(`Target DB identity mismatch during cleanup: ${dbIdent.rows[0].db} (OID: ${dbIdent.rows[0].oid})`);
                }

                // Re-verify Canary Table in Catalog
                const catCheck = await cleanupClient.query(`
                    SELECT c.oid AS table_oid, pg_get_userbyid(c.relowner) AS table_owner
                    FROM pg_class c
                    JOIN pg_namespace n ON c.relnamespace = n.oid
                    WHERE n.nspname = 'public' AND c.relname = $1;
                `, [CANARY_TABLE_NAME]);

                if (catCheck.rows.length === 0 || Number(catCheck.rows[0].table_oid) !== canaryTableOid || catCheck.rows[0].table_owner !== canaryTableOwner) {
                    throw new Error('Canary table catalog identity mismatch before DROP TABLE');
                }

                // Verify Canary Table Row Content
                const canaryRow = await cleanupClient.query(`
                    SELECT marker_uuid, database_name, run_id FROM "${CANARY_TABLE_NAME}" WHERE marker_uuid = $1;
                `, [canaryUuid]);
                if (canaryRow.rows.length === 0 || canaryRow.rows[0].database_name !== TARGET_TEST_DB || canaryRow.rows[0].run_id !== RUN_ID) {
                    throw new Error('Canary row contents invalid or missing before DROP TABLE');
                }

                // Transactional DROP
                await cleanupClient.query('BEGIN;');
                await cleanupClient.query(`DROP TABLE "${CANARY_TABLE_NAME}";`);
                await cleanupClient.query('COMMIT;');

                // Independent Post-Drop Catalog Verification
                const postDropCheck = await cleanupClient.query(`
                    SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1;
                `, [CANARY_TABLE_NAME]);
                if (Number(postDropCheck.rows[0].cnt) !== 0) {
                    throw new Error('Canary table still exists in catalog after DROP TABLE execution');
                }

                // Canary Registry File Unlinking (Strictly after confirmed catalog DROP)
                if (CANARY_REGISTRY_PATH && fs.existsSync(CANARY_REGISTRY_PATH)) {
                    fs.unlinkSync(CANARY_REGISTRY_PATH);
                }
                console.log('✓ Canary table dropped transactionally and registry cleaned cleanly.');

            } catch (cleanupErr) {
                cleanupErrors.push(`Canary cleanup failure: ${cleanupErr.message}`);
                outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
                outcomeReason = `Canary cleanup failed; forensic evidence preserved: ${cleanupErr.message}`;
            } finally {
                if (cleanupClient) {
                    try {
                        await cleanupClient.end();
                        activePgClients.delete(cleanupClient);
                    } catch (e) {
                        cleanupErrors.push(`Failed to end cleanupClient: ${e.message}`);
                    }
                }
            }
        } else {
            console.log(`[FORENSIC PRESERVATION] Canary table and external registry preserved on disk/DB due to non-PASS outcome (${outcome}).`);
        }

        // SQLite Working Replica Cleanup (Strictly gated by outcome === 'PASS')
        if (outcome === 'PASS' && isolatedSqliteDbPath) {
            const replicaSidecars = [
                `${isolatedSqliteDbPath}-wal`,
                `${isolatedSqliteDbPath}-shm`,
                isolatedSqliteDbPath
            ];
            for (const filePath of replicaSidecars) {
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (unlinkErr) {
                        cleanupErrors.push(`Failed to delete SQLite replica file ${filePath}: ${unlinkErr.message}`);
                    }
                }
            }
        } else if (isolatedSqliteDbPath && fs.existsSync(isolatedSqliteDbPath)) {
            console.log(`[FORENSIC PRESERVATION] SQLite isolated replica preserved at ${isolatedSqliteDbPath} for audit.`);
        }

        // Close any lingering PostgreSQL clients tracked in activePgClients
        for (const client of activePgClients) {
            try {
                await client.end();
                activePgClients.delete(client);
            } catch (e) {
                cleanupErrors.push(`Failed to close lingering client: ${e.message}`);
            }
        }

        if (activePgClients.size > 0) {
            cleanupErrors.push(`${activePgClients.size} PostgreSQL clients remained unclosed`);
        }

        // If cleanup errors occurred, demote PASS to INCONCLUSIVE_REQUIRING_AUDIT
        if (cleanupErrors.length > 0 && outcome === 'PASS') {
            outcome = 'INCONCLUSIVE_REQUIRING_AUDIT';
            outcomeReason = `Tests passed but cleanup operations encountered errors: ${cleanupErrors.join('; ')}`;
        }
    }

    console.log('\n================================================================');
    if (outcome === 'PASS') {
        console.log('🎉 ALL STAGE 1 CONTRACT & PARITY TESTS PASSED 100%!');
    } else {
        console.log(`⚠️ FINAL TEST SUITE OUTCOME: [${outcome}]`);
        console.log(`   Reason: ${outcomeReason}`);
    }
    console.log('================================================================\n');

    return {
        outcome,
        reason: outcomeReason,
        run_id: RUN_ID,
        target_db: TARGET_TEST_DB,
        cleanupErrors
    };
}

if (require.main === module) {
    runStage1ParityTests()
        .then((result) => {
            if (result.outcome !== 'PASS') {
                console.error(`\n❌ TEST FAILED: ${result.outcome} - ${result.reason}`);
                process.exit(1);
            }
            process.exit(0);
        })
        .catch((err) => {
            console.error('\n❌ UNCAUGHT FATAL ERROR:', err);
            process.exit(1);
        });
}

module.exports = {
    runStage1ParityTests,
    generateRunId,
    computeSha256,
    EXPECTED_SNAPSHOT_SHA256
};
