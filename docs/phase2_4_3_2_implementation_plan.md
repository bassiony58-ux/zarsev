# ZARSEV — Phase 2.4.3.2: Implementation Plan & Scope Definition
## Core Business & Session Routes Integration (`authRoutes.js`, `productRoutes.js`, `approvalRoutes.js`)

**Repository:** `M:\ZZZ`  
**Branch:** `feature/postgres-foundation`  
**Expected HEAD:** `377c546b608fba3c24db2718fff91732be724385`  
**Execution Timestamp:** 2026-11-02T20:32:00+02:00  

---

## 1. Scope Definition & Dependency Analysis

Following the successful completion of Phase 2.4.3.1 (Core Middleware, Leaf Routes, Manufacturer Routes), Phase 2.4.3.2 addresses the three remaining application routes governing the **User Session Lifecycle** and the **Product Catalog & Approval Lifecycle**:

1. [`src/routes/authRoutes.js`](file:///m:/ZZZ/src/routes/authRoutes.js) — Session lifecycle, production login, dev-login guard, token revocation logout, personas.
2. [`src/routes/productRoutes.js`](file:///m:/ZZZ/src/routes/productRoutes.js) — Public catalog query, status filtering, demo quarantine, product details, manufacturer tenant update.
3. [`src/routes/approvalRoutes.js`](file:///m:/ZZZ/src/routes/approvalRoutes.js) — Super Admin/Logistics approval queue, decision workflows (APPROVE/REJECT), manufacturer rejected product resubmission.

### Cross-Dialect & Tenant Isolation Matrix

| File Path | Endpoints / Operations | SQLite Behavior | PostgreSQL Behavior & Dual-Dialect Fix | Tenant & Authorization Rules |
| :--- | :--- | :--- | :--- | :--- |
| `src/routes/authRoutes.js` | `GET /me`<br>`POST /login`<br>`POST /dev-login`<br>`POST /logout`<br>`GET /personas` | `is_active = 1`, `token_version` arithmetic, synchronous DB calls. | `is_active` is boolean (`true`/`false`). Use `isEntityActive()`. Dual-dialect in `/personas`: `{ sqlite: 'WHERE u.is_active = 1', postgres: 'WHERE u.is_active = true' }`. | `/dev-login` & `/personas` 404 in production. Rate limit (5/email, 20/IP). `/logout` increments `token_version` to invalidate JWT. |
| `src/routes/productRoutes.js` | `GET /`<br>`GET /:id`<br>`PUT /:id` | `is_demo = 0`, `is_primary = 1`, `JSON.parse(specifications)`. | Dual-dialect queries for `is_demo` and `is_primary`. Safe idempotent JSON parser for `specifications`. | Public view shows `status = 'PUBLISHED'` only; demo products strictly masked. `PUT /:id` enforces `prod.manufacturer_id === req.user.manufacturer_id` (403 on IDOR). |
| `src/routes/approvalRoutes.js` | `GET /queue`<br>`POST /:productId/decide`<br>`POST /:productId/resubmit` | `is_primary = 1`, `JSON.parse(specifications)`. | Dual-dialect subquery for `is_primary`. Safe idempotent JSON parser for `specifications`. | `GET /queue` & `POST /:productId/decide` restricted to `SUPER_ADMIN` and `LOGISTICS_OFFICER` (403 for manufacturers). `POST /:productId/resubmit` enforces `prod.manufacturer_id === req.user.manufacturer_id`. |

---

## 2. Allowed Target Files

- `src/routes/authRoutes.js`
- `src/routes/productRoutes.js`
- `src/routes/approvalRoutes.js`
- `test/test_phase2_4_3_2_routes.js` (New test suite)
- `docs/phase2_4_3_2_implementation_plan.md` (This document)
- `docs/phase2_4_3_2_routes_report.md` (Completion report)

**Strictly Forbidden:**
- Modifying `dbClient.js`, `pgAdapter.js`, `pgMigrator.js`, `auth.js`, `subscriptionGuard.js`.
- Modifying import routes/services (`importRoutes.js`, `duplicateDetectionService.js`, `importJobQueue.js`).
- Modifying schema files or database migrations.

---

## 3. Test Strategy & Safety Protocol

1. **Target Test Database**: Real isolated PostgreSQL `zarsev_test` and in-memory SQLite database.
2. **Untouched Databases**: Production SQLite databases remain bit-perfect; `zarsev_dev` remains at 0 public tables.
3. **Deterministic Cleanup**: All synthetic records (`users`, `manufacturers`, `products`, `product_images`) tracked by ID and deleted in `finally`.
4. **Verification Gates**:
   - Phase 2.4.3.2 isolated suite (`node test/test_phase2_4_3_2_routes.js`).
   - P0 Security (`test_security_p0.js`).
   - Authorization (`test_authorization.js`).
   - Phase A & B & C regression suites.
   - Master test suite (`run_all_tests.js`).
