// Now Playing → Telegram-канал. Cloudflare Worker (бесплатный план).
// Раз в минуту (cron) проверяет, что играет в Spotify, и редактирует один пост в канале.
//
// Переменные (Settings → Variables and Secrets):
//   TG_TOKEN              — токен бота от @BotFather            (secret)
//   TG_CHANNEL            — @username канала или -100...        (text)
//   SPOTIFY_CLIENT_ID     — Client ID приложения Spotify        (text)
//   SPOTIFY_CLIENT_SECRET — Client secret приложения Spotify    (secret)
//   ADMIN_KEY             — любой свой пароль для /login и /status (secret)
//   CHECKS_PER_MINUTE     — необязательно, 1–4, по умолчанию 3
// Хранилище: KV binding NP (если добавлен вручную) или Durable Object STORE из wrangler.jsonc

import { DurableObject } from "cloudflare:workers";

export class Store extends DurableObject {
  async get(k) { return (await this.ctx.storage.get(k)) ?? null; }
  async put(k, v) { await this.ctx.storage.put(k, v); }
  async delete(k) { await this.ctx.storage.delete(k); }
}

// Подменяем env.NP единым интерфейсом get/put/delete
function withStore(env) {
  if (env.NP || !env.STORE) return env;
  const stub = env.STORE.get(env.STORE.idFromName("main"));
  const NP = {
    async get(k, type) {
      const v = await stub.get(k);
      return v != null && type === "json" ? JSON.parse(v) : v;
    },
    put: (k, v) => stub.put(k, v),
    delete: (k) => stub.delete(k),
  };
  return { ...env, NP };
}

const SPOTIFY_SCOPES = "user-read-currently-playing user-read-playback-state";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronTick(withStore(env)));
  },

  async fetch(request, env) {
    env = withStore(env);
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const authed = env.ADMIN_KEY && key === env.ADMIN_KEY;
    const redirectUri = `${url.origin}/callback`;

    try {
      switch (url.pathname) {
        case "/":
          return page("Now Playing бот работает",
            "Открой <code>/login?key=ТВОЙ_ADMIN_KEY</code>, чтобы подключить Spotify, или <code>/status?key=…</code>, чтобы посмотреть состояние.");

        case "/login": {
          if (!authed) return page("Нет доступа", "Добавь к ссылке <code>?key=</code> со своим ADMIN_KEY.", 403);
          checkEnv(env);
          const state = crypto.randomUUID();
          await env.NP.put("oauth_state", state);
          const auth = new URL("https://accounts.spotify.com/authorize");
          auth.search = new URLSearchParams({
            client_id: env.SPOTIFY_CLIENT_ID,
            response_type: "code",
            redirect_uri: redirectUri,
            scope: SPOTIFY_SCOPES,
            state,
          });
          return Response.redirect(auth.toString(), 302);
        }

        case "/callback": {
          const err = url.searchParams.get("error");
          if (err) return page("Spotify отказал", `Ошибка: ${esc(err)}`, 400);
          const saved = await env.NP.get("oauth_state");
          if (!saved || saved !== url.searchParams.get("state")) {
            return page("Ссылка устарела", "Открой /login ещё раз.", 400);
          }
          const tok = await spotifyToken(env, {
            grant_type: "authorization_code",
            code: url.searchParams.get("code"),
            redirect_uri: redirectUri,
          });
          await env.NP.put("refresh_token", tok.refresh_token);
          await env.NP.delete("oauth_state");
          const res = await tick(env);
          return page("Spotify подключён ✅", `Бот будет обновлять пост раз в минуту. Сейчас: ${esc(res)}`);
        }

        case "/status": {
          if (!authed) return page("Нет доступа", "Нужен <code>?key=</code>.", 403);
          const state = await loadState(env);
          const hasToken = !!(await env.NP.get("refresh_token"));
          return json({ spotify_connected: hasToken, ...state });
        }

        case "/run": {
          if (!authed) return page("Нет доступа", "Нужен <code>?key=</code>.", 403);
          const force = url.searchParams.has("force");
          if (force) {
            const s = await loadState(env);
            s.key = "__force__";
            s.idle = false;
            await saveState(env, s);
          }
          return json({ result: await tick(env) });
        }

        case "/reset": {
          // Забыть пост: следующий трек создаст новый пост в канале
          if (!authed) return page("Нет доступа", "Нужен <code>?key=</code>.", 403);
          await env.NP.delete("state");
          return json({ ok: true, result: await tick(env) });
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (e) {
      return page("Ошибка", esc(e.message || String(e)), 500);
    }
  },
};

// ---------------------------------------------------------------- main logic

async function cronTick(env) {
  const n = Math.min(4, Math.max(1, parseInt(env.CHECKS_PER_MINUTE || "3", 10) || 3));
  const gap = 60000 / n;
  const start = Date.now();
  for (let i = 0; i < n; i++) {
    try {
      await tick(env);
    } catch (e) {
      console.log("tick error:", e.message || e);
      if (e.fatal) return;
    }
    if (i < n - 1) {
      const wait = start + gap * (i + 1) - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
}

async function tick(env) {
  checkEnv(env);
  const refresh = await env.NP.get("refresh_token");
  if (!refresh) return "Spotify ещё не подключён — открой /login?key=…";

  const state = await loadState(env);
  const now = await currentlyPlaying(env, refresh);

  if (now) {
    if (now.key === state.key && !state.idle) return `без изменений: ${now.title}`;
    await showTrack(env, state, now);
    state.key = now.key;
    state.idle = false;
    state.last = { title: now.title, artist: now.artist, cover: now.cover, url: now.url };
    await saveState(env, state);
    return `играет: ${now.title} — ${now.artist}`;
  }

  if (state.idle) return "ничего не играет";
  if (state.message_id) await showIdle(env, state);
  state.key = null;
  state.idle = true;
  await saveState(env, state);
  return "ничего не играет (обновил пост)";
}

// ---------------------------------------------------------------- spotify

async function spotifyToken(env, params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Spotify token: ${j.error_description || j.error || r.status}`);
    if (j.error === "invalid_grant" || j.error === "invalid_client") e.fatal = true;
    throw e;
  }
  return j;
}

let cachedAccess = null; // живёт, пока жив изолят — экономит запросы

async function accessToken(env, refresh) {
  if (cachedAccess && cachedAccess.refresh === refresh && Date.now() < cachedAccess.exp) {
    return cachedAccess.token;
  }
  const j = await spotifyToken(env, { grant_type: "refresh_token", refresh_token: refresh });
  if (j.refresh_token && j.refresh_token !== refresh) await env.NP.put("refresh_token", j.refresh_token);
  cachedAccess = {
    refresh: j.refresh_token || refresh,
    token: j.access_token,
    exp: Date.now() + (j.expires_in - 120) * 1000,
  };
  return cachedAccess.token;
}

async function currentlyPlaying(env, refresh) {
  const token = await accessToken(env, refresh);
  const r = await fetch(
    "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (r.status === 204) return null;
  if (r.status === 401) cachedAccess = null;
  if (!r.ok) throw new Error(`Spotify ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const it = j.item;
  if (!j.is_playing || !it) return null;

  let artist, images;
  if (it.type === "episode") {
    artist = it.show?.name || "";
    images = it.images || it.show?.images || [];
  } else {
    artist = (it.artists || []).map((a) => a.name).join(", ");
    images = it.album?.images || [];
  }
  return {
    key: it.id || `${it.name}|${artist}`,
    title: it.name || "Без названия",
    artist,
    album: it.type === "episode" ? "" : it.album?.name || "",
    cover: images[0]?.url || null,
    url: it.external_urls?.spotify || null,
  };
}

// ---------------------------------------------------------------- telegram

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) {
    const e = new Error(`Telegram ${method}: ${j.description}`);
    e.description = (j.description || "").toLowerCase();
    throw e;
  }
  return j.result;
}

function buttons(url) {
  return url ? { inline_keyboard: [[{ text: "▶ Открыть в Spotify", url }]] } : undefined;
}

function captionPlaying(t) {
  let s = `🎧 <b>Сейчас слушаю</b>\n\n<b>${esc(t.title)}</b>\n${esc(t.artist)}`;
  if (t.album && t.album !== t.title) s += `\n<i>${esc(t.album)}</i>`;
  return s;
}

function captionIdle(last) {
  let s = "💤 <b>Сейчас ничего не играет</b>";
  if (last) s += `\n\nПоследним был: <b>${esc(last.title)}</b> — ${esc(last.artist)}`;
  return s;
}

const FALLBACK_COVER = "https://dummyimage.com/640x640/1e1e28/a784ff.png&text=%E2%99%AA";

async function showTrack(env, state, t) {
  const media = {
    type: "photo",
    media: t.cover || FALLBACK_COVER,
    caption: captionPlaying(t),
    parse_mode: "HTML",
  };
  const markup = buttons(t.url);

  if (state.message_id) {
    try {
      await tg(env, "editMessageMedia", {
        chat_id: env.TG_CHANNEL,
        message_id: state.message_id,
        media,
        reply_markup: markup,
      });
      return;
    } catch (e) {
      if (e.description?.includes("not modified")) return;
      if (!/not found|can't be edited|message_id_invalid/.test(e.description || "")) throw e;
    }
  }
  const msg = await tg(env, "sendPhoto", {
    chat_id: env.TG_CHANNEL,
    photo: media.media,
    caption: media.caption,
    parse_mode: "HTML",
    reply_markup: markup,
    disable_notification: true,
  });
  state.message_id = msg.message_id;
}

async function showIdle(env, state) {
  try {
    await tg(env, "editMessageCaption", {
      chat_id: env.TG_CHANNEL,
      message_id: state.message_id,
      caption: captionIdle(state.last),
      parse_mode: "HTML",
      reply_markup: buttons(state.last?.url),
    });
  } catch (e) {
    if (e.description?.includes("not modified")) return;
    if (/not found|can't be edited|message_id_invalid/.test(e.description || "")) {
      state.message_id = null;
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- helpers

async function loadState(env) {
  return (await env.NP.get("state", "json")) || { message_id: null, key: null, idle: false, last: null };
}

async function saveState(env, s) {
  await env.NP.put("state", JSON.stringify(s));
}

function checkEnv(env) {
  const need = ["TG_TOKEN", "TG_CHANNEL", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "ADMIN_KEY"];
  const missing = need.filter((k) => !env[k]);
  if (!env.NP) missing.push("хранилище (KV NP или Durable Object STORE)");
  if (missing.length) {
    const e = new Error("Не заданы переменные: " + missing.join(", "));
    e.fatal = true;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#111318;color:#eee;padding:24px;max-width:560px;margin:auto;line-height:1.5">
<h2>${title}</h2><p>${body}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
