// /netlify/functions/status.js  (CommonJS)
const { getStore } = require("@netlify/blobs");

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

exports.handler = async () => {
  // credenciais do Blobs via env
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;
  const store = getStore({ name: "doe-history", siteID, token, consistency: "strong" });

  const raw = await store.get("history.json");
  if (!raw) {
    const emptyHtml = `
      <!doctype html>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <style>
        :root {
          --bg: #f7f7fb; --surface: #ffffff; --text: #1f2937; --muted: #6b7280;
          --brand: #4f46e5; --ok: #16a34a; --warn: #d97706; --bad: #ef4444;
          --chip: #eef2ff; --chip-text: #3730a3; --border: #e5e7eb;
          --shadow: 0 8px 24px rgba(0,0,0,.06);
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --bg: #0b0f16; --surface: #0f172a; --text: #e5e7eb; --muted: #94a3b8;
            --brand: #818cf8; --ok: #22c55e; --warn: #f59e0b; --bad: #f87171;
            --chip: #111827; --chip-text: #c7d2fe; --border: #1e293b;
            --shadow: 0 8px 24px rgba(0,0,0,.4);
          }
        }
        *{box-sizing:border-box}
        body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,"Helvetica Neue",Arial}
        .wrap{max-width:1100px;margin:40px auto;padding:0 16px}
        header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
        .logo{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:var(--brand);color:#fff;font-weight:800;box-shadow:var(--shadow)}
        h1{font-size:clamp(20px,3vw,28px);margin:0}
        .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:18px}
        .muted{color:var(--muted)}
        a{color:var(--brand);text-decoration:none}
        .center{display:flex;align-items:center;justify-content:center;height:50vh}
      </style>
      <body>
        <div class="wrap">
          <header>
            <div class="logo">D</div>
            <h1>Monitor de Diários — status</h1>
          </header>
          <div class="card center"><div class="muted">Sem histórico ainda. Assim que a função diária rodar, os registros aparecerão aqui.</div></div>
        </div>
      </body>`;
    return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: emptyHtml };
  }

  const j = JSON.parse(raw);
  const runs = (j.runs || []).map(r => {
    const edition = r.edition || (() => {
      const m = /diario-oficial-(\d{2})-(\d{2})-(\d{4})-portal\.pdf/i.exec(r.pdfUrl || "");
      return m ? `${m[1]}/${m[2]}/${m[3]}` : "-";
    })();
    const source = r.source || (r.pdfUrl && r.pdfUrl.includes("auniao.pb.gov.br") ? "DOE/PB" : "DEJT TRT-13");
    const terms = Array.isArray(r.hits) ? r.hits : [];
    return {
      when: r.when,
      whenFmt: new Date(r.when).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }),
      source,
      edition,
      pdfUrl: r.pdfUrl,
      found: !!r.found,
      terms
    };
  });

  const sources = Array.from(new Set(runs.map(r => r.source))).sort();

  const html = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Monitor de Diários — status</title>
<style>
  :root { --bg:#f7f7fb; --surface:#fff; --text:#1f2937; --muted:#6b7280; --brand:#4f46e5; --ok:#16a34a; --bad:#ef4444; --chip:#eef2ff; --chip-text:#3730a3; --border:#e5e7eb; --shadow:0 8px 24px rgba(0,0,0,.06); }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f16; --surface:#0f172a; --text:#e5e7eb; --muted:#94a3b8; --brand:#818cf8; --ok:#22c55e; --bad:#f87171; --chip:#111827; --chip-text:#c7d2fe; --border:#1e293b; --shadow:0 8px 24px rgba(0,0,0,.4);} }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,"Helvetica Neue",Arial}
  a{color:var(--brand);text-decoration:none}
  .wrap{max-width:1100px;margin:40px auto;padding:0 16px}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  .logo{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:var(--brand);color:#fff;font-weight:800;box-shadow:var(--shadow)}
  h1{font-size:clamp(20px,3vw,28px);margin:0}
  .muted{color:var(--muted)}
  .toolbar{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 20px}
  .toolbar .control{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
  .control input[type="search"]{border:0;outline:0;background:transparent;color:var(--text);min-width:220px}
  .control select{border:0;outline:0;background:transparent;color:var(--text)}
  .toggle{display:flex;align-items:center;gap:8px;cursor:pointer}
  .toggle input{accent-color:var(--brand);width:18px;height:18px}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:var(--chip);color:var(--chip-text);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:16px}
  @media (min-wi
