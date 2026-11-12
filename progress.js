// Janela de progresso do Quantopus Exporter.
// Abre pelo botão Exportar do popup, manda a aba do WhatsApp começar e mostra o avanço.
// Os arquivos são gravados pela própria aba (via service worker / chrome.downloads) em
// Downloads/<pasta>/<número>/ — esta janela não escolhe pasta nem grava nada.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
const command = params.get('cmd') === 'exportAll' ? 'exportAll' : 'export';
const opts = JSON.parse(params.get('opts') || '{}');

let running = false;
let gotProgress = false;
let startedAt = 0;
let timer = null;

// ---------- Registro de diagnóstico ----------

function log(text, isError = false) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('pt-BR')}  ${text}`;
  if (isError) li.className = 'err';
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
  if (isError) $('logBox').open = true;
}
const errText = (err) => `${err?.name || 'Erro'}: ${err?.message || err}`;

$('copyLog').addEventListener('click', async (e) => {
  e.preventDefault();
  const text = [...$('log').children].map((li) => li.textContent).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('copyLog').textContent = 'Copiado!';
  } catch {
    $('copyLog').textContent = 'Não foi possível copiar';
  }
  setTimeout(() => ($('copyLog').textContent = 'Copiar detalhes'), 2000);
});

$('openDlSettings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://settings/downloads' });
});

// ---------- Execução e progresso ----------

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function runMsg(text, kind) {
  $('runMsg').textContent = text;
  $('runMsg').className = 'msg ' + (kind || '');
  $('runMsg').hidden = !text;
}

async function start() {
  const version = globalThis.chrome?.runtime?.getManifest?.().version || '?';
  $('subtitle').textContent = (command === 'exportAll' ? 'Exportar todas as conversas' : 'Exportar a conversa aberta') + ` · v${version}`;
  $('stats').hidden = command !== 'exportAll';
  const folder = `Downloads/${opts.folder || 'Quantopus Exporter'}/`;
  $('dest').textContent = command === 'exportAll' && !opts.separateFiles
    ? `Entrega: um único .zip em ${folder} (uma pasta por número dentro dele)`
    : `Salvando em: ${folder}`;
  $('now').textContent = 'Iniciando…';
  log(`Janela aberta · v${version} · aba ${tabId} · ${command} · Downloads/${opts.folder || ''}`);

  running = true;
  startedAt = Date.now();
  timer = setInterval(() => ($('elapsed').textContent = fmtTime(Date.now() - startedAt)), 1000);

  try {
    const res = await chrome.tabs.sendMessage(tabId, { cmd: command, opts: { ...opts, saveMode: 'downloads', destName: 'Downloads' } });
    log('Resposta da aba: ' + JSON.stringify(res));
    if (!res?.ok) {
      finish({ error: true, title: 'Não foi possível começar', text: res?.error || 'A aba do WhatsApp recusou o pedido.' });
      return;
    }
  } catch (err) {
    log('A aba não respondeu — ' + errText(err), true);
    finish({
      error: true,
      title: 'Não foi possível começar',
      text: 'A aba do WhatsApp não respondeu. Recarregue o WhatsApp Web (F5) e clique em Exportar de novo.',
    });
    return;
  }
  setTimeout(() => {
    if (running && !gotProgress) {
      log('Nenhum progresso recebido em 10 s.', true);
      runMsg('A aba do WhatsApp não enviou progresso. Recarregue o WhatsApp Web (F5) e comece de novo.', 'err');
    }
  }, 10000);
}

function update(p) {
  if (!gotProgress) { gotProgress = true; runMsg(''); log('Progresso recebido da aba.'); }
  if (p.chat) $('now').textContent = p.chat;
  if (p.text != null) $('text').textContent = p.text;
  const bar = $('bar');
  if (p.total) {
    const pct = Math.min(100, Math.round(((p.current || 0) / p.total) * 100));
    bar.classList.remove('indeterminate');
    bar.firstElementChild.style.width = pct + '%';
    $('count').textContent = `Conversa ${p.current || 0} de ${p.total} · ${pct}%`;
  } else if (p.current) {
    $('count').textContent = `Conversa ${p.current}`;
  }
  if (p.exported != null) $('nOk').textContent = p.exported;
  if (p.skipped != null) $('nSkip').textContent = p.skipped;
  if (p.failed != null) $('nErr').textContent = p.failed;
  if (p.saved) log(`Salvo: ${p.saved}`);
  if (p.done) finish(p);
}

function finish(p) {
  if (!running) return;
  running = false;
  clearInterval(timer);
  log(`Fim: ${p.title || ''} — ${String(p.text || '').replace(/\n/g, ' | ')}`, !!p.error);
  $('runTitle').textContent = p.error ? 'Interrompido' : 'Concluído';
  $('now').textContent = p.title || (p.error ? 'Erro' : 'Pronto!');
  const bar = $('bar');
  bar.classList.remove('indeterminate');
  if (!p.error) bar.firstElementChild.style.width = '100%';
  if (p.text) $('text').textContent = p.text;
  runMsg(p.error ? 'A exportação não terminou normalmente. Veja os detalhes abaixo.' : 'Exportação concluída. Pode fechar esta janela.',
    p.error ? 'err' : 'ok');
  $('stop').hidden = true;
  $('close').hidden = false;
}

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  $('stop').textContent = 'Parando…';
  log('Pedido de parada enviado.');
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'cancel' }); } catch (err) { log('Parada não entregue — ' + errText(err), true); }
});
$('close').addEventListener('click', () => window.close());

function boot() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.tab?.id === tabId && msg?.cmd === 'progress') update(msg);
  });
  if (!tabId) {
    log('Janela aberta sem aba de origem.', true);
    runMsg('Abra esta janela pelo botão Exportar do Quantopus Exporter.', 'err');
    return;
  }
  start();
}

// Fora da extensão (testes), o boot é chamado manualmente depois de simular a API.
if (globalThis.chrome?.runtime?.onMessage) boot();
else globalThis.__quantopusBoot = boot;
