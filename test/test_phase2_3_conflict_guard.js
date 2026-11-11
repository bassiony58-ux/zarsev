/**
 * test/test_phase2_3_conflict_guard.js
 * 
 * Strict Phase 2.3 & 2.3.2 Verification Suite:
 * Validates the Hardened Conflict Guard and Record-Level Integrity Engine of
 * `scripts/migrate_sqlite_to_postgres.js`.
 * 
 * Test Scenarios:
 *  1. Insert non-existent record.
 *  2. Accept existing identical record as ALREADY_MATCHED without modification.
 *  3. Detect single field mismatch and halt with structured error.
 *  3.1. Strict string comparison: "ABC" vs "ABC " (Zero generic trimming).
 *  4. Detect JSONB mismatch (semantic comparison, key-order independent).
 *  5. Detect NULL mismatch (NULL vs value, value vs NULL, NULL vs NULL).
 *  6. Detect financial precision and price mismatch.
 *  7. Detect date and timestamp mismatch.
 *  8. Transaction rollback: No undocumented partial migration left on conflict.
 *  9. Re-run after conflict explicitly resolved succeeds with ALREADY_MATCHED.
 * 10. Verify zero modification to existing 342 business records.
 * 11. Generalized sensitive-value redaction (password_hash, api_token, secret_key, credential_value, safe error format).
 * 12. Dynamic schema column coverage (live validation, extra target column, missing target column, unmapped source column).
 */

const assert = require('assert');
const crypto = require('crypto');
const { getMigratorClient, closePool } = require('../src/db/pgAdapter');
const {
    compareRecordFields,
    transferSingleRecord,
    validateSchemaCoverage,
    sanitizeDiffValue,
    formatSafeError,
    MigrationConflictError,
    SchemaMismatchError,
    SENSITIVE_COLUMN_PATTERN,
    TABLE_DEFINITIONS
} = require('../scripts/migrate_sqlite_to_postgres');

function hashObject(obj) {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

async function runPhase2_3Tests() {
    console.log('================================================================');
    console.log('🧪 Phase 2.3.2: Strict Conflict Guard & Hardening Test Suite');
    console.log('================================================================\n');

    const pgClient = getMigratorClient('zarsev_test');
    await pgClient.connect();

    // Capture initial baseline hashes for all 342 business records to verify zero modification
    console.log('--- Capturing Baseline State for all 342 Business Records ---');
    const baselineHashes = new Map();
    for (const [table, meta] of Object.entries(TABLE_DEFINITIONS)) {
        const rows = (await pgClient.query(`SELECT * FROM "${table}" ORDER BY "${meta.idCol}" ASC;`)).rows;
        for (const row of rows) {
            baselineHashes.set(`${table}:${row[meta.idCol]}`, hashObject(row));
        }
    }
    console.log(`✓ Baseline captured: ${baselineHashes.size} records across 9 tables.\n`);

    try {
        // -------------------------------------------------------------
        // Test 1: Insert non-existent record
        // -------------------------------------------------------------
        console.log('Test 1: Inserting non-existent synthetic record...');
        const synthCat1 = {
            id: 'synth_conf_test_cat_01',
            parent_id: null,
            name_ar: 'تصنيف تجريبي لاختبار الصراع',
            name_en: 'Synthetic Conflict Test Category',
            slug: 'synth-conf-cat-01',
            icon: 'icon-test',
            created_at: '2026-11-02T12:00:00.000Z'
        };

        // Ensure clean state before
        await pgClient.query("DELETE FROM categories WHERE id = 'synth_conf_test_cat_01';");

        const res1 = await transferSingleRecord(
            pgClient,
            'categories',
            synthCat1,
            TABLE_DEFINITIONS.categories.insertSql,
            TABLE_DEFINITIONS.categories.transformRow
        );
        assert.strictEqual(res1.action, 'INSERTED', 'Must report action as INSERTED');
        assert.strictEqual(res1.rowCount, 1, 'Must insert exactly 1 row');

        const inDb1 = (await pgClient.query("SELECT * FROM categories WHERE id = 'synth_conf_test_cat_01';")).rows[0];
        assert(inDb1, 'Record must exist in DB');
        assert.strictEqual(inDb1.slug, 'synth-conf-cat-01');
        console.log('  ✓ Passed: Record inserted cleanly.\n');

        // -------------------------------------------------------------
        // Test 2: Accept existing identical record as ALREADY_MATCHED
        // -------------------------------------------------------------
        console.log('Test 2: Accepting existing identical record without modification...');
        const res2 = await transferSingleRecord(
            pgClient,
            'categories',
            synthCat1,
            TABLE_DEFINITIONS.categories.insertSql,
            TABLE_DEFINITIONS.categories.transformRow
        );
        assert.strictEqual(res2.action, 'ALREADY_MATCHED', 'Must report action as ALREADY_MATCHED');
        assert.strictEqual(res2.rowCount, 0, 'Must not perform any insert');

        const inDb2 = (await pgClient.query("SELECT * FROM categories WHERE id = 'synth_conf_test_cat_01';")).rows[0];
        assert.strictEqual(hashObject(inDb1), hashObject(inDb2), 'DB record must remain 100% bit-for-bit unchanged');
        console.log('  ✓ Passed: Identical record detected as ALREADY_MATCHED and left untouched.\n');

        // -------------------------------------------------------------
        // Test 3: Detect single field mismatch and halt
        // -------------------------------------------------------------
        console.log('Test 3: Detecting single field mismatch and halting...');
        const synthCatMismatched = {
            ...synthCat1,
            name_en: 'DIFFERENT Name Conflict'
        };

        let caught3 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'categories',
                synthCatMismatched,
                TABLE_DEFINITIONS.categories.insertSql,
                TABLE_DEFINITIONS.categories.transformRow
            );
        } catch (err) {
            caught3 = err;
        }

        assert(caught3 instanceof MigrationConflictError, 'Must throw MigrationConflictError');
        assert.strictEqual(caught3.table, 'categories');
        assert.strictEqual(caught3.id, 'synth_conf_test_cat_01');
        assert(caught3.differences.some(d => d.column === 'name_en'), 'Differences must identify column name_en');
        assert(caught3.message.includes('DIFFERENT Name Conflict'), 'Error message must specify differing source value');
        console.log(`  ✓ Passed: Single field mismatch correctly detected and rejected:`);
        console.log(`    "${caught3.message.split('\n')[1]}"\n`);

        // -------------------------------------------------------------
        // Test 3.1: Strict string comparison: "ABC" vs "ABC " (Zero generic trimming)
        // -------------------------------------------------------------
        console.log('Test 3.1: Testing strict string comparison without generic .trim()...');
        // Target DB has name_en = 'Synthetic Conflict Test Category'
        // Test A: Source has same text + trailing space: 'Synthetic Conflict Test Category '
        const synthCatTrailingSpace = {
            ...synthCat1,
            name_en: 'Synthetic Conflict Test Category ' // Trailing space!
        };

        let caught3_1 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'categories',
                synthCatTrailingSpace,
                TABLE_DEFINITIONS.categories.insertSql,
                TABLE_DEFINITIONS.categories.transformRow
            );
        } catch (err) {
            caught3_1 = err;
        }

        assert(caught3_1 instanceof MigrationConflictError, 'Must throw MigrationConflictError on trailing space difference');
        assert(caught3_1.differences.some(d => d.column === 'name_en' && d.reason === 'String exact value mismatch'));
        console.log('  ✓ Passed: Trailing whitespace difference correctly detected as mismatch (zero silent trimming).');

        // Test B: Exact match without trailing space succeeds as ALREADY_MATCHED
        const res3_1b = await transferSingleRecord(
            pgClient,
            'categories',
            synthCat1,
            TABLE_DEFINITIONS.categories.insertSql,
            TABLE_DEFINITIONS.categories.transformRow
        );
        assert.strictEqual(res3_1b.action, 'ALREADY_MATCHED', 'Exact string match must succeed as ALREADY_MATCHED');
        console.log('  ✓ Passed: Exact string matches without false positive.\n');

        // -------------------------------------------------------------
        // Test 4: Detect JSONB mismatch (semantic comparison, key-order independent)
        // -------------------------------------------------------------
        console.log('Test 4: Testing JSONB semantic comparison and mismatch detection...');
        const synthProdId = 'synth_conf_test_prd_01';
        await pgClient.query("DELETE FROM products WHERE id = $1;", [synthProdId]);

        // Insert a synthetic product with specs: {"color":"blue","grade":"A"}
        await pgClient.query(
            `INSERT INTO products (
                id, manufacturer_id, category_id, sku, name_ar, name_en, specifications, price, currency, price_unit, status, is_demo, created_at, updated_at
            ) VALUES ($1, 'mfg_delta_iqf', 'synth_conf_test_cat_01', 'SKU-JSON-TEST', 'منتج اختبار', 'Test Product', $2, '100.00', 'USD', 'MT', 'DRAFT', true, NOW(), NOW());`,
            [synthProdId, JSON.stringify({ color: 'blue', grade: 'A' })]
        );

        // 4.1: Source with identical JSON but DIFFERENT KEY ORDER: {"grade":"A","color":"blue"}
        const synthProdReorderedKey = {
            id: synthProdId,
            manufacturer_id: 'mfg_delta_iqf',
            category_id: 'synth_conf_test_cat_01',
            sku: 'SKU-JSON-TEST',
            name_ar: 'منتج اختبار',
            name_en: 'Test Product',
            specifications: '{"grade":"A","color":"blue"}', // Reversed key order!
            price: 100.0,
            currency: 'USD',
            price_unit: 'MT',
            status: 'DRAFT',
            is_demo: 1,
            created_at: (await pgClient.query('SELECT created_at FROM products WHERE id = $1;', [synthProdId])).rows[0].created_at,
            updated_at: (await pgClient.query('SELECT updated_at FROM products WHERE id = $1;', [synthProdId])).rows[0].updated_at
        };

        const res4_1 = await transferSingleRecord(
            pgClient,
            'products',
            synthProdReorderedKey,
            TABLE_DEFINITIONS.products.insertSql,
            TABLE_DEFINITIONS.products.transformRow
        );
        assert.strictEqual(res4_1.action, 'ALREADY_MATCHED', 'Reordered JSON keys must match semantically');
        console.log('  ✓ Passed: Reordered JSON keys correctly recognized as semantically identical.');

        // 4.2: Source with genuinely different JSON: {"color":"red","grade":"A"}
        const synthProdDiffJson = {
            ...synthProdReorderedKey,
            specifications: '{"color":"red","grade":"A"}'
        };

        let caught4 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'products',
                synthProdDiffJson,
                TABLE_DEFINITIONS.products.insertSql,
                TABLE_DEFINITIONS.products.transformRow
            );
        } catch (err) {
            caught4 = err;
        }

        assert(caught4 instanceof MigrationConflictError, 'Must throw MigrationConflictError for JSON mismatch');
        assert(caught4.differences.some(d => d.column === 'specifications'), 'Must identify specifications column');
        console.log('  ✓ Passed: Genuine JSON mismatch correctly detected and rejected.\n');

        // -------------------------------------------------------------
        // Test 5: Detect NULL mismatch
        // -------------------------------------------------------------
        console.log('Test 5: Detecting NULL mismatch (NULL vs value, value vs NULL, NULL vs NULL)...');
        const synthMfrId = 'synth_conf_test_mfr_01';
        await pgClient.query("DELETE FROM manufacturers WHERE id = $1;", [synthMfrId]);

        // Insert manufacturer with contact_email = NULL
        await pgClient.query(
            `INSERT INTO manufacturers (
                id, name_ar, name_en, code, business_model, country, city, contact_email, is_verified, is_demo, created_at
            ) VALUES ($1, 'مصنع تجريبي', 'Synth Mfr', 'CODE_NULL_TEST', 'DIRECT_CONTRACT', 'مصر', 'القاهرة', NULL, true, true, NOW());`,
            [synthMfrId]
        );

        // 5.1: Source has contact_email = 'contact@example.com' (NOT NULL vs DB NULL)
        const synthMfrNonNull = {
            id: synthMfrId,
            name_ar: 'مصنع تجريبي',
            name_en: 'Synth Mfr',
            code: 'CODE_NULL_TEST',
            business_model: 'DIRECT_CONTRACT',
            country: 'مصر',
            city: 'القاهرة',
            contact_email: 'contact@example.com',
            is_verified: 1,
            is_demo: 1,
            created_at: (await pgClient.query('SELECT created_at FROM manufacturers WHERE id = $1;', [synthMfrId])).rows[0].created_at
        };

        let caught5_1 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'manufacturers',
                synthMfrNonNull,
                TABLE_DEFINITIONS.manufacturers.insertSql,
                TABLE_DEFINITIONS.manufacturers.transformRow
            );
        } catch (err) {
            caught5_1 = err;
        }

        assert(caught5_1 instanceof MigrationConflictError, 'Must throw on NOT NULL vs NULL');
        assert(caught5_1.differences.some(d => d.column === 'contact_email' && d.reason.includes('Source is NOT NULL but target is NULL')));
        console.log('  ✓ Passed: Source NOT NULL vs Target NULL mismatch correctly detected.');

        // 5.2: Target has NOT NULL, Source has NULL
        await pgClient.query("UPDATE manufacturers SET contact_email = 'existing@example.com' WHERE id = $1;", [synthMfrId]);
        const synthMfrNull = {
            ...synthMfrNonNull,
            contact_email: null
        };

        let caught5_2 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'manufacturers',
                synthMfrNull,
                TABLE_DEFINITIONS.manufacturers.insertSql,
                TABLE_DEFINITIONS.manufacturers.transformRow
            );
        } catch (err) {
            caught5_2 = err;
        }

        assert(caught5_2 instanceof MigrationConflictError, 'Must throw on NULL vs NOT NULL');
        assert(caught5_2.differences.some(d => d.column === 'contact_email' && d.reason.includes('Source is NULL but target is NOT NULL')));
        console.log('  ✓ Passed: Source NULL vs Target NOT NULL mismatch correctly detected.');

        // 5.3: Both NULL
        await pgClient.query("UPDATE manufacturers SET contact_email = NULL WHERE id = $1;", [synthMfrId]);
        const res5_3 = await transferSingleRecord(
            pgClient,
            'manufacturers',
            synthMfrNull,
            TABLE_DEFINITIONS.manufacturers.insertSql,
            TABLE_DEFINITIONS.manufacturers.transformRow
        );
        assert.strictEqual(res5_3.action, 'ALREADY_MATCHED', 'Both NULL must match cleanly');
        console.log('  ✓ Passed: Both NULL correctly treated as identical match.\n');

        // -------------------------------------------------------------
        // Test 6: Detect financial precision and price mismatch
        // -------------------------------------------------------------
        console.log('Test 6: Detecting price and financial precision mismatch...');
        // 6.1: Precision match: 100.5 vs '100.50'
        const synthProdPrecisionMatch = {
            ...synthProdReorderedKey,
            specifications: '{"color":"blue","grade":"A"}',
            price: 100.5 // numeric equivalent to 100.50
        };
        await pgClient.query("UPDATE products SET price = 100.50 WHERE id = $1;", [synthProdId]);

        const res6_1 = await transferSingleRecord(
            pgClient,
            'products',
            synthProdPrecisionMatch,
            TABLE_DEFINITIONS.products.insertSql,
            TABLE_DEFINITIONS.products.transformRow
        );
        assert.strictEqual(res6_1.action, 'ALREADY_MATCHED', '100.5 must match 100.50');
        console.log('  ✓ Passed: Decimal precision parity (100.5 vs 100.50) matched without error.');

        // 6.2: Price mismatch: 100.51 vs 100.50
        const synthProdPriceMismatch = {
            ...synthProdPrecisionMatch,
            price: 100.51
        };

        let caught6 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'products',
                synthProdPriceMismatch,
                TABLE_DEFINITIONS.products.insertSql,
                TABLE_DEFINITIONS.products.transformRow
            );
        } catch (err) {
            caught6 = err;
        }

        assert(caught6 instanceof MigrationConflictError, 'Must throw on price difference');
        assert(caught6.differences.some(d => d.column === 'price' && d.reason.includes('Financial precision mismatch')));
        console.log('  ✓ Passed: Financial value mismatch (100.51 vs 100.50) correctly detected.\n');

        // -------------------------------------------------------------
        // Test 7: Detect date and timestamp mismatch
        // -------------------------------------------------------------
        console.log('Test 7: Detecting date and timestamp mismatch...');
        // 7.1: Timestamp point-in-time match
        const dbCreatedAt = (await pgClient.query('SELECT created_at FROM products WHERE id = $1;', [synthProdId])).rows[0].created_at;
        const synthProdDateMatch = {
            ...synthProdPrecisionMatch,
            created_at: new Date(dbCreatedAt).toISOString()
        };

        const res7_1 = await transferSingleRecord(
            pgClient,
            'products',
            synthProdDateMatch,
            TABLE_DEFINITIONS.products.insertSql,
            TABLE_DEFINITIONS.products.transformRow
        );
        assert.strictEqual(res7_1.action, 'ALREADY_MATCHED', 'Identical timestamp instant must match');
        console.log('  ✓ Passed: Identical timestamp instant matched cleanly.');

        // 7.2: Timestamp mismatch (5 minutes later)
        const synthProdDateMismatch = {
            ...synthProdDateMatch,
            created_at: new Date(new Date(dbCreatedAt).getTime() + 300000).toISOString()
        };

        let caught7 = null;
        try {
            await transferSingleRecord(
                pgClient,
                'products',
                synthProdDateMismatch,
                TABLE_DEFINITIONS.products.insertSql,
                TABLE_DEFINITIONS.products.transformRow
            );
        } catch (err) {
            caught7 = err;
        }

        assert(caught7 instanceof MigrationConflictError, 'Must throw on date mismatch');
        assert(caught7.differences.some(d => d.column === 'created_at' && d.reason.includes('Timestamp mismatch')));
        console.log('  ✓ Passed: Timestamp mismatch correctly detected and rejected.\n');

        // -------------------------------------------------------------
        // Test 8: Transaction rollback: No partial migration on conflict
        // -------------------------------------------------------------
        console.log('Test 8: Testing transaction rollback on conflict (zero partial migration)...');
        const batchItemValid = {
            id: 'synth_conf_test_cat_batch_01',
            parent_id: null,
            name_ar: 'دفعة تصنيف سليم',
            name_en: 'Valid Batch Cat',
            slug: 'synth-batch-valid',
            icon: null,
            created_at: '2026-11-02T13:00:00.000Z'
        };

        const batchItemConflicting = {
            ...synthCat1, // exists in DB with slug 'synth-conf-cat-01'
            slug: 'DIFFERENT_CONFLICTING_SLUG' // Conflict!
        };

        // Clean up batch item if exists
        await pgClient.query("DELETE FROM categories WHERE id = 'synth_conf_test_cat_batch_01';");

        let batchError = null;
        await pgClient.query('BEGIN;');
        try {
            // Step A: Insert valid new record (succeeds inside tx)
            const rA = await transferSingleRecord(
                pgClient,
                'categories',
                batchItemValid,
                TABLE_DEFINITIONS.categories.insertSql,
                TABLE_DEFINITIONS.categories.transformRow
            );
            assert.strictEqual(rA.action, 'INSERTED');

            // Step B: Attempt conflicting record (must fail and throw)
            await transferSingleRecord(
                pgClient,
                'categories',
                batchItemConflicting,
                TABLE_DEFINITIONS.categories.insertSql,
                TABLE_DEFINITIONS.categories.transformRow
            );

            await pgClient.query('COMMIT;');
        } catch (err) {
            batchError = err;
            await pgClient.query('ROLLBACK;').catch(() => {});
        }

        assert(batchError instanceof MigrationConflictError, 'Batch must fail with MigrationConflictError');

        // Verify that batchItemValid was NOT committed to DB (rolled back!)
        const checkRolledBack = (await pgClient.query("SELECT * FROM categories WHERE id = 'synth_conf_test_cat_batch_01';")).rows;
        assert.strictEqual(checkRolledBack.length, 0, 'Valid record in failing transaction must be rolled back');
        console.log('  ✓ Passed: Transaction successfully rolled back; zero partial writes committed.\n');

        // -------------------------------------------------------------
        // Test 9: Re-run after conflict explicitly resolved succeeds
        // -------------------------------------------------------------
        console.log('Test 9: Re-running transfer after resolving conflict...');
        const resolvedBatchItem = {
            ...synthCat1,
            slug: 'synth-conf-cat-01' // Matches DB!
        };

        let rerunError = null;
        await pgClient.query('BEGIN;');
        try {
            const r1 = await transferSingleRecord(
                pgClient,
                'categories',
                batchItemValid,
                TABLE_DEFINITIONS.categories.insertSql,
                TABLE_DEFINITIONS.categories.transformRow
            );
            assert.strictEqual(r1.action, 'INSERTED');

            const r2 = await transferSingleRecord(
                pgClient,
                'categories',
                resolvedBatchItem,
                TABLE_DEFINITIONS.categories.insertSql,
                TABLE_DEFINITIONS.categories.transformRow
            );
            assert.strictEqual(r2.action, 'ALREADY_MATCHED');

            await pgClient.query('COMMIT;');
        } catch (err) {
            rerunError = err;
            await pgClient.query('ROLLBACK;').catch(() => {});
        }

        assert.strictEqual(rerunError, null, 'Re-run must complete without error');
        console.log('  ✓ Passed: Re-run succeeded cleanly with ALREADY_MATCHED and no conflicts.\n');

        // -------------------------------------------------------------
        // Test 11: Generalized Sensitive-Value Redaction
        // -------------------------------------------------------------
        console.log('Test 11: Testing generalized sensitive-value redaction and safe error logging...');
        // 11.1: password_hash
        const r1 = sanitizeDiffValue('password_hash', '$pbkdf2$iterations=210000$hash...');
        assert.strictEqual(r1, '[REDACTED_PASSWORD_HASH]');

        // 11.2: api_token
        const r2 = sanitizeDiffValue('api_token', 'tok_live_9876543210');
        assert.strictEqual(r2, '[REDACTED_API_TOKEN]');

        // 11.3: secret_key
        const r3 = sanitizeDiffValue('secret_key', 'sk_live_abcdef123456');
        assert.strictEqual(r3, '[REDACTED_SECRET_KEY]');

        // 11.4: credential_value
        const r4 = sanitizeDiffValue('credential_value', 'cred_secret_pass');
        assert.strictEqual(r4, '[REDACTED_CREDENTIAL_VALUE]');

        // 11.5: SENSITIVE_COLUMN_PATTERN validation
        assert(SENSITIVE_COLUMN_PATTERN.test('admin_password'));
        assert(SENSITIVE_COLUMN_PATTERN.test('jwt_secret'));
        assert(SENSITIVE_COLUMN_PATTERN.test('refresh_token'));
        assert(SENSITIVE_COLUMN_PATTERN.test('encryption_key'));
        assert(SENSITIVE_COLUMN_PATTERN.test('user_credential'));
        assert(!SENSITIVE_COLUMN_PATTERN.test('subscription_id'));
        assert(!SENSITIVE_COLUMN_PATTERN.test('category_id'));
        assert(!SENSITIVE_COLUMN_PATTERN.test('price'));

        // 11.6: formatSafeError strips raw row data from PostgreSQL errors
        const mockRawDbErr = new Error('duplicate key value violates unique constraint "users_email_key" Key (email)=(admin@example.com) (Failing row contains (usr_01, admin, $pbkdf2$iterations=210000$secret))');
        mockRawDbErr.code = '23505';

        const safeErr = formatSafeError(mockRawDbErr, 'users', 'usr_01');
        assert(!safeErr.message.includes('$pbkdf2$'), 'Safe error must NEVER leak raw row data');
        assert(safeErr.message.includes('(Failing row values redacted for security)'));
        assert(safeErr.message.includes('SQLSTATE: 23505'));
        assert.strictEqual(safeErr.table, 'users');
        assert.strictEqual(safeErr.recordId, 'usr_01');
        console.log('  ✓ Passed: Sensitive columns (password_hash, api_token, secret_key, credential_value) and raw row errors redacted.\n');

        // -------------------------------------------------------------
        // Test 12: Dynamic Schema Coverage Validation
        // -------------------------------------------------------------
        console.log('Test 12: Testing dynamic schema column coverage validation...');

        // 12.1: Live tables in zarsev_test pass schema coverage
        for (const tableName of Object.keys(TABLE_DEFINITIONS)) {
            const coverageRes = await validateSchemaCoverage(pgClient, null, tableName);
            assert.strictEqual(coverageRes.valid, true);
            assert.strictEqual(coverageRes.columnCount, TABLE_DEFINITIONS[tableName].columns.length);
        }
        console.log('  ✓ Passed: All 9 live tables in zarsev_test 100% pass dynamic schema coverage.');

        // 12.2: Mock target schema with extra unexpected column
        const mockClientExtra = {
            query: async () => ({
                rows: [
                    ...TABLE_DEFINITIONS.categories.columns.map(c => ({ column_name: c })),
                    { column_name: 'unexpected_extra_column' }
                ]
            })
        };
        let caughtExtra = null;
        try {
            await validateSchemaCoverage(mockClientExtra, null, 'categories');
        } catch (err) {
            caughtExtra = err;
        }
        assert(caughtExtra instanceof SchemaMismatchError, 'Must throw SchemaMismatchError on extra column');
        assert.strictEqual(caughtExtra.details.type, 'EXTRA_TARGET_COLUMNS');
        assert(caughtExtra.details.columns.includes('unexpected_extra_column'));
        console.log('  ✓ Passed: Unexpected extra target column correctly caught before execution.');

        // 12.3: Mock target schema with missing configured column
        const mockClientMissing = {
            query: async () => ({
                rows: TABLE_DEFINITIONS.categories.columns.filter(c => c !== 'icon').map(c => ({ column_name: c }))
            })
        };
        let caughtMissing = null;
        try {
            await validateSchemaCoverage(mockClientMissing, null, 'categories');
        } catch (err) {
            caughtMissing = err;
        }
        assert(caughtMissing instanceof SchemaMismatchError, 'Must throw SchemaMismatchError on missing column');
        assert.strictEqual(caughtMissing.details.type, 'MISSING_TARGET_COLUMNS');
        assert(caughtMissing.details.columns.includes('icon'));
        console.log('  ✓ Passed: Missing configured target column correctly caught before execution.');

        // 12.4: Mock SQLite source with unmapped column
        const mockClientNormal = {
            query: async () => ({
                rows: TABLE_DEFINITIONS.categories.columns.map(c => ({ column_name: c }))
            })
        };
        const mockSqliteUnmapped = {
            prepare: () => ({
                all: () => [
                    ...TABLE_DEFINITIONS.categories.columns.map(c => ({ name: c })),
                    { name: 'unmapped_sqlite_legacy_col' }
                ]
            })
        };
        let caughtSourceUnmapped = null;
        try {
            await validateSchemaCoverage(mockClientNormal, mockSqliteUnmapped, 'categories');
        } catch (err) {
            caughtSourceUnmapped = err;
        }
        assert(caughtSourceUnmapped instanceof SchemaMismatchError, 'Must throw SchemaMismatchError on unmapped source column');
        assert.strictEqual(caughtSourceUnmapped.details.type, 'UNMAPPED_SOURCE_COLUMNS');
        assert(caughtSourceUnmapped.details.columns.includes('unmapped_sqlite_legacy_col'));
        console.log('  ✓ Passed: Unmapped source SQLite column correctly caught before execution.\n');

        // -------------------------------------------------------------
        // Test 10: Verify zero modification to existing business records
        // -------------------------------------------------------------
        console.log('Test 10: Verifying zero modification to existing 342 business records...');

        // Clean up all synthetic test rows created during the tests
        await pgClient.query("DELETE FROM products WHERE id = $1;", [synthProdId]);
        await pgClient.query("DELETE FROM manufacturers WHERE id = $1;", [synthMfrId]);
        await pgClient.query("DELETE FROM categories WHERE id IN ('synth_conf_test_cat_01', 'synth_conf_test_cat_batch_01');");

        let unmodifiedCount = 0;
        let modifiedCount = 0;

        for (const [table, meta] of Object.entries(TABLE_DEFINITIONS)) {
            const rows = (await pgClient.query(`SELECT * FROM "${table}" ORDER BY "${meta.idCol}" ASC;`)).rows;
            for (const row of rows) {
                const key = `${table}:${row[meta.idCol]}`;
                const initialHash = baselineHashes.get(key);
                if (!initialHash) {
                    console.error(`Extra unexpected row found in ${table}: ${row[meta.idCol]}`);
                    modifiedCount++;
                    continue;
                }
                const currentHash = hashObject(row);
                if (currentHash !== initialHash) {
                    console.error(`Row modified in ${table}: ${row[meta.idCol]}`);
                    modifiedCount++;
                } else {
                    unmodifiedCount++;
                }
            }
        }

        assert.strictEqual(modifiedCount, 0, 'Zero existing business records may be modified');
        assert.strictEqual(unmodifiedCount, 342, 'All 342 existing business records must remain identical');
        console.log(`  ✓ Passed: All 342 existing business records verified 100% bit-for-bit unchanged!\n`);

        console.log('================================================================');
        console.log('🎉 ALL CONFLICT GUARD & HARDENING INTEGRITY TESTS PASSED (100%)');
        console.log('================================================================\n');

    } finally {
        // Guarantee cleanup of synthetic records in case of any unhandled assertion
        await pgClient.query("DELETE FROM products WHERE id = 'synth_conf_test_prd_01';").catch(() => {});
        await pgClient.query("DELETE FROM manufacturers WHERE id = 'synth_conf_test_mfr_01';").catch(() => {});
        await pgClient.query("DELETE FROM categories WHERE id IN ('synth_conf_test_cat_01', 'synth_conf_test_cat_batch_01');").catch(() => {});

        await pgClient.end().catch(() => {});
        await closePool();
    }
}

if (require.main === module) {
    runPhase2_3Tests().catch(err => {
        console.error('\n❌ CONFLICT GUARD SUITE FAILED:', err);
        process.exit(1);
    });
}

module.exports = { runPhase2_3Tests };
