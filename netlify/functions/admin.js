// /netlify/functions/admin.js
const { getStore } = require("@netlify/blobs");

const SITE_ID = process.env.BLOBS_SITE_ID;
const TOKEN   = process.env.BLOBS_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY; // defina algo forte, ex: 32+ chars

function okHTML(body){return {statusCode:200,headers:{'content-type':'text/html; charset=utf-8'},body};}
function bad(status, msg){return {statusCode:status,body:String(msg)};}

exports.handler = async (event) => {
  // proteção simples: ?key=ADMIN_KEY
  const key = (event.queryStringParameters || {}).key || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return bad(401, "Unauthorized. Adicione ?key=SEU_ADMIN_KEY");
  }

  const store = getStore({ name: "doe-history", siteID: SITE_ID, token: TOKEN, consistency: "strong" });

  const html = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Monitor de Diários — Admin</title>
<style>
:root{--bg:#0b0f16;--surface:#0f172a;--text:#e5e7eb;--muted:#94a3b8;--brand:#818cf8;--ok:#22c55e;--bad:#f87171;--border:#1e293b;--shadow:0 8px 24px rgba(0,0,0,.35)}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.5 ui-sans-serif,system-ui}
a{color:var(--brand)}
.wrap{max-width:980px;margin:32px auto;padding:0 16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:18px;margin-bottom:16px}
h1{margin:0 0 8px;font-size:24px}
h2{margin:6px 0 10px;font-size:18px}
label{display:block;margin:8px 0 6px;color:var(--muted);font-size:14px}
input[type=text],input[type=email],textarea,select{width:100%;padding:10px;border:1px solid var(--border);border-radius:12px;background:#0b1220;color:var(--text)}
.row{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:720px){.row{grid-template-columns:1fr 1fr}}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid var(--border);background:#121a2a;color:var(--text);cursor:pointer}
.btn.primary{background:var(--brand);color:#0b0f16;border-color:transparent}
.btn.danger{background:#2a0f12;color:#ffd5d8;border-color:#3b151a}
.header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;background:#13213d;border:1px solid var(--border);color:#cdd5ff;font-size:12px}
.group{border:1px dashed var(--border);border-radius:12px;padding:12px;margin:8px 0}
hr{border:0;border-top:1px solid var(--border);margin:14px 0}
.small{font-size:13px;color:var(--muted)}
.toggle{display:flex;align-items:center;gap:8px}
</style>
<div class="wrap">
  <div class="card">
    <div class="header"><h1>Admin — Monitor de Diários</h1><a class="badge" href="/status" target="_blank">ver status</a></div>
    <div class="small">Gerencie grupos de termos e notificação por e-mail. Esta página salva no Netlify Blobs.</div>
  </div>

  <div class="card">
    <h2>Grupos</h2>
    <div id="groups"></div>
    <button class="btn" id="add">+ Adicionar grupo</button>
    <hr/>
    <button class="btn primary" id="save">💾 Salvar tudo</button>
  </div>

  <div class="card small">
    <b>Dica</b>: “Fontes” suportadas hoje: <code>DOE/PB</code>, <code>DEJT TRT-13</code>. Quando houver “achado” em uma fonte, enviaremos e-mail somente para os grupos que tiverem aquela fonte na lista e <i>notificação por e-mail</i> ligada.
  </div>
</div>

<script>
const KEY = ${JSON.stringify(key)};
const $groups = document.getElementById('groups');
const $add = document.getElementById('add');
const $save = document.getElementById('save');

function emptyGroup(){
  return { id: crypto.randomUUID(), name:"Novo grupo", sources:["DOE/PB","DEJT TRT-13"], terms:[], notifyEmail:false, email:"" };
}
function groupEl(g){
  const wrap = document.createElement('div');
  wrap.className = 'group';
  wrap.dataset.id = g.id;

  const termsStr = (g.terms||[]).join(', ');

  wrap.innerHTML = \`
    <div class="row">
      <div>
        <label>Nome do grupo</label>
        <input type="text" class="name" value="\${g.name||""}" />
      </div>
      <div>
        <label>Fontes</label>
        <select class="sources" multiple size="2">
          <option value="DOE/PB"\${g.sources?.includes("DOE/PB")?" selected":""}>DOE/PB</option>
          <option value="DEJT TRT-13"\${g.sources?.includes("DEJT TRT-13")?" selected":""}>DEJT TRT-13</option>
        </select>
        <div class="small">Use Ctrl/Cmd para selecionar múltiplas.</div>
      </div>
    </div>

    <label>Termos (separados por vírgula)</label>
    <input type="text" class="terms" value="\${termsStr}" placeholder="ex.: palácio, prefeitura, kaline" />

    <div class="row">
      <div>
        <label class="toggle"><input type="checkbox" class="notify" \${g.notifyEmail?"checked":""}/> Notificar por e-mail</label>
      </div>
      <div>
        <label>E-mail do grupo</label>
        <input type="email" class="email" value="\${g.email||""}" placeholder="nome@exemplo.com" \${g.notifyEmail?"":"disabled"} />
      </div>
    </div>

    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn danger rm">Remover grupo</button>
    </div>
  \`;

  const $notify = wrap.querySelector('.notify');
  const $email = wrap.querySelector('.email');
  $notify.addEventListener('change', ()=>{ $email.disabled = !$notify.checked; if(!$notify.checked){$email.value="";}});
  wrap.querySelector('.rm').addEventListener('click', ()=> wrap.remove());
  return wrap;
}

async function load(){
  const r = await fetch('/.netlify/functions/config?key='+encodeURIComponent(KEY));
  if(!r.ok){ alert('Falha ao carregar: '+(await r.text())); return; }
  const j = await r.json();
  const arr = Array.isArray(j.groups)? j.groups: [];
  $groups.innerHTML = '';
  arr.forEach(g => $groups.appendChild(groupEl(g)));
  if(!arr.length) $groups.appendChild(groupEl(emptyGroup()));
}

function readGroupsFromDOM(){
  const res = [];
  for (const el of $groups.querySelectorAll('.group')){
    const id = el.dataset.id;
    const name = el.querySelector('.name').value.trim();
    const sources = Array.from(el.querySelector('.sources').selectedOptions).map(o=>o.value);
    const terms = el.querySelector('.terms').value.split(',').map(s=>s.trim()).filter(Boolean);
    const notifyEmail = el.querySelector('.notify').checked;
    const email = el.querySelector('.email').value.trim();
    if (!name || !sources.length || !terms.length) continue; // ignora vazios
    if (notifyEmail && !email) { alert('Informe o e-mail para o grupo "'+name+'"'); return null; }
    res.push({ id, name, sources, terms, notifyEmail, email });
  }
  return res;
}

$add.addEventListener('click', ()=> $groups.appendChild(groupEl(emptyGroup())));
$save.addEventListener('click', async ()=>{
  const groups = readGroupsFromDOM();
  if(!groups) return;
  const r = await fetch('/.netlify/functions/config?key='+encodeURIComponent(KEY), {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ groups })
  });
  if(!r.ok){ alert('Falha ao salvar: '+(await r.text())); return; }
  alert('Salvo com sucesso!');
  load();
});

load();
</script>`;

  return okHTML(html);
};
