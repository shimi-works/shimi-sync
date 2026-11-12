// shimi-sync: 単一HTMLアプリ群のための同期コード方式データ同期API
//
//   GET /v1/:app/:code   → 200 {updatedAt, data} | 404
//   PUT /v1/:app/:code   → body {baseUpdatedAt, updatedAt, data}
//                          保存済みの updatedAt が baseUpdatedAt と一致しないときは
//                          409 + 保存済みblob を返す（クライアント側でマージして再送する）
//
// 認証はコードそのもの（推測不能な長さのランダム文字列）。オリジン制限はしない
// （コードを知らない相手には何も読めない設計のため）。
//
// コードは normalizeCode で正規形にそろえてから照合する（小文字・ハイフンなし・
// URLエンコード等の表記ゆれを吸収）。正規形のコードは変わらないため移行は不要。

const CODE_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$/; // 紛らわしい文字(I,L,O,0,1)抜き・約99bit

// コードの正規化: 届いたコードを正規形 (XXXX-XXXX-XXXX-XXXX-XXXX) にそろえる。
// 小文字化・ハイフン除去・URLエンコードなどの「表記のゆれ」を吸収するためのもので、
// 正規形のコードは正規化しても変わらないため、既存のKVキーはそのまま使える。
function normalizeCode(raw) {
  let s = raw;
  try { s = decodeURIComponent(s); } catch { /* デコードできない場合はそのまま使う */ }
  s = s.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
  if (s.length !== 20) return null;
  const grouped = [0, 1, 2, 3, 4].map(i => s.slice(i * 4, i * 4 + 4)).join("-");
  return CODE_RE.test(grouped) ? grouped : null;
}
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
    const [, app, rawCode] = m;
    const code = normalizeCode(rawCode);
    if (!APP_RE.test(app) || !code) {
      // 一時診断: 受け取ったコードの「形」だけを返す（中身そのものは返さない）
      let cleaned = null, decodeThrew = false;
      try { cleaned = decodeURIComponent(rawCode).toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""); }
      catch { decodeThrew = true; }
      const count = (re) => (rawCode.match(re) || []).length;
      return json(400, { error: "bad_app_or_code", debug: {
        app, appOk: APP_RE.test(app),
        codeLen: rawCode.length,
        upper: count(/[A-Z]/g), lower: count(/[a-z]/g), digit: count(/[0-9]/g),
        hyphen: count(/-/g), percent: count(/%/g),
        cleanedLen: cleaned === null ? null : cleaned.length, decodeThrew,
      } });
    }
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
