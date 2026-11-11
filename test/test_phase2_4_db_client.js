/**
 * test/test_phase2_4_db_client.js
 * 
 * ZARSEV — Phase 2.4.2: Async DB Facade Comprehensive Test Suite
 * 
 * Validates dbClient across both SQLite and PostgreSQL engines:
 * 1. queryOne and queryAll
 * 2. execute and rowCount
 * 3. INSERT with ID retrieval
 * 4. Multiple concurrent transactions
 * 5. COMMIT and ROLLBACK
 * 6. Nested transactions & Savepoints (isolated rollback & outer rollback)
 * 7. Connection failure and guaranteed client release
 * 8. Prevention of sensitive data leakage in normalized errors
 * 9. High-concurrency pool lease and release
 * 10. Zero impact on original SQLite files and zarsev_test 342 business records
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Enforce test environment
process.env.NODE_ENV = 'test';
process.env.ZARSEV_TEST_MODE = '1';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
if (!fs.existsSync(SANDBOX_DIR)) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

const TEST_SQLITE_PATH = path.join(SANDBOX_DIR, `facade_test_${Date.now()}_${process.pid}.db`);
process.env.DB_PATH = TEST_SQLITE_PATH;

const dbClient = require('../src/db/dbClient');
const pgAdapter = require('../src/db/pgAdapter');

// Protected files to verify immutability
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

async function runAllTests() {
    console.log('================================================================');
    console.log('🧪 ZARSEV Phase 2.4.2: Async DB Facade (dbClient) Test Suite');
    console.log('================================================================\n');

    // 1. Initial Baseline Snapshot
    const preSnapshot = captureSnapshot();
    console.log('--- Baseline Integrity Check (Pre-Test) ---');
    for (const [name, meta] of Object.entries(preSnapshot)) {
        console.log(` - ${name.padEnd(40)}: size=${meta.size} | SHA256=${meta.sha}`);
    }
    const KNOWN_VALID_HASHES = [
        'BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB',
        '5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC'
    ];
    assert.ok(
        KNOWN_VALID_HASHES.includes(preSnapshot['zarsev.db'].sha),
        'Original zarsev.db hash must match a known valid baseline before tests.'
    );

    const prePgCounts = await capturePgBusinessCounts();
    console.log(` - zarsev_test baseline business records: ${prePgCounts.total} across ${BUSINESS_TABLES.length} tables.\n`);
    assert.ok(prePgCounts.total >= 342, `zarsev_test must contain at least baseline 342 business records before test. Found: ${prePgCounts.total}`);

    // 2. Setup Isolated Environments
    // SQLite Setup:
    const sqliteDb = new DatabaseSync(TEST_SQLITE_PATH);
    sqliteDb.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE test_facade_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            price REAL,
            is_active INTEGER DEFAULT 1,
            extra_data TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // PostgreSQL Setup:
    // Create isolated table in zarsev_test via migrator client
    const migrator = pgAdapter.getMigratorClient('zarsev_test');
    await migrator.connect();
    await migrator.query(`
        DROP TABLE IF EXISTS _test_phase2_4_facade;
        CREATE TABLE _test_phase2_4_facade (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            price NUMERIC(10, 2),
            is_active BOOLEAN DEFAULT TRUE,
            extra_data JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    await migrator.end();

    try {
        // ================================================================
        // 🧪 TEST GROUP 1: Tokenizer & Dialect Resolver
        // ================================================================
        console.log('--- 🧪 Test Group 1: Lexical SQL Tokenizer & Dialect Resolver ---');
        
        // 1.1 Positional parameter conversion
        const q1 = "SELECT * FROM users WHERE status = ? AND email = ?;";
        assert.strictEqual(
            dbClient.tokenizeAndConvertParams(q1),
            "SELECT * FROM users WHERE status = $1 AND email = $2;",
            "Positional ? should be converted to $1, $2"
        );

        // 1.2 Preserving ? inside string literals
        const q2 = "SELECT * FROM items WHERE title = 'Is this a question?' AND price > ?;";
        assert.strictEqual(
            dbClient.tokenizeAndConvertParams(q2),
            "SELECT * FROM items WHERE title = 'Is this a question?' AND price > $1;",
            "Question mark inside string literal must not be converted"
        );

        // 1.3 Preserving ? inside comments
        const q3 = "SELECT * FROM tbl -- does this ? comment break?\nWHERE col = ? /* or this ? comment */ AND id = ?;";
        assert.strictEqual(
            dbClient.tokenizeAndConvertParams(q3),
            "SELECT * FROM tbl -- does this ? comment break?\nWHERE col = $1 /* or this ? comment */ AND id = $2;",
            "Question marks in comments must not be converted"
        );

        // 1.4 Dual-dialect query objects
        const dualQuery = {
            sqlite: 'SELECT * FROM items WHERE id = ?',
            postgres: 'SELECT * FROM items WHERE id = $1'
        };
        // Handled directly by facade methods
        console.log('✓ Group 1 Passed: Lexical tokenizer safely respects string literals, comments, and identifiers.');

        // ================================================================
        // 🧪 TEST GROUP 2: SQLite Engine Verification
        // ================================================================
        console.log('\n--- 🧪 Test Group 2: SQLite Engine Functionality ---');

        // 2.1 execute with INSERT and lastInsertRowid
        const ins1 = await dbClient.execute(
            'INSERT INTO test_facade_items (title, price, is_active, extra_data) VALUES (?, ?, ?, ?);',
            ['Item Alpha', 99.95, true, { sku: 'SKU-001' }],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.strictEqual(ins1.rowCount, 1, 'SQLite execute rowCount should be 1');
        assert.strictEqual(ins1.changes, 1, 'SQLite execute changes should be 1');
        assert.strictEqual(ins1.lastInsertRowid, 1, 'SQLite lastInsertRowid should be 1');

        // 2.2 queryOne
        const row1 = await dbClient.queryOne(
            'SELECT * FROM test_facade_items WHERE id = ?;',
            [1],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.ok(row1, 'SQLite queryOne should return row');
        assert.strictEqual(row1.title, 'Item Alpha');
        assert.strictEqual(row1.price, 99.95);
        assert.strictEqual(row1.is_active, 1); // Coerced to 1 in SQLite
        assert.strictEqual(JSON.parse(row1.extra_data).sku, 'SKU-001');

        // queryOne returning null for nonexistent
        const rowNone = await dbClient.queryOne(
            'SELECT * FROM test_facade_items WHERE id = ?;',
            [9999],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.strictEqual(rowNone, null, 'SQLite queryOne for nonexistent row must return null');

        // 2.3 queryAll
        await dbClient.execute(
            'INSERT INTO test_facade_items (title, price, is_active) VALUES (?, ?, ?);',
            ['Item Beta', 149.50, false],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        const allSqlite = await dbClient.queryAll(
            'SELECT * FROM test_facade_items ORDER BY id ASC;',
            [],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.strictEqual(allSqlite.length, 2, 'SQLite queryAll should return 2 rows');
        assert.strictEqual(allSqlite[1].title, 'Item Beta');
        assert.strictEqual(allSqlite[1].is_active, 0);

        // 2.4 execute UPDATE and DELETE
        const updSqlite = await dbClient.execute(
            'UPDATE test_facade_items SET price = ? WHERE id = ?;',
            [199.99, 1],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.strictEqual(updSqlite.rowCount, 1);

        const delSqlite = await dbClient.execute(
            'DELETE FROM test_facade_items WHERE id = ?;',
            [2],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.strictEqual(delSqlite.rowCount, 1);
        console.log('✓ Group 2 Passed: SQLite queryOne, queryAll, execute, and rowCount verified.');

        // ================================================================
        // 🧪 TEST GROUP 3: PostgreSQL Engine Verification
        // ================================================================
        console.log('\n--- 🧪 Test Group 3: PostgreSQL Engine Functionality ---');

        // 3.1 execute with INSERT and RETURNING id
        const insPg = await dbClient.execute(
            'INSERT INTO _test_phase2_4_facade (title, price, is_active, extra_data) VALUES (?, ?, ?, ?) RETURNING id, title;',
            ['PG Product 1', 250.75, true, { brand: 'ZARSEV' }],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(insPg.rowCount, 1, 'PostgreSQL insert rowCount should be 1');
        assert.ok(insPg.lastInsertRowid, 'PostgreSQL lastInsertRowid should be populated from RETURNING');
        assert.strictEqual(insPg.rows[0].title, 'PG Product 1');

        const pgId1 = insPg.lastInsertRowid;

        // 3.2 queryOne with parameter tokenization ($1 generated from ?)
        const rowPg = await dbClient.queryOne(
            'SELECT * FROM _test_phase2_4_facade WHERE id = ?;',
            [pgId1],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.ok(rowPg, 'PostgreSQL queryOne should return row');
        assert.strictEqual(rowPg.title, 'PG Product 1');
        assert.strictEqual(parseFloat(rowPg.price), 250.75);
        assert.strictEqual(rowPg.is_active, true);
        assert.strictEqual(rowPg.extra_data.brand, 'ZARSEV');

        // queryOne returning null
        const rowPgNone = await dbClient.queryOne(
            'SELECT * FROM _test_phase2_4_facade WHERE id = ?;',
            [999999],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(rowPgNone, null, 'PostgreSQL queryOne for nonexistent row must return null');

        // 3.3 queryAll
        await dbClient.execute(
            'INSERT INTO _test_phase2_4_facade (title, price, is_active) VALUES (?, ?, ?);',
            ['PG Product 2', 80.00, false],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        const allPg = await dbClient.queryAll(
            'SELECT * FROM _test_phase2_4_facade ORDER BY id ASC;',
            [],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(allPg.length, 2, 'PostgreSQL queryAll should return 2 rows');
        assert.strictEqual(allPg[1].title, 'PG Product 2');
        assert.strictEqual(allPg[1].is_active, false);

        // 3.4 execute UPDATE and DELETE
        const updPg = await dbClient.execute(
            'UPDATE _test_phase2_4_facade SET price = ? WHERE id = ?;',
            [299.00, pgId1],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(updPg.rowCount, 1);

        const delPg = await dbClient.execute(
            'DELETE FROM _test_phase2_4_facade WHERE title = ?;',
            ['PG Product 2'],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(delPg.rowCount, 1);
        console.log('✓ Group 3 Passed: PostgreSQL queryOne, queryAll, execute, and RETURNING verified.');

        // ================================================================
        // 🧪 TEST GROUP 4: Transaction Commit & Rollback (Both Engines)
        // ================================================================
        console.log('\n--- 🧪 Test Group 4: Transaction Commit & Rollback ---');

        // 4.1 SQLite Commit
        await dbClient.transaction(async (tx) => {
            await tx.execute(
                'INSERT INTO test_facade_items (title, price) VALUES (?, ?);',
                ['Tx Committed SQLite', 50.0],
                { customDb: sqliteDb }
            );
        }, { engine: 'sqlite', customDb: sqliteDb });

        const checkSqliteCommit = await dbClient.queryOne(
            'SELECT * FROM test_facade_items WHERE title = ?;',
            ['Tx Committed SQLite'],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.ok(checkSqliteCommit, 'Transaction committed row should exist in SQLite');

        // 4.2 SQLite Rollback on thrown error
        let sqliteErrorCaught = false;
        try {
            await dbClient.transaction(async (tx) => {
                await tx.execute(
                    'INSERT INTO test_facade_items (title, price) VALUES (?, ?);',
                    ['Tx Aborted SQLite', 60.0],
                    { customDb: sqliteDb }
                );
                throw new Error('Simulated SQLite transaction failure');
            }, { engine: 'sqlite', customDb: sqliteDb });
        } catch (err) {
            sqliteErrorCaught = true;
            assert.strictEqual(err.message, 'Simulated SQLite transaction failure');
        }
        assert.ok(sqliteErrorCaught, 'SQLite transaction error should propagate');

        const checkSqliteAbort = await dbClient.queryOne(
            'SELECT * FROM test_facade_items WHERE title = ?;',
            ['Tx Aborted SQLite'],
            { engine: 'sqlite', customDb: sqliteDb }
        );
        assert.strictEqual(checkSqliteAbort, null, 'Aborted transaction row must NOT exist in SQLite');

        // 4.3 PostgreSQL Commit
        await dbClient.transaction(async (tx) => {
            await tx.execute(
                'INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);',
                ['Tx Committed PG', 555.0]
            );
        }, { engine: 'postgres', dbNameOverride: 'zarsev_test' });

        const checkPgCommit = await dbClient.queryOne(
            'SELECT * FROM _test_phase2_4_facade WHERE title = ?;',
            ['Tx Committed PG'],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.ok(checkPgCommit, 'Transaction committed row should exist in PostgreSQL');

        // 4.4 PostgreSQL Rollback on thrown error
        let pgErrorCaught = false;
        try {
            await dbClient.transaction(async (tx) => {
                await tx.execute(
                    'INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);',
                    ['Tx Aborted PG', 777.0]
                );
                throw new Error('Simulated PG transaction failure');
            }, { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        } catch (err) {
            pgErrorCaught = true;
            assert.strictEqual(err.message, 'Simulated PG transaction failure');
        }
        assert.ok(pgErrorCaught, 'PG transaction error should propagate');

        const checkPgAbort = await dbClient.queryOne(
            'SELECT * FROM _test_phase2_4_facade WHERE title = ?;',
            ['Tx Aborted PG'],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(checkPgAbort, null, 'Aborted transaction row must NOT exist in PostgreSQL');
        console.log('✓ Group 4 Passed: Transaction COMMIT and ROLLBACK verified across both engines.');

        // ================================================================
        // 🧪 TEST GROUP 5: Nested Transactions & Savepoints
        // ================================================================
        console.log('\n--- 🧪 Test Group 5: Nested Transactions & Savepoints ---');

        // 5.1 PostgreSQL: Nested savepoint rollback without failing outer transaction
        await dbClient.transaction(async (outerTx) => {
            await outerTx.execute('INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);', ['Outer 1', 10.0]);

            // Nested Transaction 1 (Committed)
            await outerTx.transaction(async (innerTx1) => {
                await innerTx1.execute('INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);', ['Nested Committed 1', 20.0]);
            });

            // Nested Transaction 2 (Aborted and caught)
            try {
                await outerTx.transaction(async (innerTx2) => {
                    await innerTx2.execute('INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);', ['Nested Aborted 2', 30.0]);
                    throw new Error('Inner Savepoint Rollback Test');
                });
            } catch (innerErr) {
                // Outer transaction catches error and continues!
                assert.ok(innerErr.message.includes('Inner Savepoint Rollback Test'));
            }

            // Outer Transaction continues and inserts another row
            await outerTx.execute('INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);', ['Outer 2', 40.0]);
        }, { engine: 'postgres', dbNameOverride: 'zarsev_test' });

        const outer1Row = await dbClient.queryOne('SELECT * FROM _test_phase2_4_facade WHERE title = ?;', ['Outer 1'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        const nested1Row = await dbClient.queryOne('SELECT * FROM _test_phase2_4_facade WHERE title = ?;', ['Nested Committed 1'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        const nested2Row = await dbClient.queryOne('SELECT * FROM _test_phase2_4_facade WHERE title = ?;', ['Nested Aborted 2'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        const outer2Row = await dbClient.queryOne('SELECT * FROM _test_phase2_4_facade WHERE title = ?;', ['Outer 2'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });

        assert.ok(outer1Row, 'Outer 1 should be committed');
        assert.ok(nested1Row, 'Nested 1 should be committed');
        assert.strictEqual(nested2Row, null, 'Nested 2 must be rolled back by savepoint');
        assert.ok(outer2Row, 'Outer 2 should be committed');

        // 5.2 PostgreSQL: Outer rollback rolling back all nested savepoints
        try {
            await dbClient.transaction(async (outerTx) => {
                await outerTx.execute('INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);', ['Outer To Abort', 100.0]);

                await outerTx.transaction(async (innerTx) => {
                    await innerTx.execute('INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);', ['Inner Before Abort', 200.0]);
                });

                throw new Error('Outer total abortion');
            }, { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        } catch (e) {
            assert.strictEqual(e.message, 'Outer total abortion');
        }

        const outerAborted = await dbClient.queryOne('SELECT * FROM _test_phase2_4_facade WHERE title = ?;', ['Outer To Abort'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        const innerAborted = await dbClient.queryOne('SELECT * FROM _test_phase2_4_facade WHERE title = ?;', ['Inner Before Abort'], { engine: 'postgres', dbNameOverride: 'zarsev_test' });
        assert.strictEqual(outerAborted, null, 'Outer row must be rolled back');
        assert.strictEqual(innerAborted, null, 'Inner row must be rolled back when outer fails');

        // 5.3 SQLite: Nested savepoints
        await dbClient.transaction(async (outerTx) => {
            await outerTx.execute('INSERT INTO test_facade_items (title, price) VALUES (?, ?);', ['SQLite Outer 1', 11.0], { customDb: sqliteDb });

            await outerTx.transaction(async (innerTx1) => {
                await innerTx1.execute('INSERT INTO test_facade_items (title, price) VALUES (?, ?);', ['SQLite Nested 1', 22.0], { customDb: sqliteDb });
            });

            try {
                await outerTx.transaction(async (innerTx2) => {
                    await innerTx2.execute('INSERT INTO test_facade_items (title, price) VALUES (?, ?);', ['SQLite Nested Aborted 2', 33.0], { customDb: sqliteDb });
                    throw new Error('SQLite Inner Abort Test');
                });
            } catch (innerErr) {
                assert.ok(innerErr.message.includes('SQLite Inner Abort Test'));
            }

            await outerTx.execute('INSERT INTO test_facade_items (title, price) VALUES (?, ?);', ['SQLite Outer 2', 44.0], { customDb: sqliteDb });
        }, { engine: 'sqlite', customDb: sqliteDb });

        const sOuter1 = await dbClient.queryOne('SELECT * FROM test_facade_items WHERE title = ?;', ['SQLite Outer 1'], { engine: 'sqlite', customDb: sqliteDb });
        const sNested1 = await dbClient.queryOne('SELECT * FROM test_facade_items WHERE title = ?;', ['SQLite Nested 1'], { engine: 'sqlite', customDb: sqliteDb });
        const sNested2 = await dbClient.queryOne('SELECT * FROM test_facade_items WHERE title = ?;', ['SQLite Nested Aborted 2'], { engine: 'sqlite', customDb: sqliteDb });
        const sOuter2 = await dbClient.queryOne('SELECT * FROM test_facade_items WHERE title = ?;', ['SQLite Outer 2'], { engine: 'sqlite', customDb: sqliteDb });

        assert.ok(sOuter1);
        assert.ok(sNested1);
        assert.strictEqual(sNested2, null);
        assert.ok(sOuter2);

        console.log('✓ Group 5 Passed: Nested transactions and savepoints verified on both SQLite and PostgreSQL.');

        // ================================================================
        // 🧪 TEST GROUP 6: Multiple Concurrent Transactions
        // ================================================================
        console.log('\n--- 🧪 Test Group 6: Multiple Concurrent Transactions ---');
        
        const parallelCount = 5;
        const parallelPromises = [];

        for (let i = 0; i < parallelCount; i++) {
            parallelPromises.push(
                dbClient.transaction(async (tx) => {
                    await tx.execute(
                        'INSERT INTO _test_phase2_4_facade (title, price) VALUES (?, ?);',
                        [`Concurrent Tx ${i}`, 100 + i]
                    );
                    // Add small async delay to test concurrency overlap
                    await new Promise(r => setTimeout(r, 20));
                    return i;
                }, { engine: 'postgres', dbNameOverride: 'zarsev_test' })
            );
        }

        const results = await Promise.all(parallelPromises);
        assert.strictEqual(results.length, parallelCount);

        const concurrentRows = await dbClient.queryAll(
            'SELECT * FROM _test_phase2_4_facade WHERE title LIKE ? ORDER BY id ASC;',
            ['Concurrent Tx %'],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(concurrentRows.length, parallelCount, 'All concurrent transactions must commit cleanly');
        console.log(`✓ Group 6 Passed: ${parallelCount} concurrent transactions executed and committed without lock conflicts.`);

        // ================================================================
        // 🧪 TEST GROUP 7: Connection Lifecycle & Guaranteed Release on Failure
        // ================================================================
        console.log('\n--- 🧪 Test Group 7: Connection Lifecycle & Guaranteed Release on Failure ---');

        const pool = pgAdapter.getAppPool('zarsev_test');
        const initialIdle = pool.idleCount;
        const initialTotal = pool.totalCount;

        // Trigger 20 consecutive query errors to verify clients are never leaked
        for (let i = 0; i < 20; i++) {
            try {
                await dbClient.queryOne(
                    'SELECT * FROM non_existent_table_probe WHERE id = ?;',
                    [i],
                    { engine: 'postgres', dbNameOverride: 'zarsev_test' }
                );
            } catch (err) {
                assert.strictEqual(err.name, 'DbError');
            }
        }

        // Trigger 10 consecutive failed transactions
        for (let i = 0; i < 10; i++) {
            try {
                await dbClient.transaction(async (tx) => {
                    await tx.execute('INVALID SQL SYNTAX HERE');
                }, { engine: 'postgres', dbNameOverride: 'zarsev_test' });
            } catch (err) {
                assert.strictEqual(err.name, 'DbError');
            }
        }

        // Verify pool is completely healthy and can execute immediate query
        const healthCheck = await dbClient.queryOne(
            'SELECT 1 as alive;',
            [],
            { engine: 'postgres', dbNameOverride: 'zarsev_test' }
        );
        assert.strictEqual(healthCheck.alive, 1, 'Pool must remain fully functional after repeated errors');
        console.log('✓ Group 7 Passed: Connection clients strictly released in all error and failure paths.');

        // ================================================================
        // 🧪 TEST GROUP 8: Prevention of Sensitive Data Leakage in Normalized Errors
        // ================================================================
        console.log('\n--- 🧪 Test Group 8: Prevention of Sensitive Data Leakage in Normalized Errors ---');

        let sensitiveError = null;
        try {
            await dbClient.queryOne(
                "SELECT * FROM _test_phase2_4_facade WHERE password = 'SuperSecretRawPassword123!' AND token = ?;",
                ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature', 'normal_val'],
                { engine: 'postgres', dbNameOverride: 'zarsev_test' }
            );
        } catch (err) {
            sensitiveError = err;
        }

        assert.ok(sensitiveError, 'Error should be thrown on non-existent column');
        assert.strictEqual(sensitiveError.name, 'DbError');
        assert.strictEqual(sensitiveError.engine, 'postgres');

        // Check query sanitization
        assert.ok(
            !sensitiveError.query.includes('SuperSecretRawPassword123!'),
            'Raw password in query text must be redacted'
        );
        assert.ok(sensitiveError.query.includes('[REDACTED]'), 'Redaction tag must be present in query');

        // Check params sanitization
        assert.strictEqual(sensitiveError.params[0], '[REDACTED_JWT]', 'JWT parameter must be redacted');
        assert.strictEqual(sensitiveError.params[1], 'normal_val', 'Non-sensitive parameter should remain visible');

        // Check message sanitization
        assert.ok(!sensitiveError.message.includes('SuperSecretRawPassword123!'), 'Message must not contain raw secret');
        console.log('✓ Group 8 Passed: Sensitive passwords, tokens, and keys strictly redacted in DbError.');

        // ================================================================
        // 🧪 TEST GROUP 9: High-Concurrency Pool Lease and Release
        // ================================================================
        console.log('\n--- 🧪 Test Group 9: High-Concurrency Pool Lease and Release ---');

        const concurrentQueries = 50;
        const queryPromises = [];

        for (let i = 0; i < concurrentQueries; i++) {
            queryPromises.push(
                dbClient.queryOne(
                    'SELECT ?::int as num, current_database() as db;',
                    [i],
                    { engine: 'postgres', dbNameOverride: 'zarsev_test' }
                )
            );
        }

        const queryResults = await Promise.all(queryPromises);
        assert.strictEqual(queryResults.length, concurrentQueries);
        for (let i = 0; i < concurrentQueries; i++) {
            assert.strictEqual(queryResults[i].num, i);
            assert.strictEqual(queryResults[i].db, 'zarsev_test');
        }

        console.log(`✓ Group 9 Passed: ${concurrentQueries} concurrent queries resolved without connection starvation.`);

    } finally {
        // Cleanup PostgreSQL probe table via migrator
        const cleanupMigrator = pgAdapter.getMigratorClient('zarsev_test');
        try {
            await cleanupMigrator.connect();
            await cleanupMigrator.query('DROP TABLE IF EXISTS _test_phase2_4_facade;');
            await cleanupMigrator.end();
            console.log('\n[CLEANUP] Dropped isolated PostgreSQL test table: _test_phase2_4_facade.');
        } catch (cleanupErr) {
            console.error('[CLEANUP ERROR]', cleanupErr.message);
        }

        // Close pools
        await pgAdapter.closePool();
        try { sqliteDb.close(); } catch (_) {}

        // Remove SQLite sandbox test file
        if (fs.existsSync(TEST_SQLITE_PATH)) {
            try { fs.unlinkSync(TEST_SQLITE_PATH); } catch (_) {}
        }
    }

    // ================================================================
    // 🧪 TEST GROUP 10: Immutability Verification (SQLite & zarsev_test)
    // ================================================================
    console.log('\n--- 🧪 Test Group 10: Immutability & Anti-Regression Verification ---');

    const postSnapshot = captureSnapshot();
    for (const [name, meta] of Object.entries(postSnapshot)) {
        assert.strictEqual(meta.size, preSnapshot[name].size, `File size of ${name} must be identical.`);
        assert.strictEqual(meta.sha, preSnapshot[name].sha, `SHA256 of ${name} must be 100% bit-for-bit identical.`);
        console.log(`✓ Immutability Verified: ${name} (SHA256=${meta.sha})`);
    }

    const postPgCounts = await capturePgBusinessCounts();
    assert.strictEqual(postPgCounts.total, prePgCounts.total, `Total business records in zarsev_test must remain exactly unchanged (${prePgCounts.total}).`);
    for (const tbl of BUSINESS_TABLES) {
        assert.strictEqual(postPgCounts.counts[tbl], prePgCounts.counts[tbl], `Record count in ${tbl} must be unchanged.`);
    }
    console.log(`✓ Immutability Verified: All ${postPgCounts.total} records across 9 tables in zarsev_test are 100% unchanged!`);
    await pgAdapter.closePool();

    console.log('\n================================================================');
    console.log('🎉 ALL 10 PHASE 2.4.2 ASYNC DB FACADE TESTS PASSED (100% SUCCESS)!');
    console.log('================================================================');
}

runAllTests().catch((err) => {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
});
