type Env = {
  DB: D1Database;
  MEDIA: KVNamespace;
  AUTH_SECRET: string;
  GRAPH_API_VERSION?: string;
};

type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
type MediaType = "IMAGE" | "REELS";

type UserRecord = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  password_salt: string;
  role: "user" | "admin";
  created_at: string;
};

type SessionRecord = {
  user_id: string;
  expires_at: string;
};

type InstagramAccountRecord = {
  user_id: string;
  ig_user_id: string;
  access_token_cipher: string;
  access_token_iv: string;
  connected_at: string;
};

type PostRecord = {
  id: string;
  user_id: string;
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

type AuthPayload = {
  name?: unknown;
  email?: unknown;
  password?: unknown;
};

type ConnectInstagramPayload = {
  igUserId?: unknown;
  accessToken?: unknown;
};

type CreatePostPayload = {
  caption?: unknown;
  mediaUrl?: unknown;
  mediaType?: unknown;
  scheduledAt?: unknown;
};

type CountRecord = {
  status: PostStatus;
  count: number;
};

const MEDIA_LIMIT_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES: Record<string, { extension: string; mediaType: MediaType }> = {
  "image/jpeg": { extension: "jpg", mediaType: "IMAGE" },
  "image/png": { extension: "png", mediaType: "IMAGE" },
  "image/webp": { extension: "webp", mediaType: "IMAGE" },
  "video/mp4": { extension: "mp4", mediaType: "REELS" },
  "video/quicktime": { extension: "mov", mediaType: "REELS" }
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
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
  const path = normalizePath(url.pathname);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

  if ((request.method === "GET" || request.method === "HEAD") && path.startsWith("/media/")) return serveMedia(env, path, request.method === "HEAD");
  if (request.method === "GET" && path === "/") return html(renderApp());
  if (request.method === "GET" && path === "/health") return json({ ok: true, service: "instagram-auto-poster" });

  if (!path.startsWith("/api/")) return json({ ok: false, error: "مسیر پیدا نشد." }, 404);

  if (request.method === "POST" && path === "/api/auth/register") {
    const payload = await readJson<AuthPayload>(request);
    return json(await registerUser(env, payload), 201);
  }

  if (request.method === "POST" && path === "/api/auth/login") {
    const payload = await readJson<AuthPayload>(request);
    return json(await loginUser(env, payload));
  }

  const auth = await authenticate(request, env);
  if (!auth) return json({ ok: false, error: "اول وارد حساب کاربری شو." }, 401);

  if (request.method === "POST" && path === "/api/auth/logout") {
    await logout(request, env);
    return json({ ok: true });
  }

  if (request.method === "GET" && path === "/api/me") {
    const ig = await getInstagramAccount(env, auth.id);
    return json({
      ok: true,
      user: publicUser(auth),
      instagram: ig
        ? { connected: true, igUserId: ig.ig_user_id, connectedAt: ig.connected_at }
        : { connected: false }
    });
  }

  if (request.method === "GET" && path === "/api/stats") {
    return json(await getUserStats(env, auth.id));
  }

  if (request.method === "POST" && path === "/api/media/upload") {
    return json(await uploadMedia(request, env, auth), 201);
  }

  if (request.method === "POST" && path === "/api/instagram/connect") {
    const payload = await readJson<ConnectInstagramPayload>(request);
    const igUserId = String(payload.igUserId ?? "").trim();
    const accessToken = String(payload.accessToken ?? "").trim();
    if (!/^\d+$/.test(igUserId)) throw new HttpError("IG User ID باید عددی باشد.", 400);
    if (accessToken.length < 20) throw new HttpError("Access Token معتبر به نظر نمی‌رسد.", 400);

    const encrypted = await encryptSecret(env, accessToken);
    await env.DB.prepare(
      `INSERT INTO instagram_accounts (user_id, ig_user_id, access_token_cipher, access_token_iv, connected_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         ig_user_id = excluded.ig_user_id,
         access_token_cipher = excluded.access_token_cipher,
         access_token_iv = excluded.access_token_iv,
         connected_at = CURRENT_TIMESTAMP`
    ).bind(auth.id, igUserId, encrypted.cipher, encrypted.iv).run();

    return json({ ok: true, instagram: { connected: true, igUserId } });
  }

  if (request.method === "GET" && path === "/api/posts") {
    const status = url.searchParams.get("status");
    const result = status
      ? await env.DB.prepare(
          "SELECT * FROM posts WHERE user_id = ? AND status = ? ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 200"
        ).bind(auth.id, status).all<PostRecord>()
      : await env.DB.prepare(
          "SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 200"
        ).bind(auth.id).all<PostRecord>();
    return json({ ok: true, posts: result.results ?? [] });
  }

  if (request.method === "POST" && path === "/api/posts") {
    const payload = await readJson<CreatePostPayload>(request);
    const post = normalizePostPayload(payload);
    const id = crypto.randomUUID();
    const status: PostStatus = post.scheduledAt ? "scheduled" : "draft";

    await env.DB.prepare(
      `INSERT INTO posts (id, user_id, caption, media_url, media_type, status, scheduled_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(id, auth.id, post.caption, post.mediaUrl, post.mediaType, status, post.scheduledAt).run();
    await addEvent(env, id, "created", status === "scheduled" ? "پست زمان‌بندی شد." : "پیش‌نویس ساخته شد.");

    return json({ ok: true, post: await getPost(env, id, auth.id) }, 201);
  }

  const publishNowMatch = path.match(/^\/api\/posts\/([^/]+)\/publish-now$/);
  if (request.method === "POST" && publishNowMatch) {
    const id = publishNowMatch[1];
    const post = await getPost(env, id, auth.id);
    if (!post) return json({ ok: false, error: "پست پیدا نشد." }, 404);
    ctx.waitUntil(publishPost(env, post.id));
    return json({ ok: true, message: "انتشار شروع شد. چند لحظه بعد وضعیت را تازه‌سازی کن." });
  }

  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
  if (postMatch) {
    const id = postMatch[1];

    if (request.method === "PATCH") {
      const current = await getPost(env, id, auth.id);
      if (!current) return json({ ok: false, error: "پست پیدا نشد." }, 404);
      if (current.status === "publishing" || current.status === "published") {
        return json({ ok: false, error: "پست در حال انتشار یا منتشرشده قابل ویرایش نیست." }, 409);
      }

      const payload = await readJson<CreatePostPayload>(request);
      const post = normalizePostPayload(payload);
      const nextStatus: PostStatus = post.scheduledAt ? "scheduled" : "draft";
      await env.DB.prepare(
        `UPDATE posts
         SET caption = ?, media_url = ?, media_type = ?, status = ?, scheduled_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
      ).bind(post.caption, post.mediaUrl, post.mediaType, nextStatus, post.scheduledAt, id, auth.id).run();
      await addEvent(env, id, "updated", "پست ویرایش شد.");
      return json({ ok: true, post: await getPost(env, id, auth.id) });
    }

    if (request.method === "DELETE") {
      const current = await getPost(env, id, auth.id);
      if (!current) return json({ ok: false, error: "پست پیدا نشد." }, 404);
      if (current.status === "publishing") {
        return json({ ok: false, error: "پست در حال انتشار است و الان حذف نمی‌شود." }, 409);
      }
      await env.DB.prepare("DELETE FROM posts WHERE id = ? AND user_id = ?").bind(id, auth.id).run();
      return json({ ok: true });
    }
  }

  if (request.method === "GET" && path === "/api/smart/slots") {
    return json({
      ok: true,
      slots: suggestBestSlots({
        timeZone: url.searchParams.get("tz") || "UTC",
        mediaType: url.searchParams.get("mediaType") || "IMAGE",
        caption: url.searchParams.get("caption") || ""
      })
    });
  }

  return json({ ok: false, error: "درخواست نامعتبر است." }, 404);
}

async function serveMedia(env: Env, path: string, headOnly = false): Promise<Response> {
  const key = decodeURIComponent(path.slice("/media/".length));
  if (!key || key.includes("..")) return json({ ok: false, error: "Invalid media key." }, 400);
  const [body, metadataRaw] = await Promise.all([
    env.MEDIA.get(key, { type: "stream" }),
    env.MEDIA.get(`${key}:meta`)
  ]);
  if (!body) return json({ ok: false, error: "Media not found." }, 404);

  const metadata = parseMediaMetadata(metadataRaw);
  return new Response(headOnly ? null : body, {
    headers: {
      "content-type": metadata.contentType,
      "content-disposition": `inline; filename="${metadata.name.replace(/"/g, "")}"`,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}

function parseMediaMetadata(value: string | null): { contentType: string; name: string } {
  if (!value) return { contentType: "application/octet-stream", name: "media" };
  try {
    const parsed = JSON.parse(value) as { contentType?: unknown; name?: unknown };
    return {
      contentType: typeof parsed.contentType === "string" ? parsed.contentType : "application/octet-stream",
      name: typeof parsed.name === "string" ? parsed.name : "media"
    };
  } catch {
    return { contentType: "application/octet-stream", name: "media" };
  }
}

function mediaUrlFromKey(origin: string, key: string): string {
  return `${origin}/media/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function safeOriginalName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "").trim().slice(0, 120) || "media";
}

async function uploadMedia(request: Request, env: Env, user: UserRecord): Promise<Record<string, unknown>> {
  const form = await request.formData();
  const rawFile = form.get("file");
  if (!(rawFile instanceof File)) throw new HttpError("Upload a media file first.", 400);

  const contentType = rawFile.type || "application/octet-stream";
  const media = MEDIA_TYPES[contentType];
  if (!media) throw new HttpError("Only JPG, PNG, WEBP, MP4, or MOV files are supported.", 400);
  if (rawFile.size <= 0) throw new HttpError("The uploaded file is empty.", 400);
  if (rawFile.size > MEDIA_LIMIT_BYTES) throw new HttpError("Media file is too large. Maximum size is 25 MB.", 413);

  const key = `${user.id}/${crypto.randomUUID()}.${media.extension}`;
  const body = await rawFile.arrayBuffer();
  const name = safeOriginalName(rawFile.name);
  await Promise.all([
    env.MEDIA.put(key, body),
    env.MEDIA.put(`${key}:meta`, JSON.stringify({ contentType, name, size: rawFile.size, userId: user.id }))
  ]);

  const url = new URL(request.url);
  return {
    ok: true,
    media: {
      url: mediaUrlFromKey(url.origin, key),
      type: media.mediaType,
      contentType,
      size: rawFile.size,
      name
    }
  };
}

async function getUserStats(env: Env, userId: string): Promise<Record<string, unknown>> {
  const grouped = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM posts WHERE user_id = ? GROUP BY status"
  ).bind(userId).all<CountRecord>();
  const counts: Record<string, number> = {
    draft: 0,
    scheduled: 0,
    publishing: 0,
    published: 0,
    failed: 0,
    cancelled: 0
  };
  for (const row of grouped.results ?? []) counts[row.status] = Number(row.count) || 0;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const ig = await getInstagramAccount(env, userId);
  return {
    ok: true,
    stats: {
      totalPosts: total,
      scheduledPosts: counts.scheduled,
      publishedPosts: counts.published,
      failedPosts: counts.failed,
      instagramConnected: Boolean(ig),
      mediaUploadEnabled: true
    }
  };
}

function normalizePath(pathname: string): string {
  if (pathname === "/auto-post") return "/";
  if (pathname.startsWith("/auto-post/")) return pathname.slice("/auto-post".length) || "/";
  return pathname;
}

async function registerUser(env: Env, payload: AuthPayload): Promise<Record<string, unknown>> {
  const name = String(payload.name ?? "").trim().slice(0, 80);
  const email = normalizeEmail(payload.email);
  const password = String(payload.password ?? "");

  if (name.length < 2) throw new HttpError("نام خیلی کوتاه است.", 400);
  validateEmailAndPassword(email, password);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (existing) throw new HttpError("این ایمیل قبلاً ثبت شده است.", 409);

  const salt = randomBase64Url(18);
  const passwordHash = await hashPassword(password, salt, env.AUTH_SECRET);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    "INSERT INTO users (id, name, email, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, name, email, passwordHash, salt).run();

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRecord>();
  if (!user) throw new HttpError("ساخت حساب ناموفق بود.", 500);
  const token = await createSession(env, user.id);
  return { ok: true, token, user: publicUser(user) };
}

async function loginUser(env: Env, payload: AuthPayload): Promise<Record<string, unknown>> {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password ?? "");
  validateEmailAndPassword(email, password);

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRecord>();
  if (!user) throw new HttpError("ایمیل یا رمز اشتباه است.", 401);

  const passwordHash = await hashPassword(password, user.password_salt, env.AUTH_SECRET);
  if (!(await safeEqual(passwordHash, user.password_hash))) throw new HttpError("ایمیل یا رمز اشتباه است.", 401);

  const token = await createSession(env, user.id);
  return { ok: true, token, user: publicUser(user) };
}

async function authenticate(request: Request, env: Env): Promise<UserRecord | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;

  const tokenHash = await hashSessionToken(token, env.AUTH_SECRET);
  const session = await env.DB.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')"
  ).bind(tokenHash).first<SessionRecord>();
  if (!session) return null;

  return await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first<UserRecord>();
}

async function logout(request: Request, env: Env): Promise<void> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashSessionToken(token, env.AUTH_SECRET)).run();
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomBase64Url(36);
  const tokenHash = await hashSessionToken(token, env.AUTH_SECRET);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 19).replace("T", " ");
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt).run();
  return token;
}

async function processDuePosts(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT * FROM posts
     WHERE status = 'scheduled'
       AND scheduled_at IS NOT NULL
       AND scheduled_at <= datetime('now')
     ORDER BY scheduled_at ASC
     LIMIT 10`
  ).all<PostRecord>();

  for (const post of due.results ?? []) {
    await publishPost(env, post.id);
  }
}

async function publishPost(env: Env, postId: string): Promise<void> {
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first<PostRecord>();
  if (!post) return;
  if (post.status === "publishing" || post.status === "published" || post.status === "cancelled") return;

  await env.DB.prepare("UPDATE posts SET status = 'publishing', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(post.id).run();
  await addEvent(env, post.id, "publishing", "ارسال به Instagram Graph API شروع شد.");

  try {
    const account = await getInstagramAccount(env, post.user_id);
    if (!account) throw new Error("این کاربر هنوز اکانت اینستاگرام را وصل نکرده است.");
    const accessToken = await decryptSecret(env, account.access_token_cipher, account.access_token_iv);
    const result = await publishToInstagram(env, post, account.ig_user_id, accessToken);

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
    console.error(JSON.stringify({ level: "error", message: "Instagram publish failed", postId: post.id, userId: post.user_id, error: message }));
    await env.DB.prepare(
      "UPDATE posts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(message, post.id).run();
    await addEvent(env, post.id, "failed", message);
  }
}

async function publishToInstagram(
  env: Env,
  post: PostRecord,
  igUserId: string,
  accessToken: string
): Promise<{ creationId: string; mediaId: string }> {
  const graphVersion = env.GRAPH_API_VERSION ?? "v23.0";
  const base = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(igUserId)}`;
  const createBody = new URLSearchParams();
  createBody.set("caption", post.caption);
  createBody.set("access_token", accessToken);

  if (post.media_type === "REELS") {
    createBody.set("media_type", "REELS");
    createBody.set("video_url", post.media_url);
  } else {
    createBody.set("image_url", post.media_url);
  }

  const createResponse = await fetch(`${base}/media`, { method: "POST", body: createBody });
  const createJson = await safeJson(createResponse);
  if (!createResponse.ok || typeof createJson.id !== "string") {
    throw new Error(extractGraphError(createJson, "ساخت media container ناموفق بود."));
  }

  const publishBody = new URLSearchParams();
  publishBody.set("creation_id", createJson.id);
  publishBody.set("access_token", accessToken);

  const publishResponse = await fetch(`${base}/media_publish`, { method: "POST", body: publishBody });
  const publishJson = await safeJson(publishResponse);
  if (!publishResponse.ok || typeof publishJson.id !== "string") {
    throw new Error(extractGraphError(publishJson, "انتشار پست ناموفق بود."));
  }

  return { creationId: createJson.id, mediaId: publishJson.id };
}

async function getInstagramAccount(env: Env, userId: string): Promise<InstagramAccountRecord | null> {
  return await env.DB.prepare("SELECT * FROM instagram_accounts WHERE user_id = ?").bind(userId).first<InstagramAccountRecord>();
}

async function getPost(env: Env, id: string, userId: string): Promise<PostRecord | null> {
  return await env.DB.prepare("SELECT * FROM posts WHERE id = ? AND user_id = ?").bind(id, userId).first<PostRecord>();
}

async function addEvent(env: Env, postId: string, eventType: string, message: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO post_events (id, post_id, event_type, message) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), postId, eventType, message).run();
}

function normalizePostPayload(payload: CreatePostPayload): {
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

  let scheduledAt: string | null = null;
  if (scheduledAtRaw) {
    const date = new Date(scheduledAtRaw);
    if (Number.isNaN(date.getTime())) throw new HttpError("زمان انتشار نامعتبر است.", 400);
    scheduledAt = date.toISOString().slice(0, 19).replace("T", " ");
  }

  return { caption, mediaUrl, mediaType, scheduledAt };
}

function validateEmailAndPassword(email: string, password: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError("ایمیل معتبر نیست.", 400);
  if (password.length < 8) throw new HttpError("رمز باید حداقل ۸ کاراکتر باشد.", 400);
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function publicUser(user: UserRecord): Record<string, string> {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function isPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function hashPassword(password: string, salt: string, pepper: string): Promise<string> {
  const bytes = new TextEncoder().encode(`password:v2:${salt}:${password}:${pepper ?? ""}`);
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hashSessionToken(token: string, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(token + ":" + secret);
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.AUTH_SECRET));
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env: Env, value: string): Promise<{ cipher: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(value));
  return { cipher: base64Url(new Uint8Array(cipher)), iv: base64Url(iv) };
}

async function decryptSecret(env: Env, cipher: string, iv: string): Promise<string> {
  const ivBytes = fromBase64Url(iv);
  const cipherBytes = fromBase64Url(cipher);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
    await encryptionKey(env),
    toArrayBuffer(cipherBytes)
  );
  return new TextDecoder().decode(plain);
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

function randomBase64Url(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

function suggestBestSlots(options: { timeZone: string; mediaType: string; caption: string }): Array<{ label: string; value: string; reason: string; score: number }> {
  const timeZone = normalizeTimeZone(options.timeZone);
  const mediaType = String(options.mediaType || "IMAGE").toUpperCase();
  const caption = String(options.caption || "").toLowerCase();
  const now = new Date();
  const candidates: Array<{ date: Date; hour: number; dayOffset: number; score: number; reason: string }> = [];
  const candidateHours = [7, 8, 9, 11, 12, 13, 17, 18, 19, 20, 21, 22];

  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    for (const hour of candidateHours) {
      const date = buildLocalSlot(now, dayOffset, hour);
      if (date.getTime() <= now.getTime() + 45 * 60 * 1000) continue;
      const profile = scorePublishingSlot({ date, hour, dayOffset, mediaType, caption });
      candidates.push({ date, hour, dayOffset, score: profile.score, reason: profile.reason });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.date.getTime() - b.date.getTime())
    .slice(0, 9)
    .map((slot) => ({
      label: formatSlotLabel(slot.date, timeZone),
      value: formatSlotInputValue(slot.date, timeZone),
      reason: slot.reason,
      score: slot.score
    }));
}

function buildLocalSlot(now: Date, dayOffset: number, hour: number): Date {
  const date = new Date(now);
  date.setDate(now.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function scorePublishingSlot(input: { date: Date; hour: number; dayOffset: number; mediaType: string; caption: string }): { score: number; reason: string } {
  const day = input.date.getDay();
  const isWeekend = day === 0 || day === 6;
  const isReels = input.mediaType === "REELS";
  let score = 44;
  const reasons: string[] = [];

  if ([18, 19, 20, 21].includes(input.hour)) {
    score += isReels ? 28 : 22;
    reasons.push("strong evening engagement window");
  } else if ([11, 12, 13].includes(input.hour)) {
    score += 15;
    reasons.push("good lunch-break discovery window");
  } else if ([8, 9].includes(input.hour)) {
    score += 10;
    reasons.push("morning check-in audience activity");
  } else {
    score += 4;
    reasons.push("secondary audience window");
  }

  if (isWeekend && [11, 12, 20, 21].includes(input.hour)) {
    score += 9;
    reasons.push("weekend browsing behavior");
  }
  if (!isWeekend && [18, 19, 20].includes(input.hour)) {
    score += 8;
    reasons.push("after-work activity");
  }
  if (input.dayOffset === 0) score -= 8;
  if (input.dayOffset >= 1 && input.dayOffset <= 4) score += 5 - input.dayOffset;
  if (input.dayOffset >= 5) score -= 2;
  if (day === 2 || day === 3 || day === 4) score += 3;
  if (day === 1) score += 1;

  if (/\b(sale|offer|launch|product|shop|buy|discount)\b/.test(input.caption) && [11, 12, 18, 19].includes(input.hour)) {
    score += 8;
    reasons.push("commerce content timing");
  }
  if (/\b(tutorial|guide|learn|tips|how to|education)\b/.test(input.caption) && [8, 9, 12].includes(input.hour)) {
    score += 8;
    reasons.push("educational content timing");
  }
  if (/\b(fun|meme|story|behind|reel|vlog)\b/.test(input.caption) && [20, 21, 22].includes(input.hour)) {
    score += 8;
    reasons.push("entertainment content timing");
  }

  return {
    score: Math.max(1, Math.min(100, score)),
    reason: `${reasons.slice(0, 2).join(" + ")}. Predicted score: ${Math.max(1, Math.min(100, score))}/100.`
  };
}

function formatSlotLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatSlotInputValue(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function normalizeTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function renderApp(): string {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>اتوپستر اینستاگرام</title>
  <style>
    :root{color-scheme:dark;--bg:#0f1218;--card:#171b24;--soft:#202634;--line:#30384a;--text:#eef2ff;--muted:#9ca8bd;--brand:#ff4f7b;--brand2:#7c5cff;--ok:#30d158;--bad:#ff6961}
    *{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;background:radial-gradient(circle at top,#282036 0,#0f1218 42%);color:var(--text);min-height:100vh}
    .wrap{width:min(1160px,calc(100% - 28px));margin:0 auto;padding:28px 0 60px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px}
    h1,h2,h3{margin-top:0}.sub,.hint{color:var(--muted);line-height:1.8}.badge{padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);color:var(--muted)}
    .grid{display:grid;grid-template-columns:380px 1fr;gap:18px}.card{background:rgba(23,27,36,.92);border:1px solid var(--line);border-radius:22px;padding:18px;box-shadow:0 20px 70px rgba(0,0,0,.22)}
    label{display:block;margin:14px 0 7px;color:#cbd4e3;font-size:14px}input,textarea,select,button{width:100%;border:1px solid var(--line);border-radius:14px;background:#111620;color:var(--text);padding:12px 13px;font:inherit}
    textarea{min-height:130px;resize:vertical;line-height:1.9}button{cursor:pointer;border:0;background:linear-gradient(135deg,var(--brand),var(--brand2));font-weight:700;margin-top:14px}
    button.secondary{background:var(--soft);border:1px solid var(--line);font-weight:500}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.hidden{display:none!important}
    .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}.toolbar button{margin:0;width:auto;padding:10px 13px}.posts{display:grid;gap:12px}
    .post{border:1px solid var(--line);background:#111620;border-radius:18px;padding:14px;display:grid;gap:10px}.postTop{display:flex;justify-content:space-between;gap:10px;align-items:center}
    .status{font-size:12px;border-radius:999px;padding:6px 10px;background:#273047;color:#cbd4e3}.status.published{background:rgba(48,209,88,.12);color:#8ff0a4}.status.failed{background:rgba(255,105,97,.14);color:#ffaaa5}
    .caption{white-space:pre-wrap;line-height:1.9}.media{direction:ltr;text-align:left;color:#9fc2ff;word-break:break-all;font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}.actions button{width:auto;margin:0;padding:9px 12px}
    .empty{border:1px dashed var(--line);border-radius:18px;padding:32px;text-align:center;color:var(--muted)}.notice{border:1px solid rgba(255,255,255,.12);background:#111620;border-radius:18px;padding:14px;margin-bottom:14px}
    dialog{border:1px solid var(--line);border-radius:22px;background:var(--card);color:var(--text);max-width:520px;width:calc(100% - 24px)}dialog::backdrop{background:rgba(0,0,0,.65)}
    .slot{padding:10px;border:1px solid var(--line);border-radius:14px;margin-top:8px;background:#111620}.slot small{display:block;color:var(--muted);margin-top:5px;line-height:1.8}
    @media(max-width:840px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="top">
      <div>
        <h1>اتوپستر اینستاگرام</h1>
        <div class="sub">هر کاربر حساب خودش را دارد، اینستاگرام خودش را وصل می‌کند، و پست‌هایش جدا زمان‌بندی می‌شود.</div>
      </div>
      <div class="badge" id="accountBadge">در حال بررسی...</div>
    </section>

    <section class="grid" id="authView">
      <form class="card" id="loginForm">
        <h2>ورود</h2>
        <label>ایمیل</label><input id="loginEmail" type="email" autocomplete="email" />
        <label>رمز</label><input id="loginPassword" type="password" autocomplete="current-password" />
        <button type="submit">ورود</button>
        <p class="hint" id="loginMessage"></p>
      </form>
      <form class="card" id="registerForm">
        <h2>ثبت‌نام</h2>
        <label>نام</label><input id="registerName" autocomplete="name" />
        <label>ایمیل</label><input id="registerEmail" type="email" autocomplete="email" />
        <label>رمز</label><input id="registerPassword" type="password" autocomplete="new-password" />
        <button type="submit">ساخت حساب</button>
        <p class="hint">برای انتشار واقعی، بعد از ورود باید Instagram Business/Creator خودت را وصل کنی.</p>
        <p class="hint" id="registerMessage"></p>
      </form>
    </section>

    <section class="grid hidden" id="appView">
      <section>
        <form class="card" id="connectForm">
          <h2>اتصال اینستاگرام</h2>
          <p class="hint">فعلاً اتصال با IG User ID و Access Token رسمی Meta انجام می‌شود. رمز اینستاگرام را وارد نکن.</p>
          <label>IG User ID</label><input id="igUserId" dir="ltr" placeholder="1784..." />
          <label>Meta Access Token</label><input id="accessToken" dir="ltr" type="password" placeholder="EAAB..." />
          <button type="submit">ذخیره اتصال</button>
          <p class="hint" id="connectMessage"></p>
        </form>

        <form class="card" id="postForm" style="margin-top:18px">
          <h2>پست جدید</h2>
          <label>نوع محتوا</label>
          <select id="mediaType"><option value="IMAGE">عکس</option><option value="REELS">Reels / ویدئو</option></select>
          <label>لینک عمومی عکس یا ویدئو</label>
          <input id="mediaUrl" placeholder="https://example.com/photo.jpg" dir="ltr" />
          <label>کپشن</label>
          <textarea id="caption" placeholder="کپشن پست..." maxlength="2200"></textarea>
          <div class="row">
            <div><label>زمان انتشار</label><input id="scheduledAt" type="datetime-local" /></div>
            <div><label>کمک هوشمند</label><button class="secondary" type="button" id="slotsBtn">پیشنهاد ساعت</button></div>
          </div>
          <p class="hint">اگر زمان را خالی بگذاری، پست پیش‌نویس می‌شود. انتشار خودکار هر ۵ دقیقه پست‌های آماده را بررسی می‌کند.</p>
          <button type="submit">ذخیره پست</button>
          <p class="hint" id="postMessage"></p>
        </form>
      </section>

      <section class="card">
        <div class="notice" id="instagramNotice"></div>
        <div class="toolbar">
          <button class="secondary" id="refreshBtn">تازه‌سازی</button>
          <button class="secondary" data-filter="">همه</button>
          <button class="secondary" data-filter="scheduled">زمان‌بندی‌شده</button>
          <button class="secondary" data-filter="failed">خطادار</button>
          <button class="secondary" data-filter="published">منتشرشده</button>
          <button class="secondary" id="logoutBtn">خروج</button>
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
    let token = localStorage.getItem("ig_auto_user_token") || "";
    let filter = "";
    const apiPrefix = location.pathname.startsWith("/auto-post") ? "/auto-post" : "";

    function headers() { return { "content-type": "application/json", "authorization": "Bearer " + token }; }
    function statusText(status) {
      return {draft:"پیش‌نویس",scheduled:"زمان‌بندی‌شده",publishing:"در حال انتشار",published:"منتشرشده",failed:"خطادار",cancelled:"لغوشده"}[status] || status;
    }
    const htmlMap = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" };
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => htmlMap[char] || char);
    }
    async function api(path, options = {}) {
      const response = await fetch(apiPrefix + path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "درخواست ناموفق بود.");
      return data;
    }
    function setToken(nextToken) {
      token = nextToken;
      localStorage.setItem("ig_auto_user_token", token);
    }
    function showAuthed(isAuthed) {
      $("authView").classList.toggle("hidden", isAuthed);
      $("appView").classList.toggle("hidden", !isAuthed);
    }
    async function loadMe() {
      if (!token) { showAuthed(false); $("accountBadge").textContent = "حساب کاربری لازم است"; return; }
      try {
        const data = await api("/api/me");
        showAuthed(true);
        $("accountBadge").textContent = data.user.name + " / " + data.user.email;
        $("instagramNotice").textContent = data.instagram.connected
          ? "اینستاگرام وصل است: " + data.instagram.igUserId
          : "هنوز اینستاگرام وصل نشده؛ پست‌ها ذخیره می‌شوند ولی منتشر نمی‌شوند.";
        if (data.instagram.connected) $("igUserId").value = data.instagram.igUserId;
        await loadPosts();
      } catch {
        localStorage.removeItem("ig_auto_user_token");
        token = "";
        showAuthed(false);
        $("accountBadge").textContent = "لطفاً وارد شو";
      }
    }
    async function loadPosts() {
      const query = filter ? "?status=" + encodeURIComponent(filter) : "";
      const data = await api("/api/posts" + query);
      const posts = $("posts");
      if (!data.posts.length) {
        posts.innerHTML = '<div class="empty">هنوز پستی ثبت نشده.</div>';
        return;
      }
      posts.innerHTML = data.posts.map((post) => \`
        <article class="post">
          <div class="postTop"><span class="status \${post.status}">\${statusText(post.status)}</span><small>\${escapeHtml(post.scheduled_at || post.created_at)}</small></div>
          <div class="caption">\${escapeHtml(post.caption)}</div>
          <div class="media">\${escapeHtml(post.media_url)}</div>
          \${post.last_error ? '<div class="hint" style="color:var(--bad)">خطا: ' + escapeHtml(post.last_error) + '</div>' : ''}
          <div class="actions"><button class="secondary" onclick="publishNow('\${post.id}')">انتشار فوری</button><button class="secondary" onclick="removePost('\${post.id}')">حذف</button></div>
        </article>\`).join("");
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
    $("loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("loginMessage").textContent = "در حال ورود...";
      try {
        const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: $("loginEmail").value, password: $("loginPassword").value }) });
        setToken(data.token);
        $("loginMessage").textContent = "";
        await loadMe();
      } catch (error) { $("loginMessage").textContent = error.message; }
    });
    $("registerForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("registerMessage").textContent = "در حال ساخت حساب...";
      try {
        const data = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: $("registerName").value, email: $("registerEmail").value, password: $("registerPassword").value }) });
        setToken(data.token);
        $("registerMessage").textContent = "";
        await loadMe();
      } catch (error) { $("registerMessage").textContent = error.message; }
    });
    $("connectForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("connectMessage").textContent = "در حال ذخیره اتصال...";
      try {
        await api("/api/instagram/connect", { method: "POST", body: JSON.stringify({ igUserId: $("igUserId").value, accessToken: $("accessToken").value }) });
        $("accessToken").value = "";
        $("connectMessage").textContent = "اتصال ذخیره شد.";
        await loadMe();
      } catch (error) { $("connectMessage").textContent = error.message; }
    });
    $("postForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("postMessage").textContent = "در حال ذخیره...";
      try {
        await api("/api/posts", { method: "POST", body: JSON.stringify({ caption: $("caption").value, mediaUrl: $("mediaUrl").value, mediaType: $("mediaType").value, scheduledAt: $("scheduledAt").value }) });
        $("postMessage").textContent = "ذخیره شد.";
        $("caption").value = ""; $("mediaUrl").value = ""; $("scheduledAt").value = "";
        await loadPosts();
      } catch (error) { $("postMessage").textContent = error.message; }
    });
    $("refreshBtn").addEventListener("click", loadPosts);
    $("logoutBtn").addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST" }); } catch {}
      localStorage.removeItem("ig_auto_user_token"); token = ""; showAuthed(false); $("accountBadge").textContent = "خارج شدی";
    });
    document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { filter = button.dataset.filter; loadPosts(); }));
    $("slotsBtn").addEventListener("click", async () => {
      const params = new URLSearchParams({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        mediaType: $("mediaType").value,
        caption: $("caption").value.slice(0, 500)
      });
      const data = await api("/api/smart/slots?" + params.toString());
      $("slots").innerHTML = data.slots.map((slot) => \`<div class="slot"><button class="secondary" onclick="scheduledAt.value='\${slot.value}';slotsDialog.close()">\${escapeHtml(slot.label)} · \${escapeHtml(String(slot.score || ""))}/100</button><small>\${escapeHtml(slot.reason)}</small></div>\`).join("");
      slotsDialog.showModal();
    });
    loadMe();
  </script>
</body>
</html>`;
}
