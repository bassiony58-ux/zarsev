/**
 * scripts/verify_and_nullify_legacy_tokens_test_only.js
 * 
 * Verifies that all existing legacy buyer tokens in zarsev_test:
 * 1. Have accurate SHA-256 hashes in buyer_access_token_hash.
 * 2. Authenticate successfully against the live tracking API via hash-only verification.
 * 3. Nullifies legacy plaintext buyer_access_token column values in zarsev_test.
 * 4. Confirms that after nullification, zero plaintext tokens remain at rest.
 * 5. Confirms that all previously issued buyer tokens still authenticate seamlessly.
 * 
 * Safety:
 * - Strictly operates against PostgreSQL database 'zarsev_test'.
 * - Leaves zarsev.db (SQLite) and zarsev_dev 100% untouched.
 * - Does not log or expose raw tokens anywhere.
 */

const assert = require('assert');
const crypto = require('crypto');
const { Client } = require('pg');
const { resolveAppConfig, resolveMigratorConfig } = require('../src/db/pgAdapter');

const BASE_URL = 'http://localhost:3001';

async function verifyAndNullify() {
    console.log('===================================================================');
    console.log('🔒 ZARSEV PHASE 4.1: LEGACY TOKEN HASH AUDIT & NULLIFICATION');
    console.log('===================================================================\n');

    const appClient = new Client(resolveAppConfig('zarsev_test'));
    const migratorClient = new Client(resolveMigratorConfig('zarsev_test'));

    await appClient.connect();
    await migratorClient.connect();

    try {
        // 1. SAFETY ASSERTIONS
        const dbCheck = await migratorClient.query('SELECT current_database(), current_user');
        console.log(`Connected user: ${dbCheck.rows[0].current_user}`);
        console.log(`Connected database: ${dbCheck.rows[0].current_database}`);
        assert.strictEqual(
            dbCheck.rows[0].current_database,
            'zarsev_test',
            'FATAL SAFETY VIOLATION: Target database must strictly be zarsev_test!'
        );

        // 2. Fetch all legacy rows with non-null plaintext tokens
        const legacyRows = await appClient.query(`
            SELECT id, reference_no, buyer_access_token, buyer_access_token_hash
            FROM rfqs
            WHERE buyer_access_token IS NOT NULL
            ORDER BY created_at ASC
        `);

        console.log(`Found ${legacyRows.rows.length} records with non-null legacy plaintext tokens.\n`);

        const tokenFixtures = [];

        // 3. Verify each record's SHA-256 hash mathematically
        for (const row of legacyRows.rows) {
            const rawToken = row.buyer_access_token;
            const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

            assert.strictEqual(
                row.buyer_access_token_hash,
                expectedHash,
                `Hash mismatch for RFQ ${row.reference_no}!`
            );

            // Store fixture for live HTTP verification (without exposing raw token in console)
            tokenFixtures.push({
                id: row.id,
                reference_no: row.reference_no,
                token: rawToken,
                hashPrefix: row.buyer_access_token_hash.substring(0, 16) + '...'
            });

            console.log(`✓ Mathematical Hash Verified: RFQ ${row.reference_no} -> SHA-256: ${row.buyer_access_token_hash.substring(0, 16)}...`);
        }

        // 4. Pre-Nullification Live HTTP API Verification (Strictly Hash-Based)
        console.log('\n--- Pre-Nullification Live HTTP API Test (Server Pure Hash Route) ---');
        for (const fix of tokenFixtures) {
            const url = `${BASE_URL}/api/rfqs/track?ref=${encodeURIComponent(fix.reference_no)}&token=${encodeURIComponent(fix.token)}`;
            const res = await fetch(url);
            const data = await res.json();

            assert.strictEqual(res.status, 200, `Live tracking failed for ${fix.reference_no} with status ${res.status}`);
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.rfq.reference_no, fix.reference_no);
            console.log(`✓ Live HTTP Verification Pre-Nullify: RFQ ${fix.reference_no} returned 200 OK via hash`);
        }

        // 5. Execute Plaintext Nullification in zarsev_test
        console.log('\n--- Executing Plaintext Nullification in zarsev_test ---');
        const nullifyRes = await migratorClient.query(`
            UPDATE rfqs 
            SET buyer_access_token = NULL 
            WHERE buyer_access_token IS NOT NULL;
        `);
        console.log(`✓ Executed NULL update under zarsev_migrator. Rows updated: ${nullifyRes.rowCount}`);

        // 6. Verify ZERO non-null plaintext tokens remain in zarsev_test
        const countCheck = await appClient.query(`
            SELECT 
                COUNT(*) as total_rfqs,
                COUNT(buyer_access_token) as plaintext_count,
                COUNT(buyer_access_token_hash) as hashed_count
            FROM rfqs;
        `);

        const stats = countCheck.rows[0];
        console.log('\n--- Post-Nullification Database Token Statistics ---');
        console.log(` - Total RFQs:       ${stats.total_rfqs}`);
        console.log(` - Plaintext Count:  ${stats.plaintext_count}`);
        console.log(` - Hashed Count:     ${stats.hashed_count}`);

        assert.strictEqual(
            parseInt(stats.plaintext_count, 10),
            0,
            'FATAL: Expected exactly 0 non-null plaintext tokens remaining in zarsev_test!'
        );
        assert.strictEqual(
            stats.total_rfqs,
            stats.hashed_count,
            'FATAL: Every single RFQ must have a valid SHA-256 hash!'
        );
        console.log('✓ Zero non-null plaintext tokens confirmed across all records in zarsev_test.');

        // 7. Verify Legacy Column Still Exists in Schema (Do Not Drop)
        const colCheck = await appClient.query(`
            SELECT column_name, is_nullable, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'rfqs' AND column_name IN ('buyer_access_token', 'buyer_access_token_hash')
            ORDER BY column_name;
        `);
        console.log('\nSchema columns verified in rfqs table:');
        colCheck.rows.forEach(c => console.log(` - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable})`));
        assert.strictEqual(colCheck.rows.length, 2, 'Both buyer_access_token and buyer_access_token_hash must remain in schema.');

        // 8. Post-Nullification Live HTTP API Verification (All Issued Tokens Still Function 100%)
        console.log('\n--- Post-Nullification Live HTTP API Test (Proving issued tokens still work) ---');
        for (const fix of tokenFixtures) {
            const url = `${BASE_URL}/api/rfqs/track?ref=${encodeURIComponent(fix.reference_no)}&token=${encodeURIComponent(fix.token)}`;
            const res = await fetch(url);
            const data = await res.json();

            assert.strictEqual(res.status, 200, `Live tracking failed for ${fix.reference_no} with status ${res.status}`);
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.rfq.reference_no, fix.reference_no);
            assert.strictEqual(data.rfq.buyer_access_token, undefined);
            console.log(`✓ Live HTTP Verification Post-Nullify: RFQ ${fix.reference_no} returned 200 OK via SHA-256 hash alone`);
        }

        console.log('\n===================================================================');
        console.log('🎉 TASK 1 COMPLETE: ZERO PLAINTEXT CREDENTIALS REMAIN AT REST');
        console.log('===================================================================');

    } finally {
        await appClient.end();
        await migratorClient.end();
    }
}

verifyAndNullify().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Task 1 Execution Failed:', err);
    process.exit(1);
});
