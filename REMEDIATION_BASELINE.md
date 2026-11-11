# ZARSEV — Remediation Baseline Document
**Document ID:** `ZARSEV-DOC-17-REMEDIATION-BASELINE`  
**Date:** 2026-11-08  
**Branch:** `feature/manufacturer-lifecycle-remediation`  
**Execution Mode:** AUTONOMOUS REMEDIATION — CONTROLLED EXECUTION  

---

## 1. Executive Summary & Audit Baseline

This document records the exact, forensic initial state of the codebase and database schema before applying the autonomous remediation for the **Manufacturer Account Lifecycle, Security & Architecture Closure**.

### Environment Boundaries & Baseline Integrity:
- **SQLite Database (`M:\ZZZ\zarsev.db`):** STRICT READ-ONLY. SHA-256: `5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC`.
- **PostgreSQL Database (`zarsev_dev`):** STRICT READ-ONLY. 16 tables. Untouched.
- **PostgreSQL Database (`zarsev_test`):** STRICT READ-ONLY. 20 tables. Untouched.
- **Testing Approach:** All schema testing, migration validation, concurrency runs, and destructive/mutating tests will be executed against a temporary disposable PostgreSQL database (`zarsev_disposable_test`) to ensure 0% risk of data loss or schema pollution on existing test/dev environments.

---

## 2. File Hashes Baseline (Pre-Remediation)

| File | SHA-256 Hash | Status / Action |
|:---|:---|:---|
| `zarsev.db` | `5D4A93343B61F82EDA558CF0B5310E6CEC84F819CBA22BFFF65F78813C3E7CFC` | STRICT READ-ONLY |
| `src/middlewares/auth.js` | `A0878581F7635170683A69EA59CCF5F2D212078C1D21D9D0B283D658F551C3DD` | To Remediate (Auth, Version, Suspension, Sub-roles) |
| `src/utils/authUtils.js` | `89C04C2665D832496D7DB0B1D1E8D38883BBE08F15BC48550427BB613724F4DC` | Verified (PBKDF2-HMAC-SHA512 210,000 iterations) |
| `src/routes/authRoutes.js` | `72514603B62E2053EAE4201C0AF99C96C2B1C826FA96AA94524C817E85ECB050` | To Remediate (Login claims & Invitations) |
| `src/routes/quotationRoutes.js` | `235758FBCBF188A8C43680C61F470B19ED8CB6279997CF68BF685A228AF245D9` | To Remediate (RBAC sub-role enforcement) |
| `src/routes/rfqRoutes.js` | `25835BB494DBE38879B97B45C3DEF616403A9F7C69385C46B2144B279F5E3F14` | To Remediate (RBAC sub-role enforcement) |
| `src/routes/importRoutes.js` | `874E494CD46A18D450F6F7F9BC5C89C4F933DB3572E763E2BCC128E7F93CEA65` | To Remediate (RBAC sub-role enforcement) |
| `src/routes/manufacturerRoutes.js` | `0BB8B3010509B23C71E34AAB59723937F396459C030D7A8EF878FB60271AE1DC` | To Remediate (Team, invitations, docs, transfer) |

*Backups stored in: `M:\ZZZ\.backups/remediation_baseline/`*

---

## 3. Forensic Code Analysis: Existing, Broken, and Missing

### A. Existing Components (Verified Working)
1. **Password Hashing (`src/utils/authUtils.js`):**
   - PBKDF2-HMAC-SHA512 with 210,000 iterations, 32-byte salt, 64-byte key.
   - Dual-mode verification supporting both new and legacy formats.
2. **Tenant Scoping for RFQ & Catalog (`src/routes/rfqRoutes.js`, `src/routes/productRoutes.js`):**
   - Read-isolation based on `req.user.manufacturer_id` is present for basic listing.
3. **Database Adapter (`src/db/pgAdapter.js`):**
   - Clean connection pooling with configurable database targets (`dbNameOverride`).

### B. Broken Components (Critical Defects)
1. **Token Version Fallback Bypass (`src/middlewares/auth.js:94-96`):**
   - Current line: `const tokenVersion = payload.token_version !== undefined && payload.token_version !== null ? Number(payload.token_version) : 1;`
   - **Defect:** Allows legacy JWTs or tokens stripped of the claim to pass through as version `1`.
2. **Missing Manufacturer Suspension Enforcement (`src/middlewares/auth.js:106-125`):**
   - Current code fetches `manufacturers` record but never evaluates `is_active`.
   - **Defect:** Users belonging to a suspended manufacturer continue to execute all protected operations.
3. **Overly Broad RBAC on Quotation Creation (`src/routes/quotationRoutes.js:100`):**
   - Uses `requireRole(['MANUFACTURER', 'SUPER_ADMIN', 'LOGISTICS_OFFICER'])`.
   - **Defect:** Any manufacturer account, including `PRODUCTION` or `EXPORT`, can create binding commercial quotations.
4. **Unprotected RFQ Status Mutations (`src/routes/rfqRoutes.js:578`):**
   - `PATCH /api/rfq/:id/status` has no sub-role check.

### C. Missing Components (Design Only in Prior Phases)
1. **`requireSubRole` Middleware:** Missing completely from `src/middlewares/auth.js`.
2. **Central Permissions Matrix (`src/config/manufacturerPermissions.js`):** Missing.
3. **Team Management Endpoints (`/api/manufacturer/team/*`):** Missing.
4. **Invitation Lifecycle Service & Endpoints (`/api/auth/invitations/*`):** Missing.
5. **Ownership Transfer Protocol (`POST /api/manufacturer/team/transfer-ownership`):** Missing.
6. **Secure Document Management (`src/services/secureDocumentService.js`):** Missing.
7. **Manufacturer Audit Logging (`src/services/auditLogService.js`):** Missing.
8. **UI Team & Document Components in `public/views/portal-manufacturer.html`:** Missing.

---

## 4. Categorization of Fixes & Blockers

### A. What Can Be Remediated Immediately in Code (No Schema Mutation on Live DBs)
- Implementing `requireSubRole` in `src/middlewares/auth.js`.
- Fixing JWT `token_version` validation to strictly require a numeric claim.
- Adding unified manufacturer suspension check in `auth.js` (fail-closed if `is_active === false`).
- Creating `src/config/manufacturerPermissions.js`.
- Applying RBAC checks on `quotationRoutes.js`, `rfqRoutes.js`, `importRoutes.js`.
- Building `invitationService.js`, `teamRoutes`, `secureDocumentService.js`, and `auditLogService.js`.
- Adding UI components in `portal-manufacturer.html`.
- Creating the automated test suite (`test/manufacturer_lifecycle_remediation.test.js`).

### B. What Requires Migrations (Prepared for Disposable DB Execution)
- New columns: `users.sub_role`, `manufacturers.max_team_seats`.
- New tables: `manufacturer_invitations`, `manufacturer_documents`, `manufacturer_audit_logs`.
- Partial unique indexes: `uq_one_active_owner_per_mfg`.
- Strict PostgreSQL constraints: `chk_users_sub_role`, `chk_users_legacy_exempt`.
- Audit log immutability triggers and permission revocation.

### C. Administrative Decisions (DEC-01, DEC-02, DEC-03)
- **DEC-01 (`usr_mfg_delta_iqf`):** Sole user for Delta IQF. Remains strictly pending owner decision. Code will treat users without a sub-role as deny-by-default (`INSUFFICIENT_SUB_ROLE`).
- **DEC-02 (`usr_mfg_nile_fruits`):** Sole user for Nile Fruits. Remains strictly pending owner decision. Deny-by-default applied.
- **DEC-03 (`usr_legacy_test_01`):** Active orphan user. Remains untouched in existing databases. Migrations designed to handle legacy exempt status via dedicated SQL condition.

---

## 5. Remediation Roadmap

1. **Phase 2:** Remediate `auth.js` and `authRoutes.js` (Token version + Suspension + `requireSubRole`).
2. **Phase 3:** Create `src/config/manufacturerPermissions.js` and apply sub-role guards across all routes.
3. **Phase 4:** Build Invitation and Team Management backend (`invitationService.js`, team endpoints).
4. **Phase 5:** Build Single Active Owner concurrency protection and atomic ownership transfer.
5. **Phase 6:** Build Seat Quota calculation with row-locking serialization.
6. **Phase 7:** Build Secure Document Storage (`secureDocumentService.js`) with magic bytes & path traversal guards.
7. **Phase 8:** Build Audit Logging (`auditLogService.js`) with immutable database triggers.
8. **Phase 9:** Prepare Migration Scripts (`006A_provisioning_revised.sql`, `006A_finalize_revised.sql`, `006A_rollback_revised.sql`).
9. **Phase 10:** Set up disposable PostgreSQL test instance and run all 20 required automated tests.
10. **Phase 11:** Integrate Frontend Portal UI components (`portal-manufacturer.html`).
11. **Phase 12:** Produce Final Verification Report (`ZARSEV_AUTONOMOUS_REMEDIATION_FINAL_REPORT.md`).
