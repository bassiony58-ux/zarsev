const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const { runIsolationGuardTests } = require('./test_isolation_guard');
const { runExtractionTests } = require('./test_extraction');
const { runManufacturerAssignmentTests } = require('./test_manufacturer_assignment');
const { runAuthorizationTests } = require('./test_authorization');
const { runDuplicateDetectionTests } = require('./test_duplicate_detection');
const { runApprovalWorkflowTests } = require('./test_approval_workflow');
const { runE2EVerification } = require('./e2e_flow_verification');
const { runSecurityP0Tests } = require('./test_security_p0');
const { runRemediationTests } = require('./test_phase1_1_remediation');
const { runMigrationTests } = require('./test_migrations');

function getFileInfo(filePath) {
    if (!fs.existsSync(filePath)) {
        return { exists: false, size: 0, hash: null };
    }
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
    return { exists: true, size: stat.size, hash };
}

async function main() {
    console.log('================================================================');
    console.log('⚓ ZARSEV Smart Product Import & Hardened Test Suite');
    console.log('================================================================\n');

    const projectRoot = path.resolve(__dirname, '..');
    const realDbPath = path.join(projectRoot, 'zarsev.db');
    const realBakPath = path.join(projectRoot, 'zarsev.db.bak');
    const realPrequarantinePath = path.join(projectRoot, 'zarsev.db.phase1_2_prequarantine.bak');

    // 1. Capture exact cryptographic snapshot of original SQLite database & backups BEFORE test execution
    const beforeDb = getFileInfo(realDbPath);
    const beforeBak = getFileInfo(realBakPath);
    const beforePrequarantine = getFileInfo(realPrequarantinePath);

    console.log('[BASELINE INTEGRITY SNAPSHOT - BEFORE TESTS]');
    console.log(` - zarsev.db:                                size=${beforeDb.size} bytes | SHA256=${beforeDb.hash}`);
    console.log(` - zarsev.db.bak:                            size=${beforeBak.size} bytes | SHA256=${beforeBak.hash}`);
    console.log(` - zarsev.db.phase1_2_prequarantine.bak:     size=${beforePrequarantine.size} bytes | SHA256=${beforePrequarantine.hash}\n`);

    // 2. Set mandatory test mode flags
    process.env.NODE_ENV = 'test';
    process.env.ZARSEV_TEST_MODE = '1';
    process.env.DB_ENGINE = 'sqlite';
    process.env.JWT_SECRET = 'zarsev_test_jwt_secret_min_32_characters_long_for_security';

    const start = Date.now();

    // 3. Execute all suites in isolated environments
    await runIsolationGuardTests();
    await runExtractionTests();
    await runManufacturerAssignmentTests();
    await runAuthorizationTests();
    await runDuplicateDetectionTests();
    await runApprovalWorkflowTests();
    await runE2EVerification();
    await runSecurityP0Tests();
    await runRemediationTests();
    await runMigrationTests();

    // 4. Capture exact cryptographic snapshot of original SQLite database & backups AFTER test execution
    const afterDb = getFileInfo(realDbPath);
    const afterBak = getFileInfo(realBakPath);
    const afterPrequarantine = getFileInfo(realPrequarantinePath);

    console.log('\n[POST-TEST INTEGRITY SNAPSHOT - AFTER TESTS]');
    console.log(` - zarsev.db:                                size=${afterDb.size} bytes | SHA256=${afterDb.hash}`);
    console.log(` - zarsev.db.bak:                            size=${afterBak.size} bytes | SHA256=${afterBak.hash}`);
    console.log(` - zarsev.db.phase1_2_prequarantine.bak:     size=${afterPrequarantine.size} bytes | SHA256=${afterPrequarantine.hash}`);

    // 5. REGRESSION ASSERTIONS: Prove bit-level immutability
    assert.strictEqual(afterDb.size, beforeDb.size,
        `[CRITICAL REGRESSION] Original zarsev.db size changed! Before: ${beforeDb.size}, After: ${afterDb.size}`);
    assert.strictEqual(afterDb.hash, beforeDb.hash,
        `[CRITICAL REGRESSION] Original zarsev.db hash changed! Before: ${beforeDb.hash}, After: ${afterDb.hash}`);
    assert.strictEqual(afterBak.hash, beforeBak.hash,
        `[CRITICAL REGRESSION] Backup zarsev.db.bak hash changed!`);
    assert.strictEqual(afterPrequarantine.hash, beforePrequarantine.hash,
        `[CRITICAL REGRESSION] Backup phase1_2_prequarantine.bak hash changed!`);

    console.log('\n🛡️  REGRESSION CHECK PASSED: Original SQLite database and all backups are 100% UNTOUCHED and BIT-PERFECT!');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log('================================================================');
    console.log(`🎉 ALL 10 TEST SUITES (INCLUDING ISOLATION & MIGRATIONS) PASSED IN ${elapsed}s!`);
    console.log('================================================================');
}

main().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});
