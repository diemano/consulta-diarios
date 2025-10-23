// Admin API: CRUD de grupos de termos
const { getStore } = require("@netlify/blobs");

const siteID = process.env.BLOBS_SITE_ID;
const token  = process.env.BLOBS_TOKEN;
const store  = getStore({ name: "doe-config", siteID, token, consistency: "strong" });

async function loadConfig() {
  const raw = await store.get("config.json");
  return raw ? JSON.parse(raw) : { groups: [] };
}

async function saveConfig(cfg) {
  await store.set("config.json", JSON.stringify(cfg));
}

function ok(json) {
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(json, null, 2) };
}
function bad(status, msg) {
  return { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: msg }) };
}
function uid() {
  return "grp_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

exports.handler = async (event) => {
  try {
    const key = event.queryStringParameters?.key || event.headers["x-admin-key"];
    if (!key || key !== process.env.ADMIN_KEY) return bad(401, "unauthorized");

    const method = event.httpMethod || "GET";

    if (method === "GET") {
      const cfg = await loadConfig();
      return ok(cfg);
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      // body: { id?, name, sources:[...], terms:[...], notifyEmail:boolean, emails:[...] }
      if (!body.name || !Array.isArray(body.sources) || !Array.isArray(body.terms)) {
        return bad(400, "invalid payload");
      }
      const cfg = await loadConfig();
      if (body.id) {
        const idx = cfg.groups.findIndex(g => g.id === body.id);
        if (idx === -1) return bad(404, "not found");
        cfg.groups[idx] = { ...cfg.groups[idx], ...body, updatedAt: new Date().toISOString() };
      } else {
        cfg.groups.unshift({
          id: uid(),
          name: String(body.name),
          sources: [...new Set(body.sources)],
          terms: body.terms.map(s => String(s).trim()).filter(Boolean),
          notifyEmail: !!body.notifyEmail,
          emails: (body.emails || []).map(s => String(s).trim()).filter(Boolean),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      await saveConfig(cfg);
      return ok(cfg);
    }

    if (method === "DELETE") {
      const id = event.queryStringParameters?.id;
      if (!id) return bad(400, "missing id");
      const cfg = await loadConfig();
      const before = cfg.groups.length;
      cfg.groups = cfg.groups.filter(g => g.id !== id);
      if (cfg.groups.length === before) return bad(404, "not found");
      await saveConfig(cfg);
      return ok(cfg);
    }

    return bad(405, "method not allowed");
  } catch (e) {
    return bad(500, e.message);
  }
};
