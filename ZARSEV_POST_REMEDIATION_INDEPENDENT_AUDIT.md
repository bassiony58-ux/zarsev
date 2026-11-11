# ZARSEV — Independent Post-Remediation Code Audit Report
## Phase 2: Implementation Verification, Security Hardening & Defect Closure

---

**Document ID:** `AUDIT-ZARSEV-2026-PHASE2-INDEPENDENT`  
**Audit Target Branch:** `feature/manufacturer-lifecycle-remediation`  
**Audit Head Commit:** `377c546b608fba3c24db2718fff91732be724385`  
**Execution Mode:** `STRICT READ-ONLY — FORENSIC CODE AUDIT`  
**Audit Date:** November 8, 2026 (Local Time: 01:21:00+02:00)  
**Status:** **NOT PRODUCTION READY — CONDITIONAL ACCEPTANCE PENDING DEFECT REMEDIATION**

---

## 1. Executive Summary & Audit Mandate

Following the completion of the *Autonomous Remediation Mission* which claimed **26/26 tests passing**, this independent code audit was conducted under strict forensic standards. The purpose of this audit was not to introduce new features or execute migrations, but to examine the actual code changes line-by-line, verify test execution integrity, validate security and lifecycle invariants, and assess whether the reported results represent real operational correctness rather than superficial test compliance.

### Summary of Audit Findings
1. **Core Lifecycle & Security Invariants**: Largely well-engineered and correctly implemented in runtime code. Strict JWT `token_version` checking, dynamic manufacturer suspension verification, and deny-by-default RBAC enforcement (`requireSubRole`) were verified in actual Express middleware and route layers.
2. **Defect in Team Invitations (`teamService.js:38`)**: A database column name mismatch (`invited_by_user_id` instead of `invited_by`) causes `GET /api/manufacturer/team` to throw an error in PostgreSQL. Because this error was wrapped in a silent `try/catch` block, it failed silently and always returned an empty invitations list (`invitations = []`), hiding pending invitations and corrupting frontend seat counters.
3. **Misrepresentation of Document Encryption & Malware Defense**: The document service does **not** encrypt files at rest (files are written as raw plaintext bytes to disk using `fs.writeFileSync`). Claims of "encrypted files" and "malware scanning" are inaccurate; the system relies on directory isolation and binary Magic Bytes validation only.
4. **Audit Log Immutability Gap (`TRUNCATE` Vulnerability)**: The PostgreSQL trigger `trg_prevent_mfg_audit_mutation` protects `BEFORE UPDATE OR DELETE ON manufacturer_audit_logs FOR EACH ROW`. In PostgreSQL, row-level triggers do **not** intercept `TRUNCATE`. Without a statement-level trigger or explicit privilege revocation, `zarsev_app` could purge the audit table.
5. **Test Suite Implementation Flaws**:
   - `TC-TENANT-16` used a mocked object and an inline `if` statement rather than testing `authMiddleware` via Express HTTP.
   - `TC-SEAT-19` did not run an independent scenario, piggybacking on `TC-CONC-01`.
   - `TC-CONC-05` inserted directly via SQL rather than verifying API concurrency.
   - `TC-SEC-09` called internal service methods directly rather than testing through the router.
6. **Regression Suite Discrepancies**:
   - `npm test` fails in `test_security_p0.js` when default `.env` sets `DB_ENGINE=postgres` because SQLite test fixtures are mismatched with PostgreSQL query routing.
   - When run in SQLite mode, `test_phase1_1_remediation.js` fails on legacy login because the new security rule in `authRoutes.js` rightly blocks unlinked manufacturer accounts (`role = 'MANUFACTURER'` with `manufacturer_id = NULL`), conflicting with the legacy test fixture.
7. **Rollback Backup Completeness**: `rollback_006A_revised.sql` utilizes `CREATE TABLE AS SELECT ...` which discards Primary Keys, Foreign Keys, Unique constraints, Check constraints, and Indexes.

---

## 2. Operational Constraints Verification & Zero-Mutation Integrity Proof

Under the strict mandate of this audit, zero database writes or unauthorized environment modifications occurred on real project databases.

### Cryptographic Baseline Verification
| Target Database | Expected State / Hash | Post-Audit State / Hash | Verification Status |
| :--- | :--- | :--- | :--- |
| `M:\ZZZ\zarsev.db` (SQLite) | `5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC` | `5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC` | **MATCH (100% UNTOUCHED)** |
| `zarsev.db.bak` | `77E32117AA24639364FDA5EA046149599054D4347D4D1C17E6EE9BFC917B72CD` | `77E32117AA24639364FDA5EA046149599054D4347D4D1C17E6EE9BFC917B72CD` | **MATCH (100% UNTOUCHED)** |
| `zarsev_dev` (PG:5432) | 16 Public Tables | 16 Public Tables | **MATCH (100% UNTOUCHED)** |
| `zarsev_test` (PG:5432) | 20 Public Tables (`sub_role` absent) | 20 Public Tables (`sub_role` absent) | **MATCH (100% UNTOUCHED)** |
| Account DEC-01 (`usr_mfg_delta_iqf`) | `sub_role: NULL`, `is_active: 1` | `sub_role: NULL`, `is_active: 1` | **UNMUTATED** |
| Account DEC-02 (`usr_mfg_nile_fruits`) | `sub_role: NULL`, `is_active: 1` | `sub_role: NULL`, `is_active: 1` | **UNMUTATED** |
| Account DEC-03 (`usr_legacy_test_01`) | `manufacturer_id: NULL`, `is_legacy_exempt: 0` | `manufacturer_id: NULL`, `is_legacy_exempt: 0` | **UNMUTATED** |

---

## 3. Forensic Audit of the 26 Remediation Tests

The test suite in `test/test_manufacturer_lifecycle_full_suite.js` was evaluated against an 8-point inspection checklist:
1. Calls actual application code?
2. Calls real Route vs direct Service?
3. Uses disposable PostgreSQL cluster?
4. Uses standalone SQL to simulate results?
5. Asserts HTTP status, response body, and DB state?
6. Employs real assertions vs simple console print?
7. Concurrency tests use real concurrent operations?
8. Could test pass despite application defects?

### Comprehensive 26-Test Audit Ledger

| ID | Test Name | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Auditor Assessment & Caveats |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **TC-MIG-PRE-01** | DEC-03 Gate blocks orphan | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | No | **VERIFIED**: Correctly validates migration gate rejection when DEC-03 is unresolved. |
| **TC-MIG-PROV-02** | Provisioning succeeds | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | No | **VERIFIED**: Confirms migration applies cleanly when DEC-03 is resolved. |
| **TC-MIG-10** | Finalize blocks null sub_role | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | No | **VERIFIED**: Validates DEC-01/DEC-02 gate prevents finalize until owner decides. |
| **TC-AUDIT-21** | Audit logs trigger immutability | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | **Caveat** | **PARTIALLY VERIFIED**: Tests UPDATE/DELETE on rows; omits statement TRUNCATE. |
| **TC-MIG-FIN-03** | Finalize succeeds | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | No | **VERIFIED**: Confirms finalize completes after accounts have sub-roles assigned. |
| **TC-AUTH-11** | Reject JWT missing token_version | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP request to Express, asserts HTTP 401 `TOKEN_VERSION_REQUIRED`. |
| **TC-AUTH-12** | Reject JWT stale token_version | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP request to Express, asserts HTTP 401 `SESSION_REVOKED`. |
| **TC-TENANT-16** | Unlinked manufacturer rejection | **No** | **No** | Yes | Yes | **No** | **No** | N/A | **YES** | **FAILED TEST INTEGRITY**: Middleware check was simulated with a hardcoded mock object and inline `if`; did not invoke Express router. |
| **TC-RBAC-14** | SALES blocked from invite | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP POST to `/api/manufacturer/team/invite`, asserts 403 `INSUFFICIENT_SUB_ROLE`. |
| **TC-RBAC-13** | PRODUCTION blocked quote create | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP POST to `/api/quotations`, asserts 403 `INSUFFICIENT_SUB_ROLE`. |
| **TC-RBAC-15** | EXPORT blocked role update | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP PATCH to team role endpoint, asserts 403 `INSUFFICIENT_SUB_ROLE`. |
| **TC-OWNER-20** | Prevent deactivating sole OWNER | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP PATCH, asserts HTTP 400 forbidding deactivating sole owner. |
| **TC-CONC-04** | Reject invite for existing email | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP POST, asserts HTTP 400 when inviting registered email. |
| **TC-CONC-01** | Concurrency on last seat | Yes | Route | Yes | No | Yes | Yes | **Yes** | No | **VERIFIED**: `Promise.all` issues 2 simultaneous HTTP POST requests; exactly 1 gets 201, 1 gets 400. |
| **TC-SEAT-19** | Strict seat quota calculation | Yes | Route | Yes | No | Yes | Yes | N/A | **Caveat** | **PARTIALLY VERIFIED**: Piggybacks on `TC-CONC-01` response variables instead of isolated run. |
| **TC-CONC-02** | Re-invite after revoke | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP DELETE followed by POST, asserts 201. |
| **TC-CONC-03** | Replay attack on invitation accept | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP POST to `/api/auth/accept-invitation` twice; 1st gets 200, 2nd gets 400. |
| **TC-INV-18** | Reject expired invitation | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Sets expired timestamp in DB, HTTP POST gets 400 expired error. |
| **TC-CONC-05** | Second active owner blocked | Yes | **No** | Yes | Yes | No | Yes | **No** | **Caveat** | **PARTIALLY VERIFIED**: Direct SQL insertion tests DB partial index; does not test concurrent API calls. |
| **TC-CONC-06** | Ownership transfer rollback | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Wrong password aborts transaction; original owner intact. |
| **TC-CONC-07** | Immediate suspension check | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Updates `manufacturers.is_active = false`; subsequent HTTP request gets 403 `MANUFACTURER_SUSPENDED`. |
| **TC-SEC-08** | Cross-tenant document download | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP GET for other manufacturer doc returns HTTP 403. |
| **TC-SEC-09** | Document path traversal check | Yes | **No** | Yes | No | No | Yes | N/A | **Caveat** | **PARTIALLY VERIFIED**: Tests service function directly (`../../etc`); does not test via router param. |
| **TC-TENANT-17** | Cross-tenant quotation isolation | Yes | Route | Yes | No | Yes | Yes | N/A | No | **VERIFIED**: Real HTTP GET across tenants returns HTTP 403. |
| **TC-MIG-ROLLBACK-01** | Rollback stop on accepted invite | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | No | **VERIFIED**: Asserts rollback aborts if accepted invitations exist. |
| **TC-MIG-ROLLBACK-02** | Clean rollback execution | Yes | N/A (DDL) | Yes | No | N/A | Yes | N/A | No | **VERIFIED**: Asserts rollback drops tables and logs to `_migration_archive_log`. |

---

## 4. Authentication, Authorization & RBAC Code Audit

### JWT `token_version` Enforcement
In [src/middlewares/auth.js](file:///M:/ZZZ/src/middlewares/auth.js#L93-L115):
```javascript
if (payload.token_version === undefined || payload.token_version === null) {
    return res.status(401).json({
        success: false,
        code: 'TOKEN_VERSION_REQUIRED',
        error: 'غير مصرح: رمز الجلسة يفتقر إلى إصدار التوكن الإلزامي'
    });
}
const tokenVersion = Number(payload.token_version);
if (!Number.isInteger(tokenVersion) || tokenVersion < 1) {
    return res.status(401).json({
        success: false,
        code: 'INVALID_TOKEN_VERSION',
        error: 'غير مصرح: إصدار رمز الجلسة غير صالح'
    });
}
const currentVersion = user.token_version !== undefined && user.token_version !== null ? Number(user.token_version) : 1;
if (tokenVersion !== currentVersion) {
    return res.status(401).json({
        success: false,
        code: 'SESSION_REVOKED',
        error: 'غير مصرح: تم تسجيل الخروج وإبطال جلسة هذا الرمز (Session Revoked)'
    });
}
```
**Audit Assessment**: Zero fallback to 1. Strict numeric validation. Rejects revoked tokens immediately. Bypasses are prevented.

### Dynamic Manufacturer Suspension
In [src/middlewares/auth.js](file:///M:/ZZZ/src/middlewares/auth.js#L142-L162):
On every authenticated request by a `MANUFACTURER` user, the database is queried dynamically:
```javascript
const mfg = await dbClient.queryOne('SELECT id, name_ar, is_active FROM manufacturers WHERE id = ?', [user.manufacturer_id], dbOpts);
if (!mfg) {
    return res.status(403).json({ code: 'MANUFACTURER_NOT_FOUND', error: 'غير مصرح: المنشأة غير موجودة بالنظام' });
}
if (!isEntityActive(mfg.is_active)) {
    return res.status(403).json({ code: 'MANUFACTURER_SUSPENDED', error: 'غير مصرح: تم تجميد حساب هذه المنشأة مؤقتاً' });
}
```
**Audit Assessment**: Real-time evaluation against database. Does not rely on stale token claims.

### Sensitive Route Protection Classification
All routes executing state modifications (`INSERT`, `UPDATE`, `DELETE`) were audited:

| Endpoint | Method | Required Roles / Sub-Roles | Tenant Isolation Mechanism | Protection Classification |
| :--- | :---: | :--- | :--- | :--- |
| `/api/quotations` | `POST` | `OWNER`, `SALES` | Matches `req.user.manufacturer_id === rfq.manufacturer_id` | **HIGH — STRICT RBAC & TENANT GUARD** |
| `/api/quotations/:id/status` | `PATCH` | Buyer or `SUPER_ADMIN` | Verifies buyer ownership of RFQ | **HIGH — STRICT OWNER GUARD** |
| `/api/rfqs/:id/status` | `PATCH` | `OWNER`, `SALES` | Matches `req.user.manufacturer_id === rfq.manufacturer_id` | **HIGH — STRICT TENANT GUARD** |
| `/api/imports/upload` | `POST` | `OWNER`, `PRODUCTION` | Binds upload session to `req.user.manufacturer_id` | **HIGH — RESTRICTED TO PRODUCTION** |
| `/api/imports/:id/items/:itemId` | `PUT` | `OWNER`, `PRODUCTION` | `checkImportAccess` verifies `imp.manufacturer_id` | **HIGH — STRICT ITEM TENANT GUARD** |
| `/api/imports/:id/items/:itemId` | `DELETE` | `OWNER`, `PRODUCTION` | `checkImportAccess` verifies `imp.manufacturer_id` | **HIGH — STRICT ITEM TENANT GUARD** |
| `/api/imports/:id/save-draft` | `POST` | `OWNER`, `PRODUCTION` | `checkImportAccess` verifies `imp.manufacturer_id` | **HIGH — STRICT TENANT GUARD** |
| `/api/imports/:id/submit-review` | `POST` | `OWNER`, `PRODUCTION` | `checkImportAccess` verifies `imp.manufacturer_id` | **HIGH — STRICT TENANT GUARD** |
| `/api/imports/:id/publish` | `POST` | `SUPER_ADMIN` only | Gated by `requireRole(['SUPER_ADMIN'])` | **CRITICAL — ADMIN ONLY** |
| `/api/approvals/:id/approve` | `POST` | `SUPER_ADMIN`, `LOGISTICS_OFFICER` | Gated by `requireRole` | **CRITICAL — DUAL ADMIN/LOGISTICS** |
| `/api/approvals/:id/reject` | `POST` | `SUPER_ADMIN`, `LOGISTICS_OFFICER` | Gated by `requireRole` | **CRITICAL — DUAL ADMIN/LOGISTICS** |
| `/api/manufacturer/team/invite` | `POST` | `OWNER` only | Binds invitation to `req.user.manufacturer_id` | **HIGH — OWNER ONLY** |
| `/api/manufacturer/team/invitations/:id` | `DELETE` | `OWNER` only | Verifies invitation belongs to `req.user.manufacturer_id` | **HIGH — OWNER ONLY** |
| `/api/manufacturer/team/users/:id/role` | `PATCH` | `OWNER` only | Prevents role change across tenants & sole owner demotion | **HIGH — OWNER ONLY** |
| `/api/manufacturer/team/users/:id/status`| `PATCH` | `OWNER` only | Prevents status toggle across tenants & sole owner freeze | **HIGH — OWNER ONLY** |
| `/api/manufacturer/team/transfer-ownership`| `POST` | `OWNER` only | Single ACID transaction with re-auth password validation | **CRITICAL — OWNER ONLY WITH RE-AUTH** |
| `/api/manufacturer/documents` | `POST` | `OWNER` (Legal) / `OWNER, EXPORT` (Export) | Writes to isolated mfg directory | **HIGH — SUB-ROLE RESTRICTED** |
| `/api/manufacturer/documents/:id` | `DELETE` | `OWNER` only | Verifies document belongs to manufacturer | **HIGH — OWNER ONLY** |

---

## 5. Manufacturer Account Lifecycle & Invitations Audit

### Invariant Enforcement
1. **Preventing Deactivation of Sole Active OWNER**:
   Implemented in `src/services/teamService.js:changeMemberStatus`: Queries count of other active owners. If 0, throws: `"لا يمكن تجميد أو تعطيل المالك الوحيد للمنشأة"`.
2. **Preventing Demotion of Sole Active OWNER**:
   Implemented in `src/services/teamService.js:changeMemberSubRole`: Queries count of other active owners. If 0, throws: `"لا يمكن خفض رتبة المالك الوحيد للمنشأة"`.
3. **Atomic Ownership Transfer**:
   Implemented in `src/services/teamService.js:transferOwnership`: Runs inside `dbClient.transaction`. Validates owner password with PBKDF2. Demotes old owner to `SALES` (or specified role), promotes target to `OWNER`, increments `token_version` for both accounts to revoke active sessions, and logs audit record. Rollback guaranteed on any failure.
4. **Duplicate Invitations & Replays**:
   In `src/services/invitationService.js:acceptInvitation`: Transaction verifies `status === 'PENDING'` and `expires_at > CURRENT_TIMESTAMP`. Upon completion, transitions status to `'ACCEPTED'`. Replay attempts fail immediately with HTTP 400.

### ⚠️ Discovered Defect: Column Mismatch in `teamService.js:38`
- **Location**: [src/services/teamService.js](file:///M:/ZZZ/src/services/teamService.js#L38)
- **Defective Code**:
  ```javascript
  invitations = await dbClient.queryAll(`
      SELECT id, email, sub_role, status, expires_at, created_at, invited_by_user_id
      FROM manufacturer_invitations
      WHERE manufacturer_id = ?
      ORDER BY created_at DESC
  `, [manufacturerId], dbOpts);
  ```
- **PostgreSQL Schema Definition** in `src/db/migrations/pg/006A_provisioning_revised.sql:115`:
  `invited_by VARCHAR(50) NOT NULL REFERENCES users(id)`
- **Root Cause**: The query references `invited_by_user_id`, whereas the column name in the database schema is `invited_by`.
- **Symptom & Silent Failure**: The query throws `column "invited_by_user_id" does not exist`. Because lines 43-45 wrap this query in:
  ```javascript
  catch (err) {
      invitations = [];
  }
  ```
  The error was swallowed silently.
- **Impact**: `GET /api/manufacturer/team` **never returns pending invitations** in PostgreSQL mode. In the frontend, the pending invitations table remains permanently empty ("0"), and pending invitations are omitted from the seat calculation.
- **Required Remediation**: Modify query in `src/services/teamService.js:38` to `SELECT id, email, sub_role, status, expires_at, created_at, invited_by AS invited_by_user_id`.

---

## 6. Secure Document Storage & Access Audit

### Cleartext Storage vs. Encryption Claims
- **Claim in Previous Report**: "Secure encrypted document storage at rest."
- **Actual Implementation** in [src/services/secureDocumentService.js](file:///M:/ZZZ/src/services/secureDocumentService.js#L149):
  `fs.writeFileSync(targetFilePath, fileBuffer);`
- **Audit Verdict**: **NOT ENCRYPTED AT REST**. Files are stored as raw, plaintext binary bytes on the filesystem. No AES-256-GCM, no cipher stream, and no envelope encryption is used. Files are merely segregated into subfolders by manufacturer ID with UUID filenames.

### Malware Scanning Reality
- **Claim in Previous Report**: "Malware scanning defense."
- **Actual Implementation** in [src/services/secureDocumentService.js](file:///M:/ZZZ/src/services/secureDocumentService.js#L34-L56):
  `validateMagicBytes(buffer, ext)` checks only file headers (e.g. `%PDF`, `\x89PNG`, `\xFF\xD8\xFF`).
- **Audit Verdict**: **NO MALWARE SCANNING ENGINE EXISTS**. There is no ClamAV daemon, no sandboxed detonation, and no heuristic inspection. While Magic Bytes prevent renaming `.exe` to `.pdf`, malicious PDFs with embedded JavaScript or exploits are not scanned.

### Verified Security Controls
- **Path Traversal Guard**: `getManufacturerStorageDir` sanitizes the ID (`replace(/[^a-zA-Z0-9_-]/g, '')`), rejects `..`, `/`, `\`, and asserts `mfgDir.startsWith(BASE_STORAGE_DIR)`.
- **File Size Limit**: Strictly capped at 10 MB (`MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024`).
- **Tenant Isolation**: `getDocumentForDownload` checks `doc.manufacturer_id === user.manufacturer_id`. Unauthorized cross-tenant attempts return HTTP 403.
- **Download Authentication**: No public direct URLs or static asset serving; all downloads require `authMiddleware` and are logged to `manufacturer_audit_logs`.

---

## 7. Audit Log Tamper-Resistance & PostgreSQL Trigger Audit

### Data Sanitization
In [src/services/auditLogService.js](file:///M:/ZZZ/src/services/auditLogService.js#L15-L32):
`sanitizeMetadata` recursively strips sensitive keys (`password`, `password_hash`, `token`, `raw_token`, `token_hash`, `secret`, `buyer_access_token`, `authorization`) replacing them with `[REDACTED]`.

### Immutability Trigger Implementation
In `src/db/migrations/pg/006A_provisioning_revised.sql`:
```sql
CREATE OR REPLACE FUNCTION trg_mfg_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_VIOLATION: Audit log records in manufacturer_audit_logs cannot be modified or deleted!';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_mfg_audit_mutation
    BEFORE UPDATE OR DELETE ON manufacturer_audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION trg_mfg_audit_logs_immutable();
```

### ⚠️ Discovered Security Gap: `TRUNCATE` Vulnerability
- **Root Cause**: In PostgreSQL, `FOR EACH ROW` triggers are executed only for row-level DML (`UPDATE`, `DELETE`). The `TRUNCATE` command is a table-level operation that completely bypasses `FOR EACH ROW` triggers.
- **Risk**: A compromised application database user (`zarsev_app`) with table permissions could execute `TRUNCATE manufacturer_audit_logs;`, obliterating all audit records without triggering an exception.
- **Required Remediation**:
  1. Add a statement-level trigger in PostgreSQL:
     ```sql
     DROP TRIGGER IF EXISTS trg_prevent_mfg_audit_truncate ON manufacturer_audit_logs;
     CREATE TRIGGER trg_prevent_mfg_audit_truncate
         BEFORE TRUNCATE ON manufacturer_audit_logs
         FOR EACH STATEMENT
         EXECUTE FUNCTION trg_mfg_audit_logs_immutable();
     ```
  2. Revoke `TRUNCATE` explicitly in database grants:
     ```sql
     REVOKE TRUNCATE ON manufacturer_audit_logs FROM zarsev_app;
     ```

---

## 8. Migration 006A, Finalize, and Rollback Forensic Audit

### Execution Order & Safety Gates
1. **Provisioning (`006A_provisioning_revised.sql`)**:
   - Order: Tables created, columns added, constraints enforced.
   - **DEC-03 Gate**: Halts if orphan account `usr_legacy_test_01` has `is_legacy_exempt = false`.
   - **Check Constraint**: `chk_users_legacy_exempt` strictly restricts `is_legacy_exempt = true` to `id = 'usr_legacy_test_01'`.
   - **Check Constraint**: `chk_mfg_user_has_id` enforces `manufacturer_id NOT NULL` for all `MANUFACTURER` accounts unless exempted under DEC-03.
   - **Partial Unique Index**: `uq_one_active_owner_per_mfg` on `users (manufacturer_id) WHERE role = 'MANUFACTURER' AND sub_role = 'OWNER' AND is_active = true`.
2. **Finalize (`006A_finalize_revised.sql`)**:
   - **DEC-01 / DEC-02 Gate**: Halts if any active manufacturer account has `sub_role IS NULL`.
   - **Owner Invariant Gate**: Halts if any active manufacturer lacks an active `OWNER`.
   - Does **not** make automatic assumptions; forces explicit owner resolution.
3. **Rollback (`rollback_006A_revised.sql`)**:
   - **Stop Condition**: Halts with `ROLLBACK_STOP_CONDITION_ACCEPTED_INVITATIONS` if accepted team invitations exist.
   - **Archive Protocol**: Backs up data to `_archive_mfg_*` tables and records event in `_migration_archive_log`.

### ⚠️ Backup Incompleteness in Rollback Script
- **Limitation**: The rollback script creates archives using:
  ```sql
  CREATE TABLE _archive_mfg_invitations_... AS SELECT * FROM manufacturer_invitations;
  ```
- **Forensic Assessment**: As specified in the audit instructions, `CREATE TABLE AS SELECT` (CTAS) is **not a complete backup**. It preserves raw table data, but completely strips:
  - Primary Key constraints.
  - Foreign Key constraints.
  - Unique constraints.
  - Check constraints.
  - Indexes.
  - Column Default values.
- **Recommendation**: Document clearly in the runbook that restoring from `_archive_*` tables requires re-running DDL migrations to rebuild structural constraints.

---

## 9. Frontend & Integration Audit (`public/views/portal-manufacturer.html`)

### API Binding & Error Handling
- **Authentication Handshake**: `checkMfgAuth()` queries `/api/auth/me`. If unauthenticated or role is unauthorized, redirects to `/?auth_required=mfg`.
- **HTTP Error Processing**: `zarsevFetch` in `public/js/common.js` parses JSON error responses and throws `new Error(data.error)`. The UI catches these errors and renders user-facing Arabic toasts (`showToast`).
- **Interactive Controls Verified**:
  - Invite Team Member modal -> `POST /api/manufacturer/team/invite`
  - Revoke Invitation button -> `DELETE /api/manufacturer/team/invitations/:id`
  - Change Sub-role modal -> `PATCH /api/manufacturer/team/users/:id/role`
  - Deactivate/Activate User button -> `PATCH /api/manufacturer/team/users/:id/status`
  - Transfer Ownership modal -> `POST /api/manufacturer/team/transfer-ownership`
  - Upload Document modal -> `POST /api/manufacturer/documents`
  - Download Document link -> `/api/manufacturer/documents/:id/download`
  - Quotation Response modal -> `POST /api/quotations`

### Impact of Swallowed Error on Frontend
Due to the column name bug in `teamService.js:38`, `res.invitations` was always returned as `[]`. Consequently:
- `mfg-invites-count` displayed `0`.
- The pending invitations table displayed "لا توجد دعوات معلقة حالياً" even when active invitations were pending.
- Remaining seat progress bar calculation was skewed because pending invitations were not added to `used` seats.

---

## 10. Regression Testing Audit

### Full Test Suite Execution Summary
The legacy and regression test suites were executed under controlled test isolation:

```
Baseline DB Hash: 5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC (Unchanged)
```

| Test Suite | File | Result | Exit Code | Notes |
| :--- | :--- | :---: | :---: | :--- |
| **Isolation Guard** | `test/test_isolation_guard.js` | **PASSED (10/10)** | 0 | Test isolation and path safety verified. |
| **Extraction** | `test/test_extraction.js` | **PASSED (6/6)** | 0 | Excel, CSV, Image clustering verified. |
| **Manufacturer Assignment** | `test/test_manufacturer_assignment.js`| **PASSED (6/6)** | 0 | Direct contract & marketing model verified. |
| **Authorization** | `test/test_authorization.js` | **PASSED (4/4)** | 0 | RBAC & subscription limits verified. |
| **Duplicate Detection** | `test/test_duplicate_detection.js` | **PASSED (5/5)** | 0 | SKU, Name, Image hash collision verified. |
| **Approval Workflow** | `test/test_approval_workflow.js` | **PASSED (4/4)** | 0 | Review, reject, resubmit, approve verified. |
| **End-to-End Flow** | `test/e2e_flow_verification.js` | **PASSED (7/7)** | 0 | Full lifecycle from upload to publish verified. |
| **Security P0** | `test/test_security_p0.js` | **PASSED (12/12)** | 0 | Passed 100% when run with `DB_ENGINE=sqlite`. |
| **Milestone 2.1 Migrations**| `test/test_migrations.js` | **PASSED (15/15)** | 0 | Backup parity, crash recovery, WAL verified. |
| **Phase 1.1 Remediation** | `test/test_phase1_1_remediation.js` | **FAILED (Suite 3)**| 1 | Regression conflict on unlinked legacy fixture. |

### Regression Failure Analysis
1. **`test_security_p0.js` Failure in Mixed Environment**:
   - *Cause*: `run_all_tests.js` loads `.env` where `DB_ENGINE=postgres`. `test_helper.js` sets up isolated SQLite files, but `dbClient` routed queries to PostgreSQL `zarsev_test`.
   - *Fix*: `setupTestEnvironment` in `test_helper.js` must explicitly declare `process.env.DB_ENGINE = 'sqlite'`.
2. **`test_phase1_1_remediation.js` Failure on Test Suite 3**:
   - *Error*: `AssertionError [ERR_ASSERTION]: Legacy user login must succeed (actual: 403, expected: 200)`.
   - *Root Cause*: The test fixture inserted `usr_legacy_test_01` with `role = 'MANUFACTURER'` and `manufacturer_id = NULL`. The new hardened login logic in `src/routes/authRoutes.js:134` correctly detects that an unlinked manufacturer account is attempting to log in and returns `HTTP 403 { code: 'MANUFACTURER_UNLINKED' }`.
   - *Auditor Assessment*: The application behavior is secure and correct. The legacy test fixture was written prior to the mandatory `manufacturer_id` invariant and must be updated to assign a valid `manufacturer_id` (or use a `BUYER` role for testing password re-hashing).

---

## 11. Git & Environment Repository Audit

### Repository Status
```bash
$ git status
On branch feature/manufacturer-lifecycle-remediation
Changes not staged for commit:
  modified:   .gitignore
  modified:   package.json
  modified:   public/js/common.js
  modified:   public/views/review.html
  modified:   public/views/portal-manufacturer.html
  modified:   src/app.js
  modified:   src/db/database.js
  modified:   src/middlewares/auth.js
  modified:   src/routes/approvalRoutes.js
  modified:   src/routes/authRoutes.js
  modified:   src/routes/importRoutes.js
  modified:   src/routes/manufacturerRoutes.js
  modified:   src/routes/quotationRoutes.js
  modified:   src/routes/rfqRoutes.js
  modified:   src/services/teamService.js
  modified:   src/services/invitationService.js
  modified:   src/services/secureDocumentService.js
  modified:   src/services/auditLogService.js
  ... (46 files modified)
```

### Untracked Files Inventory
- `src/config/manufacturerPermissions.js`
- `src/db/migrations/pg/006A_provisioning_revised.sql`
- `src/db/migrations/pg/006A_finalize_revised.sql`
- `src/db/migrations/pg/rollback_006A_revised.sql`
- `test/test_manufacturer_lifecycle_full_suite.js`
- `test/manufacturer_remediation_results.json`
- `ZARSEV_AUTONOMOUS_REMEDIATION_FINAL_REPORT.md`

### Secret Scanning & Hygiene
- No passwords, API keys, or private certificates are staged or committed.
- `.env` remains in `.gitignore`.
- Head commit remains: `377c546b608fba3c24db2718fff91732be724385`.
- **Zero Git Commit / Push Operations Were Executed During This Audit.**

---

## 12. Comprehensive Claims Verification Matrix

| Claim from Previous Report | Independent Code Evidence | Test Verification Proof | Audit Verdict |
| :--- | :--- | :--- | :---: |
| **1. 26/26 Tests Passed** | `test/test_manufacturer_lifecycle_full_suite.js` | Exit code 0 on port 5433 | **PARTIALLY VERIFIED**<br>*(Exit code 0, but 4 tests contained mocks or piggybacking)* |
| **2. Mandatory `token_version`** | `src/middlewares/auth.js:93-115` | `TC-AUTH-11`, `TC-AUTH-12` | **VERIFIED** |
| **3. Dynamic Suspension Check** | `src/middlewares/auth.js:142-160` | `TC-CONC-07` | **VERIFIED** |
| **4. Sub-role RBAC Enforcement** | `src/middlewares/auth.js:requireSubRole` | `TC-RBAC-13`, `14`, `15` | **VERIFIED** |
| **5. Sole Active Owner Protection**| `src/services/teamService.js:77, 128` | `TC-OWNER-20`, `TC-CONC-06` | **VERIFIED** |
| **6. Atomic Ownership Transfer** | `src/services/teamService.js:transferOwnership` | `TC-CONC-06` | **VERIFIED** |
| **7. Replay-Proof Invitations** | `src/services/invitationService.js:acceptInvitation`| `TC-CONC-03`, `TC-INV-18` | **VERIFIED** |
| **8. Seat Limit Race Defense** | `src/services/invitationService.js:createInvitation`| `TC-CONC-01` (`Promise.all`) | **VERIFIED** |
| **9. Database Unique Owner Guard**| `uq_one_active_owner_per_mfg` in 006A | `TC-CONC-05` | **VERIFIED** |
| **10. Team Invitations Listing** | `src/services/teamService.js:38` | Column mismatch query failure | **FAILED**<br>*(Swallowed SQL error in teamService)* |
| **11. Document Encryption at Rest** | `src/services/secureDocumentService.js:149` | `fs.writeFileSync` (plaintext) | **FAILED**<br>*(Stored in plaintext, not encrypted)* |
| **12. Malware Scanning Defense** | `src/services/secureDocumentService.js:34` | Magic bytes check only | **FAILED**<br>*(Header check only, no scanner engine)* |
| **13. Audit Log Immutability** | `trg_prevent_mfg_audit_mutation` in 006A | `TC-AUDIT-21` (row-level only) | **PARTIALLY VERIFIED**<br>*(UPDATE/DELETE blocked; TRUNCATE open)* |
| **14. Migration Safety Gates** | `006A_provisioning_revised.sql:38, 10` | `TC-MIG-PRE-01`, `TC-MIG-10` | **VERIFIED** |
| **15. Rollback Reversibility** | `rollback_006A_revised.sql` | `TC-MIG-ROLLBACK-01`, `02` | **PARTIALLY VERIFIED**<br>*(Stop condition works; CTAS strips constraints)* |
| **16. System Production Ready** | Pending owner decisions DEC-01/02/03 | Unresolved business gates | **NOT TESTED / BLOCKED** |

---

## 13. Defect Ledger & Detailed Remediation Roadmap

The audit identified **5 concrete defects and architectural gaps**. The table below details their root cause, risk severity, and remediation requirements:

| Defect ID | Description | Severity | Layer | Root Cause | Remediation Action | Required Decision / Approval |
| :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| **DEF-01** | Column mismatch in `teamService.js:38` (`invited_by_user_id`) | **HIGH** | Code | Schema column is named `invited_by`. Swallowed error causes empty invitation list in UI. | Update query in `teamService.js:38` to `SELECT ..., invited_by AS invited_by_user_id`. | Technical Fix (Ready) |
| **DEF-02** | Audit log `TRUNCATE` vulnerability | **HIGH** | Migration / DB | PostgreSQL row-level triggers do not fire on `TRUNCATE`. Table can be wiped by `zarsev_app`. | Add statement-level trigger `BEFORE TRUNCATE` in 006A and revoke TRUNCATE privilege. | Technical Fix (Ready) |
| **DEF-03** | Test suite mock in `TC-TENANT-16` | **MEDIUM** | Test | Test developer simulated middleware with inline `if` instead of invoking `authMiddleware`. | Update `TC-TENANT-16` to pass mock request to actual `authMiddleware(req, res, next)`. | Technical Fix (Ready) |
| **DEF-04** | Regression failure on legacy unlinked login | **MEDIUM** | Test Fixture | Phase 1.1 test fixture created orphan manufacturer account, violating new security rules. | Update fixture in `test_phase1_1_remediation.js` to assign a valid `manufacturer_id` or use BUYER role. | Technical Fix (Ready) |
| **DEF-05** | CTAS backup constraint loss during Rollback | **LOW** | Migration | `CREATE TABLE AS SELECT` strips PKs, FKs, Unique constraints, and Indexes. | Enhance rollback runbook documenting schema reconstruction procedure. | Architectural Note |

---

## 14. Final Auditor Certification & Production Gate Verdict

### Final Verdict: **CONDITIONAL ACCEPTANCE — NOT PRODUCTION READY**

1. **Why the System Cannot Be Certified as "Production Ready"**:
   - **Unresolved Business Decisions**: Decisions DEC-01 (`usr_mfg_delta_iqf`), DEC-02 (`usr_mfg_nile_fruits`), and DEC-03 (`usr_legacy_test_01`) remain pending explicit approval by the project owner. Migration 006A intentionally halts if these decisions are not resolved.
   - **Active Functional Defects**: The team invitations query bug (DEF-01) and audit log truncate gap (DEF-02) must be closed in code and migration scripts.
   - **Unapplied Migration**: Migration 006A has not been applied to production databases.
2. **Next Steps for Project Owner**:
   - Review and sign off on decisions DEC-01, DEC-02, and DEC-03.
   - Authorize applying the fixes for DEF-01 and DEF-02 on the feature branch.
   - Re-run the full 26-test verification suite and legacy regression suite.
   - Schedule controlled execution of Migration 006A under the verified maintenance window.

---
*Report certified by Independent Code Auditor on November 8, 2026.*
