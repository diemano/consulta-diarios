import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import nodemailer from "nodemailer";
import { getStore } from "@netlify/blobs";

const DOE_LIST_URL = "https://auniao.pb.gov.br/doe";

// Use SEMPRE as env vars (você já as criou)
const siteID = process.env.BLOBS_SITE_ID;
const token  = process.env.BLOBS_TOKEN;

// Cria o store com credenciais explícitas
const store = getStore({
  name: "doe-history",
  siteID,
  token,
  consistency: "strong",
});

// Helpers de persistência
async function loadHistory() {
  const raw = await store.get("history.json");
  return raw ? JSON.parse(raw) : { lastSeenHref: null, runs: [] };
}
async function saveHistory(h) {
  await store.set("history.json", JSON.stringify(h));
}


// ===== Utilitários =====

function extractEditionFromUrl(u) {
  const m = /diario-oficial-(\d{2})-(\d{2})-(\d{4})-portal\.pdf/i.exec(u || "");
  if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  return `${dd}/${mm}/${yyyy}`;
}

function normalize(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function clean(s) {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\s+/g, " ");
}

function makeElasticRegex(term) {
  const letters = clean(term).replace(/[^a-z0-9]/g, "");
  const esc = letters.split("").map(ch => ch.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")).join("\\W*");
  return new RegExp(esc, "iu");
}

function parsePdfHrefFromHtml(html) {
  // tenta achar link do “Diário Oficial DD-MM-YYYY Portal.pdf”
  const m = html.match(/href="([^"]+diario-oficial-\d{2}-\d{2}-\d{4}-portal\.pdf)"/i);
  return m ? new URL(m[1], DOE_LIST_URL).href : null;
}

async function fetchLatestPdfUrl() {
  const res = await fetch(DOE_LIST_URL, { timeout: 20000 });
  if (!res.ok) throw new Error("Falha ao abrir a página do DOE.");
  const html = await res.text();
  const href = parsePdfHrefFromHtml(html);
  if (!href) throw new Error("Não achei link do PDF na página do DOE.");
  return href;
}

const TMP_DIR = "/tmp";
async function downloadPdf(url) {
  // Suporte a file:// para testes locais (opcional)
  if (url.startsWith("file://")) {
    const p = url.replace("file://", "");
    const buf = await fs.readFile(p);
    const file = path.join(TMP_DIR, "doe.pdf");
    await fs.writeFile(file, buf);
    return file;
  }
  const r = await fetch(url, { timeout: 60000 });
  if (!r.ok) throw new Error(`Falha ao baixar PDF: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const file = path.join(TMP_DIR, "doe.pdf");
  await fs.writeFile(file, buf);
  return file;
}

// ===== Leitura do PDF com pdfjs-dist (compatível com Functions) =====
async function searchTermsInPdf(file, terms, { wantSnippets = false } = {}) {
  const buf = await fs.readFile(file);
  const data = new Uint8Array(buf);

  // import dinâmico funciona em CJS/ESM
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDoc = await loadingTask.promise;

  let raw = "";
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    // concatena itens; alguns PDFs têm NBSP e quebras estranhas
    raw += tc.items.map(it => (it.str || "")).join(" ") + "\n";
  }

  const textClean = clean(raw);

  const hits = [];
  const snippets = [];

  for (const term of terms) {
    const rx = makeElasticRegex(term);
    const m = textClean.match(rx);
    if (m) {
      hits.push(term);
      if (wantSnippets) {
        const idxClean = m.index ?? 0;
        const approxStart = Math.max(0, Math.floor(idxClean * (raw.length / textClean.length)) - 200);
        const approxEnd = Math.min(raw.length, approxStart + 400);
        const snippetRaw = raw.slice(approxStart, approxEnd).replace(/\s+/g, " ");
        snippets.push(`[…] ${snippetRaw} […]`);
      }
    }
  }

  return { hits, snippets };
}

// ===== Notificações =====
async function notifyEmail({ subject, html }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_TO, MAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_TO) return;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({ from: MAIL_FROM || SMTP_USER, to: MAIL_TO, subject, html });
}

async function notifyTelegram({ text }) {
  const { TG_BOT_TOKEN, TG_CHAT_ID } = process.env;
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true })
  });
}

// ===== Handler =====
export const handler = async (event) => {
  try {
    const qp = event?.queryStringParameters || {};
    const urlOverride = qp.url;
    const termsOverride = qp.terms || qp.t || "";
    const dry = qp.dry === "1";
    const wantSnippets = qp.snippets === "1";
    const SEND_EMPTY = process.env.SEND_EMPTY === "1";

    const TERMS = (termsOverride || process.env.TERMS || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    if (!TERMS.length) {
      return { statusCode: 200, body: "Sem termos configurados." };
    }

    const hist = await loadHistory();
    const pdfUrl = urlOverride || await fetchLatestPdfUrl();
    const isManual = Boolean(urlOverride);

    if (!isManual && hist.lastSeenHref === pdfUrl) {
      // já processado hoje
      return { statusCode: 200, body: "Sem edição nova." };
    }

    const file = await downloadPdf(pdfUrl);
    const { hits, snippets } = await searchTermsInPdf(file, TERMS, { wantSnippets });
    const found = hits.length > 0;

    // alerta quando encontra
    if (found && !dry) {
      const subject = `DOE/PB: encontrei ${hits.join(", ")} 🎯`;
      const html =
        `<p>Encontrei no <a href="${pdfUrl}">DOE/PB</a> os termos: <b>${hits.join(", ")}</b>.</p>` +
        (wantSnippets && snippets?.length ? `<pre>${snippets.join("\n---\n")}</pre>` : "");
      await notifyEmail({ subject, html });
      await notifyTelegram({ text: `DOE/PB ✅ ${hits.join(", ")}\n${pdfUrl}` });
    } else if (!found && SEND_EMPTY && !dry) {
      await notifyEmail({
        subject: "DOE/PB: nenhum termo encontrado hoje",
        html: `<p>Nada encontrado no <a href="${pdfUrl}">DOE/PB de hoje</a>.</p>`
      });
      await notifyTelegram({ text: `DOE/PB ⭕ nada hoje\n${pdfUrl}` });
    }

    // histórico (somente quando for execução “do dia”, não manual de teste)
    if (!isManual) {
      hist.lastSeenHref = pdfUrl;
      const entry = {
        when: new Date().toISOString(),
        pdfUrl,
        found,
        hits,
        edition: extractEditionFromUrl(pdfUrl)
      };
      hist.runs ??= [];
      hist.runs.unshift(entry);
      hist.runs = hist.runs.slice(0, 200);
      await saveHistory(hist);
    }

    // resposta JSON (ótimo p/ testes e monitoramento)
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        pdfUrl,
        edition: extractEditionFromUrl(pdfUrl),
        termsUsed: TERMS,
        count: hits.length,
        hits,
        ...(wantSnippets ? { snippets } : {})
      }, null, 2)
    };

  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Erro: " + e.message };
  }
};
