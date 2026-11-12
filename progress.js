// Janela do Quantopus Exporter.
// Etapa 1: escolher a pasta de destino (File System Access, na origem da extensão).
// Etapa 2: botão "Iniciar exportação" → manda a aba do WhatsApp começar; esta janela
// grava cada arquivo recebido na pasta escolhida e mostra o progresso.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
const command = params.get('cmd') === 'exportAll' ? 'exportAll' : 'export';
const opts = JSON.parse(params.get('opts') || '{}');

let dir = null; // FileSystemDirectoryHandle confirmado (com permissão de escrita)
let running = false;
let gotProgress = false;
let startedAt = 0;
let timer = null;
let writes = 0;

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
    await navigator.clipboard.writeText(`Quantopus Exporter ${chrome.runtime.getManifest?.().version || ''}\n${text}`);
    $('copyLog').textContent = 'Copiado!';
  } catch {
    $('copyLog').textContent = 'Não foi possível copiar';
  }
  setTimeout(() => ($('copyLog').textContent = 'Copiar detalhes'), 2000);
});

// ---------- Pasta guardada (IndexedDB da extensão) ----------

const IDB_NAME = 'quantopus-exporter';
const IDB_STORE = 'handles';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Gravação ----------

const joinPath = (...parts) => parts.filter(Boolean).join('/');

async function writeToDir(root, path, content) {
  const parts = path.split('/');
  const fileName = parts.pop();
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  // Não sobrescreve: "arquivo.txt" → "arquivo (2).txt" se já existir.
  let name = fileName;
  for (let i = 2; ; i++) {
    try { await d.getFileHandle(name); } catch { break; }
    name = fileName.replace(/(\.\w+)?$/, (ext) => ` (${i})${ext}`);
  }
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
  return joinPath(...parts, name);
}

// Confere, de verdade, que dá para gravar na pasta: cria e apaga um arquivo de teste.
async function probeWrite(handle) {
  const probe = '.quantopus-teste';
  const fh = await handle.getFileHandle(probe, { create: true });
  const w = await fh.createWritable();
  await w.write('ok');
  await w.close();
  await handle.removeEntry(probe);
}

// ---------- Etapa 1: pasta de destino ----------

function destMsg(text, kind = 'err') {
  $('destMsg').textContent = text;
  $('destMsg').className = 'msg ' + kind;
  $('destMsg').hidden = !text;
}

function showChosen(handle) {
  const box = $('chosen');
  if (handle) {
    box.classList.add('ok');
    $('chosenName').textContent = `✓ ${handle.name}`;
    $('chosenHint').textContent = `Os arquivos irão para ${joinPath(handle.name, opts.folder)}/<número>/`;
    $('startInfo').textContent = 'Pasta confirmada. Clique para começar.';
  } else {
    box.classList.remove('ok');
    $('chosenName').textContent = 'Nenhuma pasta escolhida';
    $('chosenHint').textContent = 'Escolha onde as conversas serão salvas.';
    $('startInfo').textContent = 'Escolha a pasta acima para liberar o botão.';
  }
  $('startBtn').disabled = !handle;
}

// Confirma a pasta: permissão de escrita + gravação de teste. Só então libera "Iniciar".
async function confirmFolder(handle, { request }) {
  log(`Pasta recebida: "${handle.name}"`);
  try {
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    log(`Permissão atual: ${perm}`);
    if (perm !== 'granted' && request) {
      perm = await handle.requestPermission({ mode: 'readwrite' });
      log(`Permissão após pedido: ${perm}`);
    }
    if (perm !== 'granted') {
      destMsg('O Chrome não autorizou gravar nessa pasta. Clique de novo e escolha "Permitir" / "Editar arquivos".');
      return false;
    }
    await probeWrite(handle);
    log('Gravação de teste na pasta: OK');
  } catch (err) {
    log('Falha ao confirmar a pasta — ' + errText(err), true);
    destMsg('Não foi possível gravar nessa pasta (' + (err?.message || err) + '). Escolha outra pasta.');
    return false;
  }
  dir = handle;
  destMsg('');
  showChosen(handle);
  try { await idbSet('dir', handle); log('Pasta guardada para as próximas vezes.'); }
  catch (err) { log('Não foi possível guardar a pasta (não impede a exportação) — ' + errText(err)); }
  return true;
}

const BLOCKED_HINT =
  'Nenhuma pasta foi selecionada. Se você escolheu Downloads, Documentos, Área de Trabalho ou uma pasta ' +
  'do sistema, o Chrome recusa a raiz delas: crie ou escolha uma subpasta (ex.: Downloads\\Quantopus).';

async function pickFolder(startIn) {
  destMsg('');
  log(startIn ? 'Abrindo seletor em Downloads…' : 'Abrindo seletor de pasta…');
  let handle;
  try {
    handle = await window.showDirectoryPicker(
      startIn ? { id: 'quantopus-dl', mode: 'readwrite', startIn } : { id: 'quantopus', mode: 'readwrite' }
    );
  } catch (err) {
    log('Seletor fechou sem pasta — ' + errText(err), err?.name !== 'AbortError');
    destMsg(err?.name === 'AbortError' ? BLOCKED_HINT : 'Não foi possível abrir o seletor: ' + (err?.message || err),
      err?.name === 'AbortError' ? 'info' : 'err');
    return;
  }
  await confirmFolder(handle, { request: true });
}

async function initDest() {
  $('subtitle').textContent = command === 'exportAll' ? 'Exportar todas as conversas' : 'Exportar a conversa aberta';
  log(`Janela aberta · aba ${tabId} · ${command} · subpasta "${opts.folder || ''}"`);
  showChosen(null);

  if (typeof window.showDirectoryPicker !== 'function') {
    log('Este navegador não tem showDirectoryPicker.', true);
    destMsg('Este navegador não permite escolher pastas. Atualize o Chrome.');
    $('pick').disabled = $('useDownloads').disabled = true;
    return;
  }

  let saved = null;
  try { saved = await idbGet('dir'); } catch (err) { log('Sem pasta guardada — ' + errText(err)); }
  if (!saved) { log('Nenhuma pasta usada antes.'); return; }

  log(`Última pasta usada: "${saved.name}"`);
  // Se a permissão ainda vale (mesma sessão do Chrome), já deixa confirmada.
  try {
    if ((await saved.queryPermission({ mode: 'readwrite' })) === 'granted') {
      await confirmFolder(saved, { request: false });
      return;
    }
  } catch {}
  const btn = $('useSaved');
  btn.hidden = false;
  btn.textContent = `Usar a última pasta: "${saved.name}"`;
  btn.addEventListener('click', () => confirmFolder(saved, { request: true }));
}

$('pick').addEventListener('click', () => pickFolder());
$('useDownloads').addEventListener('click', () => pickFolder('downloads'));
$('startBtn').addEventListener('click', () => { if (dir) start(); });

// ---------- Etapa 2: execução e progresso ----------

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
  $('startBtn').disabled = true;
  $('stepDest').hidden = true;
  $('stepRun').hidden = false;
  $('stats').hidden = command !== 'exportAll';
  $('dest').textContent = 'Destino: ' + joinPath(dir.name, opts.folder);
  $('now').textContent = `Pasta "${dir.name}" confirmada. Iniciando…`;
  running = true;
  startedAt = Date.now();
  timer = setInterval(() => ($('elapsed').textContent = fmtTime(Date.now() - startedAt)), 1000);

  const runOpts = { ...opts, saveMode: 'dir', destName: dir.name };
  log(`Enviando "${command}" para a aba ${tabId}…`);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { cmd: command, opts: runOpts });
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
      text: 'A aba do WhatsApp não respondeu. Recarregue o WhatsApp Web (F5), abra o Quantopus de novo e tente outra vez.',
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
  if (p.done) finish(p);
}

function finish(p) {
  if (!running && $('stop').hidden) return;
  running = false;
  clearInterval(timer);
  log(`Fim: ${p.title || ''} — ${String(p.text || '').replace(/\n/g, ' | ')}`, !!p.error);
  $('runTitle').textContent = p.error ? 'Interrompido' : 'Concluído';
  $('now').textContent = p.title || (p.error ? 'Erro' : 'Pronto!');
  const bar = $('bar');
  bar.classList.remove('indeterminate');
  if (!p.error) bar.firstElementChild.style.width = '100%';
  if (p.text) $('text').textContent = p.text;
  runMsg(p.error ? 'A exportação não terminou normalmente. Veja os detalhes abaixo.' : `Exportação concluída: ${writes} arquivo(s) gravado(s). Pode fechar esta janela.`,
    p.error ? 'err' : 'ok');
  $('stop').hidden = true;
  $('close').hidden = false;
  $('keepOpen').hidden = true;
}

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  $('stop').textContent = 'Parando…';
  log('Pedido de parada enviado.');
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'cancel' }); } catch (err) { log('Parada não entregue — ' + errText(err), true); }
});
$('close').addEventListener('click', () => window.close());

window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

function onMessage(msg, sender, sendResponse) {
  if (sender.tab?.id !== tabId) return;
  if (msg?.cmd === 'write') {
    if (!dir) { sendResponse({ ok: false, error: 'nenhuma pasta confirmada' }); return; }
    writeToDir(dir, msg.path, msg.content)
      .then((written) => {
        writes++;
        log(`Gravado: ${written}`);
        sendResponse({ ok: true, where: joinPath(dir.name, written) });
      })
      .catch((err) => {
        log(`Falha ao gravar ${msg.path} — ${errText(err)}`, true);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }
  if (msg?.cmd === 'progress') update(msg);
}

function boot() {
  chrome.runtime.onMessage.addListener(onMessage);
  if (!tabId) {
    log('Janela aberta sem aba de origem.', true);
    destMsg('Abra esta janela pelo botão Exportar do Quantopus Exporter.');
    for (const id of ['useSaved', 'pick', 'useDownloads']) $(id).disabled = true;
    return;
  }
  initDest();
}

// Fora da extensão (testes), o boot é chamado manualmente depois de simular a API.
if (globalThis.chrome?.runtime?.onMessage) boot();
else globalThis.__quantopusBoot = boot;
