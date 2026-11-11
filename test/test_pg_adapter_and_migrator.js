/**
 * test/test_pg_adapter_and_migrator.js
 * 
 * Deep test suite for PostgreSQL Adapter & Migrator.
 * 
 * Strict Safety Rules:
 * - Operates EXCLUSIVELY on zarsev_test.
 * - FATAL GUARD blocks any execution against zarsev_dev.
 * - ZERO modification or access to SQLite database files.
 * - Full teardown and cleanup of test objects in zarsev_test.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
    getAppPool,
    getMigratorClient,
    queryAll,
    queryOne,
    execute,
    transaction,
    safeJsonParse,
    closePool,
    JsonCorruptionError,
    resolveAppConfig,
    resolveMigratorConfig
} = require('../src/db/pgAdapter');

const {
    MIGRATION_LOCK_ID,
    runMigrations,
    getMigrationStatus,
    discoverMigrationFiles,
    computeSha256
} = require('../src/db/pgMigrator');

// Target database configuration
const TARGET_TEST_DB = 'zarsev_test';

function computeFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}

async function runPgAdapterAndMigratorTests() {
    console.log('================================================================');
    console.log('🐘 PostgreSQL Foundation Test Suite: pgAdapter & pgMigrator');
    console.log('================================================================\n');

    // -----------------------------------------------------------------
    // Safety Isolation Guard: Verify DB is zarsev_test and SQLite is intact
    // -----------------------------------------------------------------
    process.env.NODE_ENV = 'test';
    const appConfig = resolveAppConfig(TARGET_TEST_DB);
    const migConfig = resolveMigratorConfig(TARGET_TEST_DB);

    if (appConfig.database !== TARGET_TEST_DB || migConfig.database !== TARGET_TEST_DB) {
        throw new Error(`[FATAL ISOLATION GUARD] Test suite must target '${TARGET_TEST_DB}', got app=${appConfig.database}, mig=${migConfig.database}`);
    }

    if (appConfig.database === 'zarsev_dev' || migConfig.database === 'zarsev_dev') {
        throw new Error('[FATAL ISOLATION GUARD] Execution against zarsev_dev is strictly prohibited in tests!');
    }

    const projectRoot = path.resolve(__dirname, '..');
    const sqlitePath = path.join(projectRoot, 'zarsev.db');
    const sqliteBakPath = path.join(projectRoot, 'zarsev.db.bak');
    const sqlitePrequarantinePath = path.join(projectRoot, 'zarsev.db.phase1_2_prequarantine.bak');

    const sqliteHashBefore = computeFileHash(sqlitePath);
    const sqliteBakHashBefore = computeFileHash(sqliteBakPath);
    const sqlitePrequarantineHashBefore = computeFileHash(sqlitePrequarantinePath);

    console.log('[SAFETY ISOLATION GUARD]');
    console.log(` - Target PostgreSQL DB:    ${TARGET_TEST_DB}`);
    console.log(` - zarsev_app user:         ${appConfig.user}`);
    console.log(` - zarsev_migrator user:    ${migConfig.user}`);
    console.log(` - SQLite zarsev.db hash:   ${sqliteHashBefore}`);
    console.log('✓ Target database validated strictly as test environment.\n');

    let migratorClient = null;
    let tempMigrationsDir = null;

    try {
        migratorClient = getMigratorClient(TARGET_TEST_DB);
        await migratorClient.connect();

        // -----------------------------------------------------------------
        // SECTION 1: pgAdapter — Basic Queries & DML
        // -----------------------------------------------------------------
        console.log('--- 1. Testing pgAdapter Core Operations ---');

        // Setup test table with zarsev_migrator (DDL)
        await migratorClient.query(`
            DROP TABLE IF EXISTS _test_adapter_items;
            CREATE TABLE _test_adapter_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                metadata JSONB,
                amount NUMERIC(10, 2) DEFAULT 0.00,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('✓ DDL: Created test table _test_adapter_items via zarsev_migrator.');

        // Test execute (INSERT) with zarsev_app
        const insertRes1 = await execute(
            'INSERT INTO _test_adapter_items (name, metadata, amount) VALUES ($1, $2, $3) RETURNING id;',
            ['Item Alpha', JSON.stringify({ category: 'tools', active: true }), 49.99]
        );
        assert.strictEqual(insertRes1.rowCount, 1, 'execute() must return rowCount = 1 on INSERT');
        assert(insertRes1.rows[0].id > 0, 'execute() must return generated id');
        const item1Id = insertRes1.rows[0].id;

        const insertRes2 = await execute(
            'INSERT INTO _test_adapter_items (name, metadata, amount) VALUES ($1, $2, $3) RETURNING id;',
            ['Item Beta', JSON.stringify({ category: 'parts', active: false }), 12.50]
        );
        const item2Id = insertRes2.rows[0].id;
        console.log(`✓ execute(): Inserted 2 test items (IDs: ${item1Id}, ${item2Id}) via zarsev_app.`);

        // Test queryAll with parameterized filter ($1)
        const allItems = await queryAll('SELECT * FROM _test_adapter_items ORDER BY id ASC;');
        assert.strictEqual(allItems.length, 2, 'queryAll() must return 2 rows');
        assert.strictEqual(allItems[0].name, 'Item Alpha');
        assert.strictEqual(allItems[1].name, 'Item Beta');

        const filteredItems = await queryAll('SELECT * FROM _test_adapter_items WHERE name = $1;', ['Item Alpha']);
        assert.strictEqual(filteredItems.length, 1);
        assert.strictEqual(filteredItems[0].name, 'Item Alpha');
        console.log('✓ queryAll(): Successfully retrieved all and filtered rows with $1 parameters.');

        // Test queryOne
        const oneItem = await queryOne('SELECT * FROM _test_adapter_items WHERE id = $1;', [item1Id]);
        assert(oneItem !== null, 'queryOne() must return row object');
        assert.strictEqual(oneItem.name, 'Item Alpha');

        const nonExistent = await queryOne('SELECT * FROM _test_adapter_items WHERE id = $1;', [999999]);
        assert.strictEqual(nonExistent, null, 'queryOne() must return null when no rows match');
        console.log('✓ queryOne(): Successfully returned single row and null on missing entity.');

        // -----------------------------------------------------------------
        // SECTION 2: pgAdapter — Transactions & Savepoints
        // -----------------------------------------------------------------
        console.log('\n--- 2. Testing pgAdapter Transactions & Savepoints ---');

        // Test 2.1: Transaction Commit
        await transaction(async (client) => {
            await execute(
                'INSERT INTO _test_adapter_items (name, amount) VALUES ($1, $2);',
                ['Tx Item 1', 100.00],
                client
            );
            await execute(
                'INSERT INTO _test_adapter_items (name, amount) VALUES ($1, $2);',
                ['Tx Item 2', 200.00],
                client
            );
        });

        const txItems = await queryAll("SELECT * FROM _test_adapter_items WHERE name LIKE 'Tx Item %' ORDER BY id ASC;");
        assert.strictEqual(txItems.length, 2, 'Committed transaction rows must persist');
        console.log('✓ Transaction Commit: Successfully persisted rows inside transaction.');

        // Test 2.2: Transaction Rollback on Error
        let txFailed = false;
        try {
            await transaction(async (client) => {
                await execute(
                    'INSERT INTO _test_adapter_items (name, amount) VALUES ($1, $2);',
                    ['Should Rollback', 999.00],
                    client
                );
                throw new Error('Simulated business error inside transaction');
            });
        } catch (err) {
            txFailed = true;
            assert.strictEqual(err.message, 'Simulated business error inside transaction');
        }
        assert.strictEqual(txFailed, true, 'Transaction must rethrow error');

        const rollbackCheck = await queryOne("SELECT * FROM _test_adapter_items WHERE name = 'Should Rollback';");
        assert.strictEqual(rollbackCheck, null, 'Rolled back row must NOT exist in database');
        console.log('✓ Transaction Rollback: Cleanly rolled back all changes on exception.');

        // Test 2.3: Nested Transactions via Savepoints (Inner Commit)
        await transaction(async (tx1) => {
            await execute("INSERT INTO _test_adapter_items (name) VALUES ('Outer 1');", [], tx1);

            await transaction(async (tx2) => {
                await execute("INSERT INTO _test_adapter_items (name) VALUES ('Inner 1');", [], tx2);
            }, { client: tx1 });

            await execute("INSERT INTO _test_adapter_items (name) VALUES ('Outer 2');", [], tx1);
        });

        const nestedItems = await queryAll("SELECT name FROM _test_adapter_items WHERE name IN ('Outer 1', 'Inner 1', 'Outer 2');");
        assert.strictEqual(nestedItems.length, 3, 'Both outer and inner committed savepoints must persist');
        console.log('✓ Nested Transaction (Inner Commit): Savepoint released and outer committed successfully.');

        // Test 2.4: Nested Transactions via Savepoints (Inner Rollback without Outer Abort)
        await transaction(async (tx1) => {
            await execute("INSERT INTO _test_adapter_items (name) VALUES ('Outer Kept');", [], tx1);

            let innerFailed = false;
            try {
                await transaction(async (tx2) => {
                    await execute("INSERT INTO _test_adapter_items (name) VALUES ('Inner Rolled Back');", [], tx2);
                    throw new Error('Savepoint rollback simulation');
                }, { client: tx1 });
            } catch (err) {
                innerFailed = true;
                assert.strictEqual(err.message, 'Savepoint rollback simulation');
            }
            assert.strictEqual(innerFailed, true);

            // Outer continues successfully after catching inner failure
            await execute("INSERT INTO _test_adapter_items (name) VALUES ('Outer Also Kept');", [], tx1);
        });

        const keptItems = await queryAll("SELECT name FROM _test_adapter_items WHERE name IN ('Outer Kept', 'Inner Rolled Back', 'Outer Also Kept');");
        const keptNames = keptItems.map(r => r.name);
        assert(keptNames.includes('Outer Kept'), 'Outer Kept must exist');
        assert(keptNames.includes('Outer Also Kept'), 'Outer Also Kept must exist');
        assert(!keptNames.includes('Inner Rolled Back'), 'Inner Rolled Back must NOT exist');
        console.log('✓ Nested Transaction (Inner Rollback): Inner savepoint rolled back cleanly; outer transaction preserved.');

        // Test 2.5: Serialization Conflict Retry Simulation
        let attemptsCount = 0;
        const retryResult = await transaction(async (client) => {
            attemptsCount++;
            if (attemptsCount < 3) {
                const conflictErr = new Error('could not serialize access due to concurrent update');
                conflictErr.code = '40001'; // SQLSTATE serialization failure
                throw conflictErr;
            }
            return 'retry_success';
        }, { maxRetries: 3, retryOnSerialization: true });

        assert.strictEqual(retryResult, 'retry_success');
        assert.strictEqual(attemptsCount, 3, 'transaction() must retry up to maxRetries on 40001');
        console.log(`✓ Serialization Retry: Successfully retried 40001 conflict across ${attemptsCount} attempts with backoff.`);

        // Test 2.6: Tainted Client Removal on Rollback Failure
        let taintedErrorCaught = false;
        try {
            await transaction(async (client) => {
                // Forcefully destroy client socket to simulate catastrophic mid-transaction disconnect
                if (client.connection && client.connection.stream) {
                    client.connection.stream.destroy();
                }
                throw new Error('Mid-transaction network disruption');
            }, { retryOnSerialization: false });
        } catch (err) {
            taintedErrorCaught = true;
            assert.strictEqual(err.message, 'Mid-transaction network disruption');
            assert(err.rollbackError, 'Tainted connection must capture rollbackError on failed rollback');
        }
        assert.strictEqual(taintedErrorCaught, true, 'transaction() must throw and record rollback failure');

        // Verify pool recovers and can issue subsequent queries cleanly
        const poolRecoverCheck = await queryOne('SELECT 1 AS alive;');
        assert.strictEqual(poolRecoverCheck.alive, 1, 'Pool must remain healthy after tainted client eviction');
        console.log('✓ Tainted Client Removal: Dead connection evicted from pool on rollback failure; pool recovered.');

        // -----------------------------------------------------------------
        // SECTION 3: pgAdapter — Strict JSON Parsing & JsonCorruptionError
        // -----------------------------------------------------------------
        console.log('\n--- 3. Testing pgAdapter safeJsonParse ---');

        // Passthrough of parsed object
        const objInput = { key: 'val', num: 42 };
        assert.strictEqual(safeJsonParse(objInput), objInput, 'Must return object reference directly');

        // Valid JSON string
        const validJsonStr = '{"user": "alice", "roles": ["admin"]}';
        const parsedObj = safeJsonParse(validJsonStr);
        assert.deepStrictEqual(parsedObj, { user: 'alice', roles: ['admin'] });

        // Null, undefined, empty string
        const defObj = {};
        const defArr = [];
        assert.strictEqual(safeJsonParse(null), null);
        assert.strictEqual(safeJsonParse(undefined), null);
        assert.strictEqual(safeJsonParse('', { defaultValue: defObj }), defObj);
        assert.strictEqual(safeJsonParse('   ', { defaultValue: defArr }), defArr);

        // Corrupted JSON string -> MUST throw JsonCorruptionError
        let jsonErrorThrown = false;
        try {
            safeJsonParse('{"malformed": json without quotes}', {
                column: 'extra_properties',
                entityId: 1042
            });
        } catch (err) {
            jsonErrorThrown = true;
            assert(err instanceof JsonCorruptionError, 'Error must be an instance of JsonCorruptionError');
            assert.strictEqual(err.name, 'JsonCorruptionError');
            assert.strictEqual(err.column, 'extra_properties');
            assert.strictEqual(err.entityId, 1042);
            assert(err.rawSnippet.includes('{"malformed"'));
            assert(err.cause instanceof SyntaxError);
        }
        assert.strictEqual(jsonErrorThrown, true, 'safeJsonParse must never swallow corrupted JSON');
        console.log('✓ safeJsonParse: Passed object passthrough, valid string parsing, empty fallbacks, and JsonCorruptionError.');

        // -----------------------------------------------------------------
        // SECTION 4: pgMigrator — Advisory Lock & Migration Engine
        // -----------------------------------------------------------------
        console.log('\n--- 4. Testing pgMigrator Operations ---');

        // Test 4.1: Advisory Lock Collision & Mutual Exclusion
        console.log('4.1 Testing advisory lock mutual exclusion...');
        const lockClientA = getMigratorClient(TARGET_TEST_DB);
        const lockClientB = getMigratorClient(TARGET_TEST_DB);
        await lockClientA.connect();
        await lockClientB.connect();

        try {
            // Client A acquires advisory lock
            const lockARes = await lockClientA.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [MIGRATION_LOCK_ID]);
            assert.strictEqual(lockARes.rows[0].locked, true, 'Client A must acquire migration advisory lock');

            // Client B tries to acquire same advisory lock -> MUST return false
            const lockBRes = await lockClientB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [MIGRATION_LOCK_ID]);
            assert.strictEqual(lockBRes.rows[0].locked, false, 'Client B must be rejected while Client A holds advisory lock');

            // Client A unlocks
            await lockClientA.query('SELECT pg_advisory_unlock($1::bigint);', [MIGRATION_LOCK_ID]);

            // Now Client B can acquire
            const lockBRetry = await lockClientB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [MIGRATION_LOCK_ID]);
            assert.strictEqual(lockBRetry.rows[0].locked, true, 'Client B must acquire lock once Client A has unlocked');
            await lockClientB.query('SELECT pg_advisory_unlock($1::bigint);', [MIGRATION_LOCK_ID]);
        } finally {
            await lockClientA.end().catch(() => {});
            await lockClientB.end().catch(() => {});
        }
        console.log('✓ Advisory Lock: Mutual exclusion strictly enforced via pg_try_advisory_lock($1::bigint).');

        // Setup temporary migrations folder for isolated migrator testing
        tempMigrationsDir = path.join(os.tmpdir(), `zarsev_pg_test_mig_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
        fs.mkdirSync(tempMigrationsDir, { recursive: true });

        // Clean previous test migration tables if any
        await migratorClient.query(`
            DROP TABLE IF EXISTS _test_mig_sample_1;
            DROP TABLE IF EXISTS _test_mig_sample_3;
            DROP TABLE IF EXISTS _pg_migration_failures;
            DROP TABLE IF EXISTS _pg_migrations;
        `);

        // Test 4.2: Successful Transactional Migration
        console.log('4.2 Testing initial migration run...');
        const mig1Sql = `
            CREATE TABLE _test_mig_sample_1 (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                description TEXT
            );
            INSERT INTO _test_mig_sample_1 (code, description) VALUES ('TEST_01', 'Initial test seed');
        `;
        const mig1Path = path.join(tempMigrationsDir, '001_initial_test.sql');
        fs.writeFileSync(mig1Path, mig1Sql, 'utf8');

        const migRun1 = await runMigrations(TARGET_TEST_DB, tempMigrationsDir);
        assert.strictEqual(migRun1.appliedCount, 1);
        assert.deepStrictEqual(migRun1.applied, ['001_initial_test.sql']);

        // Verify table exists and row is inserted
        const mig1Check = await migratorClient.query('SELECT * FROM _test_mig_sample_1;');
        assert.strictEqual(mig1Check.rows.length, 1);
        assert.strictEqual(mig1Check.rows[0].code, 'TEST_01');

        // Verify _pg_migrations entry
        const metaRes1 = await migratorClient.query('SELECT * FROM _pg_migrations WHERE name = $1;', ['001_initial_test.sql']);
        assert.strictEqual(metaRes1.rows.length, 1);
        assert.strictEqual(metaRes1.rows[0].checksum, computeSha256(mig1Sql));
        assert(metaRes1.rows[0].execution_time_ms >= 0);
        console.log('✓ Migrator Run 1: Successfully applied transactional migration and recorded in _pg_migrations.');

        // Test 4.3: Migration Idempotency
        console.log('4.3 Testing migration idempotency (second run)...');
        const migRun2 = await runMigrations(TARGET_TEST_DB, tempMigrationsDir);
        assert.strictEqual(migRun2.appliedCount, 0, 'Re-running without new files must apply 0 migrations');
        assert.deepStrictEqual(migRun2.applied, []);
        console.log('✓ Migration Idempotency: Re-execution skipped already-applied migration.');

        // Test 4.4: Checksum Anti-Tampering Verification
        console.log('4.4 Testing checksum tampering detection...');
        const tamperedSql = mig1Sql + '\n-- Tampered comment injected by unauthorized editor';
        fs.writeFileSync(mig1Path, tamperedSql, 'utf8');

        let checksumErrThrown = false;
        try {
            await runMigrations(TARGET_TEST_DB, tempMigrationsDir);
        } catch (err) {
            checksumErrThrown = true;
            assert.strictEqual(err.code, 'CHECKSUM_MISMATCH');
            assert(err.message.includes('has been modified on disk'));
        }
        assert.strictEqual(checksumErrThrown, true, 'Migrator must reject modified migration files with CHECKSUM_MISMATCH');
        console.log('✓ Checksum Anti-Tampering: Detected altered migration file and halted execution.');

        // Restore original checksum for next steps
        fs.writeFileSync(mig1Path, mig1Sql, 'utf8');

        // Test 4.5: Transactional Rollback on Failing Migration
        console.log('4.5 Testing transactional rollback on failing migration...');
        const brokenSql = `
            CREATE TABLE _test_mig_sample_2_never (
                id SERIAL PRIMARY KEY
            );
            -- Intentional syntax error below:
            INVALID SQL SYNTAX HERE THAT MUST FAIL TRANSACTION;
        `;
        const mig2Path = path.join(tempMigrationsDir, '002_failing_migration.sql');
        fs.writeFileSync(mig2Path, brokenSql, 'utf8');

        let mig2Failed = false;
        try {
            await runMigrations(TARGET_TEST_DB, tempMigrationsDir);
        } catch (err) {
            mig2Failed = true;
        }
        assert.strictEqual(mig2Failed, true, 'Broken migration must throw');

        // Verify _test_mig_sample_2_never was rolled back and does NOT exist
        const tableCheck = await migratorClient.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = '_test_mig_sample_2_never';
        `);
        assert.strictEqual(tableCheck.rows.length, 0, 'Rolled back migration table must NOT exist in schema');

        // Verify failure was recorded in _pg_migration_failures
        const failureRes = await migratorClient.query('SELECT * FROM _pg_migration_failures WHERE name = $1;', ['002_failing_migration.sql']);
        assert.strictEqual(failureRes.rows.length, 1, 'Failure must be recorded in _pg_migration_failures');
        assert(failureRes.rows[0].error_message.length > 0);
        console.log('✓ Transactional Rollback: Rolled back broken DDL and recorded in _pg_migration_failures.');

        // Remove the broken migration file
        fs.unlinkSync(mig2Path);

        // Test 4.6: Non-Transactional Migration Directive (-- no-transaction)
        console.log('4.6 Testing non-transactional directive (-- no-transaction)...');
        const nonTxSql = `-- no-transaction\nCREATE TABLE _test_mig_sample_3 (id SERIAL PRIMARY KEY, label TEXT);`;
        const mig3Path = path.join(tempMigrationsDir, '003_non_tx_migration.sql');
        fs.writeFileSync(mig3Path, nonTxSql, 'utf8');

        const migRun3 = await runMigrations(TARGET_TEST_DB, tempMigrationsDir);
        assert.strictEqual(migRun3.appliedCount, 1);
        assert.deepStrictEqual(migRun3.applied, ['003_non_tx_migration.sql']);

        const mig3Check = await migratorClient.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = '_test_mig_sample_3';
        `);
        assert.strictEqual(mig3Check.rows.length, 1, 'Non-transactional migration table must exist');
        console.log('✓ Non-Transactional Directive: Successfully executed with -- no-transaction.');

        // Test 4.7: getMigrationStatus
        console.log('4.7 Testing getMigrationStatus...');
        const status = await getMigrationStatus(TARGET_TEST_DB, tempMigrationsDir);
        assert.strictEqual(status.totalDiscovered, 2);
        assert.strictEqual(status.applied.length, 2);
        assert.strictEqual(status.pending.length, 0);
        assert.strictEqual(status.applied[0].name, '001_initial_test.sql');
        assert.strictEqual(status.applied[1].name, '003_non_tx_migration.sql');
        console.log('✓ getMigrationStatus: Accurately reported applied and pending migration status.');

        // Test 4.8: Strict Migration Metadata & Business Table Permissions
        console.log('4.8 Testing strict metadata table permission hardening & business table retention...');
        const appPool = getAppPool(TARGET_TEST_DB);

        // 1. zarsev_app can SELECT metadata tables
        const metaRows = await appPool.query('SELECT name FROM _pg_migrations;');
        assert(Array.isArray(metaRows.rows), 'zarsev_app must be allowed to SELECT from _pg_migrations');
        const failRows = await appPool.query('SELECT * FROM _pg_migration_failures;');
        assert(Array.isArray(failRows.rows), 'zarsev_app must be allowed to SELECT from _pg_migration_failures');
        console.log('  ✓ Positive permission: zarsev_app can SELECT from metadata tables.');

        // 2. zarsev_app is BLOCKED from INSERT on _pg_migrations (SQLSTATE 42501)
        let insertMetaBlocked = false;
        try {
            await appPool.query("INSERT INTO _pg_migrations (name, checksum, execution_time_ms) VALUES ('rogue.sql', 'HASH', 0);");
        } catch (err) {
            insertMetaBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected 42501 permission denied, got ${err.code}`);
        }
        assert.strictEqual(insertMetaBlocked, true, 'zarsev_app must NOT be able to INSERT into _pg_migrations');

        // 3. zarsev_app is BLOCKED from UPDATE on _pg_migrations
        let updateMetaBlocked = false;
        try {
            await appPool.query("UPDATE _pg_migrations SET checksum = 'HACKED';");
        } catch (err) {
            updateMetaBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected 42501 permission denied, got ${err.code}`);
        }
        assert.strictEqual(updateMetaBlocked, true, 'zarsev_app must NOT be able to UPDATE _pg_migrations');

        // 4. zarsev_app is BLOCKED from DELETE on _pg_migrations
        let deleteMetaBlocked = false;
        try {
            await appPool.query("DELETE FROM _pg_migrations;");
        } catch (err) {
            deleteMetaBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected 42501 permission denied, got ${err.code}`);
        }
        assert.strictEqual(deleteMetaBlocked, true, 'zarsev_app must NOT be able to DELETE from _pg_migrations');

        // 5. zarsev_app is BLOCKED from TRUNCATE on _pg_migrations
        let truncateMetaBlocked = false;
        try {
            await appPool.query("TRUNCATE TABLE _pg_migrations;");
        } catch (err) {
            truncateMetaBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected 42501 permission denied, got ${err.code}`);
        }
        assert.strictEqual(truncateMetaBlocked, true, 'zarsev_app must NOT be able to TRUNCATE _pg_migrations');

        // 6. zarsev_app is BLOCKED from INSERT on _pg_migration_failures
        let insertFailBlocked = false;
        try {
            await appPool.query("INSERT INTO _pg_migration_failures (name, error_message) VALUES ('fake', 'fake');");
        } catch (err) {
            insertFailBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected 42501 permission denied, got ${err.code}`);
        }
        assert.strictEqual(insertFailBlocked, true, 'zarsev_app must NOT be able to INSERT into _pg_migration_failures');
        console.log('  ✓ Negative permission: zarsev_app write access (INSERT/UPDATE/DELETE/TRUNCATE) strictly denied (SQLSTATE 42501).');

        // 7. PUBLIC has zero access on metadata tables
        const publicGrants = await migratorClient.query(`
            SELECT grantee, privilege_type FROM information_schema.role_table_grants
            WHERE table_name IN ('_pg_migrations', '_pg_migration_failures') AND grantee = 'PUBLIC';
        `);
        assert.strictEqual(publicGrants.rows.length, 0, 'PUBLIC must have 0 privileges on metadata tables');
        console.log('  ✓ Isolation check: PUBLIC has 0 privileges on metadata tables.');

        // 8. Normal business tables retain full DML for zarsev_app
        await migratorClient.query(`
            DROP TABLE IF EXISTS _test_sample_biz;
            CREATE TABLE _test_sample_biz (id SERIAL PRIMARY KEY, title TEXT);
        `);
        // zarsev_app INSERT on business table
        const bizInsert = await appPool.query("INSERT INTO _test_sample_biz (title) VALUES ('Biz Item') RETURNING id;");
        assert.strictEqual(bizInsert.rowCount, 1);
        const bizId = bizInsert.rows[0].id;

        // zarsev_app SELECT on business table
        const bizSelect = await appPool.query("SELECT * FROM _test_sample_biz WHERE id = $1;", [bizId]);
        assert.strictEqual(bizSelect.rows.length, 1);

        // zarsev_app UPDATE on business table
        const bizUpdate = await appPool.query("UPDATE _test_sample_biz SET title = 'Updated Biz Item' WHERE id = $1;", [bizId]);
        assert.strictEqual(bizUpdate.rowCount, 1);

        // zarsev_app DELETE on business table
        const bizDelete = await appPool.query("DELETE FROM _test_sample_biz WHERE id = $1;", [bizId]);
        assert.strictEqual(bizDelete.rowCount, 1);

        // zarsev_app DDL (DROP / CREATE) still strictly blocked
        let bizDropBlocked = false;
        try {
            await appPool.query("DROP TABLE _test_sample_biz;");
        } catch (err) {
            bizDropBlocked = true;
            assert.strictEqual(err.code, '42501');
        }
        assert.strictEqual(bizDropBlocked, true, 'zarsev_app must NOT be able to DROP business tables');

        let appCreateBlocked = false;
        try {
            await appPool.query("CREATE TABLE _test_app_rogue (id INT);");
        } catch (err) {
            appCreateBlocked = true;
            assert.strictEqual(err.code, '42501');
        }
        assert.strictEqual(appCreateBlocked, true, 'zarsev_app must NOT be able to CREATE tables');

        await migratorClient.query("DROP TABLE _test_sample_biz;");
        console.log('  ✓ Normal business table permissions: zarsev_app retains full DML (SELECT/INSERT/UPDATE/DELETE) while DDL remains strictly blocked.');
        console.log('✓ Metadata Protection & Business Table Permissions: Verified 100% compliant.');

    } finally {
        // -----------------------------------------------------------------
        // SECTION 5: Teardown & Mandatory Cleanup
        // -----------------------------------------------------------------
        console.log('\n--- 5. Mandatory Cleanup & Integrity Teardown ---');

        if (migratorClient) {
            try {
                await migratorClient.query(`
                    DROP TABLE IF EXISTS _test_adapter_items;
                    DROP TABLE IF EXISTS _test_mig_sample_1;
                    DROP TABLE IF EXISTS _test_mig_sample_3;
                    DROP TABLE IF EXISTS _pg_migration_failures;
                    DROP TABLE IF EXISTS _pg_migrations;
                `);
                console.log('✓ Cleaned up all test tables and migration metadata tables from zarsev_test.');
            } catch (err) {
                console.error('[CLEANUP WARNING] Failed to drop test tables:', err.message);
            }
            await migratorClient.end().catch(() => {});
        }

        // Close runtime connection pool
        await closePool();
        console.log('✓ Closed active PostgreSQL connection pools.');

        // Remove temporary migrations directory
        if (tempMigrationsDir && fs.existsSync(tempMigrationsDir)) {
            try {
                fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
                console.log('✓ Removed temporary test migrations directory.');
            } catch (err) {
                console.error('[CLEANUP WARNING] Failed to remove temp migrations directory:', err.message);
            }
        }

        // Verify SQLite database bit-for-bit integrity
        const sqliteHashAfter = computeFileHash(sqlitePath);
        const sqliteBakHashAfter = computeFileHash(sqliteBakPath);
        const sqlitePrequarantineHashAfter = computeFileHash(sqlitePrequarantinePath);

        assert.strictEqual(sqliteHashBefore, sqliteHashAfter, '[FATAL INTEGRITY VIOLATION] zarsev.db hash changed during tests!');
        assert.strictEqual(sqliteBakHashBefore, sqliteBakHashAfter, '[FATAL INTEGRITY VIOLATION] zarsev.db.bak hash changed during tests!');
        assert.strictEqual(sqlitePrequarantineHashBefore, sqlitePrequarantineHashAfter, '[FATAL INTEGRITY VIOLATION] zarsev.db.phase1_2_prequarantine.bak hash changed during tests!');
        console.log('✓ SQLite Integrity Verified: 100% bit-for-bit identical before and after PostgreSQL tests.');

        // Verify zarsev_dev retains exactly its 16 migrated tables and was not mutated by test
        const devMigClient = getMigratorClient('zarsev_dev');
        try {
            await devMigClient.connect();
            const devTables = await devMigClient.query(`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public';
            `);
            assert.strictEqual(devTables.rows.length, 16, `[FATAL INTEGRITY VIOLATION] zarsev_dev public schema has ${devTables.rows.length} tables! Expected 16.`);
            console.log('✓ Dev DB Integrity Verified: zarsev_dev has exactly 16 tables in schema public.');
        } finally {
            await devMigClient.end().catch(() => {});
        }
    }

    console.log('\n================================================================');
    console.log('✅ ALL POSTGRESQL ADAPTER & MIGRATOR TESTS PASSED (100%)');
    console.log('================================================================');
}

if (require.main === module) {
    runPgAdapterAndMigratorTests().catch(err => {
        console.error('\n❌ POSTGRESQL TEST SUITE FAILED:', err);
        process.exit(1);
    });
}

module.exports = { runPgAdapterAndMigratorTests };
