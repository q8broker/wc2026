# ⚽ توقعات كأس العالم 2026

تطبيق ويب (PWA) بالعربي لتوقع نتائج مباريات كأس العالم 2026 مع الأصدقاء — نقاط، ترتيب، مجموعات، شجرة إقصائيات، نتائج مباشرة وتشكيلات.

**التطبيق المباشر:** https://q8broker.github.io/wc2026/

## المكونات
| الملف | الوصف |
|---|---|
| `index.html` | التطبيق كاملاً (React 18 + Babel في المتصفح، بدون خطوة بناء) |
| `sw.js` + `manifest.json` | ملفات الـ PWA (تثبيت على الجوال + عمل أوفلاين) |
| `clever-processor/index.ts` | Supabase Edge Function — وسيط مصدر البيانات (sportdb/flashscore) مع كاش وميزانية طلبات وربط واعتماد نتائج تلقائي |
| `apply-all.sql` | إصلاحات قاعدة البيانات + حماية السيرفر (مطبقة) |
| `fixes.sql`, `settings-security.sql` | ملفات SQL الأصلية المضمنة في apply-all |

## الخلفية
- قاعدة البيانات والمصادقة: [Supabase](https://supabase.com) — مشروع `WC2026`
- مصدر بيانات المباريات: sportdb.dev (المفتاح محفوظ في أسرار الـ Edge Function ولا يظهر للمتصفح)
- درجة حرارة الملاعب: Open-Meteo (بدون مفتاح)

## النشر
الموقع يُخدم من GitHub Pages مباشرة من فرع `main`. أي تعديل على `index.html` يصل للمستخدمين فور الدفع (مع تحديث رقم النسخة `APP_VERSION` وكاش `sw.js`).

نسخ احتياطية على Netlify: `astonishing-ganache-b7b258.netlify.app` و `glowing-sunflower-1c66ff.netlify.app`.
