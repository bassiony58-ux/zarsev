# ZARSEV — Phase 2.4.3.1-B Independent Code Audit & Phase 2.4.3.1-C Readiness Proposal

**Repository:** `M:\ZZZ`  
**Branch:** `feature/postgres-foundation`  
**Baseline Git HEAD:** `377c546b608fba3c24db2718fff91732be724385`  
**Audit Date:** 2026-11-02  
**Audit Scope:** Read-Only Verification of Phase 2.4.3.1-B & Implementation Planning for Phase 2.4.3.1-C

---

# Part A — READ-ONLY Independent Code Audit

## 1. Executive Summary & Verification Methodology

A comprehensive, strictly read-only code audit was conducted on the source and test files modified in Phase 2.4.3.1-B:
- `src/routes/categoryRoutes.js`
- `src/routes/subscriptionRoutes.js`
- `test/test_phase2_4_3_1_b_routes.js`

Every finding has been evaluated and classified under the standard severity scheme:
- **PASS**: Meets all architectural, functional, security, and type safety requirements.
- **PASS WITH NOTE**: Functionally correct and safe; includes an architectural observation or defensive recommendation.
- **NEEDS REVIEW**: Requires consideration prior to production deployment.
- **BLOCKER**: Prevents approval or exposes data integrity / security risks.

### Summary Table of Findings

| ID | Category | Item Audited | Classification | Summary |
| :--- | :--- | :--- | :--- | :--- |
| **F-01** | Category Routes | Multi-Level Tree Assembly | **PASS** | Recursive $O(N)$ tree builder handles roots, children, and grandchildren without $N+1$ queries. |
| **F-02** | Category Routes | Orphan Category Handling | **PASS WITH NOTE** | Orphaned nodes excluded from root tree and safely retained in `flat` array for admin visibility. |
| **F-03** | Category Routes | Infinite Recursion & Cycles | **PASS WITH NOTE** | Traversal starts from roots; DAG acyclicity is maintained by schema. Defensively recommend visited set. |
| **F-04** | Category Routes | Alphabetical Sorting | **PASS** | `ORDER BY name_ar ASC` preserved at SQL level; array ordering preserved through map. |
| **F-05** | Category Routes | Frontend Compatibility | **PASS** | Response schema `{ success: true, categories: [...], flat: [...] }` 100% compatible with frontend views. |
| **F-06** | Subscription Routes | RBAC & Authorization | **PASS** | Public unauthenticated GET; strict `SUPER_ADMIN` requirement on PUT with 401/403 rejection. |
| **F-07** | Subscription Routes | Pre-Update Existence Check | **PASS** | Non-existent plan returns HTTP 404 before opening transaction. |
| **F-08** | Subscription Routes | Payload Validation & Injection | **PASS** | Rejects negative quotas and malformed types with HTTP 400; static SQL prevents parameter injection. |
| **F-09** | Subscription Routes | Cross-Engine Booleans | **PASS** | Parameters normalized to integer/boolean representations compatible with SQLite and PostgreSQL. |
| **F-10** | Subscription Routes | JSON/JSONB Normalization | **PASS** | `parseAllowedFormats` normalizes SQLite text and PostgreSQL pre-parsed Array idempotently. |
| **F-11** | Subscription Routes | Transaction Atomicity | **PASS** | UPDATE and subsequent SELECT enclosed within `dbClient.transaction` with automatic rollback on failure. |
| **F-12** | Subscription Routes | Immutable Field Protection | **PASS** | Sensitive columns (`id`, `name`, `created_at`) cannot be modified via PUT endpoint. |
| **F-13** | Test Quality | Failure History Investigation | **PASS WITH NOTE** | All 5 initial test execution failures diagnosed, documented, and properly addressed. |
| **F-14** | Test Quality | Assertion Rigor | **PASS** | No assertions weakened; all 16 test cases assert exact HTTP codes and response payloads. |
| **F-15** | Test Quality | Deterministic Cleanup | **PASS** | Synthetic fixtures tracked and deleted in reverse dependency order in `finally` blocks. |
| **F-16** | Data Integrity | Baseline Immutability | **PASS** | Bit-perfect SHA256 hashes on all SQLite files; exactly 342 records retained in `zarsev_test`. |

---

## 2. Detailed Audit Findings

### 2.1 Category Hierarchy (`src/routes/categoryRoutes.js`)

#### F-01: Multi-Level Tree Assembly — [PASS]
- **Inspection:** In `buildCategoryHierarchy(roots, nonRoots)`, child categories are indexed into `childrenByParent = new Map()` in a single $O(N)$ pass. `attachChildren(node)` queries `childrenByParent.get(node.id)` and maps each child recursively.
- **Verification:** Evaluated against 1-level, 2-level (parent $\rightarrow$ child), and 3-level (root $\rightarrow$ subcategory $\rightarrow$ grandchild) fixtures. Node subtrees are correctly nested without additional database queries.

#### F-02: Orphan Category Handling — [PASS WITH NOTE]
- **Inspection:** An orphaned category is defined as having `parent_id IS NOT NULL` where `parent_id` does not match any valid category `id`.
  - In `buildCategoryHierarchy`, tree traversal begins strictly from `roots` (`WHERE parent_id IS NULL`). Because no root references the orphaned parent ID, the orphan node is never attached to any root branch in `tree`.
  - In the HTTP response: `categories: tree` cleanly excludes the orphan, avoiding null-pointer rendering errors on public trees.
  - In `flat: [...categories, ...subcategories]`, the orphan is retained because it was returned by `WHERE parent_id IS NOT NULL`.
- **Note:** This behavior is optimal: public visitors see clean trees, while administrative dropdowns (e.g. `public/views/bulk-edit.html`) that iterate over `flat` can still see and reassign orphaned records.

#### F-03: Cycle Detection & Infinite Recursion Risk — [PASS WITH NOTE]
- **Inspection:** Does `attachChildren` risk infinite recursion if cyclical data exists (e.g., $A \rightarrow B \rightarrow A$)?
  - In `zarsev_test` and PostgreSQL migrations, `categories_parent_id_fkey` enforces referential integrity.
  - Traversal starts strictly from roots (`parent_id IS NULL`). Disconnected cyclical components are never entered.
  - However, if a child category in SQLite is manually updated to point back to an ancestor, `attachChildren` could encounter a call-stack overflow (`RangeError: Maximum call stack size exceeded`).
- **Recommendation:** While the current production schema and seed data are strictly acyclic, adding a `visitedSet = new Set()` check inside `attachChildren` is recommended for defense-in-depth during future DDL hardening.

#### F-04: Alphabetical Ordering at Every Level — [PASS]
- **Inspection:** Roots are queried with `SELECT * FROM categories WHERE parent_id IS NULL ORDER BY name_ar ASC`. Non-roots are queried with `SELECT * FROM categories WHERE parent_id IS NOT NULL ORDER BY name_ar ASC`.
- **Verification:** Map insertion preserves query order. `directChildren.map(...)` iterates in FIFO order. Ordering is stable and alphabetical across all levels in both SQLite and PostgreSQL.

#### F-05: Frontend Consumer Compatibility — [PASS]
- **Inspection:** Inspected `public/views/bulk-edit.html` (line 172: `cats.flat.forEach(...)`) and `public/views/review.html` (line 187: `categoriesData = cats.flat;`).
- **Verification:** Frontend views exclusively consume `response.flat`. Leaf categories now returning `subcategories: []` instead of `undefined` does not disrupt any frontend consumer.

---

### 2.2 Subscription Routes (`src/routes/subscriptionRoutes.js`)

#### F-06: RBAC & Authorization Enforcement — [PASS]
- **Inspection:**
  - `GET /plans`: Unauthenticated public read. Accessible to anonymous, manufacturer, and admin callers.
  - `PUT /plans/:id`: Protected by `authMiddleware, requireRole(['SUPER_ADMIN'])`.
- **Verification:** Tested in `test/test_phase2_4_3_1_b_routes.js`:
  - Anonymous caller $\rightarrow$ HTTP 401 (`غير مصرح: يلزم تسجيل الدخول...`).
  - Manufacturer caller $\rightarrow$ HTTP 403 (`غير مسموح: ليس لديك الصلاحية...`).
  - Super Admin $\rightarrow$ HTTP 200.

#### F-07: Pre-Update Existence Check — [PASS]
- **Inspection:** Lines 102-108 execute `plan = await dbClient.queryOne('SELECT * FROM subscriptions WHERE id = ?', [id], dbOpts);` before opening a transaction.
- **Verification:** A non-existent ID immediately returns HTTP 404 (`باقة الاشتراك غير موجودة`) without opening an unnecessary transaction or acquiring database write locks.

#### F-08: Payload Validation & Injection Resistance — [PASS]
- **Inspection:** `validatePlanUpdatePayload` strictly checks:
  - Body must be a non-null, non-array object.
  - `allowed_formats` must be an array of non-empty strings.
  - `max_products_per_import` must be a non-negative number.
  - `max_monthly_imports` must be a non-negative number.
  - `max_file_size_mb` must be a number $> 0$.
- **Verification:** Rejects malformed payloads with HTTP 400. The UPDATE query uses an explicit, fixed column list (`SET allowed_formats = ?, max_products_per_import = ? ...`), preventing property-injection attacks.

#### F-09: Cross-Engine Boolean Conversion — [PASS]
- **Inspection:** Boolean values for `ai_extraction_enabled` and `bulk_import_enabled` are converted via `val ? 1 : 0`.
- **Verification:**
  - SQLite: `node:sqlite` binds integer `1`/`0` (avoids `ERR_INVALID_ARG_TYPE`).
  - PostgreSQL: `pg` passes integer `1`/`0`, which PostgreSQL coerces to `BOOLEAN`.
  - On retrieval, SQLite returns integer `1`/`0`, PostgreSQL returns native `boolean`.

#### F-10: JSON/JSONB Normalization — [PASS]
- **Inspection:** `parseAllowedFormats(raw)` checks `Array.isArray(raw)`. If already an Array (as returned by PostgreSQL for `JSONB`), it is returned directly. If a string (as returned by SQLite), it parses via `JSON.parse()`.
- **Verification:** Eliminates `SyntaxError` on PostgreSQL while supporting SQLite text columns.

#### F-11: Transaction Rollback Integrity — [PASS]
- **Inspection:** Both the UPDATE and the re-fetching SELECT are wrapped inside `await dbClient.transaction(...)`.
- **Verification:** Any error during the write or read steps triggers an automatic transaction ROLLBACK. The outer `try/catch` catches the error and issues a structured HTTP 500 response without crashing the server.

#### F-12: Immutable & Sensitive Field Protection — [PASS]
- **Inspection:** The `id`, `name`, and `created_at` fields are omitted from the UPDATE query.
- **Verification:** Calling `PUT /plans/:id` with `{ id: 'new_id', name: 'Hacked Name' }` does not modify `id` or `name`.

---

### 2.3 Test Suite Quality & Diagnostic Audit

#### F-13: Investigation of Test Failures Encountered During Development — [PASS WITH NOTE]
During the development of `test/test_phase2_4_3_1_b_routes.js`, five initial failures occurred. Each was investigated:

1. **Pre-Test Record Count Mismatch (`343 !== 342`):**
   - *Cause:* Scratch prototype `scratch/test_tx_routes.js` committed a test row `_synth_test_tx_sub`.
   - *Fix:* Executed `scratch/clean_synth.js` to restore `zarsev_test` to 342 records.
2. **Category Empty List Assumption on Populated Database:**
   - *Cause:* Test assumed `zarsev_test` had 0 categories, when it contains the 14 real migrated categories.
   - *Fix:* Verified empty tree on SQLite and verified the 6 baseline roots / 14 flat categories on PostgreSQL.
3. **PostgreSQL Foreign Key Violation 23503:**
   - *Cause:* Test attempted to insert a category with `parent_id = 'cat_non_existent_9999'` directly into `zarsev_test`. PostgreSQL strictly enforced `categories_parent_id_fkey`.
   - *Fix:* Asserted that PostgreSQL rejects invalid parent IDs with 23503, and verified orphan tree exclusion on SQLite and unit test.
4. **Missing `is_demo` Column in Mock SQLite Schema:**
   - *Cause:* Test SQLite schema omitted `is_demo` in `users`.
   - *Fix:* Added `is_demo INTEGER NOT NULL DEFAULT 0` to the test table.
5. **Async Middleware Timing Race in Mock Handler:**
   - *Cause:* Synchronous `requireRole` middleware did not return the promise returned by `next()`, causing the test runner to evaluate assertions before handler 3 resolved.
   - *Fix:* Wrapped mock `res.json()` and `res.end()` in a Promise to await true completion.

*Note:* All failures were legitimate issues in test harness setup rather than application regressions, and were resolved cleanly without weakening test assertions.

#### F-14: Assertion Rigor — [PASS]
All 16 test cases assert exact HTTP status codes (200, 400, 401, 403, 404, 500), payload success flags, array lengths, and object fields. No assertions were bypassed.

#### F-15: Deterministic Fixture Cleanup — [PASS]
All synthetic IDs are registered in `pgSyntheticIds` and deleted in reverse dependency order inside guaranteed `finally` blocks.

#### F-16: Baseline Immutability — [PASS]
Post-test audits confirm:
- `zarsev_test` retains all 342 records across the 9 business tables.
- All three SQLite baseline database files maintain bit-perfect SHA256 hashes.

---

# Part B — Phase 2.4.3.1-C Readiness Proposal

## 1. Objective & Scope Definition

**Target Modules for Phase 2.4.3.1-C:**
1. `src/routes/manufacturerRoutes.js`
2. Dedicated Verification Suite (`test/test_phase2_4_3_1_c_routes.js`)
3. Health check probe verification

**Out of Scope for Phase C:**
- `productRoutes.js`, `importRoutes.js`, `approvalRoutes.js`, `authRoutes.js`.
- Migrations, schema DDL, production deployment.

---

## 2. Technical Dependency & Dialect Analysis

### 2.1 Critical Dependency: `findMatchingManufacturer` in `duplicateDetectionService.js`
In `src/routes/manufacturerRoutes.js` (lines 110-120):
```javascript
router.get('/match', authMiddleware, (req, res) => {
    const { name } = req.query;
    if (!name) return res.json({ success: true, match: null });
    const match = findMatchingManufacturer(name);
    res.json({ success: true, match });
});
```
- In `src/services/duplicateDetectionService.js` (line 128), `findMatchingManufacturer` calls:
  `const db = getDb(); const manufacturers = db.prepare('SELECT id, name_ar, name_en, code, business_model FROM manufacturers').all();`.
- **Architectural Decision Required for Phase C:**
  - **Option 1 (Recommended):** Convert `findMatchingManufacturer` in `duplicateDetectionService.js` to `async findMatchingManufacturer(extractedName, dbOpts)` using `await dbClient.queryAll(...)`. This cleanly transitions duplicate detection service queries to `dbClient`.
  - **Option 2:** In `manufacturerRoutes.js`, query manufacturers asynchronously via `await dbClient.queryAll(...)` and pass the array to an in-memory matching helper `findMatchingManufacturerInMemory(name, manufacturersList)`.

### 2.2 SQL Dialect Divergences in `manufacturerRoutes.js`
1. **Public Demo Exclusion Filter:**
   - Current SQLite: `WHERE (m.is_demo = 0 OR m.is_demo IS NULL)`
   - PostgreSQL equivalent: `WHERE (m.is_demo = false OR m.is_demo IS NULL)`
   - *Resolution:* Dual-dialect query or `is_demo IS NOT TRUE`.
2. **Correlated Subquery Count:**
   - Query: `(SELECT COUNT(*) FROM products p WHERE p.manufacturer_id = m.id) as products_count`
   - In PostgreSQL, `COUNT(*)` returns a string representation of `bigint`.
   - *Resolution:* Use `(SELECT COUNT(*)::int FROM products p WHERE p.manufacturer_id = m.id) as products_count`.
3. **Boolean Columns on INSERT (`POST /`):**
   - Query: `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)` for `is_verified, is_demo`.
   - *Resolution:* Pass parameters as `true, false` or `1, 0`, which `dbClient` normalizes.

---

## 3. Tenant Isolation & Privacy Boundaries

1. **Role-Based Visibility Enforcement:**
   - **`MANUFACTURER` Role:** MUST query strictly `WHERE m.id = ?` using `req.user.manufacturer_id`. If `req.user.manufacturer_id` is null, returns empty list `[]`. Must NEVER see other manufacturers.
   - **Public / Unauthenticated:** Excludes all demo records (`is_demo = 0` / `false`). Serializes strictly through `serializePublicManufacturer`, stripping `contact_email`, `contact_phone`, `business_model`, and `subscription_id`.
   - **Admin / Logistics:** Accesses full administrative serialization with `products_count`.
2. **Creation Security (`POST /`):**
   - Strictly restricted to `SUPER_ADMIN` and `LOGISTICS_OFFICER`.
   - Anonymous callers receive HTTP 401; manufacturers receive HTTP 403.
   - Rejects duplicate name or code with HTTP 409.

---

## 4. Proposed Test Strategy for Phase 2.4.3.1-C

Construct `test/test_phase2_4_3_1_c_routes.js` validating:
1. Public listing excludes demo manufacturers and strips sensitive fields.
2. Manufacturer user receives only their own profile.
3. Super Admin receives full administrative serialization with `products_count`.
4. Filter by `business_model` query parameter.
5. Single manufacturer lookup: public vs admin vs owner vs demo record (404).
6. Match endpoint: fuzzy matching with confidence score.
7. Profile creation: Super Admin succeeds (201); duplicate name/code rejected (409); missing required fields rejected (400); unauthorized rejected (401/403).
8. Database failure returns structured HTTP 500 without crash.
9. Cross-engine response parity between SQLite and PostgreSQL.
10. Deterministic cleanup of all synthetic `_synth_c_%` records.

---

## 5. Verification Checkpoint & Environment Snapshot

### 5.1 SQLite File Hashes (Bit-Perfect Preservation)
- `zarsev.db`: `BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB` (286,720 bytes)
- `zarsev.db.bak`: `77E32117AA24639364FDA5EA046149599054D4347D4D1C17E6EE9BFC917B72CD` (122,880 bytes)
- `zarsev.db.phase1_2_prequarantine.bak`: `F86FC491D2ED9E082684EFF1871A6E2DA92B628D8B368F3437972DDFB4DF35A8` (196,608 bytes)

### 5.2 PostgreSQL Database Counts
- **`zarsev_test`:** Exactly **342 business records** across all 9 tables:
  - `categories`: 14
  - `manufacturers`: 4
  - `users`: 6
  - `subscriptions`: 3
  - `products`: 60
  - `product_images`: 2
  - `imports`: 53
  - `import_items`: 95
  - `import_logs`: 105
- **`zarsev_dev`:** Exactly **0 public tables** (clean, pristine development database).

### 5.3 Git Working Tree
- **Git HEAD:** `377c546b608fba3c24db2718fff91732be724385`
- Working tree contains uncommitted files from previous approved phases; zero files staged or committed.

---

## 6. Execution Stop Notice

```
================================================================
✅ VERDICT: PHASE 2.4.3.1-B AUDIT COMPLETE — ALL CHECKS PASS
================================================================
```

In accordance with strict safety rules, execution has **STOPPED**. Phase 2.4.3.1-C implementation will **NOT** begin without explicit approval.
