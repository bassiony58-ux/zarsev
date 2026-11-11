/**
 * test/test_phase2_4_2_5_fixes.js
 * 
 * ZARSEV — Phase 2.4.2.5: Targeted Critical Fixes Comprehensive Test Suite
 * 
 * Verifies:
 * 1. Finding 1: SQLite Shared-Connection Read Isolation
 *    - Test A: External queryOne during active T1 waits until COMMIT
 *    - Test B: External queryAll during active T1 waits until COMMIT
 *    - Test C: External queryOne & queryAll during ROLLBACK wait and do not observe uncommitted records
 *    - Test D: External execute waits until transaction completes
 *    - Test E: Nested savepoints do not deadlock or re-acquire mutex incorrectly
 *    - Test F: Failed query or rejected transaction cleanly releases mutex
 *    - Test G: Two independent callers cannot execute inside each other's transactions
 * 
 * 2. Finding 2: PostgreSQL Numbered-Parameter Detection & Ignored $N in Literals
 *    - Single-quoted string with '$100' and positional ?
 *    - Single-quoted string with '$999' and native $1
 *    - Sequential $1 and $2
 *    - Repeated $1
 *    - $N inside E-strings and comments
 *    - $N inside dollar-quoted strings
 *    - JSONB ?, ?|, ?& operators
 *    - Mixed JSONB operators and actual parameters
 *    - Missing and extra parameter validation
 * 
 * 3. Integrity verification of SQLite hashes and zarsev_test 342 records
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

const TEST_SQLITE_PATH = path.join(SANDBOX_DIR, `fixes_test_${Date.now()}_${process.pid}.db`);
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

async function runTests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Phase 2.4.2.5: Targeted Critical Fixes Test Suite');
    console.log('================================================================\n');

    const preSnap = captureSnapshot();
    assert.strictEqual(preSnap['zarsev.db'].sha, 'BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB');
    const prePgCounts = await capturePgBusinessCounts();
    assert.strictEqual(prePgCounts.total, 342);

    // Setup isolated SQLite database on a SINGLE shared connection
    const sharedSqlite = new DatabaseSync(TEST_SQLITE_PATH);
    sharedSqlite.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE test_shared_items (
            id INTEGER PRIMARY KEY,
            title TEXT,
            amount REAL
        );
    `);

    try {
        // =====================================================================
        // FINDING 1: SQLite Shared-Connection Read Isolation Tests
        // =====================================================================
        console.log('--- 🧪 Finding 1: SQLite Shared-Connection Read Isolation ---');

        // Test A: External queryOne during active T1 waits until COMMIT
        console.log('\n--- Test A: External queryOne during active T1 waits until COMMIT ---');
        const eventsA = [];
        let t1CommittedTimeA = 0;
        let extReadCompletedTimeA = 0;
        let extRowA = null;

        const t1PromiseA = dbClient.transaction(async (tx) => {
            eventsA.push({ time: Date.now(), event: 'T1_START' });
            await tx.execute('INSERT INTO test_shared_items (id, title, amount) VALUES (?, ?, ?);', [1, 't1_uncommitted', 10.0], { customDb: sharedSqlite });
            eventsA.push({ time: Date.now(), event: 'T1_INSERTED' });
            
            await new Promise(r => setTimeout(r, 80));
            t1CommittedTimeA = Date.now();
            eventsA.push({ time: t1CommittedTimeA, event: 'T1_COMMITTING' });
        }, { engine: 'sqlite', customDb: sharedSqlite });

        await new Promise(r => setTimeout(r, 20));
        eventsA.push({ time: Date.now(), event: 'EXT_QUERYONE_TRIGGERED' });
        extRowA = await dbClient.queryOne('SELECT * FROM test_shared_items WHERE id = ?;', [1], { engine: 'sqlite', customDb: sharedSqlite });
        extReadCompletedTimeA = Date.now();
        eventsA.push({ time: extReadCompletedTimeA, event: 'EXT_QUERYONE_RETURNED', row: extRowA });

        await t1PromiseA;
        eventsA.forEach(e => console.log(` [${e.time}] ${e.event}`, e.row ? JSON.stringify(e.row) : ''));
        assert.ok(extReadCompletedTimeA >= t1CommittedTimeA, 'External queryOne must complete AFTER T1 commits');
        assert.ok(extRowA, 'External queryOne must observe committed record');
        assert.strictEqual(extRowA.title, 't1_uncommitted');
        console.log('✓ Test A Passed: External queryOne waited for COMMIT and observed committed row.');

        // Test B: External queryAll during active T1 waits until COMMIT
        console.log('\n--- Test B: External queryAll during active T1 waits until COMMIT ---');
        const eventsB = [];
        let t1CommittedTimeB = 0;
        let extReadCompletedTimeB = 0;
        let extRowsB = null;

        const t1PromiseB = dbClient.transaction(async (tx) => {
            eventsB.push({ time: Date.now(), event: 'T1_START' });
            await tx.execute('INSERT INTO test_shared_items (id, title, amount) VALUES (?, ?, ?);', [2, 't1_uncommitted_2', 20.0], { customDb: sharedSqlite });
            eventsB.push({ time: Date.now(), event: 'T1_INSERTED' });
            
            await new Promise(r => setTimeout(r, 80));
            t1CommittedTimeB = Date.now();
            eventsB.push({ time: t1CommittedTimeB, event: 'T1_COMMITTING' });
        }, { engine: 'sqlite', customDb: sharedSqlite });

        await new Promise(r => setTimeout(r, 20));
        eventsB.push({ time: Date.now(), event: 'EXT_QUERYALL_TRIGGERED' });
        extRowsB = await dbClient.queryAll('SELECT * FROM test_shared_items WHERE id = ?;', [2], { engine: 'sqlite', customDb: sharedSqlite });
        extReadCompletedTimeB = Date.now();
        eventsB.push({ time: extReadCompletedTimeB, event: 'EXT_QUERYALL_RETURNED', count: extRowsB.length });

        await t1PromiseB;
        eventsB.forEach(e => console.log(` [${e.time}] ${e.event}`));
        assert.ok(extReadCompletedTimeB >= t1CommittedTimeB, 'External queryAll must complete AFTER T1 commits');
        assert.strictEqual(extRowsB.length, 1);
        assert.strictEqual(extRowsB[0].title, 't1_uncommitted_2');
        console.log('✓ Test B Passed: External queryAll waited for COMMIT and observed committed rows.');

        // Test C: External queryOne & queryAll during ROLLBACK wait and do not observe uncommitted records
        console.log('\n--- Test C: External queryOne & queryAll during ROLLBACK ---');
        const eventsC = [];
        let t1RollbackTimeC = 0;
        let extRowC = null;
        let extRowsC = null;

        const t1PromiseC = (async () => {
            try {
                await dbClient.transaction(async (tx) => {
                    eventsC.push({ time: Date.now(), event: 'T1_START' });
                    await tx.execute('INSERT INTO test_shared_items (id, title, amount) VALUES (?, ?, ?);', [3, 'to_be_aborted', 30.0], { customDb: sharedSqlite });
                    eventsC.push({ time: Date.now(), event: 'T1_INSERTED' });
                    await new Promise(r => setTimeout(r, 80));
                    t1RollbackTimeC = Date.now();
                    eventsC.push({ time: t1RollbackTimeC, event: 'T1_THROWING_ERROR' });
                    throw new Error('Simulated T1 Abort');
                }, { engine: 'sqlite', customDb: sharedSqlite });
            } catch (err) {
                eventsC.push({ time: Date.now(), event: 'T1_ROLLED_BACK' });
            }
        })();

        await new Promise(r => setTimeout(r, 20));
        eventsC.push({ time: Date.now(), event: 'EXT_READS_TRIGGERED' });
        const [qOneRes, qAllRes] = await Promise.all([
            dbClient.queryOne('SELECT * FROM test_shared_items WHERE id = ?;', [3], { engine: 'sqlite', customDb: sharedSqlite }),
            dbClient.queryAll('SELECT * FROM test_shared_items WHERE id = ?;', [3], { engine: 'sqlite', customDb: sharedSqlite })
        ]);
        const extReadsDoneTimeC = Date.now();
        eventsC.push({ time: extReadsDoneTimeC, event: 'EXT_READS_COMPLETED', qOneRes, qAllCount: qAllRes.length });

        await t1PromiseC;
        eventsC.forEach(e => console.log(` [${e.time}] ${e.event}`, e.qOneRes !== undefined ? `qOne=${e.qOneRes}, qAll=${e.qAllCount}` : ''));
        assert.ok(extReadsDoneTimeC >= t1RollbackTimeC, 'External reads must complete AFTER rollback finishes');
        assert.strictEqual(qOneRes, null, 'External queryOne must NOT observe aborted uncommitted record');
        assert.strictEqual(qAllRes.length, 0, 'External queryAll must return empty array for aborted record');
        console.log('✓ Test C Passed: External reads waited until ROLLBACK completed and observed 0 dirty records.');

        // Test D: External execute waits until transaction completes
        console.log('\n--- Test D: External execute waits until transaction completes ---');
        const eventsD = [];
        let t1CommitTimeD = 0;
        let extExecDoneTimeD = 0;

        const t1PromiseD = dbClient.transaction(async (tx) => {
            eventsD.push({ time: Date.now(), event: 'T1_START' });
            await tx.execute('INSERT INTO test_shared_items (id, title, amount) VALUES (?, ?, ?);', [4, 't1_row_4', 40.0], { customDb: sharedSqlite });
            await new Promise(r => setTimeout(r, 80));
            t1CommitTimeD = Date.now();
            eventsD.push({ time: t1CommitTimeD, event: 'T1_COMMITTING' });
        }, { engine: 'sqlite', customDb: sharedSqlite });

        await new Promise(r => setTimeout(r, 20));
        eventsD.push({ time: Date.now(), event: 'EXT_EXECUTE_TRIGGERED' });
        await dbClient.execute('INSERT INTO test_shared_items (id, title, amount) VALUES (?, ?, ?);', [5, 'ext_row_5', 50.0], { engine: 'sqlite', customDb: sharedSqlite });
        extExecDoneTimeD = Date.now();
        eventsD.push({ time: extExecDoneTimeD, event: 'EXT_EXECUTE_COMPLETED' });

        await t1PromiseD;
        eventsD.forEach(e => console.log(` [${e.time}] ${e.event}`));
        assert.ok(extExecDoneTimeD >= t1CommitTimeD, 'External execute must complete AFTER T1 commits');
        console.log('✓ Test D Passed: External execute waited until T1 finished.');

        // Test E: Nested savepoints do not deadlock
        console.log('\n--- Test E: Nested savepoints do not deadlock ---');
        await dbClient.transaction(async (outerTx) => {
            await outerTx.execute('INSERT INTO test_shared_items (id, title) VALUES (?, ?);', [6, 'outer_row'], { customDb: sharedSqlite });
            
            await outerTx.transaction(async (innerTx1) => {
                await innerTx1.execute('INSERT INTO test_shared_items (id, title) VALUES (?, ?);', [7, 'inner_row_1'], { customDb: sharedSqlite });
            });

            try {
                await outerTx.transaction(async (innerTx2) => {
                    await innerTx2.execute('INSERT INTO test_shared_items (id, title) VALUES (?, ?);', [8, 'inner_row_2_aborted'], { customDb: sharedSqlite });
                    throw new Error('Savepoint rollback test');
                });
            } catch (_) {}

            await outerTx.execute('INSERT INTO test_shared_items (id, title) VALUES (?, ?);', [9, 'outer_row_after'], { customDb: sharedSqlite });
        }, { engine: 'sqlite', customDb: sharedSqlite });

        const r6 = await dbClient.queryOne('SELECT * FROM test_shared_items WHERE id = 6;', [], { engine: 'sqlite', customDb: sharedSqlite });
        const r7 = await dbClient.queryOne('SELECT * FROM test_shared_items WHERE id = 7;', [], { engine: 'sqlite', customDb: sharedSqlite });
        const r8 = await dbClient.queryOne('SELECT * FROM test_shared_items WHERE id = 8;', [], { engine: 'sqlite', customDb: sharedSqlite });
        const r9 = await dbClient.queryOne('SELECT * FROM test_shared_items WHERE id = 9;', [], { engine: 'sqlite', customDb: sharedSqlite });
        assert.ok(r6);
        assert.ok(r7);
        assert.strictEqual(r8, null, 'Aborted savepoint must not be present');
        assert.ok(r9);
        console.log('✓ Test E Passed: Nested savepoints executed without deadlock; rollback isolated.');

        // Test F: Failed query or rejected transaction cleanly releases mutex
        console.log('\n--- Test F: Failed query or rejected transaction releases mutex ---');
        let errCaughtF = false;
        try {
            await dbClient.transaction(async (tx) => {
                await tx.execute('INVALID SQL SYNTAX HERE;', [], { customDb: sharedSqlite });
            }, { engine: 'sqlite', customDb: sharedSqlite });
        } catch (e) {
            errCaughtF = true;
        }
        assert.ok(errCaughtF, 'Transaction failure must throw');

        // Subsequent query must succeed immediately
        const postFailRes = await dbClient.queryOne('SELECT 1 as alive;', [], { engine: 'sqlite', customDb: sharedSqlite });
        assert.strictEqual(postFailRes.alive, 1);
        console.log('✓ Test F Passed: Mutex was cleanly released after query error.');

        // Test G: Two independent callers cannot execute inside each other's transactions
        console.log('\n--- Test G: Caller isolation on shared connection ---');
        const callerEvents = [];
        const caller1 = dbClient.transaction(async (tx1) => {
            callerEvents.push('C1_START');
            await tx1.execute('INSERT INTO test_shared_items (id, title) VALUES (?, ?);', [10, 'c1'], { customDb: sharedSqlite });
            await new Promise(r => setTimeout(r, 40));
            callerEvents.push('C1_END');
        }, { engine: 'sqlite', customDb: sharedSqlite });

        const caller2 = dbClient.transaction(async (tx2) => {
            callerEvents.push('C2_START');
            await tx2.execute('INSERT INTO test_shared_items (id, title) VALUES (?, ?);', [11, 'c2'], { customDb: sharedSqlite });
            callerEvents.push('C2_END');
        }, { engine: 'sqlite', customDb: sharedSqlite });

        await Promise.all([caller1, caller2]);
        console.log('Caller sequence:', callerEvents.join(' -> '));
        assert.deepStrictEqual(callerEvents, ['C1_START', 'C1_END', 'C2_START', 'C2_END']);
        console.log('✓ Test G Passed: Callers strictly serialized without cross-talk.');

        // =====================================================================
        // FINDING 2: PostgreSQL Numbered-Parameter Detection & Ignored $N
        // =====================================================================
        console.log('\n--- 🧪 Finding 2: PostgreSQL Numbered-Parameter Detection ---');

        // 1. Single-quoted string with '$100' and positional ?
        const q2_1 = "SELECT 'Total cost is $100' as txt, ?::int as id";
        const r2_1 = await dbClient.queryOne(q2_1, [1], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_1.txt, 'Total cost is $100');
        assert.strictEqual(r2_1.id, 1);
        console.log("✓ Test 2.1 Passed: 'Total cost is $100' with ?::int -> converted and bound successfully.");

        // 2. Single-quoted string with '$999' and native $1
        const q2_2 = "SELECT '$999' as price, $1::int as item_id";
        const r2_2 = await dbClient.queryOne(q2_2, [55], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_2.price, '$999');
        assert.strictEqual(r2_2.item_id, 55);
        console.log("✓ Test 2.2 Passed: '$999' with native $1 -> maxNumbered=1, bound successfully.");

        // 3. Sequential $1 and $2
        const q2_3 = "SELECT $1::text as first_name, $2::text as last_name";
        const r2_3 = await dbClient.queryOne(q2_3, ['John', 'Doe'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_3.first_name, 'John');
        assert.strictEqual(r2_3.last_name, 'Doe');
        console.log("✓ Test 2.3 Passed: Sequential $1 and $2 bound successfully.");

        // 4. Repeated $1
        const q2_4 = "SELECT $1::int as a, ($1::int * 2) as b";
        const r2_4 = await dbClient.queryOne(q2_4, [21], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_4.a, 21);
        assert.strictEqual(r2_4.b, 42);
        console.log("✓ Test 2.4 Passed: Repeated $1 bound once and referenced twice.");

        // 5. $N inside E-strings and comments
        const q2_5 = `
            SELECT 
                E'Discount of $50 applied' as e_str,
                -- Line comment with $25
                /* Block comment with $75 */
                ?::text as code;
        `;
        const r2_5 = await dbClient.queryOne(q2_5, ['PROMO2026'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_5.e_str, 'Discount of $50 applied');
        assert.strictEqual(r2_5.code, 'PROMO2026');
        console.log("✓ Test 2.5 Passed: $N inside E-strings and comments strictly ignored.");

        // 6. $N inside dollar-quoted strings
        const q2_6 = "SELECT $$ value is $500 in dollar quotes $$ as dq, ?::int as num";
        const r2_6 = await dbClient.queryOne(q2_6, [77], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.ok(r2_6.dq.includes('$500'));
        assert.strictEqual(r2_6.num, 77);
        console.log("✓ Test 2.6 Passed: $N inside dollar-quoted strings ignored.");

        // 7. JSONB ?, ?|, ?& operators
        const q2_7 = "SELECT '{\"a\": 1}'::jsonb ? 'a' as has_a, '{\"a\": 1}'::jsonb ?| array['a', 'b'] as has_any, '{\"a\": 1}'::jsonb ?& array['a'] as has_all";
        const r2_7 = await dbClient.queryOne(q2_7, [], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_7.has_a, true);
        assert.strictEqual(r2_7.has_any, true);
        assert.strictEqual(r2_7.has_all, true);
        console.log("✓ Test 2.7 Passed: JSONB ?, ?|, ?& operators preserved.");

        // 8. Mixed JSONB operators and actual parameters
        const q2_8 = "SELECT '{\"dept\": \"hr\"}'::jsonb ? 'dept' as is_hr, ?::text as note";
        const r2_8 = await dbClient.queryOne(q2_8, ['approved'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(r2_8.is_hr, true);
        assert.strictEqual(r2_8.note, 'approved');
        console.log("✓ Test 2.8 Passed: Mixed JSONB operator and actual placeholder ? resolved.");

        // 9. Missing and extra parameters validation
        let missingErr = null;
        try {
            await dbClient.queryOne('SELECT $1::int as a, $2::int as b', [1], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        } catch (e) {
            missingErr = e;
        }
        assert.strictEqual(missingErr?.code, 'PARAM_COUNT_MISMATCH');

        let extraErr = null;
        try {
            await dbClient.queryOne('SELECT $1::int as a', [1, 2], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        } catch (e) {
            extraErr = e;
        }
        assert.strictEqual(extraErr?.code, 'PARAM_COUNT_MISMATCH');
        console.log("✓ Test 2.9 Passed: Missing and extra parameters strictly rejected with PARAM_COUNT_MISMATCH.");

    } finally {
        await pgAdapter.closePool();
        try { sharedSqlite.close(); } catch (_) {}
        if (fs.existsSync(TEST_SQLITE_PATH)) {
            try { fs.unlinkSync(TEST_SQLITE_PATH); } catch (_) {}
        }
    }

    // Baseline Immutability Check
    console.log('\n--- 🧪 Baseline Integrity Post-Check ---');
    const postSnap = captureSnapshot();
    for (const [name, meta] of Object.entries(postSnap)) {
        assert.strictEqual(meta.size, preSnap[name].size);
        assert.strictEqual(meta.sha, preSnap[name].sha);
        console.log(`✓ Immutability Verified: ${name} (SHA256=${meta.sha})`);
    }

    const postPgCounts = await capturePgBusinessCounts();
    assert.strictEqual(postPgCounts.total, 342);
    console.log('✓ Immutability Verified: All 342 records across 9 tables in zarsev_test are intact.');
    await pgAdapter.closePool();

    console.log('\n================================================================');
    console.log('🎉 ALL PHASE 2.4.2.5 TARGETED FIX TESTS PASSED (100%)!');
    console.log('================================================================');
}

runTests().catch(err => {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
});
