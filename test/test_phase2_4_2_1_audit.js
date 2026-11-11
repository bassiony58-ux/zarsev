/**
 * test/test_phase2_4_2_1_audit.js
 * 
 * ZARSEV — Phase 2.4.2.1: Independent Code Audit Verification Test Suite
 * 
 * Provides empirical verification for the audit findings:
 * 1. Tokenizer behavior on JSON operators (?, ?|, ?&), E-strings, and parameter count mismatch.
 * 2. Post-transaction reference leakage (querying on released client).
 * 3. SQLite concurrency collision on shared connection without mutex.
 * 4. Data type return asymmetries (Boolean 1/0 vs true/false, JSON string vs object, Numeric string vs float).
 * 5. RETURNING clause with non-"id" primary key column.
 * 6. Rollback error preservation in DbError.
 * 7. Verification of SQLite immutability and zarsev_test 342 business records.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

process.env.NODE_ENV = 'test';
process.env.ZARSEV_TEST_MODE = '1';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
if (!fs.existsSync(SANDBOX_DIR)) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

const TEST_SQLITE_PATH = path.join(SANDBOX_DIR, `audit_test_${Date.now()}_${process.pid}.db`);
process.env.DB_PATH = TEST_SQLITE_PATH;

const dbClient = require('../src/db/dbClient');
const pgAdapter = require('../src/db/pgAdapter');

const PROTECTED_FILES = [
    { name: 'zarsev.db', path: path.join(PROJECT_ROOT, 'zarsev.db') },
    { name: 'zarsev.db.bak', path: path.join(PROJECT_ROOT, 'zarsev.db.bak') },
    { name: 'zarsev.db.phase1_2_prequarantine.bak', path: path.join(PROJECT_ROOT, 'zarsev.db.phase1_2_prequarantine.bak') }
];

const BUSINESS_TABLES = [
    'categories',
    'manufacturers',
    'users',
    'subscriptions',
    'products',
    'product_images',
    'imports',
    'import_items',
    'import_logs'
];

function computeSha256(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function captureSnapshot() {
    const snap = {};
    for (const f of PROTECTED_FILES) {
        snap[f.name] = {
            size: fs.existsSync(f.path) ? fs.statSync(f.path).size : null,
            sha: computeSha256(f.path)
        };
    }
    return snap;
}

async function capturePgBusinessCounts() {
    const pool = pgAdapter.getAppPool('zarsev_test');
    const counts = {};
    let total = 0;
    for (const tbl of BUSINESS_TABLES) {
        const res = await pool.query(`SELECT count(*)::int as c FROM "${tbl}";`);
        const count = res.rows[0].c;
        counts[tbl] = count;
        total += count;
    }
    return { counts, total };
}

async function runAuditTests() {
    console.log('================================================================');
    console.log('🔬 ZARSEV Phase 2.4.2.1: Independent Code Audit Test Suite');
    console.log('================================================================\n');

    // Baseline checks
    const preSnap = captureSnapshot();
    assert.strictEqual(preSnap['zarsev.db'].sha, 'BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB');
    const prePgCounts = await capturePgBusinessCounts();
    assert.strictEqual(prePgCounts.total, 342);

    const auditResults = {
        tokenizerJsonOperatorsCorrupted: false,
        paramCountMismatchBehavior: null,
        postTxClientAccessible: false,
        sqliteParallelTxCollision: false,
        booleanReturnAsymmetry: false,
        jsonReturnAsymmetry: false,
        numericReturnAsymmetry: false,
        nonIdReturningHandled: false,
        rollbackErrorPreservedInDbError: false
    };

    try {
        // ----------------------------------------------------------------
        // Check 1: Tokenizer on JSONB Operators (?, ?|, ?&)
        // ----------------------------------------------------------------
        console.log('--- Audit Check 1: Tokenizer with PostgreSQL JSONB Operators ---');
        const jsonQuery1 = "SELECT '{\"a\": 1}'::jsonb ? 'a' as has_a;";
        const jsonQuery2 = "SELECT '{\"a\": 1}'::jsonb ?| array['a', 'b'] as has_any;";
        const converted1 = dbClient.tokenizeAndConvertParams(jsonQuery1);
        const converted2 = dbClient.tokenizeAndConvertParams(jsonQuery2);

        console.log(` - Original JSON query 1:  ${jsonQuery1}`);
        console.log(` - Tokenized query 1:     ${converted1}`);
        console.log(` - Original JSON query 2:  ${jsonQuery2}`);
        console.log(` - Tokenized query 2:     ${converted2}`);

        if (converted1.includes('$1') || converted2.includes('$1|')) {
            auditResults.tokenizerJsonOperatorsCorrupted = true;
            console.log(' ⚠️ FINDING CONFIRMED: Tokenizer converted JSONB existence operators into parameter placeholders.');
        }

        // ----------------------------------------------------------------
        // Check 2: Parameter Count Mismatch Behavior
        // ----------------------------------------------------------------
        console.log('\n--- Audit Check 2: Parameter Count Mismatch Behavior ---');
        const sqliteMem = new DatabaseSync(':memory:');
        sqliteMem.exec('CREATE TABLE t (a TEXT, b TEXT);');

        // SQLite with fewer params
        const sqliteStmt = sqliteMem.prepare('SELECT ? as a, ? as b;');
        const sqliteRow = sqliteStmt.get('val1');
        console.log(' - SQLite result with 2 placeholders and 1 parameter:', sqliteRow);

        // PostgreSQL with fewer params
        let pgMismatchError = null;
        try {
            await dbClient.queryOne('SELECT $1::text as a, $2::text as b;', ['val1'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        } catch (e) {
            pgMismatchError = e.message;
        }
        console.log(' - PostgreSQL result with 2 placeholders and 1 parameter (Error):', pgMismatchError);
        auditResults.paramCountMismatchBehavior = {
            sqliteBindsNullSilently: sqliteRow.b === null,
            pgThrowsError: !!pgMismatchError
        };

        // ----------------------------------------------------------------
        // Check 3: Post-Transaction Context Reuse / Client Leak
        // ----------------------------------------------------------------
        console.log('\n--- Audit Check 3: Transaction Context Invalidation After Completion ---');
        let leakedTx = null;
        await dbClient.transaction(async (tx) => {
            leakedTx = tx;
            await tx.queryOne('SELECT 1 as num;');
        }, { engine: 'postgres', dbNameOverride: 'zarsev_test' });

        try {
            const postTxRes = await leakedTx.queryOne('SELECT 99 as num;');
            if (postTxRes && postTxRes.num === 99) {
                auditResults.postTxClientAccessible = true;
                console.log(' ⚠️ FINDING CONFIRMED: Leaked transaction context successfully executed query on released pool client!');
            }
        } catch (e) {
            console.log(' - Transaction client threw on post-completion access:', e.message);
        }

        // ----------------------------------------------------------------
        // Check 4: SQLite Parallel Transaction Collision
        // ----------------------------------------------------------------
        console.log('\n--- Audit Check 4: SQLite Parallel Transactions on Shared Connection ---');
        const sharedSqlite = new DatabaseSync(':memory:');
        sharedSqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT);');

        const p1 = dbClient.transaction(async (tx) => {
            await tx.execute('INSERT INTO items (v) VALUES (?)', ['p1_start'], { customDb: sharedSqlite });
            await new Promise(r => setTimeout(r, 40));
            await tx.execute('INSERT INTO items (v) VALUES (?)', ['p1_end'], { customDb: sharedSqlite });
        }, { engine: 'sqlite', customDb: sharedSqlite });

        const p2 = dbClient.transaction(async (tx) => {
            await tx.execute('INSERT INTO items (v) VALUES (?)', ['p2_direct'], { customDb: sharedSqlite });
        }, { engine: 'sqlite', customDb: sharedSqlite });

        try {
            await Promise.all([p1, p2]);
            console.log(' - Parallel transactions both completed without collision.');
        } catch (e) {
            if (e.message.includes('cannot start a transaction within a transaction')) {
                auditResults.sqliteParallelTxCollision = true;
                console.log(' ⚠️ FINDING CONFIRMED: SQLite parallel transactions collided with:', e.message);
            }
        }

        // ----------------------------------------------------------------
        // Check 5: Data Type Mapping Asymmetries
        // ----------------------------------------------------------------
        console.log('\n--- Audit Check 5: Cross-Engine Data Type Asymmetries ---');

        // Setup test tables in SQLite and PostgreSQL
        const dtSqlite = new DatabaseSync(':memory:');
        dtSqlite.exec('CREATE TABLE dt_test (is_flag INTEGER, data TEXT, amount REAL);');
        dtSqlite.prepare('INSERT INTO dt_test VALUES (?, ?, ?);').run(1, JSON.stringify({ key: 'val' }), 123.45);
        const dtSqliteRow = dtSqlite.prepare('SELECT * FROM dt_test;').get();

        const migrator = pgAdapter.getMigratorClient('zarsev_test');
        await migrator.connect();
        await migrator.query(`
            DROP TABLE IF EXISTS _test_dt_audit;
            CREATE TABLE _test_dt_audit (
                custom_pk SERIAL PRIMARY KEY,
                is_flag BOOLEAN,
                data JSONB,
                amount NUMERIC(10, 2)
            );
            INSERT INTO _test_dt_audit (is_flag, data, amount) VALUES (TRUE, '{"key": "val"}'::jsonb, 123.45);
        `);
        await migrator.end();

        const dtPgRow = await dbClient.queryOne('SELECT * FROM _test_dt_audit;', [], { engine: 'postgres', dbNameOverride: 'zarsev_test' });

        // Boolean:
        console.log(` - Boolean return: SQLite=${typeof dtSqliteRow.is_flag} (${dtSqliteRow.is_flag}) vs PG=${typeof dtPgRow.is_flag} (${dtPgRow.is_flag})`);
        auditResults.booleanReturnAsymmetry = typeof dtSqliteRow.is_flag !== typeof dtPgRow.is_flag;

        // JSON:
        console.log(` - JSON return: SQLite=${typeof dtSqliteRow.data} (${dtSqliteRow.data}) vs PG=${typeof dtPgRow.data} (${JSON.stringify(dtPgRow.data)})`);
        auditResults.jsonReturnAsymmetry = typeof dtSqliteRow.data !== typeof dtPgRow.data;

        // Numeric:
        console.log(` - Numeric return: SQLite=${typeof dtSqliteRow.amount} (${dtSqliteRow.amount}) vs PG=${typeof dtPgRow.amount} (${dtPgRow.amount})`);
        auditResults.numericReturnAsymmetry = typeof dtSqliteRow.amount !== typeof dtPgRow.amount;

        // ----------------------------------------------------------------
        // Check 6: RETURNING Clause with Non-"id" Column
        // ----------------------------------------------------------------
        console.log('\n--- Audit Check 6: RETURNING Clause with Custom Primary Key ---');
        const retRes = await dbClient.execute(
            'INSERT INTO _test_dt_audit (is_flag, data, amount) VALUES (FALSE, null, 10.00) RETURNING custom_pk;',
            [],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        console.log(' - Execution metadata with RETURNING custom_pk:', {
            rowCount: retRes.rowCount,
            lastInsertRowid: retRes.lastInsertRowid,
            rows: retRes.rows
        });
        auditResults.nonIdReturningHandled = retRes.lastInsertRowid !== null;
        if (retRes.lastInsertRowid === null && retRes.rows.length > 0) {
            console.log(' ⚠️ FINDING CONFIRMED: lastInsertRowid is null because column is custom_pk instead of id.');
        }

        // ----------------------------------------------------------------
        // Check 7: Rollback Error Loss in DbError
        // ----------------------------------------------------------------
        console.log('\n--- Audit Check 7: Rollback Error Preservation in DbError ---');
        const baseErr = new Error('Base query failed');
        baseErr.savepointRollbackError = new Error('Savepoint rollback failed');
        baseErr.rollbackError = new Error('Outer rollback failed');

        const wrappedErr = new dbClient.DbError(baseErr.message, {
            originalError: baseErr,
            engine: 'postgres'
        });

        auditResults.rollbackErrorPreservedInDbError = !!(wrappedErr.savepointRollbackError || wrappedErr.rollbackError);
        console.log(' - Are rollback errors attached directly on DbError?', auditResults.rollbackErrorPreservedInDbError);
        if (!auditResults.rollbackErrorPreservedInDbError) {
            console.log(' ⚠️ FINDING CONFIRMED: DbError constructor did not preserve savepointRollbackError or rollbackError.');
        }

    } finally {
        // Clean up probe tables
        const cleanupMigrator = pgAdapter.getMigratorClient('zarsev_test');
        try {
            await cleanupMigrator.connect();
            await cleanupMigrator.query('DROP TABLE IF EXISTS _test_dt_audit;');
            await cleanupMigrator.end();
        } catch (_) {}

        await pgAdapter.closePool();
        if (fs.existsSync(TEST_SQLITE_PATH)) {
            try { fs.unlinkSync(TEST_SQLITE_PATH); } catch (_) {}
        }
    }

    // Post checks
    const postSnap = captureSnapshot();
    assert.strictEqual(postSnap['zarsev.db'].sha, 'BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB');
    const postPgCounts = await capturePgBusinessCounts();
    assert.strictEqual(postPgCounts.total, 342);
    await pgAdapter.closePool();

    console.log('\n================================================================');
    console.log('📊 AUDIT SUMMARY METRICS:');
    console.log(JSON.stringify(auditResults, null, 2));
    console.log('================================================================\n');

    return auditResults;
}

runAuditTests().catch(err => {
    console.error('Audit test crashed:', err);
    process.exit(1);
});
