/**
 * scripts/apply_quotation_migration_test_only.js
 * 
 * Applies migration 004_structured_commercial_quotations.sql
 * STRICTLY AND EXCLUSIVELY against PostgreSQL database 'zarsev_test'.
 * 
 * Safety guards:
 * - Refuses execution if target database is not 'zarsev_test'.
 * - Operates under zarsev_migrator least-privilege role.
 * - Leaves zarsev_dev and SQLite zarsev.db 100% untouched.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { getMigratorClient, getAppPool } = require('../src/db/pgAdapter');

async function applyMigration() {
    console.log('===================================================================');
    console.log('🚀 EXECUTING QUOTATION MIGRATION ON TEST DATABASE (zarsev_test)');
    console.log('===================================================================\n');

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

        const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', 'pg', '004_structured_commercial_quotations.sql');
        const sqlContent = fs.readFileSync(migrationPath, 'utf8');

        console.log(`Applying migration: ${path.basename(migrationPath)}...`);
        await client.query('BEGIN');
        await client.query(sqlContent);
        await client.query('COMMIT');
        console.log('✓ Migration executed successfully and committed.');

        // Verify tables exist
        const tablesRes = await client.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name IN ('quotations', 'quotation_audit_logs')
            ORDER BY table_name
        `);
        console.log('Created tables in zarsev_test:', tablesRes.rows.map(r => r.table_name));
        assert.strictEqual(tablesRes.rows.length, 2, 'Both quotations and quotation_audit_logs must exist in zarsev_test!');

        // Verify column in rfqs
        const colRes = await client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'rfqs' AND column_name = 'buyer_access_token'
        `);
        assert.strictEqual(colRes.rows.length, 1, 'Column buyer_access_token must exist in rfqs!');
        console.log('✓ Verified buyer_access_token column in rfqs table.');

        // Test zarsev_app read/write access
        const appPool = getAppPool('zarsev_test');
        const appTest = await appPool.query('SELECT count(*) FROM quotations');
        console.log(`✓ zarsev_app successfully queried quotations: count=${appTest.rows[0].count}`);
        await appPool.end();

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Migration failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

applyMigration().then(() => {
    console.log('\nMigration complete.');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
