/**
 * test/test_manufacturer_lifecycle_full_suite.js
 * 
 * ZARSEV — Master Automated Remediation Test Suite
 * Fully automated, zero-leak verification on an isolated, disposable PostgreSQL instance (port 5433).
 * Covers all 20 required scenarios + Migration lifecycle + Immutability verification.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Client } = require('M:/ZZZ/node_modules/pg');

const PG_BIN_DIR = 'C:/Program Files/PostgreSQL/16/bin';
const TEMP_DATA_DIR = path.resolve('M:/ZZZ/.disposable_pg_data');
const PORT = 5433;
const APP_PORT = 3099;

// Configure process.env to ensure app modules route to disposable PG
process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'postgres';
process.env.PGHOST = 'localhost';
process.env.PGPORT = String(PORT);
process.env.PGDATABASE_TEST = 'zarsev_test';
process.env.PG_APP_USER = 'zarsev_app';
process.env.PG_APP_PASSWORD = 'RB5UlbM6PnFiYHgdud48ZDpSTtzUUJxN';
process.env.PG_MIGRATOR_USER = 'zarsev_migrator';
process.env.PG_MIGRATOR_PASSWORD = 'bYhdH0mBrT8yLEP_3_0dXvJlS_8GNv9v';
process.env.JWT_SECRET = 'test_secret_for_remediation_suite_99999';
process.env.ENABLE_DEV_LOGIN = 'true';

const results = [];

function recordTest(id, name, status, details = {}, error = null) {
    const passed = status === 'PASSED';
    console.log(`[${passed ? 'PASS' : 'FAIL'}] ${id}: ${name}`);
    if (!passed && error) {
        console.error(`       Error: ${error.message || error}`);
    }
    results.push({
        id,
        name,
        status,
        passed,
        details,
        error: error ? (error.message || String(error)) : null,
        timestamp: new Date().toISOString()
    });
}

function runCmd(cmd) {
    return execSync(cmd, { stdio: 'ignore' });
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function request(method, route, options = {}) {
    const url = `http://localhost:${APP_PORT}${route}`;
    const headers = options.headers || {};
    let body = options.body;

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = JSON.stringify(body);
    }

    const res = await fetch(url, {
        method,
        headers,
        body
    });

    let resBody = null;
    const text = await res.text();
    try {
        resBody = JSON.parse(text);
    } catch (_) {
        resBody = text;
    }

    return {
        status: res.status,
        headers: res.headers,
        body: resBody
    };
}

async function main() {
    console.log('================================================================');
    console.log(' ZARSEV AUTONOMOUS REMEDIATION MASTER TEST SUITE');
    console.log('================================================================');

    let serverProcess = null;
    let expressServer = null;
    let migratorClient = null;

    try {
        // -------------------------------------------------------------
        // Step 1: Initialize Disposable PostgreSQL Cluster
        // -------------------------------------------------------------
        console.log('\n[Phase A] Setting up Disposable PostgreSQL Cluster on port 5433...');

        if (fs.existsSync(TEMP_DATA_DIR)) {
            try {
                runCmd(`"${PG_BIN_DIR}/pg_ctl.exe" -D "${TEMP_DATA_DIR}" stop -m immediate`);
            } catch (_) {}
            await sleep(1000);
            fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
        }

        runCmd(`"${PG_BIN_DIR}/initdb.exe" -D "${TEMP_DATA_DIR}" -U postgres -A trust --no-locale -E UTF8`);
        
        // Start postgres via pg_ctl with -w (wait)
        runCmd(`"${PG_BIN_DIR}/pg_ctl.exe" -D "${TEMP_DATA_DIR}" -o "-p ${PORT}" -l "${path.resolve('M:/ZZZ/.disposable_pg_server.log')}" -w start`);

        // Wait for connection
        let pgReady = false;
        for (let i = 0; i < 30; i++) {
            try {
                const client = new Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
                await client.connect();
                await client.query('SELECT 1');
                await client.end();
                pgReady = true;
                break;
            } catch (_) {
                await sleep(500);
            }
        }

        if (!pgReady) {
            throw new Error('Disposable PostgreSQL cluster failed to become ready');
        }
        console.log(' Disposable PostgreSQL cluster online on port 5433.');

        // -------------------------------------------------------------
        // Step 2: Create Roles & Baseline Database
        // -------------------------------------------------------------
        console.log('\n[Phase B] Provisioning roles and baseline database...');
        const adminClient = new Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
        await adminClient.connect();

        await adminClient.query(`
            DO $$
            BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_migrator') THEN
                CREATE ROLE zarsev_migrator WITH LOGIN PASSWORD 'bYhdH0mBrT8yLEP_3_0dXvJlS_8GNv9v';
              END IF;
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_app') THEN
                CREATE ROLE zarsev_app WITH LOGIN PASSWORD 'RB5UlbM6PnFiYHgdud48ZDpSTtzUUJxN';
              END IF;
            END $$;
        `);

        await adminClient.query('DROP DATABASE IF EXISTS zarsev_test');
        await adminClient.query('CREATE DATABASE zarsev_test OWNER zarsev_migrator');
        await adminClient.query('GRANT ALL PRIVILEGES ON DATABASE zarsev_test TO zarsev_migrator');
        await adminClient.query('GRANT ALL PRIVILEGES ON DATABASE zarsev_test TO zarsev_app');
        await adminClient.end();

        // Connect as migrator
        migratorClient = new Client({
            host: 'localhost',
            port: PORT,
            user: 'zarsev_migrator',
            password: 'bYhdH0mBrT8yLEP_3_0dXvJlS_8GNv9v',
            database: 'zarsev_test'
        });
        await migratorClient.connect();

        await migratorClient.query('GRANT ALL ON SCHEMA public TO zarsev_app');
        await migratorClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO zarsev_app');
        await migratorClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO zarsev_app');

        // Apply migrations 001 - 005
        const baselineMigrations = [
            '001_initial_schema.sql',
            '002_zarsev_core_foundation.sql',
            '003_buyer_rfq_and_inquiry_system.sql',
            '004_structured_commercial_quotations.sql',
            '005_buyer_token_hash_storage.sql'
        ];

        for (const m of baselineMigrations) {
            const sql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg', m), 'utf8');
            await migratorClient.query(sql);
        }
        console.log(' Baseline migrations 001-005 applied successfully.');

        // Seed baseline data
        await migratorClient.query(`
            -- Subscriptions
            INSERT INTO subscriptions (id, name, max_products_per_import, max_monthly_imports, max_file_size_mb, allowed_formats) VALUES
            ('sub_standard', 'Standard', 50, 10, 25, '["csv", "xlsx"]'),
            ('sub_pro', 'Pro', 250, 50, 50, '["csv", "xlsx", "images"]'),
            ('sub_enterprise', 'Enterprise', 1000, 500, 100, '["csv", "xlsx", "images", "pdf"]');

            -- Manufacturers
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, country, city, is_verified, is_demo) VALUES
            ('mfg_delta_iqf', 'شركة الدلتا للصناعات التجميدية', 'Delta IQF Industries', 'EGY-DELTA', 'MARKETING_SUBSCRIPTION', 'sub_standard', 'EG', 'Tanta', true, false),
            ('mfg_nile_fruits', 'شركة ثمار النيل للتصدير الزراعى', 'Nile Fruits Export Co', 'EGY-NILE', 'MARKETING_SUBSCRIPTION', 'sub_pro', 'EG', 'Sadat City', true, false),
            ('mfg_bustan_citrus', 'مزارع البستان للموالح', 'Bustan Citrus Groves', 'EGY-BUSTAN', 'DIRECT_CONTRACT', 'sub_enterprise', 'EG', 'Nubaria', true, false),
            ('mfg_damietta_agro', 'مجمع دمياط للتصنيع الزراعي', 'Damietta Agro Processing', 'EGY-DAMIETTA', 'MARKETING_SUBSCRIPTION', 'sub_standard', 'EG', 'Damietta', true, false);

            -- Initial Users (PBKDF2 hash for password: Password123!)
            -- pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67
            INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo, token_version) VALUES
            ('usr_super_admin', 'المدير العام', 'admin@zarsev.com', 'pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67', 'SUPER_ADMIN', NULL, true, false, 1),
            ('usr_logistics_officer', 'مسؤول اللوجستيات', 'logistics@zarsev.com', 'pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67', 'LOGISTICS_OFFICER', NULL, true, false, 1),
            ('usr_mfg_delta_iqf', 'مدير مصنع الدلتا', 'delta@zarsev.com', 'pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67', 'MANUFACTURER', 'mfg_delta_iqf', true, false, 1),
            ('usr_mfg_nile_fruits', 'مدير ثمار النيل', 'nile@zarsev.com', 'pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67', 'MANUFACTURER', 'mfg_nile_fruits', true, false, 1),
            ('usr_legacy_test_01', 'حساب اختبار تاريخي يتيم', 'legacy@zarsev.com', 'pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67', 'MANUFACTURER', NULL, true, false, 1);
        `);
        console.log(' Baseline seed data inserted.');

        // -------------------------------------------------------------
        // Step 3: Migration 006A Tests
        // -------------------------------------------------------------
        console.log('\n[Phase C] Testing Migration 006A Provisioning, Gates, & Finalize...');

        // Test 1: Provisioning should FAIL if DEC-03 orphan account is active and not exempt
        try {
            const provSql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg/006A_provisioning_revised.sql'), 'utf8');
            await migratorClient.query(provSql);
            recordTest('TC-MIG-PRE-01', 'Provisioning DEC-03 Gate blocks unhandled orphan', 'FAILED', {}, new Error('Expected provisioning to fail due to DEC-03 gate'));
        } catch (err) {
            try { await migratorClient.query('ROLLBACK'); } catch (_) {}
            const blocked = err.message.includes('CANNOT_PROVISION [DEC-03]');
            recordTest('TC-MIG-PRE-01', 'Provisioning DEC-03 Gate blocks unhandled orphan', blocked ? 'PASSED' : 'FAILED', { message: err.message }, blocked ? null : err);
        }

        // Now grant DEC-03 exemption safely to usr_legacy_test_01 (deactivated as required by specification)
        await migratorClient.query(`
            -- Prepare users table with column if needed before running full provisioning
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_legacy_exempt BOOLEAN NOT NULL DEFAULT false;
            UPDATE users SET is_legacy_exempt = true, is_active = false WHERE id = 'usr_legacy_test_01';
        `);

        // Now Provisioning must succeed cleanly!
        try {
            const provSql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg/006A_provisioning_revised.sql'), 'utf8');
            await migratorClient.query(provSql);
            recordTest('TC-MIG-PROV-02', 'Provisioning succeeds after DEC-03 resolved', 'PASSED');
        } catch (err) {
            recordTest('TC-MIG-PROV-02', 'Provisioning succeeds after DEC-03 resolved', 'FAILED', {}, err);
        }

        // Test 10: TC-MIG-10 - Finalize Gate blocks when DEC-01/DEC-02 (sub_role IS NULL on active mfg)
        try {
            const finSql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg/006A_finalize_revised.sql'), 'utf8');
            await migratorClient.query(finSql);
            recordTest('TC-MIG-10', 'Finalize blocks when active manufacturer has sub_role IS NULL (DEC-01/DEC-02 Gate)', 'FAILED', {}, new Error('Expected Finalize to fail'));
        } catch (err) {
            try { await migratorClient.query('ROLLBACK'); } catch (_) {}
            const blocked = err.message.includes('CANNOT_FINALIZE [DEC-01/DEC-02]');
            recordTest('TC-MIG-10', 'Finalize blocks when active manufacturer has sub_role IS NULL (DEC-01/DEC-02 Gate)', blocked ? 'PASSED' : 'FAILED', { message: err.message }, blocked ? null : err);
        }

        // Test TC-AUDIT-21: Immutable Audit Log trigger & Role Privileges reject UPDATE, DELETE, and TRUNCATE
        try {
            await migratorClient.query(`
                INSERT INTO manufacturer_audit_logs (id, manufacturer_id, actor_id, action, details)
                VALUES ('aud_test_01', 'mfg_delta_iqf', 'usr_super_admin', 'TEST_EVENT', '{"test":true}');
            `);
            let deleteBlocked = false;
            try {
                await migratorClient.query("DELETE FROM manufacturer_audit_logs WHERE id = 'aud_test_01'");
            } catch (dErr) {
                deleteBlocked = dErr.message.includes('IMMUTABLE_VIOLATION');
            }
            let updateBlocked = false;
            try {
                await migratorClient.query("UPDATE manufacturer_audit_logs SET action = 'HACKED' WHERE id = 'aud_test_01'");
            } catch (uErr) {
                updateBlocked = uErr.message.includes('IMMUTABLE_VIOLATION');
            }

            // Test TRUNCATE with migrator (tests statement-level trigger)
            let truncateTriggerBlocked = false;
            try {
                await migratorClient.query("TRUNCATE manufacturer_audit_logs");
            } catch (tErr) {
                truncateTriggerBlocked = tErr.message.includes('IMMUTABLE_VIOLATION');
            }

            // Test app role (zarsev_app) privilege boundaries
            const appTestClient = new Client({
                host: 'localhost',
                port: PORT,
                user: 'zarsev_app',
                password: 'RB5UlbM6PnFiYHgdud48ZDpSTtzUUJxN',
                database: 'zarsev_test'
            });
            await appTestClient.connect();

            // zarsev_app INSERT succeeds
            await appTestClient.query(`
                INSERT INTO manufacturer_audit_logs (id, manufacturer_id, actor_id, action, details)
                VALUES ('aud_test_app_01', 'mfg_delta_iqf', 'usr_super_admin', 'APP_INSERT', '{"app":true}');
            `);

            // zarsev_app SELECT succeeds
            const selectRes = await appTestClient.query("SELECT count(*) as count FROM manufacturer_audit_logs");
            const selectAllowed = parseInt(selectRes.rows[0].count, 10) >= 2;

            // zarsev_app UPDATE rejected
            let appUpdateBlocked = false;
            try {
                await appTestClient.query("UPDATE manufacturer_audit_logs SET action = 'HACK' WHERE id = 'aud_test_app_01'");
            } catch (err) {
                appUpdateBlocked = err.message.includes('permission denied') || err.message.includes('IMMUTABLE_VIOLATION');
            }

            // zarsev_app DELETE rejected
            let appDeleteBlocked = false;
            try {
                await appTestClient.query("DELETE FROM manufacturer_audit_logs WHERE id = 'aud_test_app_01'");
            } catch (err) {
                appDeleteBlocked = err.message.includes('permission denied') || err.message.includes('IMMUTABLE_VIOLATION');
            }

            // zarsev_app TRUNCATE rejected
            let appTruncateBlocked = false;
            try {
                await appTestClient.query("TRUNCATE manufacturer_audit_logs");
            } catch (err) {
                appTruncateBlocked = err.message.includes('permission denied') || err.message.includes('IMMUTABLE_VIOLATION');
            }

            await appTestClient.end();

            const auditImmutable = deleteBlocked && updateBlocked && truncateTriggerBlocked &&
                                   appUpdateBlocked && appDeleteBlocked && appTruncateBlocked && selectAllowed;
            recordTest('TC-AUDIT-21', 'manufacturer_audit_logs statement & row triggers reject UPDATE, DELETE, TRUNCATE under migrator & app roles', auditImmutable ? 'PASSED' : 'FAILED', {
                deleteBlocked,
                updateBlocked,
                truncateTriggerBlocked,
                appUpdateBlocked,
                appDeleteBlocked,
                appTruncateBlocked,
                selectAllowed
            });
        } catch (err) {
            recordTest('TC-AUDIT-21', 'manufacturer_audit_logs statement & row triggers reject UPDATE, DELETE, TRUNCATE under migrator & app roles', 'FAILED', {}, err);
        }

        // Now set active accounts sub-roles for runtime testing
        // delta: OWNER, nile: SALES, bustan: OWNER
        await migratorClient.query(`
            UPDATE users SET sub_role = 'OWNER' WHERE id = 'usr_mfg_delta_iqf';
            UPDATE users SET sub_role = 'SALES' WHERE id = 'usr_mfg_nile_fruits';
            INSERT INTO users (id, name, email, password_hash, role, sub_role, manufacturer_id, is_active, is_demo, token_version) VALUES
            ('usr_mfg_bustan_owner', 'مالك البستان', 'bustan@zarsev.com', 'pbkdf2:sha512:210000:72e2cf185d9b626359fce8f38bc6f8bc94d50f8851cbbcae4d8fb855e7144e57:95dd4ecfa16eb16cece48b30ea9242ea351c2789f25f234bf16327c1cb3e47d4889c02ff445c7adfd6d76bb238a8e1837f4cf802119eb412f9547d643ee1cb67', 'MANUFACTURER', 'OWNER', 'mfg_bustan_citrus', true, false, 1);
        `);

        // Finalize now succeeds
        try {
            const finSql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg/006A_finalize_revised.sql'), 'utf8');
            await migratorClient.query(finSql);
            recordTest('TC-MIG-FIN-03', 'Finalize succeeds after all decisions resolved', 'PASSED');
        } catch (err) {
            recordTest('TC-MIG-FIN-03', 'Finalize succeeds after all decisions resolved', 'FAILED', {}, err);
        }

        // Close migrator client
        await migratorClient.end();

        // -------------------------------------------------------------
        // Step 4: Boot In-Process Application
        // -------------------------------------------------------------
        console.log('\n[Phase D] Launching Express application instance on port ' + APP_PORT + '...');
        const app = require('M:/ZZZ/src/app.js');
        expressServer = await new Promise((resolve) => {
            const s = app.listen(APP_PORT, () => resolve(s));
        });
        console.log(' Application server online and listening on port ' + APP_PORT);

        // -------------------------------------------------------------
        // Helper: Tokens
        // -------------------------------------------------------------
        const { generateToken } = require('M:/ZZZ/src/utils/authUtils');
        const jwt = require('M:/ZZZ/node_modules/jsonwebtoken');
        const config = require('M:/ZZZ/src/config');

        // Helper tokens
        const deltaOwnerToken = generateToken({ id: 'usr_mfg_delta_iqf', email: 'delta@zarsev.com', token_version: 1 });
        const nileSalesToken = generateToken({ id: 'usr_mfg_nile_fruits', email: 'nile@zarsev.com', token_version: 1 });
        const bustanOwnerToken = generateToken({ id: 'usr_mfg_bustan_owner', email: 'bustan@zarsev.com', token_version: 1 });
        const superAdminToken = generateToken({ id: 'usr_super_admin', email: 'admin@zarsev.com', token_version: 1 });
        const logisticsToken = generateToken({ id: 'usr_logistics_officer', email: 'logistics@zarsev.com', token_version: 1 });

        // -------------------------------------------------------------
        // Step 5: Execute 20 Required Scenarios
        // -------------------------------------------------------------
        console.log('\n[Phase E] Executing 20 Required Runtime Scenarios...');

        // 11. TC-AUTH-11: JWT without token_version claim -> 401 TOKEN_VERSION_REQUIRED
        {
            const tokenNoVersion = jwt.sign({ id: 'usr_mfg_delta_iqf', email: 'delta@zarsev.com' }, config.JWT_SECRET);
            const res = await request('GET', '/api/manufacturer/team', {
                headers: { Authorization: `Bearer ${tokenNoVersion}` }
            });
            console.log('TC-AUTH-11 res:', res.status, res.body);
            const ok = res.status === 401 && res.body?.code === 'TOKEN_VERSION_REQUIRED';
            recordTest('TC-AUTH-11', 'JWT without token_version rejected with 401 TOKEN_VERSION_REQUIRED', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 12. TC-AUTH-12: JWT with older token_version -> 401 SESSION_REVOKED
        {
            const tokenStaleVersion = jwt.sign({ id: 'usr_mfg_delta_iqf', email: 'delta@zarsev.com', token_version: 99 }, config.JWT_SECRET);
            const res = await request('GET', '/api/manufacturer/team', {
                headers: { Authorization: `Bearer ${tokenStaleVersion}` }
            });
            console.log('TC-AUTH-12 res:', res.status, res.body);
            const ok = res.status === 401 && res.body?.code === 'SESSION_REVOKED';
            recordTest('TC-AUTH-12', 'JWT with stale token_version rejected with 401 SESSION_REVOKED', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 16. TC-TENANT-16: User with role MANUFACTURER but manufacturer_id = null -> 403 MANUFACTURER_UNLINKED
        {
            // 1. Verify DB constraint chk_mfg_user_has_id blocks unlinked manufacturer at database level
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            let dbConstraintBlocked = false;
            try {
                await pool.query(`
                    INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, token_version)
                    VALUES ('usr_unlinked_mfg', 'Unlinked Mfg', 'unlinked@test.com', 'dummy', 'MANUFACTURER', NULL, true, 1)
                `);
            } catch (cErr) {
                dbConstraintBlocked = cErr.message.includes('chk_mfg_user_has_id');
            }

            // 2. Verify via Express HTTP: Real unlinked exempt account (usr_legacy_test_01) is blocked at runtime
            const legacyToken = generateToken({ id: 'usr_legacy_test_01', email: 'legacy@zarsev.com', token_version: 1 });
            const httpRes = await request('GET', '/api/quotations/rfq/rfq_dummy', {
                headers: { Authorization: `Bearer ${legacyToken}` }
            });
            // Application rejects deactivated unlinked account with 401 USER_INACTIVE
            const httpBlocked = httpRes.status === 401 && httpRes.body?.code === 'USER_INACTIVE';

            // 3. Verify actual authMiddleware function: Invoke real authMiddleware with unlinked active manufacturer (defense-in-depth)
            const { authMiddleware } = require('M:/ZZZ/src/middlewares/auth');
            const dbClient = require('M:/ZZZ/src/db/dbClient');
            const unlinkedActiveToken = generateToken({ id: 'usr_active_unlinked_test', email: 'active_unlinked@test.com', token_version: 1 });

            const origQueryOne = dbClient.queryOne;
            dbClient.queryOne = async (sql, params, opts) => {
                if (typeof sql === 'string' && sql.includes('FROM users WHERE id = ?') && params && params[0] === 'usr_active_unlinked_test') {
                    return {
                        id: 'usr_active_unlinked_test',
                        email: 'active_unlinked@test.com',
                        role: 'MANUFACTURER',
                        manufacturer_id: null,
                        is_active: true,
                        token_version: 1
                    };
                }
                return origQueryOne.call(dbClient, sql, params, opts);
            };

            let mwStatusCode = null;
            let mwResponseBody = null;
            let nextCalled = false;

            const directReq = {
                headers: { authorization: `Bearer ${unlinkedActiveToken}` },
                cookies: {}
            };
            const directRes = {
                status(code) {
                    mwStatusCode = code;
                    return this;
                },
                json(payload) {
                    mwResponseBody = payload;
                    return this;
                }
            };

            try {
                await authMiddleware(directReq, directRes, () => { nextCalled = true; });
            } finally {
                dbClient.queryOne = origQueryOne;
            }

            const directMwBlocked = mwStatusCode === 403 && mwResponseBody?.code === 'MANUFACTURER_UNLINKED' && !nextCalled;

            const ok = dbConstraintBlocked && httpBlocked && directMwBlocked;
            recordTest('TC-TENANT-16', 'Manufacturer user without manufacturer_id rejected at DB constraint and Middleware (403 MANUFACTURER_UNLINKED & 401 USER_INACTIVE)', ok ? 'PASSED' : 'FAILED', {
                dbConstraintBlocked,
                httpStatus: httpRes.status,
                httpCode: httpRes.body?.code,
                mwStatusCode,
                mwResponseBody,
                nextCalled
            });
        }

        // 14. TC-RBAC-14: SALES sub-role cannot manage team (POST /api/manufacturer/team/invite) -> 403 INSUFFICIENT_SUB_ROLE
        {
            const res = await request('POST', '/api/manufacturer/team/invite', {
                headers: { Authorization: `Bearer ${nileSalesToken}` },
                body: { email: 'test_invite@zarsev.com', sub_role: 'SALES' }
            });
            const ok = res.status === 403 && res.body?.code === 'INSUFFICIENT_SUB_ROLE';
            recordTest('TC-RBAC-14', 'SALES sub-role prevented from inviting team members (403 INSUFFICIENT_SUB_ROLE)', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 13. TC-RBAC-13: PRODUCTION sub-role cannot create quotation (POST /api/quotations) -> 403 INSUFFICIENT_SUB_ROLE
        {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            await pool.query(`
                INSERT INTO users (id, name, email, password_hash, role, sub_role, manufacturer_id, is_active, token_version)
                VALUES ('usr_delta_prod', 'Delta Production Officer', 'delta_prod@zarsev.com', 'dummy', 'MANUFACTURER', 'PRODUCTION', 'mfg_delta_iqf', true, 1)
                ON CONFLICT (id) DO NOTHING;
            `);
            const prodToken = generateToken({ id: 'usr_delta_prod', email: 'delta_prod@zarsev.com', token_version: 1 });
            const res = await request('POST', '/api/quotations', {
                headers: { Authorization: `Bearer ${prodToken}` },
                body: { rfq_id: 'rfq_dummy', unit_price: 1500, currency: 'USD' }
            });
            const ok = res.status === 403 && res.body?.code === 'INSUFFICIENT_SUB_ROLE';
            recordTest('TC-RBAC-13', 'PRODUCTION sub-role prevented from submitting quotations (403 INSUFFICIENT_SUB_ROLE)', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 15. TC-RBAC-15: EXPORT sub-role cannot change team member roles -> 403 INSUFFICIENT_SUB_ROLE
        {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            await pool.query(`
                INSERT INTO users (id, name, email, password_hash, role, sub_role, manufacturer_id, is_active, token_version)
                VALUES ('usr_delta_export', 'Delta Export Officer', 'delta_export@zarsev.com', 'dummy', 'MANUFACTURER', 'EXPORT', 'mfg_delta_iqf', true, 1)
                ON CONFLICT (id) DO NOTHING;
            `);
            const exportToken = generateToken({ id: 'usr_delta_export', email: 'delta_export@zarsev.com', token_version: 1 });
            const res = await request('PATCH', '/api/manufacturer/team/users/usr_delta_prod/role', {
                headers: { Authorization: `Bearer ${exportToken}` },
                body: { sub_role: 'SALES' }
            });
            const ok = res.status === 403 && res.body?.code === 'INSUFFICIENT_SUB_ROLE';
            recordTest('TC-RBAC-15', 'EXPORT sub-role prevented from changing member roles (403 INSUFFICIENT_SUB_ROLE)', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 20. TC-OWNER-20: Prevent deactivating or demoting the sole active OWNER
        {
            const res = await request('PATCH', '/api/manufacturer/team/users/usr_mfg_delta_iqf/status', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                body: { is_active: false }
            });
            const ok = res.status === 400 && res.body?.error?.includes('لا يمكن تجميد أو تعطيل المالك الوحيد');
            recordTest('TC-OWNER-20', 'Prevent deactivating sole active OWNER of the manufacturer', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 4. TC-CONC-04: Cannot invite an email that is already registered as an active user
        {
            const res = await request('POST', '/api/manufacturer/team/invite', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                body: { email: 'admin@zarsev.com', sub_role: 'SALES' }
            });
            const ok = res.status === 400 && res.body?.error?.includes('مسجل بالفعل');
            recordTest('TC-CONC-04', 'Inviting existing registered user email rejected', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // 19. TC-SEAT-19 & 1. TC-CONC-01: Seat quota enforcement & Concurrent invites for last seat
        {
            // Delta IQF has max_team_seats = 2 (Standard tier).
            // Currently 1 active owner (usr_mfg_delta_iqf).
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            await pool.query("DELETE FROM users WHERE id IN ('usr_delta_prod', 'usr_delta_export')");
            await pool.query("DELETE FROM manufacturer_invitations WHERE manufacturer_id = 'mfg_delta_iqf'");

            // TC-INV-EMPTY (DEF-01 verification): Verify GET /api/manufacturer/team returns empty list when no invites exist
            const emptyTeamRes = await request('GET', '/api/manufacturer/team', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` }
            });
            const emptyOk = emptyTeamRes.status === 200 &&
                            Array.isArray(emptyTeamRes.body?.invitations) &&
                            emptyTeamRes.body.invitations.length === 0 &&
                            emptyTeamRes.body?.seatStats?.pendingInvites === 0 &&
                            emptyTeamRes.body?.seatStats?.remainingSeats === 1;
            recordTest('TC-INV-EMPTY', 'GET /api/manufacturer/team returns empty invitations list and accurate seats when no invites exist', emptyOk ? 'PASSED' : 'FAILED', {
                status: emptyTeamRes.status,
                invitationsCount: emptyTeamRes.body?.invitations?.length,
                pendingInvites: emptyTeamRes.body?.seatStats?.pendingInvites
            });

            // Now Delta has exactly 1 active member (usr_mfg_delta_iqf). Exactly 1 seat remaining!
            // Fire two simultaneous invite requests for the last available seat
            const [res1, res2] = await Promise.all([
                request('POST', '/api/manufacturer/team/invite', {
                    headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                    body: { email: 'candidate1@zarsev.com', sub_role: 'SALES' }
                }),
                request('POST', '/api/manufacturer/team/invite', {
                    headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                    body: { email: 'candidate2@zarsev.com', sub_role: 'SALES' }
                })
            ]);

            console.log('TC-CONC-01 res1:', res1.status, res1.body);
            console.log('TC-CONC-01 res2:', res2.status, res2.body);
            const statuses = [res1.status, res2.status].sort();
            const oneSuccessOneQuota = statuses[0] === 201 && statuses[1] === 400;
            const quotaMsg = (res1.body?.error || res2.body?.error || '').includes('الحد الأقصى للمقاعد');

            recordTest('TC-CONC-01', 'Two concurrent invites for last available seat: Exactly 1 succeeds, 1 receives quota error', (oneSuccessOneQuota && quotaMsg) ? 'PASSED' : 'FAILED', { res1Status: res1.status, res2Status: res2.status, res1Body: res1.body, res2Body: res2.body });
            recordTest('TC-SEAT-19', 'Strict seat quota calculation (Active + Pending < Seats) enforced', (oneSuccessOneQuota && quotaMsg) ? 'PASSED' : 'FAILED', { statuses });

            // TC-INV-LIST (DEF-01 verification): Verify GET /api/manufacturer/team returns the pending invitation with invited_by_user_id alias and enforces quota
            const listTeamRes = await request('GET', '/api/manufacturer/team', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` }
            });
            const dbInvites = await pool.query("SELECT id, email, sub_role, status, invited_by FROM manufacturer_invitations WHERE manufacturer_id = 'mfg_delta_iqf' AND status = 'PENDING'");
            const listOk = listTeamRes.status === 200 &&
                           Array.isArray(listTeamRes.body?.invitations) &&
                           listTeamRes.body.invitations.length === 1 &&
                           listTeamRes.body.invitations[0].email === 'candidate1@zarsev.com' &&
                           listTeamRes.body.invitations[0].invited_by_user_id === 'usr_mfg_delta_iqf' &&
                           listTeamRes.body.invitations[0].status === 'PENDING' &&
                           listTeamRes.body?.seatStats?.pendingInvites === 1 &&
                           listTeamRes.body?.seatStats?.totalAllocated === 2 &&
                           listTeamRes.body?.seatStats?.remainingSeats === 0 &&
                           dbInvites.rows.length === 1 &&
                           dbInvites.rows[0].email === 'candidate1@zarsev.com' &&
                           dbInvites.rows[0].invited_by === 'usr_mfg_delta_iqf';

            recordTest('TC-INV-LIST', 'GET /api/manufacturer/team returns pending invitations with invited_by_user_id alias and enforces quota', listOk ? 'PASSED' : 'FAILED', {
                status: listTeamRes.status,
                invitations: listTeamRes.body?.invitations,
                seatStats: listTeamRes.body?.seatStats,
                dbRows: dbInvites.rows
            });
        }

        // 2. TC-CONC-02: Re-inviting an email whose previous invitation expired or was revoked
        {
            // Revoke the pending invite
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            let inviteRow = await pool.query("SELECT id FROM manufacturer_invitations WHERE manufacturer_id = 'mfg_delta_iqf' AND status = 'PENDING' LIMIT 1");
            if (inviteRow.rows.length === 0) {
                await pool.query("DELETE FROM manufacturer_invitations WHERE manufacturer_id = 'mfg_delta_iqf'");
                await request('POST', '/api/manufacturer/team/invite', {
                    headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                    body: { email: 'candidate1@zarsev.com', sub_role: 'SALES' }
                });
                inviteRow = await pool.query("SELECT id FROM manufacturer_invitations WHERE manufacturer_id = 'mfg_delta_iqf' AND status = 'PENDING' LIMIT 1");
            }
            const inviteId = inviteRow.rows[0].id;

            // Revoke it
            const revRes = await request('DELETE', `/api/manufacturer/team/invitations/${inviteId}`, {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` }
            });

            // Re-invite the same email
            const reRes = await request('POST', '/api/manufacturer/team/invite', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                body: { email: 'candidate1@zarsev.com', sub_role: 'SALES' }
            });

            const ok = revRes.status === 200 && reRes.status === 201;
            recordTest('TC-CONC-02', 'Re-inviting an email after previous invitation revoked succeeds', ok ? 'PASSED' : 'FAILED', { revRes: revRes.status, reRes: reRes.status });
        }

        // 3. TC-CONC-03: Replay attack on invitation acceptance (Accept twice -> 1st succeeds, 2nd rejected)
        let activeRawToken = null;
        {
            // Get raw token from the re-created invite
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            // Re-create invite cleanly
            await pool.query("DELETE FROM manufacturer_invitations WHERE manufacturer_id = 'mfg_delta_iqf'");
            const invRes = await request('POST', '/api/manufacturer/team/invite', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                body: { email: 'newmember@delta.com', sub_role: 'SALES' }
            });
            activeRawToken = invRes.body?.invitation?.rawToken;

            // Accept 1st time
            const accept1 = await request('POST', '/api/auth/invitations/accept', {
                body: { token: activeRawToken, full_name: 'Ahmed Sales', password: 'NewSecurePassword123!' }
            });

            // Accept 2nd time (Replay)
            const accept2 = await request('POST', '/api/auth/invitations/accept', {
                body: { token: activeRawToken, full_name: 'Ahmed Sales Duplicate', password: 'NewSecurePassword123!' }
            });

            const ok = accept1.status === 201 && accept2.status === 400 && accept2.body?.error?.includes('لم تعد صالحة');
            recordTest('TC-CONC-03', 'Accepting invitation twice (replay attack): 1st succeeds, 2nd rejected', ok ? 'PASSED' : 'FAILED', { accept1Status: accept1.status, accept2Status: accept2.status, accept2Error: accept2.body?.error });
        }

        // 18. TC-INV-18: Prevent accepting expired invitation (> 48 hours)
        {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            const rawTokenExp = 'expired_test_raw_token_99999999999999999999999999999999999999999999';
            const tokenHashExp = crypto.createHash('sha256').update(rawTokenExp).digest('hex');
            
            await pool.query(`
                INSERT INTO manufacturer_invitations (
                    id, manufacturer_id, email, sub_role, token_hash, invited_by, status,
                    expires_at, created_at, updated_at
                ) VALUES (
                    'inv_expired_test', 'mfg_nile_fruits', 'expired_user@nile.com', 'SALES', $1, 'usr_mfg_nile_fruits', 'PENDING',
                    CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP - INTERVAL '49 hours', CURRENT_TIMESTAMP
                );
            `, [tokenHashExp]);

            const res = await request('POST', '/api/auth/invitations/accept', {
                body: { token: rawTokenExp, full_name: 'Expired Candidate', password: 'Password123!' }
            });

            const ok = res.status === 400 && res.body?.error?.includes('انتهت صلاحية');
            recordTest('TC-INV-18', 'Attempt to accept expired invitation rejected', ok ? 'PASSED' : 'FAILED', { status: res.status, error: res.body?.error });
        }

        // 5. TC-CONC-05: Concurrent activation of two owners for the same manufacturer blocked by partial unique index
        {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            let indexRejected = false;
            try {
                await pool.query(`
                    INSERT INTO users (id, name, email, password_hash, role, sub_role, manufacturer_id, is_active, token_version)
                    VALUES ('usr_delta_second_owner', 'Second Owner', 'second_owner@delta.com', 'dummy', 'MANUFACTURER', 'OWNER', 'mfg_delta_iqf', true, 1);
                `);
            } catch (err) {
                indexRejected = err.code === '23505' && err.message.includes('uq_one_active_owner_per_mfg');
            }
            recordTest('TC-CONC-05', 'Concurrent second active OWNER blocked by PostgreSQL partial unique index', indexRejected ? 'PASSED' : 'FAILED', { indexRejected });
        }

        // 6. TC-CONC-06: Atomic ownership transfer: complete rollback on failure
        {
            // Try transfer with incorrect password
            const failRes = await request('POST', '/api/manufacturer/team/transfer-ownership', {
                headers: { Authorization: `Bearer ${deltaOwnerToken}` },
                body: {
                    target_user_id: 'usr_new_sales_candidate',
                    password: 'WrongPassword!',
                    demoted_role: 'SALES'
                }
            });

            // Verify original owner is still OWNER
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            const ownerCheck = await pool.query("SELECT sub_role FROM users WHERE id = 'usr_mfg_delta_iqf'");
            const isStillOwner = ownerCheck.rows[0]?.sub_role === 'OWNER';

            const ok = failRes.status === 400 && isStillOwner;
            recordTest('TC-CONC-06', 'Ownership transfer rolls back on failure; original owner intact', ok ? 'PASSED' : 'FAILED', { failRes: failRes.status, isStillOwner });
        }

        // 7. TC-CONC-07: Suspending manufacturer immediately blocks subsequent requests with 403 MANUFACTURER_SUSPENDED
        {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            // Suspend Nile Fruits
            await pool.query("UPDATE manufacturers SET is_active = false WHERE id = 'mfg_nile_fruits'");

            // Nile sales user attempts request
            const res = await request('GET', '/api/quotations/rfq/rfq_dummy', {
                headers: { Authorization: `Bearer ${nileSalesToken}` }
            });

            const ok = res.status === 403 && res.body?.code === 'MANUFACTURER_SUSPENDED';
            recordTest('TC-CONC-07', 'Suspending manufacturer immediately blocks active user sessions with 403 MANUFACTURER_SUSPENDED', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });

            // Restore active status
            await pool.query("UPDATE manufacturers SET is_active = true WHERE id = 'mfg_nile_fruits'");
        }

        // 8. TC-SEC-08: Cross-tenant document download attempt -> 403
        // 9. TC-SEC-09: Path traversal in documents -> rejected
        {
            const secureDocService = require('M:/ZZZ/src/services/secureDocumentService');

            // Upload a valid PDF for Delta IQF
            const pdfBuffer = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
            const doc = await secureDocService.uploadDocument({
                manufacturerId: 'mfg_delta_iqf',
                userId: 'usr_mfg_delta_iqf',
                userSubRole: 'OWNER',
                docType: 'LEGAL',
                title: 'Commercial Register 2026',
                originalName: 'commercial_register.pdf',
                mimeType: 'application/pdf',
                fileBuffer: pdfBuffer
            });

            // Bustan owner attempts to download Delta's document
            const crossTenantRes = await request('GET', `/api/manufacturer/documents/${doc.id}/download`, {
                headers: { Authorization: `Bearer ${bustanOwnerToken}` }
            });

            const crossTenantBlocked = crossTenantRes.status === 403 && crossTenantRes.body?.error?.includes('منشأة أخرى');
            recordTest('TC-SEC-08', 'Cross-tenant document download attempt blocked with 403', crossTenantBlocked ? 'PASSED' : 'FAILED', { status: crossTenantRes.status, body: crossTenantRes.body });

            // Path Traversal Test
            let traversalBlocked = false;
            try {
                secureDocService.getManufacturerStorageDir('../../etc');
            } catch (pErr) {
                traversalBlocked = pErr.message.includes('Path Traversal Detected');
            }
            recordTest('TC-SEC-09', 'Path traversal in secure document service strictly prevented', traversalBlocked ? 'PASSED' : 'FAILED', { traversalBlocked });
        }

        // 17. TC-TENANT-17: Tenant data isolation for RFQs & Quotations
        {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            await pool.query(`
                INSERT INTO products (id, manufacturer_id, name_ar, name_en, sku, status)
                VALUES ('prod_delta_iqf_1', 'mfg_delta_iqf', 'فراولة مجمدة IQF', 'Frozen Strawberry IQF', 'SKU-DELTA-01', 'PUBLISHED')
                ON CONFLICT (id) DO NOTHING;

                INSERT INTO rfqs (
                    id, reference_no, buyer_name, company_name, business_email, phone, country,
                    product_id, manufacturer_id, assigned_manufacturer_id, requested_quantity,
                    unit_of_measurement, destination_country, destination_port, status
                ) VALUES (
                    'rfq_delta_private', 'RFQ-DELTA-01', 'John Buyer', 'Acme Trading', 'john@acme.com', '+1234567890', 'US',
                    'prod_delta_iqf_1', 'mfg_delta_iqf', 'mfg_delta_iqf', 100, 'MT', 'US', 'New York', 'UNDER_REVIEW'
                );
            `);

            // Bustan Owner tries to view Delta's private RFQ quotations
            const res = await request('GET', '/api/quotations/rfq/rfq_delta_private', {
                headers: { Authorization: `Bearer ${bustanOwnerToken}` }
            });

            const ok = res.status === 403 && res.body?.error?.includes('غير مصرح');
            recordTest('TC-TENANT-17', 'Tenant isolation: Manufacturer B cannot view RFQ quotations of Manufacturer A', ok ? 'PASSED' : 'FAILED', { status: res.status, body: res.body });
        }

        // -------------------------------------------------------------
        // Step 6: Test Migration 006A Rollback Suite & Stop Conditions
        // -------------------------------------------------------------
        console.log('\n[Phase F] Testing Migration 006A Rollback & Dynamic Archive...');
        const rollbackClient = new Client({
            host: 'localhost',
            port: PORT,
            user: 'zarsev_migrator',
            password: 'bYhdH0mBrT8yLEP_3_0dXvJlS_8GNv9v',
            database: 'zarsev_test'
        });
        await rollbackClient.connect();

        // 1. Rollback Stop Condition: Should abort because an ACCEPTED invitation exists
        let rollbackStopTriggered = false;
        try {
            const rollbackSql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg/rollback/rollback_006A_revised.sql'), 'utf8');
            await rollbackClient.query(rollbackSql);
        } catch (rErr) {
            rollbackStopTriggered = rErr.message.includes('ROLLBACK_ABORTED');
        }
        recordTest('TC-MIG-ROLLBACK-01', 'Rollback Stop Condition blocks rollback when accepted invitations exist', rollbackStopTriggered ? 'PASSED' : 'FAILED', { rollbackStopTriggered });

        // 2. Clear accepted invitations and execute clean rollback with full dynamic archive
        let rollbackCleanSuccess = false;
        try {
            await rollbackClient.query("DELETE FROM manufacturer_invitations WHERE status = 'ACCEPTED'");
            const rollbackSql = fs.readFileSync(path.resolve('M:/ZZZ/src/db/migrations/pg/rollback/rollback_006A_revised.sql'), 'utf8');
            await rollbackClient.query(rollbackSql);

            // Verify archive tables exist in registry
            const archiveLog = await rollbackClient.query("SELECT * FROM _migration_archive_log WHERE migration_tag = '006A'");
            const hasArchive = archiveLog.rows.length > 0 && archiveLog.rows[0].users_archive_table.startsWith('_archive_006a_users_');
            rollbackCleanSuccess = hasArchive;
        } catch (rErr2) {
            console.error('Clean rollback error:', rErr2);
        }
        recordTest('TC-MIG-ROLLBACK-02', 'Clean rollback executes with full snapshot and registers in _migration_archive_log', rollbackCleanSuccess ? 'PASSED' : 'FAILED', { rollbackCleanSuccess });

        await rollbackClient.end();

        // Summary of results
        console.log('\n================================================================');
        console.log(' TEST EXECUTION SUMMARY');
        console.log('================================================================');
        const passedCount = results.filter(r => r.passed).length;
        const totalCount = results.length;
        console.log(`Total Tests Run: ${totalCount}`);
        console.log(`Passed: ${passedCount}`);
        console.log(`Failed: ${totalCount - passedCount}`);
        console.log(`Success Rate: ${((passedCount / totalCount) * 100).toFixed(1)}%`);

        // Write report artifact
        fs.writeFileSync(
            path.resolve('M:/ZZZ/test/manufacturer_remediation_results.json'),
            JSON.stringify({ summary: { total: totalCount, passed: passedCount, failed: totalCount - passedCount }, results }, null, 2),
            'utf8'
        );

    } catch (err) {
        console.error('\n[FATAL SUITE ERROR]:', err);
    } finally {
        // Close Express
        if (expressServer) {
            expressServer.close();
            console.log('\nExpress test server closed.');
        }

        if (migratorClient) {
            try { await migratorClient.end(); } catch (_) {}
        }
        try {
            const pool = require('M:/ZZZ/src/db/pgAdapter').getAppPool();
            await pool.end();
            console.log('App DB pool closed.');
        } catch (_) {}

        // Stop disposable postgres cluster cleanly
        try {
            console.log('Stopping disposable PostgreSQL cluster...');
            runCmd(`"${PG_BIN_DIR}/pg_ctl.exe" -D "${TEMP_DATA_DIR}" stop -m immediate`);
            console.log('Disposable PostgreSQL cluster stopped cleanly.');
        } catch (_) {}
    }
}

main();
