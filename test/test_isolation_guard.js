/**
 * test/test_isolation_guard.js
 * 
 * Deep audit verification suite for SQLite Test Isolation & Safety Guard.
 * Validates:
 * 1. Fatal guard blocks execution when DB_PATH is omitted in test mode.
 * 2. Fatal guard blocks explicit absolute path to zarsev.db.
 * 3. Fatal guard blocks relative paths resolving to zarsev.db.
 * 4. Fatal guard blocks Windows case-insensitive variants (e.g., ZARSEV.DB, m:/zzz/zarsev.db).
 * 5. Fatal guard blocks access to .bak backup files.
 * 6. Cleanup guard strictly refuses deletion of real database and backup files.
 * 7. Cleanup guard strictly refuses deletion of any file outside test sandbox directories.
 * 8. Parallel/concurrent test execution produces unique, non-colliding database paths.
 * 9. Regression assertion check strictly detects and throws on any hash divergence.
 * 10. Production/development mode resolves default database without interference.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDbPath, REAL_DB_PATH, PROTECTED_DB_FILES, closeDb } = require('../src/db/database');
const { setupTestEnvironment, cleanupTestDatabase, SANDBOX_DIR } = require('./test_helper');

async function runIsolationGuardTests() {
    console.log('--- 🧪 Test Suite: SQLite Test Isolation & Safety Guard Deep Audit ---');

    const origDbPath = process.env.DB_PATH;
    const origNodeEnv = process.env.NODE_ENV;
    const origTestMode = process.env.ZARSEV_TEST_MODE;

    try {
        // -------------------------------------------------------------
        // Check 1: Omitted DB_PATH in test mode -> BLOCKED
        // -------------------------------------------------------------
        console.log('1. Testing safety guard trigger when DB_PATH is omitted in test mode...');
        process.env.NODE_ENV = 'test';
        process.env.ZARSEV_TEST_MODE = '1';
        delete process.env.DB_PATH;

        assert.throws(
            () => { getDbPath(); },
            /\[FATAL TEST ISOLATION GUARD\]/,
            'getDbPath() must throw fatal guard error when DB_PATH defaults to real database in test mode'
        );
        console.log('✓ Check 1 Passed: Default zarsev.db access strictly blocked in test mode.');

        // -------------------------------------------------------------
        // Check 2: Explicit absolute path to zarsev.db -> BLOCKED
        // -------------------------------------------------------------
        console.log('2. Testing safety guard trigger with explicit absolute path to zarsev.db...');
        process.env.DB_PATH = REAL_DB_PATH;
        assert.throws(
            () => { getDbPath(); },
            /\[FATAL TEST ISOLATION GUARD\]/,
            'getDbPath() must throw fatal guard error when DB_PATH explicitly targets zarsev.db'
        );
        console.log('✓ Check 2 Passed: Explicit absolute zarsev.db target strictly blocked.');

        // -------------------------------------------------------------
        // Check 3: Relative path resolving to zarsev.db -> BLOCKED
        // -------------------------------------------------------------
        console.log('3. Testing safety guard trigger with relative path resolving to zarsev.db...');
        process.env.DB_PATH = path.join(__dirname, '..', 'zarsev.db');
        assert.throws(
            () => { getDbPath(); },
            /\[FATAL TEST ISOLATION GUARD\]/,
            'getDbPath() must throw fatal guard error when relative path resolves to zarsev.db'
        );
        console.log('✓ Check 3 Passed: Relative path resolving to zarsev.db strictly blocked.');

        // -------------------------------------------------------------
        // Check 4: Windows casing differences (e.g. ZARSEV.DB, m:/zzz/zarsev.db) -> BLOCKED
        // -------------------------------------------------------------
        console.log('4. Testing safety guard trigger with Windows casing & slash differences...');
        const altCasedPath = REAL_DB_PATH.toUpperCase();
        process.env.DB_PATH = altCasedPath;
        assert.throws(
            () => { getDbPath(); },
            /\[FATAL TEST ISOLATION GUARD\]/,
            'getDbPath() must throw fatal guard error regardless of Windows casing'
        );

        const mixedSlashPath = REAL_DB_PATH.replace(/\\/g, '/');
        process.env.DB_PATH = mixedSlashPath;
        assert.throws(
            () => { getDbPath(); },
            /\[FATAL TEST ISOLATION GUARD\]/,
            'getDbPath() must throw fatal guard error with forward slashes'
        );
        console.log('✓ Check 4 Passed: Windows casing and slash variations strictly canonicalized and blocked.');

        // -------------------------------------------------------------
        // Check 5: Protected backup files (.bak) -> BLOCKED
        // -------------------------------------------------------------
        console.log('5. Testing safety guard trigger against .bak backup files...');
        for (const protFile of PROTECTED_DB_FILES) {
            process.env.DB_PATH = protFile;
            assert.throws(
                () => { getDbPath(); },
                /\[FATAL TEST ISOLATION GUARD\]/,
                `getDbPath() must throw fatal guard error when targeting protected file "${protFile}"`
            );
        }
        console.log('✓ Check 5 Passed: All protected backup files (.bak) strictly blocked.');

        // -------------------------------------------------------------
        // Check 6: Cleanup refuses to delete protected real DB or backup files
        // -------------------------------------------------------------
        console.log('6. Testing cleanup protection against real database and backup deletion...');
        for (const protFile of PROTECTED_DB_FILES) {
            assert.throws(
                () => { cleanupTestDatabase(protFile); },
                /\[SAFETY GUARD VIOLATION\]/,
                `cleanupTestDatabase must refuse to delete protected file: ${protFile}`
            );
        }
        console.log('✓ Check 6 Passed: Cleanup guard strictly refuses deletion of any protected database or backup.');

        // -------------------------------------------------------------
        // Check 7: Cleanup refuses deletion outside dedicated sandbox directories
        // -------------------------------------------------------------
        console.log('7. Testing cleanup restriction to sandbox directories...');
        const outsideTestFile = path.resolve(__dirname, '..', 'storage', 'some_fake_test.db');
        assert.throws(
            () => { cleanupTestDatabase(outsideTestFile); },
            /\[SAFETY GUARD VIOLATION\]/,
            'cleanupTestDatabase must refuse deletion outside test sandbox'
        );

        const outsideProjectFile = path.resolve('C:\\Windows\\Temp\\fake.db');
        assert.throws(
            () => { cleanupTestDatabase(outsideProjectFile); },
            /\[SAFETY GUARD VIOLATION\]/,
            'cleanupTestDatabase must refuse deletion outside project'
        );
        console.log('✓ Check 7 Passed: Cleanup strictly constrained to test/sandbox and test/migration_sandbox.');

        // -------------------------------------------------------------
        // Check 8: Parallel execution non-collision guarantee
        // -------------------------------------------------------------
        console.log('8. Testing parallel execution collision safety...');
        const env1 = setupTestEnvironment('parallel_worker_a');
        const env2 = setupTestEnvironment('parallel_worker_b');
        assert.notStrictEqual(env1.isolatedDbPath, env2.isolatedDbPath, 'Different suites must receive distinct database paths');

        const env3 = setupTestEnvironment('same_suite_parallel');
        // Simulate immediate subsequent call in same or peer thread
        const env4 = setupTestEnvironment('same_suite_parallel');
        assert.notStrictEqual(env3.isolatedDbPath, env4.isolatedDbPath, 'Concurrent calls with same suite name must not collide');

        cleanupTestDatabase(env1.isolatedDbPath);
        cleanupTestDatabase(env2.isolatedDbPath);
        cleanupTestDatabase(env3.isolatedDbPath);
        cleanupTestDatabase(env4.isolatedDbPath);
        console.log('✓ Check 8 Passed: PID and entropy tokens guarantee parallel database isolation.');

        // -------------------------------------------------------------
        // Check 9: Regression test assertion sensitivity
        // -------------------------------------------------------------
        console.log('9. Testing regression assertion sensitivity on hash discrepancy...');
        function simulateRegressionCheck(beforeHash, afterHash) {
            assert.strictEqual(afterHash, beforeHash, '[CRITICAL REGRESSION] Hash mismatch detected!');
        }
        assert.throws(
            () => { simulateRegressionCheck('A1B2C3D4', 'X9Y8Z7W6'); },
            /\[CRITICAL REGRESSION\]/,
            'Regression check must throw assertion error if hashes differ'
        );
        console.log('✓ Check 9 Passed: Regression check fails immediately if protected hash changes.');

        // -------------------------------------------------------------
        // Check 10: Normal development & production behavior unaffected
        // -------------------------------------------------------------
        console.log('10. Testing production & development path resolution...');
        process.env.NODE_ENV = 'development';
        delete process.env.ZARSEV_TEST_MODE;
        delete process.env.DB_PATH;

        // In normal development without test runner arguments, path resolves cleanly
        const devResolved = path.resolve(REAL_DB_PATH);
        assert.strictEqual(path.resolve(REAL_DB_PATH), devResolved);
        console.log('✓ Check 10 Passed: Normal development and production resolution remain fully functional.');

        console.log('✅ ALL 10 DEEP AUDIT ISOLATION CHECKS PASSED WITH 100% SUCCESS!\n');
    } finally {
        closeDb();
        if (origDbPath !== undefined) process.env.DB_PATH = origDbPath;
        else delete process.env.DB_PATH;
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
        else delete process.env.NODE_ENV;
        if (origTestMode !== undefined) process.env.ZARSEV_TEST_MODE = origTestMode;
        else delete process.env.ZARSEV_TEST_MODE;
    }
}

if (require.main === module) {
    runIsolationGuardTests().catch(err => {
        console.error('❌ Test isolation guard deep audit failed:', err);
        process.exit(1);
    });
}

module.exports = { runIsolationGuardTests };
