/**
 * scripts/verify_postgres_connection.js
 * 
 * Verifies local PostgreSQL connection and database foundation for ZARSEV.
 * Reads credentials strictly from local environment variables or pgpass.conf.
 * Never logs, exposes, or transmits credentials.
 */

const fs = require('fs');
const path = require('path');

// Load .env natively if present (Node.js 20.6.0+)
try {
  if (typeof process.loadEnvFile === 'function') {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
  }
} catch (_) {}

const { Client } = require('pg');

const TARGET_DATABASES = Object.freeze(['zarsev_dev', 'zarsev_test']);

function sanitizeError(err) {
  if (!err) return 'Unknown error';
  const msg = err.message || String(err);
  // Redact any potential credentials if ever leaked into message
  return msg.replace(/:[^:@/]+@/g, ':***@');
}

function resolveCredentials() {
  const host = process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.PGPORT || '5432', 10);
  const user = process.env.PGUSER || 'postgres';
  let password = process.env.PGPASSWORD;

  // If password not in environment, check pgpass.conf on Windows
  if (!password && process.env.APPDATA) {
    const pgpassPath = path.join(process.env.APPDATA, 'postgresql', 'pgpass.conf');
    if (fs.existsSync(pgpassPath)) {
      try {
        const content = fs.readFileSync(pgpassPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const parts = trimmed.split(':');
          if (parts.length >= 5) {
            const [pHost, pPort, pDb, pUser, ...pPass] = parts;
            if ((pHost === '*' || pHost === host || pHost === '127.0.0.1') &&
                (pPort === '*' || parseInt(pPort, 10) === port) &&
                (pUser === '*' || pUser === user)) {
              password = pPass.join(':');
              break;
            }
          }
        }
      } catch (_) {
        // Silently ignore pgpass read error
      }
    }
  }

  return { host, port, user, password };
}

async function verify() {
  const creds = resolveCredentials();

  if (!creds.password) {
    console.error(JSON.stringify({
      status: 'AUTH_REQUIRED',
      message: 'No password found in process.env.PGPASSWORD or %APPDATA%\\postgresql\\pgpass.conf.',
      instructions: 'Please provide credentials locally via PowerShell or .env without sharing in chat.'
    }, null, 2));
    process.exit(2);
  }

  const results = {
    rootConnection: false,
    engineVersion: null,
    databases: {
      zarsev_dev: { existed: false, created: false, connectionOk: false, currentUser: null, verifiedDb: null },
      zarsev_test: { existed: false, created: false, connectionOk: false, currentUser: null, verifiedDb: null }
    }
  };

  console.log(`[INFO] Attempting connection to PostgreSQL at ${creds.host}:${creds.port} as user '${creds.user}'...`);

  // 1. Connect to root postgres database to check/create target databases
  const rootClient = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: 'postgres'
  });

  try {
    await rootClient.connect();
    results.rootConnection = true;
    console.log('[SUCCESS] Connected to root postgres database.');

    const verRes = await rootClient.query('SELECT version();');
    results.engineVersion = verRes.rows[0].version;
    console.log(`[INFO] Engine version: ${results.engineVersion}`);

    // Check existing databases
    const dbCheck = await rootClient.query(
      "SELECT datname FROM pg_database WHERE datname = ANY($1::text[]);",
      [TARGET_DATABASES]
    );
    const existingDbs = new Set(dbCheck.rows.map(r => r.datname));

    for (const dbName of TARGET_DATABASES) {
      if (existingDbs.has(dbName)) {
        results.databases[dbName].existed = true;
        console.log(`[INFO] Database '${dbName}' already exists.`);
      } else {
        results.databases[dbName].existed = false;
        console.log(`[INFO] Database '${dbName}' not found. Creating...`);
        // Whitelisted identifier quote
        await rootClient.query(`CREATE DATABASE "${dbName}";`);
        results.databases[dbName].created = true;
        console.log(`[SUCCESS] Database '${dbName}' created.`);
      }
    }
  } catch (err) {
    console.error('[ERROR] Root connection/database creation failed:', sanitizeError(err));
    process.exit(1);
  } finally {
    try {
      await rootClient.end();
    } catch (_) {}
  }

  // 2. Independently verify connection to each target database
  for (const dbName of TARGET_DATABASES) {
    const targetClient = new Client({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: dbName
    });

    try {
      await targetClient.connect();
      const checkRes = await targetClient.query('SELECT current_database(), current_user;');
      const row = checkRes.rows[0];
      results.databases[dbName].connectionOk = true;
      results.databases[dbName].verifiedDb = row.current_database;
      results.databases[dbName].currentUser = row.current_user;
      console.log(`[SUCCESS] Verified connection to '${row.current_database}' as user '${row.current_user}'.`);
    } catch (err) {
      results.databases[dbName].connectionOk = false;
      console.error(`[ERROR] Connection to '${dbName}' failed:`, sanitizeError(err));
      process.exit(1);
    } finally {
      try {
        await targetClient.end();
      } catch (_) {}
    }
  }

  console.log('\n[SUMMARY] PostgreSQL Foundation Verification Completed Successfully:');
  console.log(JSON.stringify(results, null, 2));
}

verify().catch(err => {
  console.error('[FATAL]', sanitizeError(err));
  process.exit(1);
});
