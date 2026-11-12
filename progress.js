// Janela flutuante do Quantopus Exporter: escolhe a pasta de destino, grava os arquivos
// em segundo plano (File System Access API, na origem da extensão) e mostra o progresso.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
const command = params.get('cmd') === 'exportAll' ? 'exportAll' : 'export';
const opts = JSON.parse(params.get('opts') || '{}');

let dir = null; // FileSystemDirectoryHandle escolhido (null = Downloads)
let running = false;
let startedAt = 0;
let timer = null;

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

// ---------- Escolha da pasta ----------

function destError(text, kind = 'err') {
  $('destMsg').textContent = text;
  $('destMsg').className = 'msg ' + kind;
  $('destMsg').hidden = !text;
}

const BLOCKED_HINT =
  'Nenhuma pasta foi selecionada. O Chrome não permite usar a raiz de algumas pastas ' +
  '(Downloads, Documentos, Área de Trabalho e pastas do sistema). Crie ou escolha uma ' +
  'subpasta dentro delas, por exemplo Downloads\\Quantopus.';

// Abre o seletor de pastas. startIn = 'downloads' começa na pasta Downloads.
async function pickFolder(startIn) {
  destError('');
  let d;
  try {
    d = await window.showDirectoryPicker(
      startIn ? { id: 'quantopus-dl', mode: 'readwrite', startIn } : { id: 'quantopus', mode: 'readwrite' }
    );
  } catch (err) {
    // O Chrome devolve "AbortError" tanto quando o usuário cancela quanto quando recusa
    // uma pasta protegida. Nos dois casos explicamos o que fazer, em vez de não fazer nada.
    if (err?.name === 'AbortError') destError(BLOCKED_HINT, 'info');
    else destError('Não foi possível usar essa pasta: ' + (err?.message || err));
    return;
  }
  try {
    if ((await d.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
        (await d.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      destError('O Chrome não autorizou gravar nessa pasta. Tente de novo e clique em "Permitir"/"Editar arquivos".');
      return;
    }
  } catch (err) {
    destError('Não foi possível verificar a permissão da pasta: ' + (err?.message || err));
    return;
  }
  try { await idbSet('dir', d); } catch {}
  start(d);
}

async function initDest() {
  $('subtitle').textContent = command === 'exportAll' ? 'Exportar todas as conversas' : 'Exportar a conversa aberta';
  if (typeof window.showDirectoryPicker !== 'function') {
    $('pick').hidden = true;
    destError('Este navegador não permite escolher pastas. Os arquivos irão para Downloads.');
  }
  let saved = null;
  try { saved = await idbGet('dir'); } catch {}
  if (saved) {
    const btn = $('useSaved');
    btn.hidden = false;
    btn.textContent = `Usar a pasta "${saved.name}"`;
    $('pick').textContent = 'Escolher outra pasta…';
    $('pick').className = 'ghost';
    btn.addEventListener('click', async () => {
      try {
        const perm = await saved.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') start(saved);
        else destError('Sem permissão para gravar nessa pasta. Autorize ou escolha outra.');
      } catch (err) {
        destError('Não foi possível usar essa pasta: ' + (err?.message || err));
      }
    });
  }
}

$('pick').addEventListener('click', () => pickFolder());
$('useDownloads').addEventListener('click', () => pickFolder('downloads'));

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

async function start(chosen) {
  dir = chosen;
  $('stepDest').hidden = true;
  $('stepRun').hidden = false;
  $('stats').hidden = command !== 'exportAll';
  $('dest').textContent = 'Destino: ' + joinPath(dir ? dir.name : 'Downloads', opts.folder);
  running = true;
  startedAt = Date.now();
  timer = setInterval(() => ($('elapsed').textContent = fmtTime(Date.now() - startedAt)), 1000);

  $('now').textContent = `Pasta "${dir ? dir.name : 'Downloads'}" selecionada. Iniciando…`;

  const runOpts = { ...opts, saveMode: dir ? 'dir' : 'downloads', destName: dir ? dir.name : 'Downloads' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, { cmd: command, opts: runOpts });
    if (!res?.ok) {
      finish({ error: true, title: 'Não foi possível começar', text: res?.error || 'A aba do WhatsApp não respondeu.' });
      return;
    }
  } catch (err) {
    finish({
      error: true,
      title: 'Não foi possível começar',
      text: 'A aba do WhatsApp não respondeu. Recarregue o WhatsApp Web (F5), abra o Quantopus de novo e tente outra vez.',
    });
    return;
  }
  // Se a aba aceitou mas nenhum progresso chegar, avisa em vez de ficar parado em silêncio.
  setTimeout(() => {
    if (running && !gotProgress) {
      runMsg('A aba do WhatsApp não enviou nenhum progresso. Se a extensão foi atualizada agora, ' +
        'recarregue o WhatsApp Web (F5) e comece de novo.', 'err');
    }
  }, 10000);
}

let gotProgress = false;

function update(p) {
  if (!gotProgress) { gotProgress = true; runMsg(''); }
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
  running = false;
  clearInterval(timer);
  $('runTitle').textContent = p.error ? '2 · Interrompido' : '2 · Concluído';
  $('now').textContent = p.title || (p.error ? 'Erro' : 'Pronto!');
  const bar = $('bar');
  bar.classList.remove('indeterminate');
  if (!p.error) bar.firstElementChild.style.width = '100%';
  if (p.text) $('text').textContent = p.text;
  runMsg(p.error ? 'A exportação não terminou normalmente. Veja a mensagem acima.' : 'Exportação concluída. Você já pode fechar esta janela.', p.error ? 'err' : 'ok');
  $('stop').hidden = true;
  $('close').hidden = false;
  $('keepOpen').hidden = true;
}

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  $('stop').textContent = 'Parando…';
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'cancel' }); } catch {}
});
$('close').addEventListener('click', () => window.close());

window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

// Mensagens do content script da aba do WhatsApp.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab?.id !== tabId) return;
  if (msg?.cmd === 'write') {
    if (!dir) { sendResponse({ ok: false, error: 'sem pasta escolhida' }); return; }
    writeToDir(dir, msg.path, msg.content)
      .then((written) => sendResponse({ ok: true, where: joinPath(dir.name, written) }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.cmd === 'progress') update(msg);
});

if (!tabId) {
  destError('Abra esta janela pelo botão Exportar do Quantopus Exporter.');
  for (const id of ['useSaved', 'pick', 'useDownloads']) $(id).disabled = true;
} else {
  initDest();
}
