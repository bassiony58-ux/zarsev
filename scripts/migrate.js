#!/usr/bin/env node
/**
 * ZARSEV Sovereign Platform — Versioned Database Migration CLI Runner
 *
 * USAGE:
 *   node scripts/migrate.js status
 *   node scripts/migrate.js up
 *   node scripts/migrate.js down
 *
 * OPTIONS:
 *   --db <path>              Override target SQLite database path
 *   --migrations-dir <path>  Override migrations directory path
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
    getMigrationStatus,
    migrateUp,
    migrateDown
} = require('../src/db/migrator');

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = { command: 'status', options: {} };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === 'up' || arg === 'down' || arg === 'status') {
            parsed.command = arg;
        } else if (arg === '--db' && i + 1 < args.length) {
            parsed.options.dbPath = path.resolve(args[++i]);
        } else if (arg === '--migrations-dir' && i + 1 < args.length) {
            parsed.options.migrationsDir = path.resolve(args[++i]);
        }
    }
    return parsed;
}

function main() {
    const { command, options } = parseArgs();
    const targetDbPath = options.dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'zarsev.db');
    const migrationsDir = options.migrationsDir || path.join(__dirname, '..', 'src', 'db', 'migrations');

    console.log('================================================================');
    console.log('📦 ZARSEV Sovereign Database Migration Tool');
    console.log(`📂 Database:       ${targetDbPath}`);
    console.log(`📁 Migrations Dir: ${migrationsDir}`);
    console.log(`⚙️  Command:        ${command.toUpperCase()}`);
    console.log('================================================================\n');

    let db;
    try {
        db = new DatabaseSync(targetDbPath);
        db.exec('PRAGMA foreign_keys = ON;');
    } catch (err) {
        console.error('❌ Failed to open target database:', err.message);
        process.exit(1);
    }

    try {
        if (command === 'status') {
            const status = getMigrationStatus(db, migrationsDir);
            console.log(`Applied Migrations: (${status.totalApplied})`);
            if (status.applied.length > 0) {
                console.table(status.applied.map(a => ({
                    Batch: a.batch,
                    Name: a.name,
                    Checksum: a.checksum.substring(0, 16) + '...',
                    AppliedAt: a.applied_at
                })));
            } else {
                console.log('  (None applied yet)\n');
            }

            console.log(`Pending Migrations: (${status.totalPending})`);
            if (status.pending.length > 0) {
                console.table(status.pending.map(p => ({
                    File: p.fileName,
                    Name: p.name,
                    Checksum: p.checksum.substring(0, 16) + '...'
                })));
            } else {
                console.log('  (No pending migrations. Database is up to date.)\n');
            }
            return;
        }

        if (command === 'up') {
            console.log('🚀 Running pending migrations...\n');
            const result = migrateUp(db, targetDbPath, { migrationsDir });
            console.log(`\n✅ ${result.message}`);
            if (result.appliedMigrations && result.appliedMigrations.length > 0) {
                console.table(result.appliedMigrations.map(m => ({
                    Batch: m.batch,
                    Migration: m.name,
                    PreMigrationBackup: path.basename(m.backupPath)
                })));
            }
            return;
        }

        if (command === 'down') {
            console.log('⏪ Rolling back last migration batch...\n');
            const result = migrateDown(db, targetDbPath, { migrationsDir });
            console.log(`\n✅ ${result.message}`);
            if (result.revertedMigrations && result.revertedMigrations.length > 0) {
                console.table(result.revertedMigrations.map(m => ({
                    Batch: m.batch,
                    RevertedMigration: m.name,
                    PreRollbackBackup: path.basename(m.backupPath)
                })));
            }
            return;
        }

    } catch (err) {
        console.error('\n❌ [MIGRATION ERROR]:', err.message);
        process.exit(1);
    } finally {
        try { db.close(); } catch (e) {}
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
