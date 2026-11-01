const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'zarsev.db');

let dbInstance = null;

function getDb() {
    if (!dbInstance) {
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        dbInstance = new DatabaseSync(DB_PATH);
        dbInstance.exec('PRAGMA foreign_keys = ON;');
    }
    return dbInstance;
}

function ensureColumn(db, table, column, definition) {
    try {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!columns.includes(column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
        }
    } catch (err) {
        console.error(`Migration error on table ${table}, column ${column}:`, err.message);
    }
}

function runMigrations(db) {
    // Users table additions
    ensureColumn(db, 'users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, 'users', 'password_hash', 'TEXT NULL');
    ensureColumn(db, 'users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');

    // Demo flags
    ensureColumn(db, 'manufacturers', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'products', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'imports', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
}

function initDb() {
    const db = getDb();
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schemaSql);
    runMigrations(db);
    return db;
}

module.exports = {
    getDb,
    initDb,
    DB_PATH
};
