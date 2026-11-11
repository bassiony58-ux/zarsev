/**
 * test/test_phase2_2_dry_run_verification.js
 * 
 * Comprehensive 10-Point Verification Suite for Phase 2.2 Dry Run.
 * 
 * Strict Safety Rules:
 * - Operates EXCLUSIVELY on zarsev_test.
 * - Asserts zarsev_dev remains 100% untouched with 0 tables.
 * - Asserts SQLite files are 100% bit-for-bit identical before and after.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getMigratorClient, getAppPool, safeJsonParse, closePool } = require('../src/db/pgAdapter');
const { migrateData } = require('../scripts/migrate_sqlite_to_postgres');

const TARGET_DB = 'zarsev_test';
const SQLITE_PATH = path.resolve(__dirname, '..', 'zarsev.db');

function getHash(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

async function runDryRunVerification() {
    console.log('================================================================');
    console.log('🧪 Phase 2.2 Migration Dry Run: Execution & Verification Suite');
    console.log('================================================================\n');

    // 1. Snapshot SQLite files before execution
    const hashBeforeDb = getHash(SQLITE_PATH);
    const hashBeforeBak = getHash(path.resolve(__dirname, '..', 'zarsev.db.bak'));
    const hashBeforePre = getHash(path.resolve(__dirname, '..', 'zarsev.db.phase1_2_prequarantine.bak'));

    // 2. Execute Data Migration to zarsev_test
    console.log('--- Step 1: Executing Dry Run Migration to zarsev_test ---');
    const transferStats = await migrateData(TARGET_DB);
    console.log('Transfer Stats:', JSON.stringify(transferStats, null, 2));

    const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
    const migClient = getMigratorClient(TARGET_DB);
    await migClient.connect();
    const appPool = getAppPool(TARGET_DB);

    try {
        console.log('\n--- Step 2: 10-Point Deep Integrity Verification ---\n');

        // -------------------------------------------------------------
        // Point 1: Exact Row Count Parity
        // -------------------------------------------------------------
        console.log('Point 1: Verifying Exact Row Count Parity across all 9 tables...');
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

        for (const t of tables) {
            const sqCount = sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${t}";`).get().cnt;
            const pgCountRes = await migClient.query(`SELECT COUNT(*)::int as cnt FROM "${t}";`);
            const pgCount = pgCountRes.rows[0].cnt;
            assert.strictEqual(sqCount, pgCount, `Row count mismatch for table '${t}': SQLite=${sqCount}, PG=${pgCount}`);
            console.log(`  ✓ Table '${t}': exactly ${sqCount} rows in SQLite and PostgreSQL.`);
        }

        // -------------------------------------------------------------
        // Point 2: Cell-by-Cell Value Parity
        // -------------------------------------------------------------
        console.log('\nPoint 2: Verifying Cell-by-Cell Record Parity for Critical Entities...');
        
        // Users verification
        const sqUsers = sqlite.prepare('SELECT * FROM users ORDER BY id ASC;').all();
        for (const u of sqUsers) {
            const pgUser = (await migClient.query('SELECT * FROM users WHERE id = $1;', [u.id])).rows[0];
            assert(pgUser, `User ${u.id} must exist in PostgreSQL`);
            assert.strictEqual(u.name, pgUser.name);
            assert.strictEqual(u.email, pgUser.email);
            assert.strictEqual(u.role, pgUser.role);
            assert.strictEqual(u.password_hash, pgUser.password_hash, `Password hash mismatch on user ${u.id}`);
            assert.strictEqual(u.manufacturer_id, pgUser.manufacturer_id);
            assert.strictEqual(u.is_active === 1, pgUser.is_active);
            assert.strictEqual(u.is_demo === 1, pgUser.is_demo);
            assert.strictEqual(u.token_version, pgUser.token_version);
        }
        console.log(`  ✓ Users: Verified all ${sqUsers.length} user records cell-by-cell (including 4 NULL passwords).`);

        // Products verification (all 60 products)
        const sqProds = sqlite.prepare('SELECT * FROM products ORDER BY id ASC;').all();
        for (const p of sqProds) {
            const pgProd = (await migClient.query('SELECT * FROM products WHERE id = $1;', [p.id])).rows[0];
            assert(pgProd, `Product ${p.id} must exist in PostgreSQL`);
            assert.strictEqual(p.name_ar, pgProd.name_ar);
            assert.strictEqual(p.sku, pgProd.sku);
            assert.strictEqual(p.manufacturer_id, pgProd.manufacturer_id);
            assert.strictEqual(p.category_id, pgProd.category_id);
            assert.strictEqual(p.status, pgProd.status);
            assert.strictEqual(p.is_demo === 1, pgProd.is_demo, `Demo flag mismatch on product ${p.id}`);
            if (p.price != null) {
                assert.strictEqual(parseFloat(p.price).toFixed(2), parseFloat(pgProd.price).toFixed(2));
            } else {
                assert.strictEqual(pgProd.price, null);
            }
        }
        console.log(`  ✓ Products: Verified all ${sqProds.length} product records cell-by-cell.`);

        // -------------------------------------------------------------
        // Point 3: Foreign Key Integrity & Zero Orphaned Records
        // -------------------------------------------------------------
        console.log('\nPoint 3: Verifying Foreign Key Integrity & Zero Orphaned Records...');
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
            console.log(`  ✓ FK Check '${oc.name}': 0 orphan records.`);
        }

        // -------------------------------------------------------------
        // Point 4: Uniqueness Constraints & Duplicates Check
        // -------------------------------------------------------------
        console.log('\nPoint 4: Verifying Uniqueness Constraints...');
        const dupEmail = await migClient.query('SELECT email, COUNT(*) as c FROM users GROUP BY email HAVING COUNT(*) > 1;');
        assert.strictEqual(dupEmail.rows.length, 0, 'No duplicate emails allowed');
        const dupCode = await migClient.query('SELECT code, COUNT(*) as c FROM manufacturers GROUP BY code HAVING COUNT(*) > 1;');
        assert.strictEqual(dupCode.rows.length, 0, 'No duplicate manufacturer codes allowed');
        const dupSlug = await migClient.query('SELECT slug, COUNT(*) as c FROM categories GROUP BY slug HAVING COUNT(*) > 1;');
        assert.strictEqual(dupSlug.rows.length, 0, 'No duplicate category slugs allowed');
        console.log('  ✓ Uniqueness verified on users.email, manufacturers.code, categories.slug.');

        // -------------------------------------------------------------
        // Point 5: NULL Counts Parity
        // -------------------------------------------------------------
        console.log('\nPoint 5: Verifying NULL Counts Parity...');
        const sqNullPass = sqlite.prepare('SELECT COUNT(*) as cnt FROM users WHERE password_hash IS NULL;').get().cnt;
        const pgNullPassRes = await migClient.query('SELECT COUNT(*)::int as cnt FROM users WHERE password_hash IS NULL;');
        const pgNullPass = pgNullPassRes.rows[0].cnt;
        assert.strictEqual(sqNullPass, 4, 'SQLite must have exactly 4 NULL password_hash');
        assert.strictEqual(pgNullPass, 4, 'PostgreSQL must preserve exactly 4 NULL password_hash');
        console.log(`  ✓ NULL password_hash parity: exactly ${pgNullPass} users with NULL password.`);

        // -------------------------------------------------------------
        // Point 6: Financial Precision
        // -------------------------------------------------------------
        console.log('\nPoint 6: Verifying Financial Precision...');
        const pgPrices = (await migClient.query('SELECT price FROM products WHERE price IS NOT NULL;')).rows;
        assert.strictEqual(pgPrices.length, 60, 'All 60 products must have valid NUMERIC prices');
        for (const pr of pgPrices) {
            assert(/^[0-9]+\.[0-9]{2}$/.test(pr.price), `Price must be formatted as NUMERIC(12, 2), got: ${pr.price}`);
        }
        console.log('  ✓ Financial Precision: All 60 product prices formatted with exact 2 decimal places.');

        // -------------------------------------------------------------
        // Point 7: Timestamps & Timezones
        // -------------------------------------------------------------
        console.log('\nPoint 7: Verifying Timestamps & Timezones...');
        const sampleDate = (await migClient.query('SELECT created_at FROM users LIMIT 1;')).rows[0].created_at;
        assert(sampleDate instanceof Date, 'PostgreSQL TIMESTAMPTZ must be returned as native Date object');
        assert(!isNaN(sampleDate.getTime()), 'Timestamp must be valid epoch');
        console.log(`  ✓ Timestamps parsed as valid native Date: ${sampleDate.toISOString()}`);

        // -------------------------------------------------------------
        // Point 8: JSONB Validity & safeJsonParse
        // -------------------------------------------------------------
        console.log('\nPoint 8: Verifying JSONB Validity via safeJsonParse...');
        const sampleSubs = (await migClient.query('SELECT allowed_formats FROM subscriptions;')).rows;
        for (const s of sampleSubs) {
            const parsed = safeJsonParse(s.allowed_formats, { column: 'allowed_formats' });
            assert(Array.isArray(parsed), 'allowed_formats must be an array');
        }
        const sampleImports = (await migClient.query('SELECT source_files FROM imports;')).rows;
        for (const im of sampleImports) {
            const parsed = safeJsonParse(im.source_files, { column: 'source_files' });
            assert(Array.isArray(parsed), 'source_files must be an array');
        }
        console.log('  ✓ JSONB validity: All JSONB columns pass safeJsonParse without corruption.');

        // -------------------------------------------------------------
        // Point 9: Lifecycle & Quarantine Parity
        // -------------------------------------------------------------
        console.log('\nPoint 9: Verifying Lifecycle & Quarantine Parity...');
        const pendingProds = (await migClient.query("SELECT COUNT(*)::int as cnt FROM products WHERE status = 'PENDING_APPROVAL';")).rows[0].cnt;
        const publishedProds = (await migClient.query("SELECT COUNT(*)::int as cnt FROM products WHERE status = 'PUBLISHED';")).rows[0].cnt;
        const demoProds = (await migClient.query("SELECT COUNT(*)::int as cnt FROM products WHERE is_demo = true;")).rows[0].cnt;
        const nonDemoPublished = (await migClient.query("SELECT COUNT(*)::int as cnt FROM products WHERE is_demo = false AND status = 'PUBLISHED';")).rows[0].cnt;

        assert.strictEqual(pendingProds, 21, 'Must have exactly 21 PENDING_APPROVAL products');
        assert.strictEqual(publishedProds, 39, 'Must have exactly 39 PUBLISHED products');
        assert.strictEqual(demoProds, 25, 'Must have exactly 25 is_demo = true products');
        assert.strictEqual(nonDemoPublished, 14, 'Must have exactly 14 public non-demo published products');
        console.log(`  ✓ Lifecycle Parity: 21 Pending, 39 Published (including 25 Quarantined Demo, 14 Public Catalog).`);

        // -------------------------------------------------------------
        // Point 10: Application Queries & Permissions with zarsev_app
        // -------------------------------------------------------------
        console.log('\nPoint 10: Verifying Application Runtime Permissions with zarsev_app...');
        // Public Catalog query
        const publicCatalog = await appPool.query("SELECT id, name_ar, price, currency FROM products WHERE is_demo = false AND status = 'PUBLISHED';");
        assert.strictEqual(publicCatalog.rows.length, 14, 'Public catalog query must return exactly 14 products');
        console.log(`  ✓ zarsev_app Catalog Query: Returned ${publicCatalog.rows.length} public non-demo products.`);

        // DML test with zarsev_app using a valid foreign key from imports
        const realImport = (await appPool.query('SELECT id FROM imports LIMIT 1;')).rows[0];
        assert(realImport, 'Must have at least one valid import in imports table');
        const insertTest = await appPool.query(
            "INSERT INTO import_logs (id, import_id, step, message, severity) VALUES ('log_test_app', $1, 'DRY_RUN_APP_TEST', 'App logged successfully', 'INFO') RETURNING id;",
            [realImport.id]
        );
        assert.strictEqual(insertTest.rowCount, 1);
        await appPool.query("DELETE FROM import_logs WHERE id = 'log_test_app';");
        console.log('  ✓ zarsev_app DML: Successfully inserted and deleted test log entry.');

        // DDL block test with zarsev_app
        let ddlBlocked = false;
        try {
            await appPool.query('CREATE TABLE _test_app_illegal (id INT);');
        } catch (err) {
            ddlBlocked = true;
            assert.strictEqual(err.code, '42501');
        }
        assert.strictEqual(ddlBlocked, true, 'zarsev_app must NOT be able to execute DDL');
        console.log('  ✓ zarsev_app DDL Protection: Rejected with SQLSTATE 42501.');

        // -------------------------------------------------------------
        // Step 3: Idempotency & Re-run Verification
        // -------------------------------------------------------------
        console.log('\n--- Step 3: Verifying Idempotency & Re-run Behavior ---');
        const reRunStats = await migrateData(TARGET_DB);
        for (const t of tables) {
            assert.strictEqual(reRunStats[t].insertedCount, 0, `Re-run of migration must insert 0 rows for table '${t}'`);
        }
        console.log('✓ Idempotency verified: Re-running data migration inserted 0 new rows (ON CONFLICT DO NOTHING).\n');

    } finally {
        sqlite.close();
        await migClient.end().catch(() => {});
        await closePool();
    }

    // -------------------------------------------------------------
    // Step 4: Final Environment & Safety Assertions
    // -------------------------------------------------------------
    console.log('--- Step 4: Final Safety & Isolation Assertions ---');

    // 1. Verify zarsev_dev has exactly 0 tables
    const devMigClient = getMigratorClient('zarsev_dev');
    try {
        await devMigClient.connect();
        const devTables = (await devMigClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';")).rows;
        assert.strictEqual(devTables.length, 0, `[FATAL ISOLATION VIOLATION] zarsev_dev has ${devTables.length} tables!`);
        console.log('✓ Dev DB Integrity: zarsev_dev public schema has exactly 0 tables (untouched!).');
    } finally {
        await devMigClient.end().catch(() => {});
    }

    // 2. Verify SQLite files bit-for-bit immutability
    const hashAfterDb = getHash(SQLITE_PATH);
    const hashAfterBak = getHash(path.resolve(__dirname, '..', 'zarsev.db.bak'));
    const hashAfterPre = getHash(path.resolve(__dirname, '..', 'zarsev.db.phase1_2_prequarantine.bak'));

    assert.strictEqual(hashBeforeDb, hashAfterDb, '[FATAL INTEGRITY VIOLATION] zarsev.db hash changed!');
    assert.strictEqual(hashBeforeBak, hashAfterBak, '[FATAL INTEGRITY VIOLATION] zarsev.db.bak hash changed!');
    assert.strictEqual(hashBeforePre, hashAfterPre, '[FATAL INTEGRITY VIOLATION] zarsev.db.phase1_2_prequarantine.bak hash changed!');
    console.log('✓ SQLite Integrity: All 3 SQLite database files 100% bit-for-bit identical to baseline.');

    console.log('\n================================================================');
    console.log('✅ ALL PHASE 2.2 DRY RUN TESTS & INTEGRITY CHECKS PASSED (100%)');
    console.log('================================================================');
}

if (require.main === module) {
    runDryRunVerification().catch(err => {
        console.error('\n❌ PHASE 2.2 DRY RUN VERIFICATION FAILED:', err);
        process.exit(1);
    });
}

module.exports = { runDryRunVerification };
