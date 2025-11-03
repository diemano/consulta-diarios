import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { getStore } from "@netlify/blobs";

const DOE_LIST_URL = "https://auniao.pb.gov.br/doe";
const DEJT_URL = "https://diario.jt.jus.br/cadernos/Diario_A_13.pdf";

// ===== Persistência (Netlify Blobs) =====
const siteID = process.env.BLOBS_SITE_ID;
const token  = process.env.BLOBS_TOKEN;
const store = getStore({ name: "doe-history", siteID, token, consistency: "strong" });

async function loadHistory() {
  const raw = await store.get("history.json");
  if (!raw) return { lastSeen: {}, runs: [] };
  const j = JSON.parse(raw);
  if (j.lastSeenHref) { // compatibilidade com versão antiga
    j.lastSeen = { "DOE/PB": j.lastSeenHref };
    delete j.lastSeenHref;
  }
  j.lastSeen ??= {};
  j.runs ??= [];
  return j;
}
async function saveHistory(h) {
  await store.set("history.json", JSON.stringify(h));
}

// ==== Config (grupos) no mesmo store ====
async function loadConfig(store) {
  const raw = await store.get("config.json");
  return raw ? JSON.parse(raw) : { groups: [] };
}

// ===== Utilitários =====
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
function extractDoeEditionFromUrl(u) {
  const m = /diario-oficial-(\d{2})-(\d{2})-(\d{4})-portal\.pdf/i.exec(u || "");
  if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  return `${dd}/${mm}/${yyyy}`;
}
function formatEditionFromHTTPDate(httpDate) {
  const d = new Date(httpDate);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" });
}

async function fetchLatestDoePdfUrl() {
  const res = await fetch(DOE_LIST_URL, { timeout: 20000 });
  if (!res.ok) throw new Error("Falha ao abrir a página do DOE.");
  const html = await res.text();
  const m = html.match(/href="([^"]+diario-oficial-\d{2}-\d{2}-\d{4}-portal\.pdf)"/i);
  if (!m) throw new Error("Não achei link do PDF na página do DOE.");
  return new URL(m[1], DOE_LIST_URL).href;
}

const TMP_DIR = "/tmp";
async function downloadPdf(url) {
  if (url.startsWith("file://")) {
    const p = url.replace("file://", "");
    const buf = await fs.readFile(p);
    const file = path.join(TMP_DIR, "doc.pdf");
    await fs.writeFile(file, buf);
    return file;
  }
  const r = await fetch(url, { timeout: 60000 });
  if (!r.ok) throw new Error(`Falha ao baixar PDF: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const file = path.join(TMP_DIR, "doc.pdf");
  await fs.writeFile(file, buf);
  return file;
}

// ===== Leitura do PDF com pdfjs-dist =====
async function searchTermsInPdf(file, terms, { wantSnippets = false } = {}) {
  const buf = await fs.readFile(file);
  const data = new Uint8Array(buf);

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDoc = await loadingTask.promise;

  let raw = "";
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const tc = await page.getTextContent();
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
        const idx = m.index ?? 0;
        const approxStart = Math.max(0, Math.floor(idx * (raw.length / textClean.length)) - 200);
        const approxEnd = Math.min(raw.length, approxStart + 400);
        const snippetRaw = raw.slice(approxStart, approxEnd).replace(/\s+/g, " ");
        snippets.push(`[…] ${snippetRaw} […]`);
      }
    }
  }

  return { hits, snippets };
}

// ===== Coletoras de fontes =====
async function collectDOE() {
  const url = await fetchLatestDoePdfUrl();
  const edition = extractDoeEditionFromUrl(url);
  return { source: "DOE/PB", url, edition, dedupKey: url };
}
async function collectDEJT() {
  let edition = null;
  let dedupKey = null;
  try {
    const head = await fetch(DEJT_URL, { method: "HEAD", timeout: 15000 });
    const lastMod = head.headers.get("last-modified");
    if (lastMod) {
      edition = formatEditionFromHTTPDate(lastMod);
      dedupKey = `${DEJT_URL}#${lastMod}`;
    }
  } catch {}
  if (!edition) {
    edition = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" });
  }
  if (!dedupKey) dedupKey = `${DEJT_URL}#${edition}`;
  return { source: "DEJT TRT-13", url: DEJT_URL, edition, dedupKey };
}

// ===== Handler =====
export const handler = async (event) => {
  try {
    const qp = event?.queryStringParameters || {};
    const urlOverride = qp.url;
    const sourceFilter = (qp.source || "").toLowerCase(); // "doepb" | "dejt"
    const termsOverride = qp.terms || qp.t || "";
    const wantSnippets = qp.snippets === "1";
    const save = qp.save === "1";

    const hist = await loadHistory();
    const config = await loadConfig(store);
    const groups = Array.isArray(config.groups) ? config.groups : [];

    // Fontes alvo
    const sourcesWanted = !sourceFilter
      ? ["DOE/PB", "DEJT TRT-13"]
      : (sourceFilter === "dejt" ? ["DEJT TRT-13"] : ["DOE/PB"]);

    // Termos: override (?t=) > grupos (por fonte) > TERMs de env
    let TERMS = (termsOverride || process.env.TERMS || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    if (!termsOverride && groups.length) {
      const set = new Set();
      for (const g of groups) {
        if (g.sources?.some(s => sourcesWanted.includes(s))) {
          (g.terms || []).forEach(t => t && set.add(t));
        }
      }
      if (set.size) TERMS = Array.from(set);
    }

    if (!TERMS.length) {
      return { statusCode: 200, body: "Sem termos configurados (grupos) para as fontes selecionadas." };
    }

    // ===== Modo MANUAL (url=...) =====
    if (urlOverride) {
      const file = await downloadPdf(urlOverride);
      const { hits, snippets } = await searchTermsInPdf(file, TERMS, { wantSnippets });
      const found = hits.length > 0;

      const editionDoe = extractDoeEditionFromUrl(urlOverride);
      const source = sourceFilter === "dejt" ? "DEJT TRT-13"
                   : sourceFilter === "doepb" ? "DOE/PB"
                   : (editionDoe ? "DOE/PB" : "DEJT TRT-13");
      const edition = editionDoe || new Date().toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" });

      // histórico (opcional via ?save=1)
      if (save) {
        const matchedGroups = groups.filter(g =>
          (g.sources || []).includes(source) &&
          (g.terms || []).some(t => hits.includes(t))
        );
        const groupsHit = matchedGroups.map(g => g.name);
        const entry = { when: new Date().toISOString(), source, edition, pdfUrl: urlOverride, found, hits, groupsHit };
        hist.runs.unshift(entry);
        hist.runs = hist.runs.slice(0, 300);
        await saveHistory(hist);
      }

      return {
        statusCode: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          source,
          pdfUrl: urlOverride,
          edition,
          termsUsed: TERMS,
          count: hits.length,
          hits,
          ...(wantSnippets ? { snippets } : {})
        }, null, 2)
      };
    }

    // ===== Execução DIÁRIA =====
    const collectors = [];
    if (!sourceFilter || sourceFilter === "doepb") collectors.push(collectDOE);
    if (!sourceFilter || sourceFilter === "dejt")  collectors.push(collectDEJT);

    const results = [];

    for (const collect of collectors) {
      const meta = await collect(); // { source, url, edition, dedupKey }
      const lastSeenKey = hist.lastSeen[meta.source];

      if (lastSeenKey === meta.dedupKey) {
        results.push({ ...meta, skipped: true, message: "Sem edição nova." });
        continue;
      }

      const file = await downloadPdf(meta.url);
      const { hits, snippets } = await searchTermsInPdf(file, TERMS, { wantSnippets });
      const found = hits.length > 0;

      // histórico básico
      hist.lastSeen[meta.source] = meta.dedupKey;
      const matchedGroups = groups.filter(g =>
        (g.sources || []).includes(meta.source) &&
        (g.terms || []).some(t => hits.includes(t))
      );
      const groupsHit = matchedGroups.map(g => g.name);
      const entry = { when: new Date().toISOString(), source: meta.source, edition: meta.edition, pdfUrl: meta.url, found, hits, groupsHit };
      hist.runs.unshift(entry);
      hist.runs = hist.runs.slice(0, 300);

      results.push({ ...meta, found, hits, count: hits.length, ...(wantSnippets ? { snippets } : {}) });
    }

    await saveHistory(hist);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ termsUsed: TERMS, results }, null, 2)
    };

  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Erro: " + e.message };
  }
};
