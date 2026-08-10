// /netlify/functions/config.js
const { getStore } = require("@netlify/blobs");

const SITE_ID = process.env.BLOBS_SITE_ID;
const TOKEN   = process.env.BLOBS_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;

function json(body, code=200){ return { statusCode:code, headers:{'content-type':'application/json; charset=utf-8'}, body: JSON.stringify(body, null, 2) }; }
function bad(code, msg){ return { statusCode:code, body:String(msg) }; }

exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) return bad(401, "Unauthorized");

  const store = getStore({ name: "doe-history", siteID: SITE_ID, token: TOKEN, consistency: "strong" });
  const CONFIG_KEY = "config.json";
  const HISTORY_KEY = "history.json"; // opcional: podemos mostrar termos por grupo no futuro

  if (event.httpMethod === "GET") {
    const raw = await store.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : { groups: [] };
    return json(cfg);
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "JSON inválido"); }
    const groups = Array.isArray(body.groups) ? body.groups : [];
    // validações básicas
    for (const g of groups) {
      if (!g.id || !g.name || !Array.isArray(g.sources) || !g.sources.length || !Array.isArray(g.terms) || !g.terms.length) {
        return bad(400, `Grupo inválido: ${g && g.name ? g.name : "(sem nome)"}`);
      }
      if (g.notifyEmail && !g.email) return bad(400, `Informe o e-mail para o grupo: ${g.name}`);
      g.sources = Array.from(new Set(g.sources)); // dedup
      g.terms = Array.from(new Set(g.terms.map(s => s.trim()).filter(Boolean)));
    }
    await store.set(CONFIG_KEY, JSON.stringify({ groups }));
    return json({ ok:true });
  }

  return bad(405, "Method not allowed");
};
