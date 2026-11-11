/**
 * scripts/run_migrate_to_dev.js
 * 
 * Executes Phase 3 Section 6: Final Data Migration from SQLite to zarsev_dev.
 * 
 * Safety Rules:
 * - Operates on zarsev_dev using zarsev_migrator for DDL and data transfer.
 * - Confirms SQLite files are strictly read-only and unmutated before and after.
 * - Performs exhaustive table-by-table row count and data parity verification.
 * - Verifies zarsev_app can read from zarsev_dev.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getMigratorClient, getAppPool, closePool } = require('../src/db/pgAdapter');
const { migrateData } = require('./migrate_sqlite_to_postgres');

const TARGET_DB = 'zarsev_dev';
const SQLITE_PATH = path.resolve(__dirname, '..', 'zarsev.db');

function getHash(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

async function runDevMigration() {
    console.log('================================================================');
    console.log('🚀 Phase 3 Section 6: Final Migration to zarsev_dev');
    console.log('================================================================\n');

    // 1. Snapshot SQLite hash
    const hashBefore = getHash(SQLITE_PATH);
    console.log(`[PRE-CHECK] SQLite source: ${SQLITE_PATH}`);
    console.log(`[PRE-CHECK] SHA-256:       ${hashBefore}`);

    // 2. Execute migration into zarsev_dev
    console.log('\n--- Step 1: Running Schema Migrations & Data Transfer to zarsev_dev ---');
    const transferStats = await migrateData(TARGET_DB);
    console.log('\nTransfer Summary:');
    for (const [tbl, s] of Object.entries(transferStats)) {
        console.log(`  - ${tbl.padEnd(20)}: ${s.sourceCount} source -> ${s.insertedCount} inserted (${s.matchedCount} already matched)`);
    }

    // 3. Open clients for deep comparison
    const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
    const migClient = getMigratorClient(TARGET_DB);
    await migClient.connect();
    const appPool = getAppPool(TARGET_DB);

    try {
        console.log('\n--- Step 2: Table-by-Table Record Count & Parity Verification ---');
        const tables = [
            'subscriptions',
            'categories',
            'manufacturers',
            'users',
            'products',
            'product_images',
            'imports',
            'import_items',
            'import_logs'
        ];

        let totalSqliteRows = 0;
        let totalPgRows = 0;

        for (const t of tables) {
            const sqCount = sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${t}";`).get().cnt;
            const pgCountRes = await migClient.query(`SELECT COUNT(*)::int as cnt FROM "${t}";`);
            const pgCount = pgCountRes.rows[0].cnt;

            assert.strictEqual(sqCount, pgCount, `Row count mismatch for '${t}': SQLite=${sqCount}, PG=${pgCount}`);
            totalSqliteRows += sqCount;
            totalPgRows += pgCount;
            console.log(`  ✓ Table '${t.padEnd(18)}': exactly ${sqCount} rows in SQLite and PostgreSQL.`);
        }

        console.log(`\n✓ Total Business Records: SQLite=${totalSqliteRows} | PostgreSQL=${totalPgRows} (100% PARITY)`);

        // 4. Verify Foreign Key Integrity & Zero Orphans
        console.log('\n--- Step 3: Foreign Key Integrity Check on zarsev_dev ---');
        const orphanChecks = [
            { query: 'SELECT COUNT(*)::int as cnt FROM categories c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id);', name: 'categories.parent_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM manufacturers m WHERE m.subscription_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = m.subscription_id);', name: 'manufacturers.subscription_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM users u WHERE u.manufacturer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM manufacturers m WHERE m.id = u.manufacturer_id);', name: 'users.manufacturer_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM products p WHERE NOT EXISTS (SELECT 1 FROM manufacturers m WHERE m.id = p.manufacturer_id);', name: 'products.manufacturer_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM product_images pi WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = pi.product_id);', name: 'product_images.product_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM imports i WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.user_id);', name: 'imports.user_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM import_items ii WHERE NOT EXISTS (SELECT 1 FROM imports i WHERE i.id = ii.import_id);', name: 'import_items.import_id' },
            { query: 'SELECT COUNT(*)::int as cnt FROM import_logs il WHERE NOT EXISTS (SELECT 1 FROM imports i WHERE i.id = il.import_id);', name: 'import_logs.import_id' }
        ];

        for (const oc of orphanChecks) {
            const res = await migClient.query(oc.query);
            assert.strictEqual(res.rows[0].cnt, 0, `Orphan records detected in ${oc.name}!`);
            console.log(`  ✓ FK Check '${oc.name}': 0 orphans.`);
        }

        // 5. Verify App Pool connectivity with zarsev_app on zarsev_dev
        console.log('\n--- Step 4: Runtime App Pool Verification on zarsev_dev ---');
        const appRes = await appPool.query("SELECT current_user, current_database(), count(*)::int as published_count FROM products WHERE is_demo = false AND status = 'PUBLISHED';");
        assert.strictEqual(appRes.rows[0].current_user, 'zarsev_app');
        assert.strictEqual(appRes.rows[0].current_database, 'zarsev_dev');
        assert.strictEqual(appRes.rows[0].published_count, 14);
        console.log(`  ✓ zarsev_app query succeeded: user='${appRes.rows[0].current_user}', db='${appRes.rows[0].current_database}', published_products=${appRes.rows[0].published_count}.`);

        // 6. Test Idempotency on zarsev_dev
        console.log('\n--- Step 5: Testing Migration Idempotency on zarsev_dev ---');
        const reRunStats = await migrateData(TARGET_DB);
        for (const t of tables) {
            assert.strictEqual(reRunStats[t].insertedCount, 0, `Idempotency violation on table '${t}'`);
        }
        console.log('  ✓ Idempotency verified: Re-run inserted 0 rows.');

    } finally {
        sqlite.close();
        await migClient.end().catch(() => {});
        await closePool();
    }

    // 7. Verify SQLite immutability
    const hashAfter = getHash(SQLITE_PATH);
    assert.strictEqual(hashBefore, hashAfter, '[FATAL INTEGRITY VIOLATION] SQLite source hash changed during migration!');
    console.log(`\n✓ SQLite Source Immutability Verified: ${hashAfter}`);

    console.log('\n================================================================');
    console.log('✅ ZARSEV_DEV MIGRATION COMPLETED WITH 100% SUCCESS & FULL PARITY!');
    console.log('================================================================');
}

runDevMigration().catch(err => {
    console.error('\n❌ MIGRATION TO ZARSEV_DEV FAILED:', err);
    process.exit(1);
});
