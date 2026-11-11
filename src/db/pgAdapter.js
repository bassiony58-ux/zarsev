/**
 * src/db/pgAdapter.js
 * 
 * Production-grade asynchronous PostgreSQL adapter for ZARSEV.
 * Powered by node-postgres (pg).
 * 
 * Supports:
 * - Connection pooling for runtime operations (zarsev_app)
 * - Standalone dedicated clients for migrations (zarsev_migrator)
 * - queryAll, queryOne, execute API
 * - Nested transactions via managed savepoints
 * - Automatic retry on serialization failure (SQLSTATE 40001) / deadlock (40P01)
 * - Strict JSON parsing with JsonCorruptionError (never swallows corrupted JSON)
 * - Tainted client removal from pool on rollback failure
 */

const { Pool, Client } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Ensure .env is loaded if present
try {
    if (typeof process.loadEnvFile === 'function') {
        const envPath = path.join(__dirname, '..', '..', '.env');
        if (fs.existsSync(envPath)) {
            process.loadEnvFile(envPath);
        }
    }
} catch (_) {}

/**
 * Custom error thrown when JSON parsing fails on corrupted database text.
 * Prevents silent data corruption or loss.
 */
class JsonCorruptionError extends Error {
    constructor(message, { column, entityId, rawSnippet, cause } = {}) {
        super(message);
        this.name = 'JsonCorruptionError';
        this.column = column;
        this.entityId = entityId;
        this.rawSnippet = rawSnippet;
        this.cause = cause;
    }
}

let activeAppPool = null;
let activePoolDbName = null;
let activePoolPort = null;

/**
 * Resolves connection configuration for zarsev_app
 */
function resolveAppConfig(dbNameOverride) {
    const isTest = process.env.NODE_ENV === 'test';
    const targetDb = dbNameOverride || (isTest ? (process.env.PGDATABASE_TEST || 'zarsev_test') : (process.env.PGDATABASE_DEV || 'zarsev_dev'));

    return {
        host: (process.env.PGHOST || 'localhost').trim(),
        port: parseInt(process.env.PGPORT || '5432', 10),
        user: (process.env.PG_APP_USER || 'zarsev_app').trim(),
        password: process.env.PG_APP_PASSWORD,
        database: targetDb,
        max: parseInt(process.env.PG_POOL_MAX || '20', 10),
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000
    };
}

/**
 * Resolves connection configuration for zarsev_migrator (dedicated standalone client)
 */
function resolveMigratorConfig(dbNameOverride) {
    const isTest = process.env.NODE_ENV === 'test';
    const targetDb = dbNameOverride || (isTest ? (process.env.PGDATABASE_TEST || 'zarsev_test') : (process.env.PGDATABASE_DEV || 'zarsev_dev'));

    return {
        host: (process.env.PGHOST || 'localhost').trim(),
        port: parseInt(process.env.PGPORT || '5432', 10),
        user: (process.env.PG_MIGRATOR_USER || 'zarsev_migrator').trim(),
        password: process.env.PG_MIGRATOR_PASSWORD,
        database: targetDb,
        connectionTimeoutMillis: 10000
    };
}

/**
 * Returns or lazily creates the operational connection pool for zarsev_app
 */
function getAppPool(dbNameOverride) {
    const config = resolveAppConfig(dbNameOverride);
    if (!activeAppPool || activePoolDbName !== config.database || activePoolPort !== config.port) {
        if (activeAppPool) {
            activeAppPool.end().catch(() => {});
        }
        activeAppPool = new Pool(config);
        activePoolDbName = config.database;
        activePoolPort = config.port;

        activeAppPool.on('error', (err) => {
            console.error('[POSTGRES POOL ERROR]', err.message || err);
        });
    }
    return activeAppPool;
}

/**
 * Creates a dedicated, standalone Client instance authenticated as zarsev_migrator.
 * Callers are responsible for connecting and ending this client.
 */
function getMigratorClient(dbNameOverride) {
    const config = resolveMigratorConfig(dbNameOverride);
    return new Client(config);
}

/**
 * Executes a query returning all matching rows as an array of objects.
 * Uses native PostgreSQL parameterization ($1, $2, ...).
 * 
 * @param {string} text - SQL query text with $n placeholders
 * @param {Array} [params] - Query parameters
 * @param {object} [client] - Optional transactional client
 * @returns {Promise<Array<object>>}
 */
async function queryAll(text, params = [], client = null) {
    const runner = client || getAppPool();
    const res = await runner.query(text, params);
    return res.rows;
}

/**
 * Executes a query returning a single row or null.
 * 
 * @param {string} text - SQL query text with $n placeholders
 * @param {Array} [params] - Query parameters
 * @param {object} [client] - Optional transactional client
 * @returns {Promise<object|null>}
 */
async function queryOne(text, params = [], client = null) {
    const runner = client || getAppPool();
    const res = await runner.query(text, params);
    return res.rows.length > 0 ? res.rows[0] : null;
}

/**
 * Executes an INSERT/UPDATE/DELETE/DDL statement returning execution metadata.
 * 
 * @param {string} text - SQL query text with $n placeholders
 * @param {Array} [params] - Query parameters
 * @param {object} [client] - Optional transactional client
 * @returns {Promise<{ rowCount: number, command: string, rows: Array<object> }>}
 */
async function execute(text, params = [], client = null) {
    const runner = client || getAppPool();
    const res = await runner.query(text, params);
    return {
        rowCount: res.rowCount,
        command: res.command,
        rows: res.rows
    };
}

// Track transaction savepoint nesting depth
const clientDepthMap = new WeakMap();

/**
 * Executes operations inside a transaction block with support for:
 * - Nested transactions via safe, internally generated savepoints
 * - Serialization retry on SQLSTATE 40001 / 40P01
 * - Tainted client removal from pool if rollback fails
 * 
 * IMPORTANT ARCHITECTURAL & IDEMPOTENCY GUIDELINES:
 * 1. Callback Re-execution:
 *    When serialization/deadlock retry is enabled (the default), the provided `callback`
 *    may be executed MORE THAN ONCE if PostgreSQL raises SQLSTATE 40001 (serialization_failure)
 *    or 40P01 (deadlock_detected). Each retry runs the callback from the beginning with a fresh client.
 * 
 * 2. Database Operations Only:
 *    Callbacks MUST contain database operations only.
 * 
 * 3. No External Side Effects:
 *    Do NOT send emails, call external APIs, publish messages, modify external systems,
 *    or perform other non-transactional side effects inside retryable callbacks. Doing so
 *    risks duplicate external side effects upon retry.
 * 
 * 4. Post-Commit Execution:
 *    Perform external side effects only AFTER the transaction has successfully committed
 *    (i.e. in the application code following `await transaction(...)`).
 * 
 * 5. Disabling Retries:
 *    If an operation cannot be made idempotent or contains unavoidable external dependencies
 *    that cannot be moved outside the transaction, pass `{ retryOnSerialization: false }`
 *    in the options to ensure the callback is executed at most once, allowing serialization
 *    errors to propagate directly to the caller.
 * 
 * @param {Function} callback - async (client) => result. Must be idempotent and contain DB queries only.
 * @param {object} [options]
 * @param {string} [options.isolationLevel] - e.g. 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'
 * @param {object} [options.client] - Existing client for nested transactions (savepoints)
 * @param {number} [options.maxRetries=3] - Maximum retry attempts on serialization conflict (default: 3)
 * @param {boolean} [options.retryOnSerialization=true] - Enable serialization failure retry (set false to prevent re-execution)
 * @param {string} [options.dbNameOverride] - Target database override
 * @returns {Promise<*>}
 */
async function transaction(callback, options = {}) {
    // 1. Nested Transaction (Savepoint)
    if (options.client) {
        const client = options.client;
        const currentDepth = (clientDepthMap.get(client) || 0) + 1;
        clientDepthMap.set(client, currentDepth);

        const spName = `sp_${currentDepth}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        await client.query(`SAVEPOINT ${spName};`);

        try {
          const result = await callback(client);
          await client.query(`RELEASE SAVEPOINT ${spName};`);
          return result;
        } catch (err) {
          try {
            await client.query(`ROLLBACK TO SAVEPOINT ${spName};`);
          } catch (spRollbackErr) {
            err.savepointRollbackError = spRollbackErr;
          }
          throw err;
        } finally {
          clientDepthMap.set(client, currentDepth - 1);
        }
    }

    // 2. Outer Transaction (Acquires client from pool with retry capability)
    const maxRetries = options.maxRetries || 3;
    const retryOnSerialization = options.retryOnSerialization !== false;
    let attempt = 0;

    while (true) {
        attempt++;
        const pool = getAppPool(options.dbNameOverride);
        const client = await pool.connect();
        clientDepthMap.set(client, 1);

        let clientError = null;
        const onClientError = (err) => {
            clientError = err;
        };
        client.on('error', onClientError);

        try {
            const isoClause = options.isolationLevel ? ` ISOLATION LEVEL ${options.isolationLevel}` : '';
            await client.query(`BEGIN${isoClause};`);

            const result = await callback(client);

            await client.query('COMMIT;');
            client.removeListener('error', onClientError);
            client.release();
            return result;
        } catch (err) {
            let rollbackFailed = false;
            let rollbackError = null;

            try {
                await client.query('ROLLBACK;');
                client.removeListener('error', onClientError);
                client.release();
            } catch (rbErr) {
                rollbackFailed = true;
                rollbackError = rbErr;
                // Keep onClientError attached so the destroyed client does not emit unhandled 'error'
                // Passing error to release() removes the tainted client from pg-pool
                client.release(rbErr || clientError || true);
            }

            if (rollbackFailed) {
                err.rollbackError = rollbackError;
                throw err;
            }

            const isSerializationFailure = err.code === '40001' || err.code === '40P01';
            if (isSerializationFailure && retryOnSerialization && attempt < maxRetries) {
                // Exponential backoff with jitter: 50ms * 2^attempt + random(0-50ms)
                const delayMs = 50 * Math.pow(2, attempt) + Math.floor(Math.random() * 50);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }

            throw err;
        }
    }
}

/**
 * Strict JSON parsing function.
 * Returns native objects/arrays or default value.
 * Throws JsonCorruptionError on corrupted JSON text. Never swallows errors silently!
 * 
 * @param {string|object|null|undefined} val
 * @param {object} [metadata] - Context for error reporting
 * @param {string} [metadata.column]
 * @param {string|number} [metadata.entityId]
 * @param {*} [metadata.defaultValue=null]
 * @returns {*}
 */
function safeJsonParse(val, metadata = {}) {
    const { column, entityId, defaultValue = null } = metadata;

    if (val === null || val === undefined) {
        return defaultValue;
    }

    // Already parsed object/array (native pg driver parsing for json/jsonb columns)
    if (typeof val === 'object') {
        return val;
    }

    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.length === 0) {
            return defaultValue;
        }

        try {
            return JSON.parse(trimmed);
        } catch (err) {
            throw new JsonCorruptionError(`Corrupted JSON detected in database text for column '${column || 'unknown'}'`, {
                column,
                entityId,
                rawSnippet: trimmed.substring(0, 100),
                cause: err
            });
        }
    }

    return val;
}

/**
 * Closes the active runtime connection pool gracefully.
 */
async function closePool() {
    if (activeAppPool) {
        await activeAppPool.end();
        activeAppPool = null;
        activePoolDbName = null;
    }
}

module.exports = {
    getAppPool,
    getMigratorClient,
    queryAll,
    queryOne,
    execute,
    transaction,
    safeJsonParse,
    closePool,
    JsonCorruptionError,
    resolveAppConfig,
    resolveMigratorConfig
};
