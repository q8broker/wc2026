# ملف الاستئناف — مشروع توقعات كأس العالم 2026 (wc2026)

> هذا الملف لاستئناف العمل على جهاز جديد (Mac mini). اقرأه أولاً بالكامل.
> **ملاحظة لـ Claude الجديد:** انسخ القسمين «الذاكرة» أدناه إلى ملفات الذاكرة لديك حتى تحتفظ بالسياق.

## نظرة عامة
تطبيق ويب (PWA) بالعربي لتوقع مباريات كأس العالم 2026 بين أصدقاء الديوانية. واجهة + خلفية + بيانات مباريات حية.

## أين كل شيء
| المكوّن | المكان |
|---|---|
| **الكود (الواجهة)** | GitHub: `github.com/q8broker/wc2026` — ملف `index.html` (React+Babel في المتصفح) + `sw.js` + `manifest.json` |
| **الخلفية (Edge Function)** | ملف `clever-processor/index.ts` في نفس الريبو، **منشور على Supabase** (نسخة v40) |
| **قاعدة البيانات + الـ cron** | Supabase مشروع `aajncwbilknfjuzvrjxl` |
| **التطبيق المباشر** | https://q8broker.github.io/wc2026/ (مستضاف على GitHub Pages من فرع main) |
| **نسخ SQL** | `apply-all.sql`, `fixes.sql`, `settings-security.sql` في الريبو |

## كيف يُنشر أي تغيير
- **الواجهة (index.html / sw.js)**: عدّل → `git commit` → `git push` → GitHub Pages يحدّثها خلال دقيقة. (مع رفع رقم `APP_VERSION` في index.html وكاش `CACHE_NAME` في sw.js).
- **الخلفية (clever-processor/index.ts)**: تُنشر عبر Supabase Management API أو لوحة Supabase → Edge Functions.
- **SQL / cron**: عبر Supabase SQL Editor أو Management API.

> ملاحظة مهمة: النشر على Supabase/GitHub يحتاج توكنات (انظر «المفاتيح» أدناه). على ويندوز كانت محفوظة في المحادثة. **ستحتاج إعادة إعطائها لـ Claude على الماك** (أو تنفّذ الخطوات بنفسك من اللوحات).

## الحالة الحالية (آخر تحديث 2026-06-20)
- ✅ **الموظف الآلي (cron) مكتمل وفعّال**: pg_cron مهمة `wc2026-tick` كل 5 دقائق، يجلب تلقائياً: النتائج + التشكيلة + الإحصائيات + الأحداث + التقييمات، كلٌّ في نافذته الزمنية، بقفل ذرّي وسقف محاولات. **لا تدخّل بشري مطلوب للمباريات الجديدة.**
- ✅ النتائج محمية من تعارض التزامن (قفل ذرّي claim_sync/try_spend).
- ✅ فتح المباراة من التطبيق = قراءة فقط (صفر طلبات للمصدر).
- ⏳ **معلّق بانتظار قرارك**: 18 مباراة قديمة (11-19 يونيو) تنقصها الأحداث (انتهت قبل إصلاح الأحداث المتأخرة). سحبها الكامل ~54 طلباً (يتجاوز ميزانية اليوم 96). الخيارات: دفعات يومية / رفع مؤقت للميزانية / تركها.

## القرار المعلّق الوحيد
**backfill للـ18 مباراة**: USA-Par, Qat-Sui, Hai-Sco, Aus-Tur, Ger-Cur, Civ-Ecu, Swe-Tun, Esp-Cpv, Irn-Nzl, Fra-Sen, Arg-Alg, Por-Cod, Eng-Cro, Gha-Pan, Uzb-Col, Sui-Bih, Can-Qat, Mex-Kor.
سحب مباراة واحدة يدوياً = استدعاء الدالة بـ `{"action":"match-details","fixtureId":"<id>","force":true}`.

---

## الذاكرة (1): تفاصيل المشروع — انسخها لذاكرتك
تطبيق توقعات كأس العالم 2026:
- الكود: index.html واحد (React+Babel بالمتصفح)، sw.js، manifest.json. **مهم: Babel مثبّت على @babel/standalone@7.26.4** (نسخة 8 كسرت التطبيق سابقاً — لا تُزل التثبيت).
- الخلفية: Supabase `aajncwbilknfjuzvrjxl`، Edge Function `clever-processor`، المزود sportdb.dev (بيانات flashscore). الميزانية 96 طلب/يوم (15 محجوزة للايف). الـ1000 في x-quota = رصيد إجمالي للحساب وليس يومياً.
- المصدر يعطي التفاصيل عبر 4 مسارات منفصلة لكل مباراة (لا يوجد طلب شامل): `/lineups`, `/stats`, `/details` (أحداث+حكم+حضور), `/playerstats` (تقييمات+مراكز البدلاء). النتائج مدمجة ورخيصة عبر `/live` و`/results`.
- جداول: football_fixture_cache, football_match_details, football_h2h_cache, football_sync_state (قراءة anon مفتوحة، الكتابة لا).
- دوال SQL مضافة (SECURITY DEFINER): `claim_sync(key,field,minutes)` قفل ذرّي، `try_spend(key,day,limit)` صرف ذرّي، إضافة لـ save_prediction وحماية السيرفر.

## الذاكرة (2): حالة العمل — انسخها لذاكرتك
[محتوى wc2026-pending-user-steps الكامل — منطق الـ cron v40، النوافذ، الـ backfill المعلّق]
- الموظف v40: lineups [-10,10]/postFT[95,135] claim 14د؛ stats halftime[55,72]+statsFT[95,170] claim 18د؛ events halftime+eventsFT[95,300] موسّعة claim 30د (المصدر ينشر الأحداث متأخرة)؛ ratings statsFT[95,170] claim 18د. ftDone=present&&stamp>ko+90د. نوافذ مغلقة تمنع المحاولات اللانهائية. timeout 8ث/طلب.
- نسخ احتياطية: git tag `backup-20260615`، وملفات zip على ويندوز (Downloads + Desktop).
- المستخدم حذِر جداً: خطوات صغيرة + اختبار قبل النشر + موافقة قبل أي تغيير + حريص على الميزانية. الواجهة (index.html) لا تُعدّل إلا بإذن.

## المفاتيح (لا تُرفع على GitHub العام!)
احذف هذا القسم قبل أي push عام. أعطِ Claude على الماك التوكنات شفهياً:
- Supabase Management Token: (أنشئه من supabase.com/dashboard/account/tokens)
- GitHub Token: (أنشئه من github.com/settings/tokens)
- مفتاح sportdb في أسرار Edge Function (Supabase → Edge Functions → Secrets → FOOTBALL_API_KEY)
