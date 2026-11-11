# ZARSEV — Phase 2.4.2.1: Independent Read-Only Code Audit

**المشروع:** ZARSEV Global Trade  
**المستودع:** `M:\ZZZ`  
**الفرع النشط:** `feature/postgres-foundation`  
**الـ Base HEAD المتوقع:** `377c546b608fba3c24db2718fff91732be724385`  
**نوع المهمة:** مراجعة كود مستقلة وقراءة فقط (STRICTLY READ-ONLY CODE AUDIT)  
**تاريخ المراجعة:** 2 نوفمبر 2026  
**الملفات الخاضعة للمراجعة:**
- `src/db/dbClient.js`
- `test/test_phase2_4_db_client.js`
- `src/db/pgAdapter.js` (مرجعي)
- `src/db/database.js` (مرجعي)

---

## 1. القرار النهائي (Audit Verdict)

### 🔴 القرار: **NEEDS FIXES**

على الرغم من أن هيكل الواجهة غير المتزامنة `dbClient.js` يوفر بنية أساسية ممتازة وتجريداً نظيفاً، إلا أن التدقيق المستقل كشف عن **ثلاث مشاكل حرجة عالية الخطورة (HIGH Severity)** ومجموعتين من الملاحظات متوسطة ومنخفضة الخطورة تتطلب تصحيحاً مسبقاً قبل البدء بترحيل المسارات التشغيلية في Phase 2.4.3:
1. **تلف استعلامات مشغلات JSONB في PostgreSQL (`?`, `?|`, `?&`)** نتيجة تحويلها الخاطئ إلى معاملات موضعية `$1`.
2. **تسريب سياق المعاملة بعد انتهائها (Post-Transaction Client Leakage)** مما يتيح تشغيل استعلامات على اتصال تم تحريره وإعادته للـ Pool.
3. **تصادم المعاملات المتوازية في SQLite** على الاتصال المشترك مما يُنتج خطأ `cannot start a transaction within a transaction`.

---

## 2. سجل الملاحظات والعيوب البرمجية (Audit Findings Ledger)

### [Finding 1] تلف مشغلات وجود المفاتيح في كائنات JSONB لـ PostgreSQL
- **مستوى الخطورة:** 🔴 **HIGH**
- **المحرك المتأثر:** **PostgreSQL**
- **الملف ورقم السطر:** `src/db/dbClient.js:244-250`
- **التوصيف:**  
  في لغة PostgreSQL، تعتبر الرموز `?` و `?|` و `?&` مشغلات ثنائية أساسية للتحقق من وجود المفاتيح في كائنات `JSONB` (مثل `WHERE metadata ? 'category'`). يقوم المحلل المعجمي الحالي `tokenizeAndConvertParams` بافتراض أن أي رمز `?` خارج النصوص والتعليقات هو علامة معامل لقاعدة البيانات، مما يؤدي إلى استبداله بـ `$1` وتحويل مشغلات JSONB إلى صياغة غير صالحة مثل `$1 'key'` أو `$1|`، مما يتسبب في فشل الاستعلام فوراً بخطأ `syntax error at or near "$1"` (SQLSTATE 42601).
- **الدليل العملي والاختبار البرمجي:**  
  تم إثبات الخلل في `test/test_phase2_4_2_1_audit.js` (Check 1):
  ```sql
  -- الاستعلام الأصلي:
  SELECT '{"a": 1}'::jsonb ? 'a' as has_a;
  -- الاستعلام بعد المعالجة التلقائية (تالف):
  SELECT '{"a": 1}'::jsonb $1 'a' as has_a;
  -- استجابة PostgreSQL:
  -- syntax error at or near "$1" (code: 42601)
  ```
- **الإصلاح المقترح (بدون تنفيذ):**
  1. تحديث المحلل المعجمي `tokenizeAndConvertParams`: عند مواجهة `?`، فحص الرمز التالي `nextChar`؛ إذا كان `|` أو `&`، يتم الحفاظ عليه كمشغل JSONB.
  2. فحص سياق ما قبل `?`؛ إذا كان الرمز مسبوقاً بمسافة أو باسم عمود متبوعاً بقيمة نصية مباشرة دون وجود معلمة مقابلة في مصفوفة `params`، يتم الحفاظ عليه، أو دعم الهروب عبر `??`.
  3. توثيق تفضيل استخدام دوال PostgreSQL القياسية مثل `jsonb_exists(data, 'key')` و `jsonb_exists_any(...)` بدلاً من المشغلات الرمزية، أو تمرير صياغة منفصلة `{ sqlite: '...', postgres: '...' }` عبر معلمات `$1` أصلية.

---

### [Finding 2] إمكانية استغلال اتصال المعاملة بعد إنهائها وتحريرها للـ Pool
- **مستوى الخطورة:** 🔴 **HIGH**
- **المحرك المتأثر:** **PostgreSQL و SQLite**
- **الملف ورقم السطر:** `src/db/dbClient.js:310-334` و `src/db/dbClient.js:535-543`
- **التوصيف:**  
  لا يحتوي كائن سياق المعاملة `TransactionContext` على مؤشر حالة نشاط (`isActive` أو `isClosed`). عند انتهاء المعاملة بنجاح والتثبيت (`COMMIT`) أو التراجع (`ROLLBACK`)، يتم استدعاء `client.release()` لإعادة الاتصال إلى `pg-pool`. إذا احتفظ الكود البرمجي بمرجع لكائن `tx` واستدعى `tx.queryOne(...)` بعد انتهاء المعاملة، يتم إرسال الاستعلام مباشرة عبر العميل المُحرر (`client.query`)، مما قد ينجح في التنفيذ أثناء وجود العميل في حالة خمول بالـ Pool، أو الأخطر: تنفيذ استعلام وسط معاملة عميل آخر قام بسحب نفس الاتصال من الـ Pool في نفس اللحظة!
- **الدليل العملي والاختبار البرمجي:**  
  تم إثبات الخلل في `test/test_phase2_4_2_1_audit.js` (Check 3):
  ```javascript
  let leakedTx = null;
  await dbClient.transaction(async (tx) => {
      leakedTx = tx;
      await tx.queryOne('SELECT 1 as num;');
  }, { engine: 'postgres' });

  // استعلام بعد انتهاء المعاملة وتحرير العميل:
  const res = await leakedTx.queryOne('SELECT 99 as num;');
  // النتيجة: نفذ بنجاح واستعاد { num: 99 } على اتصال خامل داخل الـ Pool!
  ```
- **الإصلاح المقترح (بدون تنفيذ):**
  1. إضافة حقل `this.isActive = true` داخل باني `TransactionContext`.
  2. في دالة `runTransaction`، إغلاق السياق حتمياً داخل كتلة `finally`:
     ```javascript
     txCtx.isActive = false;
     ```
  3. في كل من `tx.queryOne` و `tx.queryAll` و `tx.execute` و `tx.transaction`، فحص الحالة فوراً:
     ```javascript
     if (!this.isActive) {
         throw new DbError('Transaction context has already ended. Cannot execute queries on closed transaction.', {
             code: 'TRANSACTION_CLOSED',
             engine: this.engine
         });
     }
     ```

---

### [Finding 3] تصادم المعاملات المتوازية في SQLite على الاتصال المشترك
- **مستوى الخطورة:** 🔴 **HIGH**
- **المحرك المتأثر:** **SQLite فقط**
- **الملف ورقم السطر:** `src/db/dbClient.js:581-604`
- **التوصيف:**  
  اتصال SQLite في مكتبة `node:sqlite` (`DatabaseSync`) هو اتصال متزامن مفرد. عند استدعاء معاملتين غير متزامنتين بالتوازي عبر `Promise.all([dbClient.transaction(...), dbClient.transaction(...)])`، تبدأ المعاملة الأولى وتنفذ `sqliteDb.exec('BEGIN TRANSACTION;')` ثم تنتظر Promise (مثل I/O أو استعلام). في تلك الأثناء، يبدأ الاستدعاء الثاني وينفذ `BEGIN TRANSACTION;` على نفس الاتصال، مما يؤدي إلى انهيار المعاملة بخطأ: `cannot start a transaction within a transaction`.
  كما أن استخدام الصياغة الافتراضية `BEGIN TRANSACTION;` بدلاً من `BEGIN IMMEDIATE;` يجعل العمليات عرضة للتعليق وأخطاء `SQLITE_BUSY` عند حدوث كتابات متزامنة في وضع WAL.
- **الدليل العملي والاختبار البرمجي:**  
  تم إثبات الخلل في `test/test_phase2_4_2_1_audit.js` (Check 4):
  ```javascript
  const p1 = dbClient.transaction(async (tx) => {
      await tx.execute('INSERT INTO items ...');
      await sleep(40);
  }, { engine: 'sqlite' });
  const p2 = dbClient.transaction(async (tx) => {
      await tx.execute('INSERT INTO items ...');
  }, { engine: 'sqlite' });
  await Promise.all([p1, p2]);
  // النتيجة: انهيار العملية بخطأ "cannot start a transaction within a transaction"
  ```
- **الإصلاح المقترح (بدون تنفيذ):**
  1. استخدام `BEGIN IMMEDIATE;` حصراً لمعاملات SQLite لمنع تداخل أقفال الكتابة.
  2. إنشاء Mutex غير متزامن تسلسلي (`sqliteTxMutex`) على مستوى معاملات SQLite، بحيث تنتظر المعاملة التالية انتهاء المعاملة الحالية قبل فتح المعاملة الجديدة على نفس الاتصال المفرد.

---

### [Finding 4] فقدان تفاصيل أخطاء التراجع (`savepointRollbackError` و `rollbackError`) داخل `DbError`
- **مستوى الخطورة:** 🟡 **MEDIUM**
- **المحرك المتأثر:** **PostgreSQL و SQLite**
- **الملف ورقم السطر:** `src/db/dbClient.js:48-63` و `src/db/dbClient.js:526-530`
- **التوصيف:**  
  عند فشل التراجع عن Savepoint داخلي، يتم إرفاق الخطأ إلى `err.savepointRollbackError`. ولكن عندما يُعاد تغليف الخطأ داخل `new DbError(err.message, { originalError: err })`، لا يقوم باني `DbError` بحفظ `originalError` على كائن الخطأ (`this.originalError`) ولا بنسخ `savepointRollbackError` أو `rollbackError`، مما يؤدي إلى ضياع التفاصيل التشخيصية الدقيقة لفشل التراجع.
- **الدليل العملي والاختبار البرمجي:**  
  تم إثبات الخلل في `test/test_phase2_4_2_1_audit.js` (Check 7):
  ```javascript
  const wrapped = new DbError(err.message, { originalError: err });
  console.log(wrapped.savepointRollbackError); // undefined
  console.log(wrapped.originalError); // undefined
  ```
- **الإصلاح المقترح (بدون تنفيذ):**
  في باني `DbError`:
  ```javascript
  this.originalError = originalError;
  this.savepointRollbackError = originalError?.savepointRollbackError;
  this.rollbackError = originalError?.rollbackError;
  ```

---

### [Finding 5] عدم اتساق أنواع البيانات المرجعة بين المحركين (Booleans, JSON, Numerics)
- **مستوى الخطورة:** 🟡 **MEDIUM**
- **المحرك المتأثر:** **التوافق المشترك بين المحركين**
- **الملف ورقم السطر:** `src/db/dbClient.js:360-374` و `src/db/dbClient.js:400-413`
- **التوصيف:**  
  تختلف مكتبة `node:sqlite` عن `node-postgres` في نمط القيم المسترجعة من الاستعلامات:
  1. **القيم المنطقية (Booleans):** تُرجع SQLite الأرقام `1` أو `0`، بينما تُرجع PostgreSQL بوليان JavaScript حقيقي (`true` أو `false`). إذا اعتمد الكود على المقارنة الصارمة `row.is_active === true` فسيفشل على SQLite.
  2. **كائنات JSON:** تُرجع PostgreSQL أعمدة JSONB ككائنات ومصفوفات JavaScript مُحللة تلقائياً، بينما تُرجعها SQLite كنصوص خام تتطلب استدعاء `JSON.parse()`.
  3. **أرقام الدقة العشرية (Numeric):** تُرجع PostgreSQL أعمدة `NUMERIC` كسلاسل نصية (مثل `'123.45'`) لمنع فقدان الدقة العشرية في JavaScript، بينما تُرجعها SQLite كأرقام فلوت (`123.45`).
- **الدليل العملي والاختبار البرمجي:**  
  تم توثيقه عملياً في `test/test_phase2_4_2_1_audit.js` (Check 5).
- **الإصلاح المقترح (بدون تنفيذ):**
  توثيق هذا التباين بدقة كإرشادات إلزامية لطبقة المسارات في Phase 2.4.3، والاعتماد على دوال تحويل آمنة (مثل استخدام دوال التحليل المزدوجة `safeJsonParse` المتاحة في `pgAdapter.js`).

---

### [Finding 6] حقل `lastInsertRowid` يفترض دائماً أن المعرف يسمى `id`
- **مستوى الخطورة:** 🟢 **LOW**
- **المحرك المتأثر:** **PostgreSQL و SQLite (عند استخدام RETURNING)**
- **الملف ورقم السطر:** `src/db/dbClient.js:427-429` و `src/db/dbClient.js:459`
- **التوصيف:**  
  عند استخدام جملة `RETURNING` مع جدول يمتلك Primary Key باسم غير `id` (مثل `custom_pk` أو `user_code`)، يفحص الكود فقط `rows[0]?.id !== undefined`. إذا لم يتوفر حقل `id`، يُرجع `lastInsertRowid = null` بالرغم من أن المفتاح المُنشأ موجود في الصفوف المرجعة.
- **الدليل العملي والاختبار البرمجي:**  
  تم إثباته في `test/test_phase2_4_2_1_audit.js` (Check 6) عند تنفيذ استعلام `RETURNING custom_pk` حيث كانت النتيجة `{ lastInsertRowid: null, rows: [ { custom_pk: 2 } ] }`.
- **الإصلاح المقترح (بدون تنفيذ):**
  تحديث منطق استخراج المعرف ليكون:
  ```javascript
  if (rows.length > 0) {
      lastInsertRowid = rows[0].id !== undefined ? rows[0].id : Object.values(rows[0])[0];
  }
  ```

---

### [Finding 7] تباين سلوك عدم تطابق عدد المعاملات بين المحركين
- **مستوى الخطورة:** 🟢 **LOW**
- **المحرك المتأثر:** **SQLite مقابل PostgreSQL**
- **الملف ورقم السطر:** `src/db/dbClient.js:124-257`
- **التوصيف:**  
  عند تمرير عدد معاملات أقل من عدد علامات الاستفهام في الاستعلام (مثلاً استعلام به علامتان وتمرير قيمة واحدة):
  - تقوم SQLite بربط القيمة الناقصة كـ `NULL` بصمت ودون إلقاء أي خطأ.
  - بينما تقوم PostgreSQL بإلقاء خطأ فوري: `bind message supplies 1 parameters, but prepared statement requires 2`.
- **الدليل العملي والاختبار البرمجي:**  
  تم توثيقه في `test/test_phase2_4_2_1_audit.js` (Check 2).
- **الإصلاح المقترح (بدون تنفيذ):**
  إضافة فحص اختياري على مستوى `dbClient` يتحقق من تطابق `params.length` مع عدد العلامات المُكتشفة قبل إرسال الاستعلام للمحركين.

---

## 3. تقييم جودة الاختبارات السابقة (`test/test_phase2_4_db_client.js`)

تمت مراجعة سويت الاختبارات السابق وتبين ما يلي:
- **نقاط القوة:**
  1. يعتمد على الكود الحقيقي المنشور للواجهة و`pgAdapter` دون استخدام Mocking.
  2. يعزل بيئة SQLite داخل مجلد `test/sandbox` برقم معرف ومعامل PID لتفادي التعارض مع قواعد البيانات الحقيقية.
  3. يعزل اختبارات PostgreSQL داخل جدول منفصل `_test_phase2_4_facade` يقوم `zarsev_migrator` بإنشائه وتنظيفه فوراً.
  4. يفحص البصمة الكاملة لملفات SQLite وسجلات `zarsev_test` الـ 342 قبل وبعد كل تشغيل.
- **نقاط القصور التي كشفها التدقيق:**
  1. لم يختبر مشغلات JSONB الرمزية في PostgreSQL (`?`, `?|`, `?&`).
  2. لم يختبر محاولة استخدام سياق المعاملة بعد انتهاء كتلة `transaction`.
  3. لم يختبر تشغيل معاملات متوازية على محرك SQLite (اقتصر اختبار التوازي على PostgreSQL فقط).
  4. تغاضى عن تباين الأنواع المسترجعة (حيث استخدم `JSON.parse` صراحة في اختبار SQLite بينما لم يستخدمه في PostgreSQL، واستخدم `parseFloat` في فحص أرقام PostgreSQL).

---

## 4. سويت الاختبارات المضافة للتدقيق (`test/test_phase2_4_2_1_audit.js`)

تم إنشاء وتشغيل السويت الرقابي المستقل [`test/test_phase2_4_2_1_audit.js`](file:///M:/ZZZ/test/test_phase2_4_2_1_audit.js) لإثبات كافة الملاحظات عملياً:

```
================================================================
🔬 ZARSEV Phase 2.4.2.1: Independent Code Audit Test Suite
================================================================

--- Audit Check 1: Tokenizer with PostgreSQL JSONB Operators ---
 - Original JSON query 1:  SELECT '{"a": 1}'::jsonb ? 'a' as has_a;
 - Tokenized query 1:     SELECT '{"a": 1}'::jsonb $1 'a' as has_a;
 - Original JSON query 2:  SELECT '{"a": 1}'::jsonb ?| array['a', 'b'] as has_any;
 - Tokenized query 2:     SELECT '{"a": 1}'::jsonb $1| array['a', 'b'] as has_any;
 ⚠️ FINDING CONFIRMED: Tokenizer converted JSONB existence operators into parameter placeholders.

--- Audit Check 2: Parameter Count Mismatch Behavior ---
 - SQLite result with 2 placeholders and 1 parameter: [Object: null prototype] { a: 'val1', b: null }
 - PostgreSQL result with 2 placeholders and 1 parameter (Error): bind message supplies 1 parameters, but prepared statement "" requires 2

--- Audit Check 3: Transaction Context Invalidation After Completion ---
 ⚠️ FINDING CONFIRMED: Leaked transaction context successfully executed query on released pool client!

--- Audit Check 4: SQLite Parallel Transactions on Shared Connection ---
 ⚠️ FINDING CONFIRMED: SQLite parallel transactions collided with: cannot start a transaction within a transaction

--- Audit Check 5: Cross-Engine Data Type Asymmetries ---
 - Boolean return: SQLite=number (1) vs PG=boolean (true)
 - JSON return: SQLite=string ({"key":"val"}) vs PG=object ({"key":"val"})
 - Numeric return: SQLite=number (123.45) vs PG=string (123.45)

--- Audit Check 6: RETURNING Clause with Custom Primary Key ---
 - Execution metadata with RETURNING custom_pk: { rowCount: 1, lastInsertRowid: null, rows: [ { custom_pk: 2 } ] }
 ⚠️ FINDING CONFIRMED: lastInsertRowid is null because column is custom_pk instead of id.

--- Audit Check 7: Rollback Error Preservation in DbError ---
 - Are rollback errors attached directly on DbError? false
 ⚠️ FINDING CONFIRMED: DbError constructor did not preserve savepointRollbackError or rollbackError.

================================================================
📊 AUDIT SUMMARY METRICS:
{
  "tokenizerJsonOperatorsCorrupted": true,
  "paramCountMismatchBehavior": {
    "sqliteBindsNullSilently": true,
    "pgThrowsError": true
  },
  "postTxClientAccessible": true,
  "sqliteParallelTxCollision": true,
  "booleanReturnAsymmetry": true,
  "jsonReturnAsymmetry": true,
  "numericReturnAsymmetry": true,
  "nonIdReturningHandled": false,
  "rollbackErrorPreservedInDbError": false
}
================================================================
```

---

## 5. إثبات سلامة قواعد البيانات والملفات والـ Git

| الفحص الرقابي | القيمة المعتمدة | القيمة الفعلية بعد انتهاء التدقيق | النتيجة |
| :--- | :--- | :--- | :---: |
| **بصمة `zarsev.db`** | `BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB` | `BDC1A3D940050F1ECB089D588175A67DF49FFA1F883D95C942B2551787E5D7EB` | **مطابقة 100% (Bit-Perfect)** |
| **بصمة `zarsev.db.bak`** | `77E32117AA24639364FDA5EA046149599054D4347D4D1C17E6EE9BFC917B72CD` | `77E32117AA24639364FDA5EA046149599054D4347D4D1C17E6EE9BFC917B72CD` | **مطابقة 100% (Bit-Perfect)** |
| **سجلات `zarsev_test`** | **342** سجلاً عبر 9 جداول | **342** سجلاً عبر 9 جداول | **مطابقة 100% (صفر مساس)** |
| **قاعدة `zarsev_dev`** | **0** جداول (معزولة بالكامل) | **0** جداول (معزولة بالكامل) | **معزولة 100%** |
| **الـ Git Baseline HEAD** | `377c546b608fba3c24db2718fff91732be724385` | `377c546b608fba3c24db2718fff91732be724385` | **ثابت دون تغيير** |
| **حالة ملفات التطبيق** | لم يُعدل أي Route أو Middleware أو Service أو `database.js` | لم يُعدل أي Route أو Middleware أو Service أو `database.js` | **محمية 100%** |

---

> [!IMPORTANT]
> **التوقف الإلزامي:** بناءً على نتيجة التدقيق **NEEDS FIXES**، تم إيقاف كافة العمليات التطويرية والامتناع تماماً عن إجراء أي تعديل برمجى على `src/db/dbClient.js` أو المسارات التشغيلية، بانتظار موافقتكم وتوجيهكم بشأن خطة معالجة الملاحظات المذكورة.
