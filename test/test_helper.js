/**
 * test/test_helper.js
 * 
 * Centralized test isolation framework for ZARSEV.
 * Guarantees that every test executes against a fresh, dedicated SQLite database
 * in test/sandbox/ and NEVER touches the production/development database (zarsev.db).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const { getDb, initDb, closeDb, REAL_DB_PATH, PROTECTED_DB_FILES, canonicalizePath } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');

const SANDBOX_DIR = path.resolve(__dirname, 'sandbox');
const MIGRATION_SANDBOX_DIR = path.resolve(__dirname, 'migration_sandbox');

function setupTestEnvironment(suiteName = 'general') {
    // 1. Establish mandatory test environment flags
    process.env.NODE_ENV = 'test';
    process.env.ZARSEV_TEST_MODE = '1';
    process.env.DB_ENGINE = 'sqlite';
    process.env.JWT_SECRET = 'zarsev_test_jwt_secret_min_32_characters_long_for_security';
    process.env.ENABLE_DEMO_SEED = 'true';
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

    // 2. Ensure sandbox directory exists
    if (!fs.existsSync(SANDBOX_DIR)) {
        fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    }

    // 3. Close any existing open database instance
    closeDb();

    // 4. Derive unique collision-proof isolated test database path
    // Incorporating process PID and random token guarantees parallel execution safety
    const safeName = suiteName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueToken = `${process.pid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const isolatedDbPath = path.join(SANDBOX_DIR, `test_${safeName}_${uniqueToken}.db`);

    // HARD GUARD: Refuse execution if isolated path resolves to any protected real DB or backup
    const resolvedCanonical = canonicalizePath(isolatedDbPath);
    const baseName = path.basename(isolatedDbPath).toLowerCase();

    for (const protFile of PROTECTED_DB_FILES) {
        if (resolvedCanonical === canonicalizePath(protFile)) {
            throw new Error(
                `[FATAL TEST ISOLATION ERROR] Isolated test path "${isolatedDbPath}" matches protected database: "${protFile}"!`
            );
        }
    }

    if (baseName === 'zarsev.db' || baseName.endsWith('.bak')) {
        throw new Error(
            `[FATAL TEST ISOLATION ERROR] Isolated test filename cannot be "zarsev.db" or end with ".bak"!`
        );
    }

    // 5. Clean up any previous test database artifact for this specific path
    cleanupTestDatabase(isolatedDbPath);

    // 6. Bind isolated database to process environment
    process.env.DB_PATH = isolatedDbPath;

    // 7. Initialize clean schema and seed demo data
    initDb();
    seedDatabase();

    const db = getDb();

    // Ensure core test fixtures (super admin, manufacturers) have is_demo = 0
    // so E2E catalog publishing and public gatekeeping tests reflect real production conditions
    db.prepare('UPDATE users SET is_demo = 0 WHERE id IN (?, ?, ?, ?)').run(
        'usr_super_admin', 'usr_logistics_officer', 'usr_mfg_nile_fruits', 'usr_mfg_delta_iqf'
    );
    db.prepare('UPDATE manufacturers SET is_demo = 0 WHERE id IN (?, ?, ?, ?)').run(
        'mfg_bustan_citrus', 'mfg_damietta_agro', 'mfg_nile_fruits', 'mfg_delta_iqf'
    );

    return { db, isolatedDbPath };
}

function cleanupTestDatabase(dbPath) {
    if (!dbPath) return;
    const resolved = path.resolve(dbPath);
    const resolvedLower = resolved.toLowerCase();
    const resolvedCanonical = canonicalizePath(resolved);
    const baseName = path.basename(resolved).toLowerCase();

    // HARD GUARD 1: NEVER delete any protected database file (checking canonical realpaths)
    for (const protFile of PROTECTED_DB_FILES) {
        if (resolvedCanonical === canonicalizePath(protFile)) {
            throw new Error(
                `[SAFETY GUARD VIOLATION] Refused attempt to delete protected database file: "${resolved}"`
            );
        }
    }

    // HARD GUARD 2: Refuse deleting filenames matching zarsev.db or ending with .bak
    if (baseName === 'zarsev.db' || baseName.endsWith('.bak')) {
        throw new Error(
            `[SAFETY GUARD VIOLATION] Refused attempt to delete file matching protected naming: "${resolved}"`
        );
    }

    // HARD GUARD 3: Must reside strictly inside SANDBOX_DIR or MIGRATION_SANDBOX_DIR
    const sandboxLower = path.resolve(SANDBOX_DIR).toLowerCase();
    const migrationSandboxLower = path.resolve(MIGRATION_SANDBOX_DIR).toLowerCase();

    const isInsideSandbox = resolvedLower.startsWith(sandboxLower + path.sep) || resolvedLower === sandboxLower;
    const isInsideMigration = resolvedLower.startsWith(migrationSandboxLower + path.sep) || resolvedLower === migrationSandboxLower;

    if (!isInsideSandbox && !isInsideMigration) {
        throw new Error(
            `[SAFETY GUARD VIOLATION] Refused attempt to delete database outside test sandbox directories: "${resolved}"`
        );
    }

    // Close any active connections before attempting file unlinks
    closeDb();

    // Unlink DB and sidecars with retry loop for Windows file lock release
    for (const ext of ['', '-wal', '-shm']) {
        const file = resolved + ext;
        if (fs.existsSync(file)) {
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    fs.unlinkSync(file);
                    break;
                } catch (e) {
                    if (attempt < 4) {
                        const end = Date.now() + 25;
                        while (Date.now() < end) {}
                    }
                }
            }
        }
    }
}

module.exports = {
    setupTestEnvironment,
    cleanupTestDatabase,
    SANDBOX_DIR,
    MIGRATION_SANDBOX_DIR,
    REAL_DB_PATH
};
