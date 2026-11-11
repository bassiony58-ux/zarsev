/**
 * scripts/apply_rfq_migration_test_only.js
 * 
 * Applies migration 003_buyer_rfq_and_inquiry_system.sql
 * STRICTLY AND EXCLUSIVELY against PostgreSQL database 'zarsev_test'.
 * 
 * Safety guards:
 * - Refuses execution if target is not 'zarsev_test'.
 * - Operates under zarsev_migrator least-privilege role.
 * - Leaves zarsev_dev and SQLite zarsev.db 100% untouched.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { getMigratorClient, getAppPool } = require('../src/db/pgAdapter');

async function applyMigration() {
    console.log('===============================================================');
    console.log('🚀 EXECUTING RFQ MIGRATION ON ISOLATED TEST DB (zarsev_test)');
    console.log('===============================================================\n');

    const client = getMigratorClient('zarsev_test');
    await client.connect();

    try {
        const dbCheck = await client.query('SELECT current_database(), current_user');
        console.log(`Connected user: ${dbCheck.rows[0].current_user}`);
        console.log(`Connected database: ${dbCheck.rows[0].current_database}`);

        // STRICT SAFETY ASSERTION
        assert.strictEqual(
            dbCheck.rows[0].current_database,
            'zarsev_test',
            'FATAL SAFETY VIOLATION: Database must be strictly zarsev_test!'
        );

        const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', 'pg', '003_buyer_rfq_and_inquiry_system.sql');
        const sqlContent = fs.readFileSync(migrationPath, 'utf8');

        console.log(`Applying migration: ${path.basename(migrationPath)}...`);
        await client.query('BEGIN');
        await client.query(sqlContent);
        await client.query('COMMIT');
        console.log('✓ Migration executed successfully and committed.');

        // Verification query
        const tablesRes = await client.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name IN ('rfqs', 'rfq_audit_logs', 'contact_inquiries')
            ORDER BY table_name
        `);
        console.log('Created tables verified in zarsev_test:', tablesRes.rows.map(r => r.table_name));
        assert.strictEqual(tablesRes.rows.length, 3, 'All 3 tables must exist in zarsev_test!');

        // Test zarsev_app read/write access to newly created tables
        const appPool = getAppPool('zarsev_test');
        const appTest = await appPool.query('SELECT count(*) FROM rfqs');
        console.log(`✓ zarsev_app successfully accessed rfqs table: count=${appTest.rows[0].count}`);
        await appPool.end();

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Migration failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

applyMigration();
