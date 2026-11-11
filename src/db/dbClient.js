/**
 * src/db/dbClient.js
 * 
 * Production-grade Unified Asynchronous Database Facade for ZARSEV Global Trade.
 * 
 * Provides a uniform Promise-based API for both SQLite and PostgreSQL:
 * - queryOne(sql, params, options)
 * - queryAll(sql, params, options)
 * - execute(sql, params, options)
 * - transaction(callback, options)
 * 
 * ==============================================================================
 * CROSS-ENGINE DATA TYPES CONTRACT (MANDATORY ARCHITECTURAL SPECIFICATION):
 * ==============================================================================
 * Developers and route handlers MUST NOT assume automatic cross-engine data type parity:
 * 1. BOOLEANS:
 *    - SQLite returns integers: 1 (true) or 0 (false).
 *    - PostgreSQL returns native JavaScript booleans: true or false.
 *    - Input params: dbClient automatically coerces booleans to 1/0 for SQLite.
 *    - Output handling: Route layers MUST use truthy checks `Boolean(row.is_active)`
 *      or `row.is_active ? true : false`, NEVER strict identity `row.is_active === true`.
 * 2. JSON / JSONB:
 *    - SQLite returns raw serialized JSON text strings (requires JSON.parse).
 *    - PostgreSQL returns native parsed JavaScript objects/arrays.
 *    - Input params: dbClient automatically stringifies objects for SQLite.
 *    - Output handling: Use pgAdapter.safeJsonParse() or dual-engine parsing helper.
 * 3. NUMERICS & FINANCIAL AMOUNTS:
 *    - SQLite REAL returns JavaScript floating-point Number (e.g. 123.45).
 *    - PostgreSQL NUMERIC/DECIMAL returns exact String (e.g. '123.45') to prevent
 *      IEEE 754 precision loss on financial amounts.
 *    - Output handling: Route layers must format financial values deterministically.
 * ==============================================================================
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./database');
const pgAdapter = require('./pgAdapter');

// AsyncLocalStorage tracks the active transaction context within the asynchronous call stack
const txStorage = new AsyncLocalStorage();

// Mutex registry for serializing SQLite transactions and write operations per database instance
const sqliteMutexMap = new WeakMap();

/**
 * Async FIFO Mutex ensuring serial execution of write transactions on a single-connection SQLite instance.
 */
class AsyncMutex {
    constructor() {
        this._tail = Promise.resolve();
    }

    async acquire() {
        let release;
        const next = new Promise((res) => { release = res; });
        const prev = this._tail;
        this._tail = this._tail.then(() => next);
        await prev;
        return release;
    }
}

/**
 * Retrieves or lazily creates the AsyncMutex for a given SQLite database instance.
 */
function getSqliteMutex(dbInstance) {
    if (!sqliteMutexMap.has(dbInstance)) {
        sqliteMutexMap.set(dbInstance, new AsyncMutex());
    }
    return sqliteMutexMap.get(dbInstance);
}

/**
 * Custom Unified Database Error with automatic redaction of sensitive credentials
 * and full diagnostic preservation for rollback errors.
 */
class DbError extends Error {
    constructor(message, { code, originalError, engine, query, params, detail, hint, rollbackError, savepointRollbackError } = {}) {
        const cleanMessage = sanitizeErrorMessage(message || originalError?.message || 'Database error occurred');
        super(cleanMessage);
        this.name = 'DbError';
        this.code = code || originalError?.code || 'DB_ERROR';
        this.engine = engine;
        this.query = typeof query === 'string' ? sanitizeErrorMessage(query) : query;
        this.params = sanitizeParams(params);
        if (detail) this.detail = sanitizeErrorMessage(detail);
        if (hint) this.hint = sanitizeErrorMessage(hint);

        // Preserve original and rollback errors safely with redaction
        this.originalError = originalError ? sanitizeErrorObject(originalError) : null;
        this.rollbackError = rollbackError || originalError?.rollbackError ? sanitizeErrorObject(rollbackError || originalError?.rollbackError) : null;
        this.savepointRollbackError = savepointRollbackError || originalError?.savepointRollbackError ? sanitizeErrorObject(savepointRollbackError || originalError?.savepointRollbackError) : null;

        if (originalError && originalError.stack) {
            this.stack = `${this.name}: ${this.message}\n` + sanitizeErrorMessage(originalError.stack);
        }
    }
}

/**
 * Sanitizes an error object ensuring no credentials or connection URIs leak.
 */
function sanitizeErrorObject(err) {
    if (!err) return null;
    const cleanMsg = sanitizeErrorMessage(err.message || String(err));
    const sanitized = new Error(cleanMsg);
    sanitized.name = err.name || 'Error';
    sanitized.code = err.code;
    if (err.stack) {
        sanitized.stack = sanitizeErrorMessage(err.stack);
    }
    return sanitized;
}

/**
 * Redacts passwords, connection strings, and sensitive secrets from error messages and SQL strings.
 */
function sanitizeErrorMessage(msg) {
    if (typeof msg !== 'string') return msg;
    return msg
        .replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1****$3')
        .replace(/(password|secret|token|key|credential|hash)\s*([=:]\s*['"]?)[^'"\s,)]+/gi, '$1$2[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
}

/**
 * Redacts sensitive credentials from parameter arrays and objects before error attachment.
 */
function sanitizeParams(params) {
    if (!Array.isArray(params)) return [];
    return params.map(p => {
        if (p === null || p === undefined) return p;
        if (typeof p === 'object') {
            const clone = Array.isArray(p) ? [...p] : { ...p };
            for (const key of Object.keys(clone)) {
                if (/password|secret|token|key|credential|hash/i.test(key)) {
                    clone[key] = '[REDACTED]';
                }
            }
            return clone;
        }
        if (typeof p === 'string') {
            if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(p)) {
                return '[REDACTED_JWT]';
            }
            if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(p)) {
                return '[REDACTED_HASH]';
            }
        }
        return p;
    });
}

/**
 * Normalizes parameters for SQLite (DatabaseSync) which requires integer 1/0 for booleans
 * and stringifies JSON objects.
 */
function normalizeParamsForSqlite(params) {
    if (!Array.isArray(params)) return [];
    return params.map(p => {
        if (typeof p === 'boolean') {
            return p ? 1 : 0;
        }
        if (p !== null && typeof p === 'object' && !Buffer.isBuffer(p) && !(p instanceof Uint8Array)) {
            return JSON.stringify(p);
        }
        return p;
    });
}

/**
 * Helper to check whether '?' is followed by a string literal operand (e.g. data ? 'key' or data ? E'key').
 * In standard SQL syntax, a parameter placeholder '?' can NEVER be directly followed by a string literal operand.
 * Therefore, '? \'literal\'' is unambiguously the PostgreSQL JSONB key existence operator.
 */
function isFollowedByStringOperand(sql, startIndex) {
    let j = startIndex;
    const len = sql.length;
    while (j < len && /\s/.test(sql[j])) j++;
    if (j >= len) return false;
    if (sql[j] === "'") return true;
    if ((sql[j] === 'E' || sql[j] === 'e') && j + 1 < len && sql[j + 1] === "'") return true;
    return false;
}

/**
 * Scans SQL text character-by-character to find the maximum genuine PostgreSQL
 * numbered parameter ($1, $2, ...) in normal SQL code.
 * Strictly ignores $N inside:
 * - Single-quoted strings ('...')
 * - E-strings (E'...')
 * - Double-quoted identifiers ("...")
 * - Line comments (-- ...)
 * - Block comments (/* ... * /)
 * - Dollar-quoted strings ($$...$$ or $tag$...$tag$)
 * 
 * @param {string} sql 
 * @returns {number} The maximum parameter index found, or 0 if none
 */
function scanLexicalNumberedParams(sql) {
    if (typeof sql !== 'string') return 0;
    let maxNumbered = 0;
    let i = 0;
    const len = sql.length;

    while (i < len) {
        const char = sql[i];
        const nextChar = i + 1 < len ? sql[i + 1] : '';

        // 1. Single-line comment: -- ...
        if (char === '-' && nextChar === '-') {
            const endOfLine = sql.indexOf('\n', i + 2);
            i = endOfLine === -1 ? len : endOfLine + 1;
            continue;
        }

        // 2. Multi-line comment: /* ... */
        if (char === '/' && nextChar === '*') {
            const endOfComment = sql.indexOf('*/', i + 2);
            i = endOfComment === -1 ? len : endOfComment + 2;
            continue;
        }

        // 3. String literal: '...' or E'...'
        if (char === "'" || ((char === 'E' || char === 'e') && nextChar === "'")) {
            let j = char === "'" ? i + 1 : i + 2;
            while (j < len) {
                if (sql[j] === "'") {
                    if (j + 1 < len && sql[j + 1] === "'") {
                        j += 2;
                        continue;
                    }
                    j++;
                    break;
                } else if (sql[j] === '\\' && j + 1 < len) {
                    j += 2;
                } else {
                    j++;
                }
            }
            i = j;
            continue;
        }

        // 4. Double-quoted identifier: "..."
        if (char === '"') {
            let j = i + 1;
            while (j < len) {
                if (sql[j] === '"') {
                    if (j + 1 < len && sql[j + 1] === '"') {
                        j += 2;
                        continue;
                    }
                    j++;
                    break;
                } else {
                    j++;
                }
            }
            i = j;
            continue;
        }

        // 5. Dollar-quoted string or numbered parameter: $...
        if (char === '$') {
            const tagMatch = sql.substring(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
            if (tagMatch) {
                const tag = tagMatch[1];
                const closeIndex = sql.indexOf(tag, i + tag.length);
                if (closeIndex !== -1) {
                    i = closeIndex + tag.length;
                    continue;
                }
            }

            // Genuine numbered parameter token in normal SQL: $1, $2, ...
            const numMatch = sql.substring(i).match(/^\$([1-9]\d*)\b/);
            if (numMatch) {
                const idx = parseInt(numMatch[1], 10);
                if (idx > maxNumbered) maxNumbered = idx;
                i += numMatch[0].length;
                continue;
            }
        }

        i++;
    }

    return maxNumbered;
}

/**
 * Comprehensive Lexical SQL Parser and Parameter Converter.
 * 
 * Rules:
 * 1. Strings: Single quotes ('...'), backslash escapes (\' and \\), double single quotes ('').
 * 2. Identifiers: Double quotes ("...").
 * 3. Comments: Line comments (-- ...) and block comments (/* ... * /).
 * 4. Dollar quotes: Untagged ($$ ... $$) and tagged ($tag$ ... $tag$).
 * 5. PostgreSQL JSONB Operators:
 *    - '?|' and '?&' are preserved as literal JSONB operators.
 *    - '??' is the standard PostgreSQL escape sequence for a literal '?' operator (converts to '?').
 *    - If the query already contains native numbered parameters ($1, $2, ...), any unquoted '?'
 *      is preserved as the native PostgreSQL '?' operator.
 * 6. Placeholders:
 *    - For queries using positional parameters, unquoted '?' placeholders are converted to '$1, $2, ...' for PG.
 *    - Accurate placeholder count is tracked for parameter count validation.
 * 
 * @param {string} sql 
 * @param {string} engine - 'postgres' or 'sqlite'
 * @returns {{ text: string, placeholderCount: number, paramStyle: string }}
 */
function parseAndConvertSql(sql, engine = 'postgres') {
    if (typeof sql !== 'string') {
        return { text: sql, placeholderCount: 0, paramStyle: 'none' };
    }

    let result = '';
    let paramIndex = 1;
    let i = 0;
    const len = sql.length;
    let positionalCount = 0;

    // Check if query already contains native PostgreSQL numbered parameters ($1, $2...)
    // using character-by-character lexical parsing (ignoring $N inside literals and comments)
    const maxNumbered = scanLexicalNumberedParams(sql);

    while (i < len) {
        const char = sql[i];
        const nextChar = i + 1 < len ? sql[i + 1] : '';

        // 1. Single-line comment: -- ...
        if (char === '-' && nextChar === '-') {
            const endOfLine = sql.indexOf('\n', i + 2);
            if (endOfLine === -1) {
                result += sql.substring(i);
                break;
            } else {
                result += sql.substring(i, endOfLine + 1);
                i = endOfLine + 1;
                continue;
            }
        }

        // 2. Multi-line comment: /* ... */
        if (char === '/' && nextChar === '*') {
            const endOfComment = sql.indexOf('*/', i + 2);
            if (endOfComment === -1) {
                result += sql.substring(i);
                break;
            } else {
                result += sql.substring(i, endOfComment + 2);
                i = endOfComment + 2;
                continue;
            }
        }

        // 3. String literal: '...' or E'...' (with '' and \' escape handling)
        if (char === "'" || ((char === 'E' || char === 'e') && nextChar === "'")) {
            const isE = char !== "'";
            let j = isE ? i + 2 : i + 1;
            let str = isE ? char + "'" : "'";
            while (j < len) {
                if (sql[j] === "'") {
                    if (j + 1 < len && sql[j + 1] === "'") {
                        str += "''";
                        j += 2;
                        continue;
                    }
                    str += "'";
                    j++;
                    break;
                } else if (sql[j] === '\\' && j + 1 < len) {
                    str += sql[j] + sql[j + 1];
                    j += 2;
                    continue;
                } else {
                    str += sql[j];
                    j++;
                }
            }
            result += str;
            i = j;
            continue;
        }

        // 4. Double-quoted identifier: "..."
        if (char === '"') {
            let j = i + 1;
            let ident = '"';
            while (j < len) {
                if (sql[j] === '"') {
                    if (j + 1 < len && sql[j + 1] === '"') {
                        ident += '""';
                        j += 2;
                        continue;
                    }
                    ident += '"';
                    j++;
                    break;
                } else {
                    ident += sql[j];
                    j++;
                }
            }
            result += ident;
            i = j;
            continue;
        }

        // 5. Dollar-quoted string in Postgres: $$...$$ or $tag$...$tag$
        if (char === '$') {
            const match = sql.substring(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
            if (match) {
                const tag = match[1];
                const closeIndex = sql.indexOf(tag, i + tag.length);
                if (closeIndex !== -1) {
                    result += sql.substring(i, closeIndex + tag.length);
                    i = closeIndex + tag.length;
                    continue;
                }
            }
        }

        // 6. PostgreSQL JSONB two-character operators: ?| and ?&
        if (char === '?' && (nextChar === '|' || nextChar === '&')) {
            result += '?' + nextChar;
            i += 2;
            continue;
        }

        // 7. Escaped literal '?' operator in parameterized queries: ?? -> ?
        if (char === '?' && nextChar === '?') {
            result += '?';
            i += 2;
            continue;
        }

        // 8. Standalone JSONB operator '?' followed by a string literal operand (e.g. data ? 'key')
        if (char === '?' && isFollowedByStringOperand(sql, i + 1)) {
            result += '?';
            i++;
            continue;
        }

        // 9. Parameter placeholder vs native operator '?'
        if (char === '?') {
            if (maxNumbered > 0) {
                // If query already uses native numbered parameters ($1, $2),
                // treat standalone '?' as the native PostgreSQL '?' JSONB operator!
                result += '?';
            } else {
                positionalCount++;
                if (engine === 'postgres' || engine === 'pg') {
                    result += '$' + paramIndex;
                    paramIndex++;
                } else {
                    result += '?';
                }
            }
            i++;
            continue;
        }

        result += char;
        i++;
    }

    const placeholderCount = maxNumbered > 0 ? maxNumbered : positionalCount;
    const paramStyle = maxNumbered > 0 ? 'numbered' : (positionalCount > 0 ? 'positional' : 'none');

    return { text: result, placeholderCount, paramStyle };
}

/**
 * Public wrapper preserving backward-compatibility for tokenizeAndConvertParams.
 */
function tokenizeAndConvertParams(sql) {
    return parseAndConvertSql(sql, 'postgres').text;
}

/**
 * Resolves the appropriate SQL text for the target engine, accepting either a SQL string
 * or a dual-dialect object { sqlite: '...', postgres: '...' }.
 */
function resolveSql(sql, engine) {
    if (typeof sql === 'object' && sql !== null) {
        if (engine === 'postgres' || engine === 'pg') {
            const raw = sql.postgres || sql.pg || sql.sqlite;
            return parseAndConvertSql(raw, 'postgres');
        } else {
            const raw = sql.sqlite || sql.postgres || sql.pg;
            return parseAndConvertSql(raw, 'sqlite');
        }
    }

    if (typeof sql === 'string') {
        return parseAndConvertSql(sql, engine);
    }

    throw new Error(`[dbClient] Invalid SQL statement: expected string or object, got ${typeof sql}`);
}

/**
 * Validates that the number of provided parameters matches the number of placeholders required.
 */
function validateParamCount(placeholderCount, params, engine, sqlText) {
    const providedCount = Array.isArray(params) ? params.length : 0;
    if (placeholderCount !== providedCount) {
        throw new DbError(
            `Parameter count mismatch: query expects ${placeholderCount} parameter(s), but received ${providedCount}.`,
            {
                code: 'PARAM_COUNT_MISMATCH',
                engine,
                query: sqlText,
                params
            }
        );
    }
}

/**
 * Extracts SQL command keyword (SELECT, INSERT, UPDATE, DELETE, etc.)
 */
function detectCommand(sql) {
    if (typeof sql !== 'string') return 'UNKNOWN';
    const match = sql.trim().match(/^([A-Za-z]+)\b/);
    return match ? match[1].toUpperCase() : 'UNKNOWN';
}

/**
 * Safely extracts the returned insert ID from RETURNING rows.
 * Follows the explicit contract without guessing:
 * 1. options.idColumn if specified.
 * 2. Standard known candidate keys ('id', 'pk', 'uuid', etc.).
 * 3. If single column was returned, its value.
 * 4. Otherwise returns null, preserving all returned rows.
 */
function extractInsertId(rows, options = {}) {
    if (!rows || rows.length === 0) return null;
    const firstRow = rows[0];
    if (!firstRow || typeof firstRow !== 'object') return null;

    if (options.idColumn && firstRow[options.idColumn] !== undefined) {
        return firstRow[options.idColumn];
    }

    const candidateKeys = ['id', 'pk', 'uuid', 'item_id', 'user_id', 'product_id', 'import_id', 'mfg_id', 'category_id', 'subscription_id'];
    for (const key of candidateKeys) {
        if (firstRow[key] !== undefined) {
            return firstRow[key];
        }
    }

    const keys = Object.keys(firstRow);
    if (keys.length === 1) {
        return firstRow[keys[0]];
    }

    return null;
}

/**
 * Resolves the current active engine ('sqlite' or 'postgres').
 */
function resolveEngine(options = {}, activeTx = null) {
    if (activeTx && activeTx.engine) {
        return activeTx.engine;
    }
    if (options.engine) {
        const eng = String(options.engine).toLowerCase().trim();
        return eng === 'postgres' || eng === 'pg' ? 'postgres' : 'sqlite';
    }
    const envEngine = (process.env.DB_ENGINE || 'sqlite').toLowerCase().trim();
    return envEngine === 'postgres' || envEngine === 'pg' ? 'postgres' : 'sqlite';
}

/**
 * Transaction Context wrapping an active connection and enforcing transaction context safety.
 * Tracks lifecycle status via `isActive` and rejects any operation after commit/rollback.
 */
class TransactionContext {
    constructor({ client, engine, depth = 1, parent = null, savepoint = null }) {
        this.client = client;
        this.engine = engine;
        this.depth = depth;
        this.parent = parent;
        this.savepoint = savepoint;
        this.isActive = true;
        this.children = [];
        if (parent) {
            parent.children.push(this);
        }
    }

    _assertActive() {
        if (!this.isActive) {
            throw new DbError(
                'Transaction context has already ended (committed or rolled back). Cannot execute queries on closed transaction.',
                {
                    code: 'TRANSACTION_CLOSED',
                    engine: this.engine
                }
            );
        }
    }

    close() {
        this.isActive = false;
        for (const child of this.children) {
            child.close();
        }
    }

    async queryOne(sql, params = [], options = {}) {
        this._assertActive();
        return executeQueryOne(this.engine, this.client, sql, params, { ...options, inTransaction: true });
    }

    async queryAll(sql, params = [], options = {}) {
        this._assertActive();
        return executeQueryAll(this.engine, this.client, sql, params, { ...options, inTransaction: true });
    }

    async execute(sql, params = [], options = {}) {
        this._assertActive();
        return executeStatement(this.engine, this.client, sql, params, { ...options, inTransaction: true });
    }

    async transaction(callback, options = {}) {
        this._assertActive();
        return runTransaction(this.engine, callback, { ...options, client: this.client, engine: this.engine });
    }
}

/**
 * Internal single-row query execution.
 */
async function executeQueryOne(engine, runner, sql, params = [], options = {}) {
    const parsed = resolveSql(sql, engine);
    validateParamCount(parsed.placeholderCount, params, engine, parsed.text);

    if (engine === 'postgres') {
        try {
            const res = await runner.query(parsed.text, params);
            return res.rows.length > 0 ? res.rows[0] : null;
        } catch (err) {
            throw new DbError(err.message, {
                originalError: err,
                code: err.code,
                engine: 'postgres',
                query: parsed.text,
                params,
                detail: err.detail,
                hint: err.hint
            });
        }
    }

    // SQLite
    let releaseLock = null;
    const inTx = options.inTransaction || (engine === 'sqlite' && txStorage.getStore()?.engine === 'sqlite');
    if (engine === 'sqlite' && !inTx) {
        const mutex = getSqliteMutex(runner);
        releaseLock = await mutex.acquire();
    }

    try {
        const normalized = normalizeParamsForSqlite(params);
        const stmt = runner.prepare(parsed.text);
        const row = stmt.get(...normalized);
        return row || null;
    } catch (err) {
        throw new DbError(err.message, {
            originalError: err,
            code: err.code || 'SQLITE_ERROR',
            engine: 'sqlite',
            query: parsed.text,
            params
        });
    } finally {
        if (releaseLock) {
            releaseLock();
        }
    }
}

/**
 * Internal multi-row query execution.
 */
async function executeQueryAll(engine, runner, sql, params = [], options = {}) {
    const parsed = resolveSql(sql, engine);
    validateParamCount(parsed.placeholderCount, params, engine, parsed.text);

    if (engine === 'postgres') {
        try {
            const res = await runner.query(parsed.text, params);
            return res.rows;
        } catch (err) {
            throw new DbError(err.message, {
                originalError: err,
                code: err.code,
                engine: 'postgres',
                query: parsed.text,
                params,
                detail: err.detail,
                hint: err.hint
            });
        }
    }

    // SQLite
    let releaseLock = null;
    const inTx = options.inTransaction || (engine === 'sqlite' && txStorage.getStore()?.engine === 'sqlite');
    if (engine === 'sqlite' && !inTx) {
        const mutex = getSqliteMutex(runner);
        releaseLock = await mutex.acquire();
    }

    try {
        const normalized = normalizeParamsForSqlite(params);
        const stmt = runner.prepare(parsed.text);
        return stmt.all(...normalized);
    } catch (err) {
        throw new DbError(err.message, {
            originalError: err,
            code: err.code || 'SQLITE_ERROR',
            engine: 'sqlite',
            query: parsed.text,
            params
        });
    } finally {
        if (releaseLock) {
            releaseLock();
        }
    }
}

/**
 * Internal statement execution (INSERT/UPDATE/DELETE/DDL).
 */
async function executeStatement(engine, runner, sql, params = [], options = {}) {
    const parsed = resolveSql(sql, engine);
    validateParamCount(parsed.placeholderCount, params, engine, parsed.text);

    if (engine === 'postgres') {
        try {
            const res = await runner.query(parsed.text, params);
            const rowCount = res.rowCount ?? 0;
            const rows = res.rows || [];
            const lastInsertRowid = extractInsertId(rows, options);

            return {
                rowCount,
                changes: rowCount,
                lastInsertRowid,
                rows,
                command: res.command || detectCommand(parsed.text)
            };
        } catch (err) {
            throw new DbError(err.message, {
                originalError: err,
                code: err.code,
                engine: 'postgres',
                query: parsed.text,
                params,
                detail: err.detail,
                hint: err.hint
            });
        }
    }

    // SQLite Statement Execution
    // If not inside an active transaction, acquire the SQLite mutex for write statements
    let releaseLock = null;
    const inTx = options.inTransaction || (engine === 'sqlite' && txStorage.getStore()?.engine === 'sqlite');
    if (engine === 'sqlite' && !inTx) {
        const mutex = getSqliteMutex(runner);
        releaseLock = await mutex.acquire();
    }

    try {
        const normalized = normalizeParamsForSqlite(params);
        const isReturning = /RETURNING\b/i.test(parsed.text);
        const stmt = runner.prepare(parsed.text);

        if (isReturning) {
            const rows = stmt.all(...normalized);
            const rowCount = rows.length;
            const lastInsertRowid = extractInsertId(rows, options);
            return {
                rowCount,
                changes: rowCount,
                lastInsertRowid,
                rows,
                command: detectCommand(parsed.text)
            };
        } else {
            const info = stmt.run(...normalized);
            return {
                rowCount: info.changes,
                changes: info.changes,
                lastInsertRowid: info.lastInsertRowid,
                rows: [],
                command: detectCommand(parsed.text)
            };
        }
    } catch (err) {
        throw new DbError(err.message, {
            originalError: err,
            code: err.code || 'SQLITE_ERROR',
            engine: 'sqlite',
            query: parsed.text,
            params
        });
    } finally {
        if (releaseLock) {
            releaseLock();
        }
    }
}

/**
 * Executes a callback within a managed transaction block with nested savepoint support.
 */
async function runTransaction(engine, callback, options = {}) {
    if (typeof callback !== 'function') {
        throw new Error('[dbClient.transaction] A transaction callback function is required.');
    }

    const activeTx = txStorage.getStore();

    // 1. PostgreSQL Transaction Implementation
    if (engine === 'postgres') {
        const clientOverride = options.client || (activeTx && activeTx.engine === 'postgres' ? activeTx.client : null);

        if (clientOverride) {
            // Nested transaction via SAVEPOINT
            const currentDepth = (activeTx ? activeTx.depth : 1) + 1;
            const spName = `sp_${currentDepth}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            await clientOverride.query(`SAVEPOINT ${spName};`);

            const nestedCtx = new TransactionContext({
                client: clientOverride,
                engine: 'postgres',
                parent: activeTx,
                depth: currentDepth,
                savepoint: spName
            });

            try {
                const result = await txStorage.run(nestedCtx, () => callback(nestedCtx));
                await clientOverride.query(`RELEASE SAVEPOINT ${spName};`);
                return result;
            } catch (err) {
                let spRollbackErr = null;
                try {
                    await clientOverride.query(`ROLLBACK TO SAVEPOINT ${spName};`);
                } catch (rbErr) {
                    spRollbackErr = rbErr;
                }

                if (err instanceof DbError) {
                    if (spRollbackErr) err.savepointRollbackError = sanitizeErrorObject(spRollbackErr);
                    throw err;
                }

                throw new DbError(err.message, {
                    originalError: err,
                    code: err.code,
                    engine: 'postgres',
                    savepointRollbackError: spRollbackErr
                });
            } finally {
                nestedCtx.close();
            }
        }

        // Top-level Outer Transaction
        let outerTxCtx = null;
        try {
            return await pgAdapter.transaction(async (pgClient) => {
                outerTxCtx = new TransactionContext({
                    client: pgClient,
                    engine: 'postgres',
                    depth: 1
                });
                return txStorage.run(outerTxCtx, () => callback(outerTxCtx));
            }, options);
        } catch (err) {
            if (err instanceof DbError) throw err;
            throw new DbError(err.message, {
                originalError: err,
                code: err.code,
                engine: 'postgres',
                rollbackError: err.rollbackError
            });
        } finally {
            if (outerTxCtx) {
                outerTxCtx.close();
            }
        }
    }

    // 2. SQLite Transaction Implementation
    const sqliteDb = options.db || (activeTx && activeTx.engine === 'sqlite' ? activeTx.client : (options.customDb || getDb()));

    if (activeTx && activeTx.engine === 'sqlite') {
        // Nested transaction via SAVEPOINT in SQLite
        const currentDepth = activeTx.depth + 1;
        const spName = `sp_${currentDepth}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        sqliteDb.exec(`SAVEPOINT ${spName};`);

        const nestedCtx = new TransactionContext({
            client: sqliteDb,
            engine: 'sqlite',
            parent: activeTx,
            depth: currentDepth,
            savepoint: spName
        });

        try {
            const result = await txStorage.run(nestedCtx, () => callback(nestedCtx));
            sqliteDb.exec(`RELEASE SAVEPOINT ${spName};`);
            return result;
        } catch (err) {
            let spRollbackErr = null;
            try {
                sqliteDb.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
            } catch (rbErr) {
                spRollbackErr = rbErr;
            }

            if (err instanceof DbError) {
                if (spRollbackErr) err.savepointRollbackError = sanitizeErrorObject(spRollbackErr);
                throw err;
            }

            throw new DbError(err.message, {
                originalError: err,
                code: err.code || 'SQLITE_ERROR',
                engine: 'sqlite',
                savepointRollbackError: spRollbackErr
            });
        } finally {
            nestedCtx.close();
        }
    }

    // Top-level Outer Transaction for SQLite
    // Acquire mutex to prevent concurrent transactions or write collisions on the single SQLite connection
    const mutex = getSqliteMutex(sqliteDb);
    const releaseLock = await mutex.acquire();

    let txCtx = null;
    try {
        sqliteDb.exec('BEGIN IMMEDIATE;');
        txCtx = new TransactionContext({
            client: sqliteDb,
            engine: 'sqlite',
            depth: 1
        });

        const result = await txStorage.run(txCtx, () => callback(txCtx));
        sqliteDb.exec('COMMIT;');
        return result;
    } catch (err) {
        let rbError = null;
        try {
            sqliteDb.exec('ROLLBACK;');
        } catch (rbErr) {
            rbError = rbErr;
        }

        if (err instanceof DbError) {
            if (rbError) err.rollbackError = sanitizeErrorObject(rbError);
            throw err;
        }

        throw new DbError(err.message, {
            originalError: err,
            code: err.code || 'SQLITE_ERROR',
            engine: 'sqlite',
            rollbackError: rbError
        });
    } finally {
        if (txCtx) {
            txCtx.close();
        }
        releaseLock();
    }
}

/**
 * Resolves the runner (pool or client or database instance) for single queries.
 */
function resolveRunner(engine, options = {}) {
    const activeTx = txStorage.getStore();
    if (activeTx) {
        activeTx._assertActive();
        return activeTx.client;
    }

    if (engine === 'postgres') {
        return pgAdapter.getAppPool(options.dbNameOverride);
    }

    return options.customDb || getDb();
}

/**
 * Public Facade API
 */
const dbClient = {
    /**
     * Executes a query returning a single row as an object, or null if no row matches.
     */
    async queryOne(sql, params = [], options = {}) {
        const activeTx = txStorage.getStore();
        if (activeTx) activeTx._assertActive();
        const engine = resolveEngine(options, activeTx);
        const runner = resolveRunner(engine, options);
        return executeQueryOne(engine, runner, sql, params, { ...options, inTransaction: options.inTransaction || !!activeTx });
    },

    /**
     * Executes a query returning all matching rows as an array of objects.
     */
    async queryAll(sql, params = [], options = {}) {
        const activeTx = txStorage.getStore();
        if (activeTx) activeTx._assertActive();
        const engine = resolveEngine(options, activeTx);
        const runner = resolveRunner(engine, options);
        return executeQueryAll(engine, runner, sql, params, { ...options, inTransaction: options.inTransaction || !!activeTx });
    },

    /**
     * Executes an INSERT, UPDATE, DELETE, or DDL statement returning unified execution metadata.
     */
    async execute(sql, params = [], options = {}) {
        const activeTx = txStorage.getStore();
        if (activeTx) activeTx._assertActive();
        const engine = resolveEngine(options, activeTx);
        const runner = resolveRunner(engine, options);
        return executeStatement(engine, runner, sql, params, { ...options, inTransaction: options.inTransaction || !!activeTx });
    },

    /**
     * Executes operations within a managed transaction block.
     */
    async transaction(callback, options = {}) {
        const activeTx = txStorage.getStore();
        if (activeTx) activeTx._assertActive();
        const engine = resolveEngine(options, activeTx);
        return runTransaction(engine, callback, options);
    },

    /**
     * Returns the active AsyncLocalStorage transaction context, if any.
     */
    getActiveTransaction() {
        return txStorage.getStore() || null;
    },

    /**
     * Exposes the lexical parameter converter for testing and inspection.
     */
    tokenizeAndConvertParams,
    parseAndConvertSql,

    /**
     * Exposes error sanitization utilities.
     */
    sanitizeErrorMessage,
    sanitizeParams,

    /**
     * Custom Database Error class.
     */
    DbError
};

module.exports = dbClient;
