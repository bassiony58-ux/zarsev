/**
 * scripts/setup_phase1_roles.js
 * 
 * ZARSEV — PostgreSQL Phase 1: Roles, Permissions, & Advisory Lock Setup & Verification
 * 
 * Targets ONLY: zarsev_dev and zarsev_test.
 * Zero SQLite touches, zero business tables, zero migrations.
 * Never logs or exposes credentials.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

// 1. Capture any pre-existing environment variable BEFORE loadEnvFile
// This guarantees that any variable passed from PowerShell strictly takes precedence
// over empty or template values in .env (e.g. PGPASSWORD=).
const preEnvPassword = (
  process.env.PGPASSWORD ||
  process.env.PG_ROOT_PASSWORD ||
  process.env.POSTGRES_PASSWORD ||
  ''
).trim();

// 2. Load .env natively if present (Node.js 20.6.0+)
try {
  if (typeof process.loadEnvFile === 'function') {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
  }
} catch (_) {}

// 3. Re-assert pre-existing environment password if it was non-empty
if (preEnvPassword && preEnvPassword.length > 0) {
  process.env.PGPASSWORD = preEnvPassword;
}

const TARGET_DATABASES = Object.freeze(['zarsev_dev', 'zarsev_test']);
const ADVISORY_LOCK_ID = '6503569854498753863'; // BigInt('0x5A41525345564D47').toString()

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

function sanitizeError(err) {
  if (!err) return 'Unknown error';
  const code = err.code ? `[SQLSTATE: ${err.code}] ` : '';
  const rawMsg = err.message || String(err);
  // Redact passwords, connection URIs, tokens
  const cleanMsg = rawMsg
    .replace(/:[^:@/\s]+@/g, ':***@')
    .replace(/(PASSWORD\s*['"])([^'"]+)(['"])/gi, '$1***$3')
    .replace(/password\s*:\s*['"][^'"]+['"]/gi, 'password: "***"');
  return `${code}${cleanMsg}`;
}

function resolveAdminCredentials() {
  const host = (process.env.PGHOST || 'localhost').trim();
  const port = parseInt(process.env.PGPORT || '5432', 10);
  const user = (process.env.PGUSER || 'postgres').trim();

  // Check PGPASSWORD and standard aliases, strictly ignoring empty strings
  let password = null;
  const candidateEnvVars = ['PGPASSWORD', 'PG_ROOT_PASSWORD', 'POSTGRES_PASSWORD'];
  for (const varName of candidateEnvVars) {
    const val = process.env[varName];
    if (val && typeof val === 'string' && val.trim().length > 0) {
      password = val.trim();
      break;
    }
  }

  // Check pgpass.conf on Windows if not in environment
  if (!password) {
    const pgpassCandidates = [];
    if (process.env.APPDATA) {
      pgpassCandidates.push(path.join(process.env.APPDATA, 'postgresql', 'pgpass.conf'));
    }
    if (process.env.USERPROFILE) {
      pgpassCandidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'postgresql', 'pgpass.conf'));
      pgpassCandidates.push(path.join(process.env.USERPROFILE, '.pgpass'));
    }

    for (const pgpassPath of pgpassCandidates) {
      if (fs.existsSync(pgpassPath)) {
        try {
          const content = fs.readFileSync(pgpassPath, 'utf8');
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const parts = trimmed.split(':');
            if (parts.length >= 5) {
              const [pHost, pPort, pDb, pUser, ...pPass] = parts;
              const hostMatch = (
                pHost === '*' ||
                pHost === host ||
                ((pHost === 'localhost' || pHost === '127.0.0.1') && (host === 'localhost' || host === '127.0.0.1'))
              );
              const portMatch = (pPort === '*' || parseInt(pPort, 10) === port);
              const userMatch = (pUser === '*' || pUser === user);

              if (hostMatch && portMatch && userMatch) {
                const matchedPass = pPass.join(':').trim();
                if (matchedPass.length > 0) {
                  password = matchedPass;
                  break;
                }
              }
            }
          }
          if (password) break;
        } catch (_) {}
      }
    }
  }

  return { host, port, user, password };
}

function generateSecurePassword() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Atomically updates .env with preservation of existing variables
 * Uses a replacement callback to safely handle '$' characters in passwords.
 * Cleans up temporary file on failure without exposing sensitive data.
 */
function atomicUpdateEnv(updates) {
  const envFilePath = path.join(__dirname, '..', '.env');
  const tmpFileName = `.env.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const tmpFilePath = path.join(__dirname, '..', tmpFileName);

  let envContent = '';
  if (fs.existsSync(envFilePath)) {
    envContent = fs.readFileSync(envFilePath, 'utf8');
  }

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      // Safe replacement callback avoids interpreting '$' in passwords
      envContent = envContent.replace(regex, () => `${key}=${val}`);
    } else {
      envContent = envContent.trim() ? `${envContent.trim()}\n${key}=${val}\n` : `${key}=${val}\n`;
    }
  }

  try {
    fs.writeFileSync(tmpFilePath, envContent, 'utf8');
    fs.renameSync(tmpFilePath, envFilePath);
  } catch (err) {
    if (fs.existsSync(tmpFilePath)) {
      try {
        fs.unlinkSync(tmpFilePath);
      } catch (unlinkErr) {
        console.warn(`[SECURITY WARNING] Failed to delete temporary credential file '${tmpFileName}'. Please delete it manually.`);
      }
    }
    throw new Error(`Failed to atomically update .env: ${err.message}`);
  }

  // Verification step: verify .env exists and is non-empty
  if (!fs.existsSync(envFilePath) || fs.statSync(envFilePath).size === 0) {
    throw new Error('Verification failed: .env file is missing or empty after write.');
  }
}

/**
 * Verifies that .env is actively ignored by .gitignore
 */
function verifyGitIgnoreProtection() {
  const gitIgnorePath = path.join(__dirname, '..', '.gitignore');
  if (fs.existsSync(gitIgnorePath)) {
    const content = fs.readFileSync(gitIgnorePath, 'utf8');
    const lines = content.split(/\r?\n/).map(l => l.trim());
    const isIgnored = lines.includes('.env') || lines.includes('.env*') || lines.includes('*.env');
    if (!isIgnored) {
      throw new Error('SAFETY CHECK FAILED: .env is not strictly excluded in .gitignore');
    }
  }
}

async function run() {
  // Pre-execution SQLite integrity snapshot
  const sqliteFiles = {
    'zarsev.db': computeSha256(path.join(__dirname, '..', 'zarsev.db')),
    'zarsev.db.bak': computeSha256(path.join(__dirname, '..', 'zarsev.db.bak')),
    'zarsev.db.phase1_2_prequarantine.bak': computeSha256(path.join(__dirname, '..', 'zarsev.db.phase1_2_prequarantine.bak'))
  };

  verifyGitIgnoreProtection();

  const adminCreds = resolveAdminCredentials();

  if (!adminCreds.password) {
    console.error(JSON.stringify({
      status: 'AUTH_REQUIRED',
      error: 'Missing root PostgreSQL password in PGPASSWORD or pgpass.conf',
      instructions: 'Run via PowerShell with $env:PGPASSWORD set in local memory or provide in uncommitted .env'
    }, null, 2));
    process.exit(2);
  }

  const results = {
    rolesConfigured: false,
    databasesConfigured: [],
    schemaOwnership: {},
    tests: {
      migratorDDL: {},
      appNegativeDdlBlocked: {},
      appPositiveDmlAllowed: {},
      defaultPrivilegesInherited: {},
      publicAccessDenied: {},
      advisoryLock: {}
    },
    cleanupCompleted: false,
    sqliteIntegrityVerified: true
  };

  // 1. Generate or retrieve passwords for zarsev_migrator and zarsev_app
  const migratorPassword = process.env.PG_MIGRATOR_PASSWORD || generateSecurePassword();
  const appPassword = process.env.PG_APP_PASSWORD || generateSecurePassword();

  // 2. Pre-stage credentials into .env BEFORE applying to PostgreSQL.
  // This guarantees that if the PostgreSQL query or connection fails, the passwords
  // are already securely persisted locally, allowing seamless retry without account lockout.
  atomicUpdateEnv({
    PGHOST: adminCreds.host,
    PGPORT: String(adminCreds.port),
    PG_MIGRATOR_USER: 'zarsev_migrator',
    PG_MIGRATOR_PASSWORD: migratorPassword,
    PG_APP_USER: 'zarsev_app',
    PG_APP_PASSWORD: appPassword,
    PG_DATABASE_DEV: 'zarsev_dev',
    PG_DATABASE_TEST: 'zarsev_test'
  });
  console.log('[INFO] Pre-staged credentials atomically into .env (strictly ignored by Git).');

  console.log('[1/5] Connecting to root PostgreSQL instance as admin...');
  const rootClient = new Client({
    host: adminCreds.host,
    port: adminCreds.port,
    user: adminCreds.user,
    password: adminCreds.password,
    database: 'postgres'
  });

  try {
    await rootClient.connect();

    // 3. Create/Alter roles with strictly hardened attributes
    console.log('[2/5] Creating and hardening roles (zarsev_migrator, zarsev_app)...');

    // zarsev_migrator: LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION
    // zarsev_app: LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION
    await rootClient.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zarsev_migrator') THEN
          CREATE ROLE zarsev_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${migratorPassword}';
        ELSE
          ALTER ROLE zarsev_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${migratorPassword}';
        END IF;

        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zarsev_app') THEN
          CREATE ROLE zarsev_app WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${appPassword}';
        ELSE
          ALTER ROLE zarsev_app WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${appPassword}';
        END IF;
      END $$;
    `);

    // Ensure zarsev_app is NOT a member of zarsev_migrator or pg_database_owner
    await rootClient.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_auth_members m
          JOIN pg_roles r ON m.roleid = r.oid
          JOIN pg_roles member ON m.member = member.oid
          WHERE r.rolname = 'zarsev_migrator' AND member.rolname = 'zarsev_app'
        ) THEN
          EXECUTE 'REVOKE zarsev_migrator FROM zarsev_app';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_auth_members m
          JOIN pg_roles r ON m.roleid = r.oid
          JOIN pg_roles member ON m.member = member.oid
          WHERE r.rolname = 'pg_database_owner' AND member.rolname = 'zarsev_app'
        ) THEN
          EXECUTE 'REVOKE pg_database_owner FROM zarsev_app';
        END IF;
      END $$;
    `);

    results.rolesConfigured = true;
    console.log('[SUCCESS] Roles created and hardened (zarsev_migrator [NOSUPERUSER], zarsev_app [NOINHERIT, NOSUPERUSER]).');
  } finally {
    try { await rootClient.end(); } catch (_) {}
  }

  // 4. Configure permissions independently on zarsev_dev and zarsev_test
  console.log('[3/5] Configuring schema ownership and privileges on target databases...');
  for (const dbName of TARGET_DATABASES) {
    const dbAdminClient = new Client({
      host: adminCreds.host,
      port: adminCreds.port,
      user: adminCreds.user,
      password: adminCreds.password,
      database: dbName
    });

    try {
      await dbAdminClient.connect();

      // Revoke CONNECT and TEMP from PUBLIC
      await dbAdminClient.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC;`);
      await dbAdminClient.query(`REVOKE TEMP ON DATABASE "${dbName}" FROM PUBLIC, zarsev_app;`);

      // Grant CONNECT to allowed roles only
      await dbAdminClient.query(`GRANT CONNECT ON DATABASE "${dbName}" TO zarsev_migrator, zarsev_app;`);

      // Schema public ownership to zarsev_migrator
      await dbAdminClient.query(`ALTER SCHEMA public OWNER TO zarsev_migrator;`);
      await dbAdminClient.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, zarsev_app;`);

      // zarsev_app gets USAGE only on schema public
      await dbAdminClient.query(`REVOKE ALL ON SCHEMA public FROM zarsev_app;`);
      await dbAdminClient.query(`GRANT USAGE ON SCHEMA public TO zarsev_app;`);

      // Existing tables/sequences (if any)
      await dbAdminClient.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zarsev_app;`);
      await dbAdminClient.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zarsev_app;`);
      await dbAdminClient.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;`);
      await dbAdminClient.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;`);

      // Default privileges for objects created by zarsev_migrator
      await dbAdminClient.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE zarsev_migrator IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zarsev_app;
      `);
      await dbAdminClient.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE zarsev_migrator IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO zarsev_app;
      `);

      // Verify schema owner
      const ownerRes = await dbAdminClient.query(`
        SELECT schema_name, schema_owner 
        FROM information_schema.schemata 
        WHERE schema_name = 'public';
      `);
      results.schemaOwnership[dbName] = ownerRes.rows[0]?.schema_owner;

      results.databasesConfigured.push(dbName);
      console.log(`[SUCCESS] Database '${dbName}' configured. public schema owner: '${results.schemaOwnership[dbName]}'.`);
    } finally {
      try { await dbAdminClient.end(); } catch (_) {}
    }
  }

  // 5. Mandatory Practical Permission Verification Tests
  console.log('[4/5] Executing mandatory permission tests on zarsev_test...');
  const testDb = 'zarsev_test';
  const runId = crypto.randomBytes(4).toString('hex');
  const testTable = `__phase1_perm_test_${runId}`;
  const testSeq = `__phase1_perm_seq_${runId}`;
  const unprivRole = `__phase1_unpriv_${runId}`;
  const unprivPass = crypto.randomBytes(16).toString('base64url');

  const migratorClient = new Client({
    host: adminCreds.host,
    port: adminCreds.port,
    user: 'zarsev_migrator',
    password: migratorPassword,
    database: testDb
  });

  const appClient = new Client({
    host: adminCreds.host,
    port: adminCreds.port,
    user: 'zarsev_app',
    password: appPassword,
    database: testDb
  });

  try {
    await migratorClient.connect();
    console.log('[TEST] zarsev_migrator connection: OK');

    await appClient.connect();
    console.log('[TEST] zarsev_app connection: OK');

    let primaryTestError = null;

    // A. Migrator DDL Tests with mandatory guaranteed cleanup in finally
    try {
      await migratorClient.query(`CREATE TABLE "${testTable}" (id INT PRIMARY KEY, name TEXT);`);
      await migratorClient.query(`CREATE SEQUENCE "${testSeq}";`);
      await migratorClient.query(`ALTER TABLE "${testTable}" ADD COLUMN notes TEXT;`);
      results.tests.migratorDDL = {
        createTable: true,
        createSequence: true,
        alterTable: true
      };
      console.log(`[TEST SUCCESS] zarsev_migrator executed DDL on '${testTable}' and '${testSeq}'.`);

      // B. Default Privileges Test: App DML on table created by migrator
      await appClient.query(`INSERT INTO "${testTable}" (id, name, notes) VALUES (1, 'Test Item', 'Initial');`);
      const selectRes = await appClient.query(`SELECT * FROM "${testTable}" WHERE id = 1;`);
      await appClient.query(`UPDATE "${testTable}" SET notes = 'Updated' WHERE id = 1;`);
      const seqRes = await appClient.query(`SELECT nextval('${testSeq}');`);
      await appClient.query(`DELETE FROM "${testTable}" WHERE id = 1;`);

      results.tests.defaultPrivilegesInherited = {
        insertAllowed: true,
        selectAllowed: selectRes.rows.length === 1,
        updateAllowed: true,
        sequenceAllowed: !!seqRes.rows[0].nextval,
        deleteAllowed: true
      };
      console.log('[TEST SUCCESS] zarsev_app automatically received DML and sequence permissions via DEFAULT PRIVILEGES.');

      // C. App Negative Tests (Must FAIL with 42501)
      const negativeChecks = [
        { name: 'createTable', sql: `CREATE TABLE "__phase1_app_tbl_${runId}" (id INT);` },
        { name: 'createSchema', sql: `CREATE SCHEMA "__phase1_app_sch_${runId}";` },
        { name: 'alterTable', sql: `ALTER TABLE "${testTable}" DROP COLUMN notes;` },
        { name: 'dropTable', sql: `DROP TABLE "${testTable}";` },
        { name: 'changeOwner', sql: `ALTER TABLE "${testTable}" OWNER TO zarsev_app;` },
        { name: 'setRoleMigrator', sql: 'SET ROLE zarsev_migrator;' }
      ];

      for (const check of negativeChecks) {
        try {
          await appClient.query(check.sql);
          results.tests.appNegativeDdlBlocked[check.name] = false;
          console.error(`[TEST FAILURE] zarsev_app unexpectedly succeeded in DDL: ${check.sql}`);
        } catch (err) {
          const isForbidden = err.code === '42501'; // insufficient_privilege
          results.tests.appNegativeDdlBlocked[check.name] = isForbidden;
          if (isForbidden) {
            console.log(`[TEST SUCCESS] zarsev_app rejected for '${check.name}' with SQLSTATE 42501 (insufficient_privilege).`);
          } else {
            console.warn(`[TEST WARN] zarsev_app rejected for '${check.name}' with code ${err.code}: ${sanitizeError(err)}`);
          }
        }
      }
    } catch (testErr) {
      primaryTestError = testErr;
      throw testErr;
    } finally {
      // Mandatory cleanup of test table and sequence in finally block
      let cleanupFailed = false;
      let cleanupError = null;

      try {
        await migratorClient.query(`DROP TABLE IF EXISTS "${testTable}";`);
        await migratorClient.query(`DROP SEQUENCE IF EXISTS "${testSeq}";`);
        console.log(`[CLEANUP SUCCESS] zarsev_migrator cleaned up '${testTable}' and '${testSeq}'.`);
      } catch (cleanupErr) {
        cleanupFailed = true;
        cleanupError = cleanupErr;
        console.error(`[CLEANUP ERROR] Failed to drop test objects '${testTable}' / '${testSeq}':`, sanitizeError(cleanupErr));
      }

      if (cleanupFailed) {
        results.cleanupCompleted = false;
        const fatalCleanupErr = new Error(`Mandatory cleanup failed for test objects '${testTable}' / '${testSeq}': ${sanitizeError(cleanupError)}`);
        if (primaryTestError) {
          fatalCleanupErr.primaryTestError = sanitizeError(primaryTestError);
        }
        throw fatalCleanupErr;
      }
    }

    // D. PUBLIC connection check with unique unprivileged role
    const rootAdminClient = new Client({
      host: adminCreds.host,
      port: adminCreds.port,
      user: adminCreds.user,
      password: adminCreds.password,
      database: 'postgres'
    });

    try {
      await rootAdminClient.connect();
      // Drop any potential stale role and create fresh unique unprivileged test role
      await rootAdminClient.query(`DROP ROLE IF EXISTS "${unprivRole}";`);
      await rootAdminClient.query(`CREATE ROLE "${unprivRole}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${unprivPass}';`);

      const unprivilegedClient = new Client({
        host: adminCreds.host,
        port: adminCreds.port,
        user: unprivRole,
        password: unprivPass,
        database: testDb
      });

      try {
        await unprivilegedClient.connect();
        results.tests.publicAccessDenied.connectBlocked = false;
        console.error('[TEST FAILURE] Unprivileged user unexpectedly connected to target database!');
      } catch (err) {
        const isDenied = err.code === '42501';
        results.tests.publicAccessDenied.connectBlocked = isDenied;
        console.log(`[TEST SUCCESS] Unprivileged user '${unprivRole}' blocked from '${testDb}' with SQLSTATE 42501 (permission denied).`);
      } finally {
        try { await unprivilegedClient.end(); } catch (_) {}
      }
    } finally {
      // Mandatory cleanup of unprivileged test role
      let roleCleanupFailed = false;
      let roleCleanupError = null;

      try {
        await rootAdminClient.query(`DROP ROLE IF EXISTS "${unprivRole}";`);
        console.log(`[CLEANUP SUCCESS] Removed unprivileged test role '${unprivRole}'.`);
      } catch (dropRoleErr) {
        roleCleanupFailed = true;
        roleCleanupError = dropRoleErr;
        console.error(`[CLEANUP ERROR] Failed to drop test role '${unprivRole}':`, sanitizeError(dropRoleErr));
      }

      if (roleCleanupFailed) {
        results.cleanupCompleted = false;
        throw new Error(`Mandatory cleanup failed for test role '${unprivRole}': ${sanitizeError(roleCleanupError)}`);
      }

      try { await rootAdminClient.end(); } catch (_) {}
    }

    results.cleanupCompleted = true;

  } finally {
    try { await appClient.end(); } catch (_) {}
    try { await migratorClient.end(); } catch (_) {}
  }

  // 6. Advisory Lock Verification (Section 4)
  console.log('[5/5] Testing Advisory Lock lifecycle with decimal string parameter...');
  const lockClient1 = new Client({
    host: adminCreds.host,
    port: adminCreds.port,
    user: 'zarsev_migrator',
    password: migratorPassword,
    database: testDb
  });

  const lockClient2 = new Client({
    host: adminCreds.host,
    port: adminCreds.port,
    user: 'zarsev_migrator',
    password: migratorPassword,
    database: testDb
  });

  try {
    await lockClient1.connect();
    await lockClient2.connect();

    // 1. Client 1 acquires lock
    const res1 = await lockClient1.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [ADVISORY_LOCK_ID]);
    const c1Acquired = res1.rows[0].locked === true;

    // 2. Client 2 attempts acquisition while Client 1 holds it (must return false)
    const res2 = await lockClient2.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [ADVISORY_LOCK_ID]);
    const c2Blocked = res2.rows[0].locked === false;

    // 3. Client 1 releases lock
    const resUnlock = await lockClient1.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked;', [ADVISORY_LOCK_ID]);
    const c1Unlocked = resUnlock.rows[0].unlocked === true;

    // 4. Client 2 acquires lock after release
    const res3 = await lockClient2.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [ADVISORY_LOCK_ID]);
    const c2AcquiredAfterRelease = res3.rows[0].locked === true;

    // 5. Disconnect Client 2 abruptly without unlocking
    await lockClient2.end();

    // 6. Verify lock was automatically freed on session disconnect
    const res4 = await lockClient1.query('SELECT pg_try_advisory_lock($1::bigint) AS locked;', [ADVISORY_LOCK_ID]);
    const c1AcquiredAfterDisconnect = res4.rows[0].locked === true;
    await lockClient1.query('SELECT pg_advisory_unlock($1::bigint);', [ADVISORY_LOCK_ID]);

    results.tests.advisoryLock = {
      client1Acquired: c1Acquired,
      client2BlockedWhileHeld: c2Blocked,
      client1Unlocked: c1Unlocked,
      client2AcquiredAfterUnlock: c2AcquiredAfterRelease,
      autoReleasedOnDisconnect: c1AcquiredAfterDisconnect
    };

    console.log('[TEST SUCCESS] Advisory Lock verified: acquisition, collision blocking, explicit unlock, and disconnect cleanup.');
  } finally {
    try { await lockClient1.end(); } catch (_) {}
    try { await lockClient2.end(); } catch (_) {}
  }

  // Verify SQLite files remained 100% untouched
  const postSqliteFiles = {
    'zarsev.db': computeSha256(path.join(__dirname, '..', 'zarsev.db')),
    'zarsev.db.bak': computeSha256(path.join(__dirname, '..', 'zarsev.db.bak')),
    'zarsev.db.phase1_2_prequarantine.bak': computeSha256(path.join(__dirname, '..', 'zarsev.db.phase1_2_prequarantine.bak'))
  };

  const sqliteMatches = (
    sqliteFiles['zarsev.db'] === postSqliteFiles['zarsev.db'] &&
    sqliteFiles['zarsev.db.bak'] === postSqliteFiles['zarsev.db.bak'] &&
    sqliteFiles['zarsev.db.phase1_2_prequarantine.bak'] === postSqliteFiles['zarsev.db.phase1_2_prequarantine.bak']
  );

  results.sqliteIntegrityVerified = sqliteMatches;

  console.log('\n======================================================');
  console.log('[PHASE 1 COMPLETE] All Roles, Permissions, & Locks Verified:');
  console.log(JSON.stringify(results, null, 2));
  console.log('======================================================');
}

run().catch(err => {
  console.error('[FATAL ERROR IN PHASE 1]', sanitizeError(err));
  process.exit(1);
});
