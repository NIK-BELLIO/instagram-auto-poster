# Instagram Auto Poster

یک پنل چندکاربره روی Cloudflare Workers برای زمان‌بندی و انتشار پست اینستاگرام با مسیر رسمی Instagram Graph API.

## قابلیت‌ها

- ثبت‌نام و ورود کاربران
- هر کاربر پست‌ها و اتصال اینستاگرام خودش را دارد
- ذخیره Access Token هر کاربر به‌صورت رمزگذاری‌شده با `AUTH_SECRET`
- ساخت پیش‌نویس یا پست زمان‌بندی‌شده
- انتشار خودکار با Cron هر ۵ دقیقه
- انتشار فوری
- نمایش وضعیت پست‌ها: پیش‌نویس، زمان‌بندی‌شده، منتشرشده، خطادار
- پیشنهاد ساعت مناسب برای انتشار

## نکته مهم

GitHub فقط محل نگهداری کد است. برای اینکه سیستم واقعاً کار کند باید روی Cloudflare Workers منتشر شود، چون به دیتابیس، Secret و Cron نیاز دارد.

## پیش‌نیاز اینستاگرام

برای انتشار رسمی، هر کاربر باید:

1. اکانت Instagram Professional داشته باشد: Business یا Creator.
2. اکانت Instagram را به یک Facebook Page وصل کرده باشد.
3. از Meta Developer مقدارهای رسمی زیر را داشته باشد:
   - `IG User ID`
   - `Access Token`

این پروژه پسورد اینستاگرام نمی‌گیرد و با بات مرورگر وارد اکانت نمی‌شود.

## راه‌اندازی محلی

```bash
npm install
copy .dev.vars.example .dev.vars
npm run dev
```

داخل `.dev.vars` فقط این مقدار لازم است:

```env
AUTH_SECRET=یک_کلید_خیلی_بلند_و_تصادفی_برای_رمزگذاری
```

## ساخت دیتابیس و انتشار روی Cloudflare

```bash
npx wrangler d1 create instagram-auto-poster
```

مقدار `database_id` خروجی را داخل `wrangler.jsonc` جایگزین کن، بعد:

```bash
npx wrangler d1 migrations apply instagram-auto-poster --remote
npx wrangler secret put AUTH_SECRET
npm run deploy
```

بعد از بازکردن آدرس Worker، هر نفر می‌تواند ثبت‌نام کند، اتصال اینستاگرام خودش را ذخیره کند و پست‌های خودش را زمان‌بندی کند.
