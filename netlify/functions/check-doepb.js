import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

const DOE_LIST_URL = "https://auniao.pb.gov.br/doe";
const DEJT_URL = "https://diario.jt.jus.br/cadernos/Diario_A_13.pdf";

// ===== Persistência (Netlify Blobs) =====
const siteID = process.env.BLOBS_SITE_ID;
const token  = process.env.BLOBS_TOKEN;
const store = getStore({ name: "doe-history", siteID, token, consistency: "strong" });

// ===== Configuração de e-mail (SMTP) =====
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || "monitor-diarios@no-reply.com";

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

  // Tenta múltiplos padrões de URL (o site pode mudar o formato)
  const patterns = [
    /href="([^"]+diario-oficial-\d{2}-\d{2}-\d{4}-portal\.pdf)"/i,
    /href="([^"]+diario-oficial[^"]*\.pdf)"/i,
    /href="([^"]+DOE[^"]*\.pdf)"/i,
    /href="([^"]+auniao[^"]*\.pdf)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return new URL(m[1], DOE_LIST_URL).href;
  }
  throw new Error("Não achei link do PDF na página do DOE (padrão de URL pode ter mudado).");
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

  // Configura CMaps — essencial para PDFs com fontes customizadas (ex: diários oficiais brasileiros)
  // pdfjs-dist já inclui os CMaps em pdfjs-dist/cmaps/
  const cmapDir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "cmaps");
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: cmapDir + "/",
    cMapPacked: true,
    standardFontDataUrl: cmapDir + "/",
  });
  const pdfDoc = await loadingTask.promise;

  let raw = "";
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    raw += tc.items.map(it => (it.str || "")).join(" ") + "\n";
  }

  // Debug: loga quantos caracteres foram extraídos
  console.log(`PDF extraído: ${raw.length} caracteres em ${pdfDoc.numPages} páginas. Amostra: ${raw.slice(0, 200)}`);

  const textClean = clean(raw);
  const hits = [];
  const hitCounts = {};  // termo -> nº de incidências
  const snippets = [];

  for (const term of terms) {
    const rx = makeElasticRegex(term);
    // matchAll para contar TODAS as incidências, não só a primeira
    const matches = [...textClean.matchAll(new RegExp(rx.source, "giu"))];
    if (matches.length > 0) {
      hits.push(term);
      hitCounts[term] = matches.length;
      if (wantSnippets) {
        // Pega snippet de cada match (limitado a 5 para não pesar o e-mail)
        const maxSnips = 5;
        for (let i = 0; i < Math.min(matches.length, maxSnips); i++) {
          const m = matches[i];
          const idx = m.index ?? 0;
          const approxStart = Math.max(0, Math.floor(idx * (raw.length / textClean.length)) - 200);
          const approxEnd = Math.min(raw.length, approxStart + 400);
          const snippetRaw = raw.slice(approxStart, approxEnd).replace(/\s+/g, " ");
          snippets.push(`[${i + 1}/${matches.length}] […] ${snippetRaw} […]`);
        }
      }
    }
  }

  return { hits, hitCounts, snippets };
}

// ===== Envio de e-mail de alerta =====
const EMAIL_TEMPLATE_PATH = path.join(process.cwd(), "emails", "alert", "index.html");

async function sendAlertEmail(group, result, wantSnippets) {
  if (!group.notifyEmail || !group.email) return;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP não configurado — pulando envio de e-mail para", group.email);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Monta snippets (se disponíveis)
  let snippetsHtml = "";
  if (result.snippets && result.snippets.length) {
    const escaped = result.snippets.map(s =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    );
    snippetsHtml = escaped.map(s =>
      `<p style="margin:6px 0;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;color:#374151;line-height:1.5;">${s}</p>`
    ).join("");
  }

  // Monta resumo com contagem de incidências
  const hitCounts = result.hitCounts || {};
  const countResumo = (result.hits || []).map(t => {
    const n = hitCounts[t] || 0;
    return `<strong>${t}</strong>: ${n} incidência${n > 1 ? "s" : ""}`;
  }).join("<br>");

  // Template simples (substituição direta)
  let template;
  try {
    template = await fs.readFile(EMAIL_TEMPLATE_PATH, "utf-8");
  } catch {
    template = `<html><body style="font-family:system-ui;margin:0;padding:24px;background:#f0f2f5;"><div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08);"><h2 style="color:#1f2937;">✅ Termos encontrados em {{source}}</h2><p style="color:#6b7280;">Edição: <strong>{{edition}}</strong></p><div style="background:#eef2ff;border-radius:12px;padding:14px;margin:12px 0;">{{countResumo}}</div>{{snippets}}<a href="{{pdfUrl}}" target="_blank" style="display:inline-block;margin-top:16px;padding:12px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;">📄 Abrir PDF</a><p style="margin-top:20px;font-size:12px;color:#9ca3af;">Grupo: {{groupName}} · {{dateNow}}</p></div></body></html>`;
  }

  const dateNow = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  let html = template
    .replace(/\{\{source\}\}/g, result.source)
    .replace(/\{\{edition\}\}/g, result.edition)
    .replace(/\{\{pdfUrl\}\}/g, result.pdfUrl || "")
    .replace(/\{\{countResumo\}\}/g, countResumo)
    .replace(/\{\{hits\}\}/g, (result.hits || []).join(", "))
    .replace(/\{\{snippets\}\}/g, snippetsHtml)
    .replace(/\{\{groupName\}\}/g, group.name)
    .replace(/\{\{dateNow\}\}/g, dateNow)
    .replace(/\{\{#if\s+snippets\}\}/g, "")
    .replace(/\{\{\/if\}\}/g, "")
    .replace(/\{\{#if\s+found\}\}[\s\S]*?\{\{\/if\}\}/g, "")
    .replace(/\{\{#if\s+snippets\}\}[\s\S]*?\{\{\/if\}\}/g, snippetsHtml);

  const totalIncidencias = Object.values(hitCounts).reduce((a, b) => a + b, 0);
  const subject = `🔔 ${totalIncidencias} incidência(s) em ${result.source} — ${result.edition}`;

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: group.email,
      subject,
      html,
    });
    console.log(`E-mail enviado para ${group.email} (grupo: ${group.name})`);
  } catch (err) {
    console.error(`Falha ao enviar e-mail para ${group.email}:`, err.message);
  }
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
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req, context) => {
  try {
    // Invocações agendadas não têm query string (o corpo é { next_run }).
    // Teste local: netlify functions:invoke check-doepb --query "url=...&force=1"
    let qp = {};
    try {
      const u = new URL(req?.url || "http://localhost");
      u.searchParams.forEach((v, k) => { qp[k] = v; });
    } catch { /* sem URL utilizável */ }

    let nextRun = null;
    try { nextRun = (await req.json())?.next_run || null; } catch { /* sem corpo */ }

    console.log("check-doepb acionado:", JSON.stringify(qp), "next_run:", nextRun);
    const urlOverride = qp.url;
    const sourceFilter = (qp.source || "").toLowerCase(); // "doepb" | "dejt"
    const termsOverride = qp.terms || qp.t || "";
    const wantSnippets = qp.snippets === "1";
    const save = qp.save === "1";
    const force = qp.force === "1";

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
      console.warn("check-doepb: nenhum termo configurado. Crie grupos em /admin ou defina a env TERMS.");
      return new Response("Sem termos configurados (grupos) para as fontes selecionadas. Crie grupos em /admin ou defina a env TERMS.", { status: 200 });
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

      return jsonResponse({
        source,
        pdfUrl: urlOverride,
        edition,
        termsUsed: TERMS,
        count: hits.length,
        hits,
        ...(wantSnippets ? { snippets } : {})
      });
    }

    // ===== Execução DIÁRIA =====
    const collectors = [];
    if (!sourceFilter || sourceFilter === "doepb") collectors.push(collectDOE);
    if (!sourceFilter || sourceFilter === "dejt")  collectors.push(collectDEJT);

    const results = [];

    for (const collect of collectors) {
      try {
        const meta = await collect(); // { source, url, edition, dedupKey }
        const lastSeenKey = hist.lastSeen[meta.source];

        if (!force && lastSeenKey === meta.dedupKey) {
          results.push({ ...meta, skipped: true, message: "Sem edição nova." });
          continue;
        }

        const file = await downloadPdf(meta.url);
        const { hits, hitCounts, snippets } = await searchTermsInPdf(file, TERMS, { wantSnippets });
        const found = hits.length > 0;

        // histórico básico
        hist.lastSeen[meta.source] = meta.dedupKey;
        const matchedGroups = groups.filter(g =>
          (g.sources || []).includes(meta.source) &&
          (g.terms || []).some(t => hits.includes(t))
        );
        const groupsHit = matchedGroups.map(g => g.name);
        const entry = { when: new Date().toISOString(), source: meta.source, edition: meta.edition, pdfUrl: meta.url, found, hits, hitCounts, groupsHit };
        hist.runs.unshift(entry);
        hist.runs = hist.runs.slice(0, 300);

        results.push({ ...meta, found, hits, hitCounts, count: hits.length, totalIncidencias: Object.values(hitCounts).reduce((a,b)=>a+b,0), ...(wantSnippets ? { snippets } : {}) });

        // Envia e-mails para grupos que tiveram matches nesta fonte
        if (found && matchedGroups.length) {
          for (const group of matchedGroups) {
            await sendAlertEmail(group, { ...meta, found, hits, hitCounts, snippets: wantSnippets ? snippets : [] }, wantSnippets);
          }
        }
      } catch (collectErr) {
        console.error(`Erro ao processar fonte:`, collectErr.message);
        results.push({ error: collectErr.message });
      }
    }

    await saveHistory(hist);

    return jsonResponse({ termsUsed: TERMS, results });

  } catch (e) {
    console.error(e);
    return new Response("Erro: " + e.message, { status: 500 });
  }
};

// Background function: roda por até 15 min. A leitura do PDF passa de 30s,
// que é o limite das scheduled functions do Netlify — por isso o agendamento
// ficou por conta do GitHub Actions (.github/workflows/daily-check.yml),
// que apenas chama a URL desta função nos horários configurados.
export const config = {
  background: true,
};
