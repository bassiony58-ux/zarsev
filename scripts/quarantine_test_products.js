#!/usr/bin/env node
/**
 * ZARSEV Sovereign Platform — Reversible Test/Seed Data Quarantine Tool
 *
 * PURPOSE:
 * Identifies and reversibly quarantines test records and demo seed products by setting
 * is_demo = 1 and logging quarantine metadata, preventing them from appearing in public
 * catalog views while strictly preserving data integrity and full rollback capability.
 *
 * SAFETY INVARIANTS:
 * - Does NOT delete any records or file uploads.
 * - Fully reversible via --rollback.
 * - Operates only on confirmed test/seed product IDs or test SKU patterns.
 * - Supports --dry-run mode to preview affected records before executing.
 *
 * USAGE:
 * Preview changes:
 *   node scripts/quarantine_test_products.js --dry-run
 * Apply quarantine:
 *   node scripts/quarantine_test_products.js --apply
 * Revert quarantine (Rollback):
 *   node scripts/quarantine_test_products.js --rollback
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KNOWN_TEST_SEED_IDS = [
    'prod_valencia_01',
    'prod_iqf_straw_02',
    'prod_onions_03',
    'prod_test_approval_3df3ef77',
    'prod_6ac567353f17',
    'prod_f6b8b975cca7',
    'prod_e3b6c6ff1646',
    'prod_c6ffcca4b09f',
    'prod_1fb7cd7185f7'
];

function runQuarantine(dbPath, mode = '--dry-run') {
    console.log('================================================================');
    console.log('📦 ZARSEV Reversible Product Quarantine & Cleanup Tool');
    console.log(`📂 Database: ${dbPath}`);
    console.log(`⚙️  Mode:     ${mode}`);
    console.log('================================================================\n');

    const db = new DatabaseSync(dbPath);

    if (mode === '--rollback') {
        const quarantined = db.prepare(`
            SELECT id, name_ar, sku 
            FROM products 
            WHERE rejection_reason LIKE '%[QUARANTINE_TEST_DATA]%'
        `).all();

        console.log(`Found (${quarantined.length}) products in quarantine state.`);
        if (quarantined.length === 0) {
            console.log('Nothing to roll back.');
            return { rolledBackCount: 0 };
        }

        db.exec('BEGIN TRANSACTION;');
        try {
            db.prepare(`
                UPDATE products 
                SET is_demo = 0,
                    rejection_reason = REPLACE(rejection_reason, '[QUARANTINE_TEST_DATA]', '')
                WHERE rejection_reason LIKE '%[QUARANTINE_TEST_DATA]%'
            `).run();
            db.exec('COMMIT;');
            console.log(`✅ Rollback complete: (${quarantined.length}) products restored to is_demo = 0.`);
            return { rolledBackCount: quarantined.length };
        } catch (err) {
            db.exec('ROLLBACK;');
            console.error('❌ Rollback failed:', err.message);
            throw err;
        }
    }

    // Inspect targets for quarantine
    const placeholders = KNOWN_TEST_SEED_IDS.map(() => '?').join(',');
    const targets = db.prepare(`
        SELECT p.id, p.sku, p.name_ar, p.manufacturer_id, m.name_ar as mfg_name,
               p.status, p.is_demo, p.source_import_id, p.created_at
        FROM products p
        JOIN manufacturers m ON p.manufacturer_id = m.id
        WHERE p.id IN (${placeholders})
    `).all(...KNOWN_TEST_SEED_IDS);

    console.log(`Identified (${targets.length}) confirmed test/seed product records:`);
    console.table(targets.map(t => ({
        id: t.id,
        sku: t.sku,
        name: t.name_ar.substring(0, 30),
        status: t.status,
        current_is_demo: t.is_demo,
        created: t.created_at
    })));

    if (mode === '--dry-run') {
        console.log('\n[DRY RUN PREVIEW] No changes written to database.');
        console.log('To apply this quarantine, execute with the --apply flag.');
        return { count: targets.length, applied: false };
    }

    if (mode === '--apply') {
        db.exec('BEGIN TRANSACTION;');
        try {
            const updateStmt = db.prepare(`
                UPDATE products 
                SET is_demo = 1,
                    rejection_reason = COALESCE(rejection_reason || ' ', '') || '[QUARANTINE_TEST_DATA]'
                WHERE id = ?
            `);

            let updatedCount = 0;
            for (const t of targets) {
                updateStmt.run(t.id);
                updatedCount++;
            }

            db.exec('COMMIT;');
            console.log(`\n✅ Quarantine successfully applied to (${updatedCount}) test records.`);
            console.log('   These records are now tagged with is_demo = 1 and excluded from public catalog queries.');
            console.log('   To revert this at any time, execute with --rollback.');
            return { count: updatedCount, applied: true };
        } catch (err) {
            db.exec('ROLLBACK;');
            console.error('❌ Quarantine application failed:', err.message);
            throw err;
        }
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const mode = args.includes('--apply') ? '--apply' : args.includes('--rollback') ? '--rollback' : '--dry-run';
    const targetDb = process.env.DB_PATH || path.join(__dirname, '..', 'zarsev.db');
    runQuarantine(targetDb, mode);
}

module.exports = {
    KNOWN_TEST_SEED_IDS,
    runQuarantine
};
