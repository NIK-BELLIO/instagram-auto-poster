# سیستم اتومات پست اینستاگرام

یک پنل سبک روی Cloudflare Workers برای صف‌کردن، زمان‌بندی و انتشار خودکار پست‌های اینستاگرام با Instagram Graph API رسمی.

## امکانات

- پنل مدیریت فارسی و ساده
- ساخت پیش‌نویس یا پست زمان‌بندی‌شده
- انتشار خودکار هر ۵ دقیقه با Cron
- انتشار فوری
- ثبت وضعیت‌ها: پیش‌نویس، زمان‌بندی‌شده، منتشرشده، خطادار
- ثبت تاریخچه اتفاقات هر پست
- پیشنهاد ساعت‌های مناسب برای انتشار

## پیش‌نیاز اینستاگرام

برای انتشار رسمی باید اکانت اینستاگرام Professional باشد؛ یعنی Business یا Creator، و به یک Facebook Page وصل باشد. سپس در Meta Developer یک App می‌سازی و برای Instagram Graph API توکن رسمی می‌گیری.

این پروژه پسورد اینستاگرام نمی‌گیرد و با بات مرورگر وارد اکانت نمی‌شود.

## راه‌اندازی محلی

```bash
npm install
copy .dev.vars.example .dev.vars
npm run dev
```

داخل `.dev.vars` این سه مقدار را بگذار:

```env
ADMIN_TOKEN=رمز_پنل
IG_USER_ID=instagram_business_account_id
IG_ACCESS_TOKEN=meta_long_lived_access_token
```

## ساخت دیتابیس و انتشار روی Cloudflare

```bash
npx wrangler d1 create instagram-auto-poster
```

مقدار `database_id` خروجی را داخل `wrangler.jsonc` جایگزین کن، بعد:

```bash
npx wrangler d1 migrations apply instagram-auto-poster --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IG_USER_ID
npx wrangler secret put IG_ACCESS_TOKEN
npm run deploy
```

بعد از بازکردن آدرس Worker، با همان رمز پنل وارد شو و پست‌ها را بساز.
