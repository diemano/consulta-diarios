import { getStore } from "@netlify/blobs";

export const handler = async () => {
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;

  const store = getStore({ name: "doe-history", siteID, token, consistency: "strong" });

  const raw = await store.get("history.json");
  if (!raw) return { statusCode: 200, body: "Sem histórico ainda." };

  const j = JSON.parse(raw);
  const runs = j.runs || [];

  // fallback de edição para entradas antigas (DOE pelo filename; DEJT sem filename não precisa)
  const getEdition = (r) => {
    if (r.edition) return r.edition;
    const m = /diario-oficial-(\d{2})-(\d{2})-(\d{4})-portal\.pdf/i.exec(r.pdfUrl || "");
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
    return "-";
  };

  const rows = runs.map(r => {
    const dt = new Date(r.when).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    const badge = r.found ? "✅ encontrado" : "⭕ nada";
    const terms = r.hits?.length ? r.hits.join(", ") : "-";
    const edition = getEdition(r);
    const source = r.source || "-";
    return `<tr>
      <td style="padding:.4rem .6rem;white-space:nowrap">${dt}</td>
      <td style="padding:.4rem .6rem">${source}</td>
      <td style="padding:.4rem .6rem">${edition}</td>
      <td style="padding:.4rem .6rem"><a href="${r.pdfUrl}">PDF</a></td>
      <td style="padding:.4rem .6rem">${badge}</td>
      <td style="padding:.4rem .6rem">${terms}</td>
    </tr>`;
  }).join("");

  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <h1 style="font-family:system-ui;margin:.5rem 0">Monitor de Diários — status</h1>
      <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:system-ui;font-size:14px;max-width:100%">
        <thead><tr>
          <th style="padding:.4rem .6rem">Data/Hora</th>
          <th style="padding:.4rem .6rem">Fonte</th>
          <th style="padding:.4rem .6rem">Edição</th>
          <th style="padding:.4rem .6rem">Arquivo</th>
          <th style="padding:.4rem .6rem">Resultado</th>
          <th style="padding:.4rem .6rem">Termos</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  };
};
