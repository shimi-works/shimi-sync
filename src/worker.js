// shimi-sync: 単一HTMLアプリ群のための同期コード方式データ同期API
//
//   GET /v1/:app/:code   → 200 {updatedAt, data} | 404
//   PUT /v1/:app/:code   → body {baseUpdatedAt, updatedAt, data}
//                          保存済みの updatedAt が baseUpdatedAt と一致しないときは
//                          409 + 保存済みblob を返す（クライアント側でマージして再送する）
//
// 認証はコードそのもの（推測不能な長さのランダム文字列）。オリジン制限はしない
// （コードを知らない相手には何も読めない設計のため）。

const CODE_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$/; // 紛らわしい文字(I,L,O,0,1)抜き・約99bit
const APP_RE = /^[a-z0-9-]{1,32}$/;
const MAX_BYTES = 2_000_000; // 1blobの上限（localStorage全体より十分大きい）

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const m = new URL(request.url).pathname.match(/^\/v1\/([^/]+)\/([^/]+)$/);
    if (!m) return json(404, { error: "not_found" });
    const [, app, code] = m;
    if (!APP_RE.test(app) || !CODE_RE.test(code)) return json(400, { error: "bad_app_or_code" });
    const key = `${app}:${code}`;

    if (request.method === "GET") {
      const stored = await env.SYNC.get(key);
      if (stored === null) return json(404, { error: "no_data" });
      return new Response(stored, { headers: { "Content-Type": "application/json", ...CORS } });
    }

    if (request.method === "PUT") {
      const raw = await request.text();
      if (raw.length > MAX_BYTES) return json(413, { error: "too_large", max: MAX_BYTES });
      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "bad_json" }); }
      if (typeof body.updatedAt !== "number" || body.data === undefined)
        return json(400, { error: "need_updatedAt_and_data" });

      const stored = await env.SYNC.get(key);
      if (stored !== null) {
        const cur = JSON.parse(stored);
        // 楽観ロック: クライアントが最後に見たblobと違うものが保存されていたら衝突
        if (body.baseUpdatedAt !== cur.updatedAt) return json(409, cur);
      }
      // サーバー側が空のときは baseUpdatedAt に関わらず受理する（初回・削除後の復旧）

      await env.SYNC.put(key, JSON.stringify({ updatedAt: body.updatedAt, data: body.data }));
      return json(200, { ok: true, updatedAt: body.updatedAt });
    }

    return json(405, { error: "method_not_allowed" });
  },
};
