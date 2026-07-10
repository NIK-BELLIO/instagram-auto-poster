type Env = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  IG_USER_ID: string;
  IG_ACCESS_TOKEN: string;
  GRAPH_API_VERSION?: string;
};

type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
type MediaType = "IMAGE" | "REELS";

type PostRecord = {
  id: string;
  caption: string;
  media_url: string;
  media_type: MediaType;
  status: PostStatus;
  scheduled_at: string | null;
  published_at: string | null;
  instagram_creation_id: string | null;
  instagram_media_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type CreatePostPayload = {
  caption?: unknown;
  mediaUrl?: unknown;
  mediaType?: unknown;
  scheduledAt?: unknown;
  status?: unknown;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ ok: false, error: error.message }, error.status);
      }
      console.error(JSON.stringify({ level: "error", message: "Unhandled request error", error: errorToMessage(error) }));
      return json({ ok: false, error: "خطای داخلی رخ داد." }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDuePosts(env));
  }
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return html(renderDashboard());
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "instagram-auto-poster" });
  }

  if (!url.pathname.startsWith("/api/")) {
    return json({ ok: false, error: "مسیر پیدا نشد." }, 404);
  }

  if (!(await isAuthorized(request, env))) {
    return json({ ok: false, error: "رمز پنل درست نیست." }, 401);
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    return json({
      ok: true,
      connected: Boolean(env.IG_USER_ID && env.IG_ACCESS_TOKEN),
      graphVersion: env.GRAPH_API_VERSION ?? "v23.0"
    });
  }

  if (request.method === "GET" && url.pathname === "/api/posts") {
    const status = url.searchParams.get("status");
    const result = status
      ? await env.DB.prepare("SELECT * FROM posts WHERE status = ? ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 200").bind(status).all<PostRecord>()
      : await env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT 200").all<PostRecord>();
    return json({ ok: true, posts: result.results ?? [] });
  }

  if (request.method === "POST" && url.pathname === "/api/posts") {
    const payload = await readJson<CreatePostPayload>(request);
    const post = normalizePostPayload(payload);
    const id = crypto.randomUUID();
    const status: PostStatus = post.scheduledAt ? "scheduled" : "draft";

    await env.DB.prepare(
      `INSERT INTO posts (id, caption, media_url, media_type, status, scheduled_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(id, post.caption, post.mediaUrl, post.mediaType, status, post.scheduledAt).run();
    await addEvent(env, id, "created", status === "scheduled" ? "پست زمان‌بندی شد." : "پیش‌نویس ساخته شد.");

    const created = await getPost(env, id);
    return json({ ok: true, post: created }, 201);
  }

  const publishNowMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/publish-now$/);
  if (request.method === "POST" && publishNowMatch) {
    const id = publishNowMatch[1];
    const post = await getPost(env, id);
    if (!post) return json({ ok: false, error: "پست پیدا نشد." }, 404);
    ctx.waitUntil(publishPost(env, post.id));
    return json({ ok: true, message: "انتشار شروع شد. چند لحظه بعد وضعیت را تازه‌سازی کن." });
  }

  const postMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postMatch) {
    const id = postMatch[1];

    if (request.method === "PATCH") {
      const current = await getPost(env, id);
      if (!current) return json({ ok: false, error: "پست پیدا نشد." }, 404);
      if (current.status === "publishing" || current.status === "published") {
        return json({ ok: false, error: "پست در حال انتشار یا منتشرشده قابل ویرایش نیست." }, 409);
      }

      const payload = await readJson<CreatePostPayload>(request);
      const post = normalizePostPayload(payload, true);
      const nextStatus: PostStatus = post.scheduledAt ? "scheduled" : "draft";
      await env.DB.prepare(
        `UPDATE posts
         SET caption = ?, media_url = ?, media_type = ?, status = ?, scheduled_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(post.caption, post.mediaUrl, post.mediaType, nextStatus, post.scheduledAt, id).run();
      await addEvent(env, id, "updated", "پست ویرایش شد.");
      return json({ ok: true, post: await getPost(env, id) });
    }

    if (request.method === "DELETE") {
      const current = await getPost(env, id);
      if (!current) return json({ ok: false, error: "پست پیدا نشد." }, 404);
      if (current.status === "publishing") {
        return json({ ok: false, error: "پست در حال انتشار است و الان حذف نمی‌شود." }, 409);
      }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/smart/slots") {
    return json({ ok: true, slots: suggestBestSlots() });
  }

  return json({ ok: false, error: "درخواست نامعتبر است." }, 404);
}

async function processDuePosts(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT * FROM posts
     WHERE status = 'scheduled'
       AND scheduled_at IS NOT NULL
       AND scheduled_at <= datetime('now')
     ORDER BY scheduled_at ASC
     LIMIT 5`
  ).all<PostRecord>();

  for (const post of due.results ?? []) {
    await publishPost(env, post.id);
  }
}

async function publishPost(env: Env, postId: string): Promise<void> {
  const post = await getPost(env, postId);
  if (!post) return;
  if (post.status === "publishing" || post.status === "published" || post.status === "cancelled") return;

  await env.DB.prepare("UPDATE posts SET status = 'publishing', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(post.id).run();
  await addEvent(env, post.id, "publishing", "ارسال به Instagram Graph API شروع شد.");

  try {
    const result = await publishToInstagram(env, post);
    await env.DB.prepare(
      `UPDATE posts
       SET status = 'published',
           published_at = CURRENT_TIMESTAMP,
           instagram_creation_id = ?,
           instagram_media_id = ?,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(result.creationId, result.mediaId, post.id).run();
    await addEvent(env, post.id, "published", `منتشر شد. Media ID: ${result.mediaId}`);
  } catch (error) {
    const message = errorToMessage(error);
    console.error(JSON.stringify({ level: "error", message: "Instagram publish failed", postId: post.id, error: message }));
    await env.DB.prepare(
      "UPDATE posts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(message, post.id).run();
    await addEvent(env, post.id, "failed", message);
  }
}

async function publishToInstagram(env: Env, post: PostRecord): Promise<{ creationId: string; mediaId: string }> {
  if (!env.IG_USER_ID || !env.IG_ACCESS_TOKEN) {
    throw new Error("IG_USER_ID یا IG_ACCESS_TOKEN تنظیم نشده است.");
  }

  const graphVersion = env.GRAPH_API_VERSION ?? "v23.0";
  const base = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(env.IG_USER_ID)}`;
  const createBody = new URLSearchParams();
  createBody.set("caption", post.caption);
  createBody.set("access_token", env.IG_ACCESS_TOKEN);

  if (post.media_type === "REELS") {
    createBody.set("media_type", "REELS");
    createBody.set("video_url", post.media_url);
  } else {
    createBody.set("image_url", post.media_url);
  }

  const createResponse = await fetch(`${base}/media`, {
    method: "POST",
    body: createBody
  });
  const createJson = await safeJson(createResponse);
  if (!createResponse.ok || typeof createJson.id !== "string") {
    throw new Error(extractGraphError(createJson, "ساخت media container ناموفق بود."));
  }

  const publishBody = new URLSearchParams();
  publishBody.set("creation_id", createJson.id);
  publishBody.set("access_token", env.IG_ACCESS_TOKEN);

  const publishResponse = await fetch(`${base}/media_publish`, {
    method: "POST",
    body: publishBody
  });
  const publishJson = await safeJson(publishResponse);
  if (!publishResponse.ok || typeof publishJson.id !== "string") {
    throw new Error(extractGraphError(publishJson, "انتشار پست ناموفق بود."));
  }

  return { creationId: createJson.id, mediaId: publishJson.id };
}

async function getPost(env: Env, id: string): Promise<PostRecord | null> {
  return await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRecord>();
}

async function addEvent(env: Env, postId: string, eventType: string, message: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO post_events (id, post_id, event_type, message) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), postId, eventType, message).run();
}

function normalizePostPayload(payload: CreatePostPayload, requireScheduleField = false): {
  caption: string;
  mediaUrl: string;
  mediaType: MediaType;
  scheduledAt: string | null;
} {
  const caption = String(payload.caption ?? "").trim();
  const mediaUrl = String(payload.mediaUrl ?? "").trim();
  const mediaTypeRaw = String(payload.mediaType ?? "IMAGE").trim().toUpperCase();
  const mediaType = mediaTypeRaw === "REELS" ? "REELS" : "IMAGE";
  const scheduledAtRaw = payload.scheduledAt === undefined || payload.scheduledAt === null ? "" : String(payload.scheduledAt).trim();

  if (caption.length < 2) throw new HttpError("کپشن خیلی کوتاه است.", 400);
  if (caption.length > 2200) throw new HttpError("کپشن اینستاگرام حداکثر ۲۲۰۰ کاراکتر است.", 400);
  if (!isPublicUrl(mediaUrl)) throw new HttpError("لینک رسانه باید یک URL عمومی و معتبر باشد.", 400);
  if (requireScheduleField && payload.scheduledAt === undefined) throw new HttpError("زمان انتشار مشخص نیست.", 400);

  let scheduledAt: string | null = null;
  if (scheduledAtRaw) {
    const date = new Date(scheduledAtRaw);
    if (Number.isNaN(date.getTime())) throw new HttpError("زمان انتشار نامعتبر است.", 400);
    scheduledAt = date.toISOString().slice(0, 19).replace("T", " ");
  }

  return { caption, mediaUrl, mediaType, scheduledAt };
}

function isPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
  return await safeEqual(actual, expected);
}

async function safeEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(actualHash);
  const b = new Uint8Array(expectedHash);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError("بدنه JSON نامعتبر است.", 400);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return "خطای ناشناخته";
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractGraphError(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function suggestBestSlots(): Array<{ label: string; value: string; reason: string }> {
  const slots: Array<{ label: string; value: string; reason: string }> = [];
  const now = new Date();
  const preferredHours = [12, 18, 21];

  for (let dayOffset = 0; slots.length < 9 && dayOffset < 7; dayOffset += 1) {
    for (const hour of preferredHours) {
      const date = new Date(now);
      date.setDate(now.getDate() + dayOffset);
      date.setHours(hour, 0, 0, 0);
      if (date.getTime() <= now.getTime() + 30 * 60 * 1000) continue;
      slots.push({
        label: date.toLocaleString("fa-IR", { weekday: "long", hour: "2-digit", minute: "2-digit" }),
        value: date.toISOString().slice(0, 16),
        reason: hour === 21 ? "معمولاً برای سرگرمی و پست‌های سبک بهتر جواب می‌دهد." : hour === 18 ? "بعد از کار/دانشگاه، احتمال دیده‌شدن بالاتر است." : "برای پست‌های آموزشی و محصولی مناسب است."
      });
    }
  }

  return slots;
}

function renderDashboard(): string {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>اتوپستر اینستاگرام</title>
  <style>
    :root{color-scheme:dark;--bg:#0f1218;--card:#171b24;--soft:#202634;--line:#30384a;--text:#eef2ff;--muted:#9ca8bd;--brand:#ff4f7b;--brand2:#7c5cff;--ok:#30d158;--bad:#ff6961}
    *{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;background:radial-gradient(circle at top,#282036 0,#0f1218 42%);color:var(--text);min-height:100vh}
    .wrap{width:min(1120px,calc(100% - 28px));margin:0 auto;padding:28px 0 60px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px}
    h1{margin:0;font-size:28px}.sub{color:var(--muted);margin-top:6px}.badge{padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);color:var(--muted)}
    .grid{display:grid;grid-template-columns:380px 1fr;gap:18px}.card{background:rgba(23,27,36,.92);border:1px solid var(--line);border-radius:22px;padding:18px;box-shadow:0 20px 70px rgba(0,0,0,.22)}
    label{display:block;margin:14px 0 7px;color:#cbd4e3;font-size:14px}input,textarea,select,button{width:100%;border:1px solid var(--line);border-radius:14px;background:#111620;color:var(--text);padding:12px 13px;font:inherit}
    textarea{min-height:130px;resize:vertical;line-height:1.9}button{cursor:pointer;border:0;background:linear-gradient(135deg,var(--brand),var(--brand2));font-weight:700;margin-top:14px}
    button.secondary{background:var(--soft);border:1px solid var(--line);font-weight:500}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.hint{font-size:12px;color:var(--muted);line-height:1.8}
    .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px}.toolbar button{margin:0;width:auto;padding:10px 13px}.posts{display:grid;gap:12px}
    .post{border:1px solid var(--line);background:#111620;border-radius:18px;padding:14px;display:grid;gap:10px}.postTop{display:flex;justify-content:space-between;gap:10px;align-items:center}
    .status{font-size:12px;border-radius:999px;padding:6px 10px;background:#273047;color:#cbd4e3}.status.published{background:rgba(48,209,88,.12);color:#8ff0a4}.status.failed{background:rgba(255,105,97,.14);color:#ffaaa5}
    .caption{white-space:pre-wrap;line-height:1.9}.media{direction:ltr;text-align:left;color:#9fc2ff;word-break:break-all;font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}.actions button{width:auto;margin:0;padding:9px 12px}
    .empty{border:1px dashed var(--line);border-radius:18px;padding:32px;text-align:center;color:var(--muted)}dialog{border:1px solid var(--line);border-radius:22px;background:var(--card);color:var(--text);max-width:520px;width:calc(100% - 24px)}
    dialog::backdrop{background:rgba(0,0,0,.65)}.slot{padding:10px;border:1px solid var(--line);border-radius:14px;margin-top:8px;background:#111620}.slot small{display:block;color:var(--muted);margin-top:5px;line-height:1.8}
    @media(max-width:840px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="top">
      <div>
        <h1>اتوپستر اینستاگرام</h1>
        <div class="sub">محتوا را تو می‌دهی؛ سیستم زمان‌بندی و انتشار رسمی را انجام می‌دهد.</div>
      </div>
      <div class="badge" id="connection">در حال بررسی اتصال...</div>
    </section>

    <section class="grid">
      <form class="card" id="postForm">
        <h2>پست جدید</h2>
        <label>رمز پنل</label>
        <input id="token" type="password" placeholder="رمز را وارد کن" autocomplete="current-password" />
        <label>نوع محتوا</label>
        <select id="mediaType"><option value="IMAGE">عکس</option><option value="REELS">Reels / ویدئو</option></select>
        <label>لینک عمومی عکس یا ویدئو</label>
        <input id="mediaUrl" placeholder="https://example.com/photo.jpg" dir="ltr" />
        <label>کپشن</label>
        <textarea id="caption" placeholder="کپشن پست..." maxlength="2200"></textarea>
        <div class="row">
          <div>
            <label>زمان انتشار</label>
            <input id="scheduledAt" type="datetime-local" />
          </div>
          <div>
            <label>کمک هوشمند</label>
            <button class="secondary" type="button" id="slotsBtn">پیشنهاد ساعت</button>
          </div>
        </div>
        <p class="hint">اگر زمان را خالی بگذاری، پست به‌صورت پیش‌نویس ذخیره می‌شود. انتشار خودکار هر ۵ دقیقه پست‌های آماده را بررسی می‌کند.</p>
        <button type="submit">ذخیره پست</button>
        <p class="hint" id="message"></p>
      </form>

      <section class="card">
        <div class="toolbar">
          <button class="secondary" id="refreshBtn">تازه‌سازی</button>
          <button class="secondary" data-filter="">همه</button>
          <button class="secondary" data-filter="scheduled">زمان‌بندی‌شده</button>
          <button class="secondary" data-filter="failed">خطادار</button>
          <button class="secondary" data-filter="published">منتشرشده</button>
        </div>
        <div class="posts" id="posts"></div>
      </section>
    </section>
  </main>

  <dialog id="slotsDialog">
    <h3>ساعت‌های پیشنهادی</h3>
    <div id="slots"></div>
    <button class="secondary" onclick="slotsDialog.close()">بستن</button>
  </dialog>

  <script>
    const $ = (id) => document.getElementById(id);
    const tokenInput = $("token");
    const message = $("message");
    let filter = "";
    tokenInput.value = localStorage.getItem("ig_auto_admin_token") || "";

    function authHeaders() {
      return { "content-type": "application/json", "authorization": "Bearer " + tokenInput.value };
    }
    function statusText(status) {
      return {draft:"پیش‌نویس",scheduled:"زمان‌بندی‌شده",publishing:"در حال انتشار",published:"منتشرشده",failed:"خطادار",cancelled:"لغوشده"}[status] || status;
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#039;" }[char]));
    }
    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "درخواست ناموفق بود.");
      return data;
    }
    async function loadMe() {
      try {
        const data = await api("/api/me");
        $("connection").textContent = data.connected ? "اتصال Meta آماده است" : "توکن اینستاگرام تنظیم نشده";
      } catch {
        $("connection").textContent = "برای دیدن پنل، رمز را وارد کن";
      }
    }
    async function loadPosts() {
      localStorage.setItem("ig_auto_admin_token", tokenInput.value);
      const query = filter ? "?status=" + encodeURIComponent(filter) : "";
      const data = await api("/api/posts" + query);
      const posts = $("posts");
      if (!data.posts.length) {
        posts.innerHTML = '<div class="empty">هنوز پستی ثبت نشده.</div>';
        return;
      }
      posts.innerHTML = data.posts.map((post) => \`
        <article class="post">
          <div class="postTop">
            <span class="status \${post.status}">\${statusText(post.status)}</span>
            <small>\${escapeHtml(post.scheduled_at || post.created_at)}</small>
          </div>
          <div class="caption">\${escapeHtml(post.caption)}</div>
          <div class="media">\${escapeHtml(post.media_url)}</div>
          \${post.last_error ? '<div class="hint" style="color:var(--bad)">خطا: ' + escapeHtml(post.last_error) + '</div>' : ''}
          <div class="actions">
            <button class="secondary" onclick="publishNow('\${post.id}')">انتشار فوری</button>
            <button class="secondary" onclick="removePost('\${post.id}')">حذف</button>
          </div>
        </article>
      \`).join("");
    }
    async function publishNow(id) {
      if (!confirm("الان منتشر شود؟")) return;
      await api("/api/posts/" + id + "/publish-now", { method: "POST" });
      await loadPosts();
    }
    async function removePost(id) {
      if (!confirm("حذف شود؟")) return;
      await api("/api/posts/" + id, { method: "DELETE" });
      await loadPosts();
    }
    $("postForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      message.textContent = "در حال ذخیره...";
      try {
        await api("/api/posts", {
          method: "POST",
          body: JSON.stringify({
            caption: $("caption").value,
            mediaUrl: $("mediaUrl").value,
            mediaType: $("mediaType").value,
            scheduledAt: $("scheduledAt").value
          })
        });
        message.textContent = "ذخیره شد.";
        $("caption").value = "";
        $("mediaUrl").value = "";
        $("scheduledAt").value = "";
        await loadPosts();
      } catch (error) {
        message.textContent = error.message;
      }
    });
    $("refreshBtn").addEventListener("click", loadPosts);
    document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
      filter = button.dataset.filter;
      loadPosts();
    }));
    $("slotsBtn").addEventListener("click", async () => {
      const data = await api("/api/smart/slots");
      $("slots").innerHTML = data.slots.map((slot) => \`<div class="slot"><button class="secondary" onclick="scheduledAt.value='\${slot.value}';slotsDialog.close()">\${escapeHtml(slot.label)}</button><small>\${escapeHtml(slot.reason)}</small></div>\`).join("");
      slotsDialog.showModal();
    });
    tokenInput.addEventListener("change", () => { loadMe(); loadPosts().catch(() => {}); });
    loadMe();
    loadPosts().catch(() => {});
  </script>
</body>
</html>`;
}
