#!/usr/bin/env node
/**
 * Test helper: Simulates an independent process competing for a database migration lock.
 */
const { DatabaseSync } = require('node:sqlite');
const { acquireMigrationLock, releaseMigrationLock } = require('../src/db/migrator');

const dbPath = process.argv[2];
const workerId = process.argv[3] || `worker_${process.pid}`;
const holdMs = parseInt(process.argv[4] || '600', 10);

if (!dbPath) {
    console.error('Missing dbPath argument');
    process.exit(1);
}

let db = null;
try {
    db = new DatabaseSync(dbPath);
    const handle = acquireMigrationLock(db, { lockOwner: workerId, busyTimeout: 500 });
    // Print success on stdout for parent process to read
    console.log(JSON.stringify({ status: 'ACQUIRED', workerId, token: handle.ownerToken }));

    // Hold lock synchronously
    const end = Date.now() + holdMs;
    while (Date.now() < end) {}

    releaseMigrationLock(db, handle);
    console.log(JSON.stringify({ status: 'RELEASED', workerId }));
    process.exit(0);
} catch (err) {
    console.log(JSON.stringify({ status: 'CONFLICT', workerId, error: err.message }));
    process.exit(2);
} finally {
    if (db) {
        try { db.close(); } catch (e) {}
    }
}
