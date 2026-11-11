/**
 * scripts/apply_token_hash_migration_test_only.js
 * 
 * Applies migration 005_buyer_token_hash_storage.sql
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
    console.log('🚀 EXECUTING BUYER TOKEN HASH MIGRATION ON TEST DB (zarsev_test)');
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

        const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', 'pg', '005_buyer_token_hash_storage.sql');
        const sqlContent = fs.readFileSync(migrationPath, 'utf8');

        console.log(`Applying migration: ${path.basename(migrationPath)}...`);
        await client.query('BEGIN');
        await client.query(sqlContent);
        await client.query('COMMIT');
        console.log('✓ Migration executed successfully and committed.');

        // Verify column in rfqs
        const colRes = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'rfqs' AND column_name = 'buyer_access_token_hash'
        `);
        assert.strictEqual(colRes.rows.length, 1, 'Column buyer_access_token_hash must exist in rfqs!');
        console.log(`✓ Verified column buyer_access_token_hash (${colRes.rows[0].data_type}) in rfqs table.`);

        // Verify index
        const idxRes = await client.query(`
            SELECT indexname FROM pg_indexes 
            WHERE schemaname = 'public' AND tablename = 'rfqs' AND indexname = 'idx_rfqs_token_hash'
        `);
        assert.strictEqual(idxRes.rows.length, 1, 'Index idx_rfqs_token_hash must exist!');
        console.log('✓ Verified index idx_rfqs_token_hash.');

        // Test zarsev_app read/write access
        const appPool = getAppPool('zarsev_test');
        const appTest = await appPool.query('SELECT count(*), count(buyer_access_token_hash) as hashes FROM rfqs');
        console.log(`✓ zarsev_app successfully queried rfqs: total=${appTest.rows[0].count}, hashed=${appTest.rows[0].hashes}`);
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
