import { getStore } from "@netlify/blobs";

export const handler = async () => {
  const store = getStore({ name: "doe-history", consistency: "strong" });
  const raw = await store.get("history.json");

  if (!raw) return { statusCode: 200, body: "Sem histórico ainda." };

  const j = JSON.parse(raw);
  const rows = (j.runs || []).map(r => {
    const dt = new Date(r.when).toLocaleString("pt-BR");
    const badge = r.found ? "✅ encontrado" : "⭕ nada";
    const terms = r.hits?.length ? r.hits.join(", ") : "-";
    return `<tr>
      <td style="padding:.4rem .6rem">${dt}</td>
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
      <h1 style="font-family:system-ui;margin:.5rem 0">Monitor DOE/PB — status</h1>
      <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:system-ui;font-size:14px">
        <thead><tr>
          <th style="padding:.4rem .6rem">Data/Hora</th>
          <th style="padding:.4rem .6rem">Edição</th>
          <th style="padding:.4rem .6rem">Resultado</th>
          <th style="padding:.4rem .6rem">Termos</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  };
};
