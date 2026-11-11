/**
 * test/test_phase2_connection_parity.js
 * 
 * Verifies Phase 2: PostgreSQL Connection Recovery & Foundation.
 * 
 * Tests:
 * 1. zarsev_migrator connection on zarsev_dev and zarsev_test.
 * 2. zarsev_app connection on zarsev_dev and zarsev_test.
 * 3. current_database() checks.
 * 4. current_user checks.
 * 5. DDL privileges for zarsev_migrator & DML privileges for zarsev_app.
 * 6. Rejection of unauthorized actions (e.g. zarsev_app executing DDL -> SQLSTATE 42501).
 * 
 * Cleans up temporary test objects cleanly.
 * Zero modification of SQLite or business data.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { Pool, Client } = require('pg');

// Ensure .env is loaded natively
try {
    if (typeof process.loadEnvFile === 'function') {
        const envPath = path.join(__dirname, '..', '.env');
        if (fs.existsSync(envPath)) {
            process.loadEnvFile(envPath);
        }
    }
} catch (_) {}

const config = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    migratorUser: process.env.PG_MIGRATOR_USER || 'zarsev_migrator',
    migratorPassword: process.env.PG_MIGRATOR_PASSWORD,
    appUser: process.env.PG_APP_USER || 'zarsev_app',
    appPassword: process.env.PG_APP_PASSWORD,
    databases: ['zarsev_dev', 'zarsev_test']
};

async function testDatabase(dbName) {
    console.log(`\n================================================================`);
    console.log(`🔍 Testing Database: ${dbName}`);
    console.log(`================================================================`);

    // 1. Test zarsev_migrator connection
    const migClient = new Client({
        host: config.host,
        port: config.port,
        user: config.migratorUser,
        password: config.migratorPassword,
        database: dbName
    });

    await migClient.connect();
    console.log(`[PASS] 1. zarsev_migrator connected successfully to '${dbName}'.`);

    // 2. Test zarsev_app pool connection
    const appPool = new Pool({
        host: config.host,
        port: config.port,
        user: config.appUser,
        password: config.appPassword,
        database: dbName,
        max: 5
    });

    const appClient = await appPool.connect();
    console.log(`[PASS] 2. zarsev_app Pool connected successfully to '${dbName}'.`);

    try {
        // 3. Check current_database() for both
        const migDbRes = await migClient.query('SELECT current_database();');
        const appDbRes = await appClient.query('SELECT current_database();');
        assert.strictEqual(migDbRes.rows[0].current_database, dbName);
        assert.strictEqual(appDbRes.rows[0].current_database, dbName);
        console.log(`[PASS] 3. current_database() verified as '${dbName}' for both roles.`);

        // 4. Check current_user for both
        const migUserRes = await migClient.query('SELECT current_user, session_user;');
        const appUserRes = await appClient.query('SELECT current_user, session_user;');
        assert.strictEqual(migUserRes.rows[0].current_user, config.migratorUser);
        assert.strictEqual(appUserRes.rows[0].current_user, config.appUser);
        console.log(`[PASS] 4. current_user verified: migrator='${migUserRes.rows[0].current_user}', app='${appUserRes.rows[0].current_user}'.`);

        // 5. Check DDL for migrator and DML for app
        const testTableName = `_perm_check_${Date.now()}`;
        
        // 5.1 Migrator executes DDL (CREATE TABLE)
        await migClient.query(`
            CREATE TABLE ${testTableName} (
                id SERIAL PRIMARY KEY,
                val VARCHAR(50) NOT NULL
            );
        `);
        console.log(`[PASS] 5.1 DDL: zarsev_migrator successfully created table '${testTableName}'.`);

        // 5.2 App executes DML (INSERT)
        const insertRes = await appClient.query(
            `INSERT INTO ${testTableName} (val) VALUES ($1) RETURNING id;`,
            ['test_value_1']
        );
        assert.strictEqual(insertRes.rowCount, 1);
        const newId = insertRes.rows[0].id;

        // 5.3 App executes DML (SELECT)
        const selectRes = await appClient.query(`SELECT * FROM ${testTableName} WHERE id = $1;`, [newId]);
        assert.strictEqual(selectRes.rowCount, 1);
        assert.strictEqual(selectRes.rows[0].val, 'test_value_1');

        // 5.4 App executes DML (UPDATE)
        const updateRes = await appClient.query(
            `UPDATE ${testTableName} SET val = $1 WHERE id = $2;`,
            ['updated_value', newId]
        );
        assert.strictEqual(updateRes.rowCount, 1);

        // 5.5 App executes DML (DELETE)
        const deleteRes = await appClient.query(`DELETE FROM ${testTableName} WHERE id = $1;`, [newId]);
        assert.strictEqual(deleteRes.rowCount, 1);
        console.log(`[PASS] 5.2-5.5 DML: zarsev_app verified for INSERT, SELECT, UPDATE, DELETE on '${testTableName}'.`);

        // 6. Security & Negative Permissions (Unauthorized actions rejected)
        // 6.1 zarsev_app attempting DDL (CREATE TABLE) -> MUST FAIL with 42501 (insufficient_privilege)
        let appDdlBlocked = false;
        try {
            await appClient.query(`CREATE TABLE _unauthorized_tbl (id INT);`);
        } catch (err) {
            appDdlBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected SQLSTATE 42501 for unauthorized DDL, got ${err.code}`);
            console.log(`[PASS] 6.1 Security Guard: zarsev_app DDL (CREATE TABLE) rejected as expected [SQLSTATE: ${err.code}].`);
        }
        assert.strictEqual(appDdlBlocked, true, 'zarsev_app must NOT be able to execute DDL (CREATE TABLE)');

        // 6.2 zarsev_app attempting DDL (DROP TABLE) -> MUST FAIL with 42501
        let appDropBlocked = false;
        try {
            await appClient.query(`DROP TABLE ${testTableName};`);
        } catch (err) {
            appDropBlocked = true;
            assert.strictEqual(err.code, '42501', `Expected SQLSTATE 42501 for unauthorized DROP, got ${err.code}`);
            console.log(`[PASS] 6.2 Security Guard: zarsev_app DDL (DROP TABLE) rejected as expected [SQLSTATE: ${err.code}].`);
        }
        assert.strictEqual(appDropBlocked, true, 'zarsev_app must NOT be able to execute DDL (DROP TABLE)');

        // Cleanup: Migrator drops test table
        await migClient.query(`DROP TABLE ${testTableName};`);
        console.log(`[PASS] 6.3 Cleanup: zarsev_migrator cleanly dropped table '${testTableName}'.`);

    } finally {
        appClient.release();
        await appPool.end();
        await migClient.end();
    }
}

async function run() {
    console.log('================================================================');
    console.log('🚀 ZARSEV PHASE 2: POSTGRESQL FOUNDATION PARITY & SECURITY AUDIT');
    console.log('================================================================');

    for (const db of config.databases) {
        await testDatabase(db);
    }

    console.log(`\n================================================================`);
    console.log('🎯 ALL 6 CONNECTION & PRIVILEGE CHECKS PASSED ON BOTH DATABASES!');
    console.log('================================================================\n');
}

run().catch((err) => {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
});
