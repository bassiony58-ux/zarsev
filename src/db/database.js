const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

function getDbPath() {
    return process.env.DB_PATH || path.join(__dirname, '..', '..', 'zarsev.db');
}

let dbInstance = null;
let currentDbPath = null;

function getDb() {
    const targetPath = getDbPath();
    if (!dbInstance || currentDbPath !== targetPath) {
        if (dbInstance) {
            try { dbInstance.close(); } catch (e) {}
            dbInstance = null;
        }
        const dbDir = path.dirname(targetPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        dbInstance = new DatabaseSync(targetPath);
        dbInstance.exec('PRAGMA foreign_keys = ON;');
        currentDbPath = targetPath;
    }
    return dbInstance;
}

function closeDb() {
    if (dbInstance) {
        try { dbInstance.close(); } catch (e) {}
        dbInstance = null;
        currentDbPath = null;
    }
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
    ensureColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');

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
    closeDb,
    getDbPath,
    get DB_PATH() {
        return getDbPath();
    }
};
