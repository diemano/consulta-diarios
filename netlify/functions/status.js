import fs from "fs/promises";
import path from "path";

export const handler = async () => {
  const HISTORY_FILE = process.env.HISTORY_FILE || path.join("/tmp", "history.json");
  try {
    const j = JSON.parse(await fs.readFile(HISTORY_FILE, "utf-8"));
    const list = (j.hits || []).map(h =>
      `<li>${new Date(h.when).toLocaleString("pt-BR")} — <a href="${h.pdfUrl}">PDF</a> — <b>${h.hits.join(", ")}</b></li>`
    ).join("");
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: `<h1>Monitor DOE/PB</h1><p>Último PDF visto: <a href="${j.lastSeenHref}">${j.lastSeenHref || "-"}</a></p><ul>${list}</ul>`
    };
  } catch {
    return { statusCode: 200, body: "Sem histórico ainda." };
  }
};
