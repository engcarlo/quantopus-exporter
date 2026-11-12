const $ = (id) => document.getElementById(id);
const WA = 'https://web.whatsapp.com/';
let tabId = null;
let pageStatus = null; // resposta do content script: { inChat, hasList, chatName, running }

// Mensagem de status no topo do popup. kind: 'info' | 'err' | 'ok'
function show(text, kind = 'info') {
  const m = $('msg');
  m.textContent = text || '';
  m.className = kind === 'info' ? '' : kind;
  m.hidden = !text;
}

// Botão de ação abaixo da mensagem (ex.: abrir ou recarregar o WhatsApp Web).
function action(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  $('actions').replaceChildren(b);
}

const mode = () => document.querySelector('input[name="mode"]:checked').value;
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// Atualiza a tela conforme o modo escolhido e o estado da página.
function refresh() {
  const all = mode() === 'all';
  $('oneBox').hidden = all;
  $('allBox').hidden = !all;
  $('go').textContent = all ? 'Exportar todas' : 'Exportar';

  const st = pageStatus;
  $('chatName').textContent = st?.chatName || '—';
  if (!st) { $('go').disabled = true; return; }

  if (st.running) {
    $('go').disabled = true;
    show('Já existe uma exportação em andamento nesta aba.');
  } else if (all) {
    $('go').disabled = !st.hasList;
    show(st.hasList ? '' : 'A lista de conversas do WhatsApp ainda não carregou. Aguarde e abra este menu de novo.');
  } else {
    $('go').disabled = !st.inChat;
    show(st.inChat ? '' : 'Clique em uma conversa no WhatsApp Web e abra este menu de novo, ou escolha "Todas as conversas".');
  }
}

// Envia mensagem ao content script; se ele não responder (extensão instalada ou
// recarregada com o WhatsApp já aberto), injeta o script e tenta de novo.
async function send(msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function init() {
  if (load('format')) $('format').value = load('format');
  if (load('speed')) $('speed').value = load('speed');
  $('folder').value = load('folder') ?? 'Quantopus Exporter';
  $('separateFiles').checked = load('separateFiles') === '1';
  $('openDlSettings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://settings/downloads' });
  });
  if (load('mode') === 'all') document.querySelector('input[name="mode"][value="all"]').checked = true;
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', () => { save('mode', mode()); refresh(); });
  }
  refresh();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  if (!tab?.url?.startsWith(WA)) {
    show('Abra o WhatsApp Web nesta aba para exportar conversas.');
    action('Abrir WhatsApp Web', () => chrome.tabs.create({ url: WA }));
    return;
  }

  try {
    pageStatus = await send({ cmd: 'status' });
  } catch {
    show('Não consegui me conectar à página do WhatsApp Web. Recarregue a página e abra este menu de novo.', 'err');
    action('Recarregar WhatsApp Web', async () => {
      await chrome.tabs.reload(tabId);
      window.close();
    });
    return;
  }
  refresh();
}

$('go').addEventListener('click', async () => {
  const all = mode() === 'all';
  const opts = {
    format: $('format').value,
    loadAll: $('loadAll').checked,
    since: $('since').value || null,
    delay: Number($('speed').value),
    maxMessages: parseInt($('maxMessages').value, 10) || 0,
    folder: $('folder').value.trim() || 'Quantopus Exporter',
  };
  save('folder', $('folder').value.trim());
  if (all) {
    opts.skipUnread = $('skipUnread').checked;
    opts.includeGroups = $('includeGroups').checked;
    opts.maxChats = parseInt($('maxChats').value, 10) || 0;
    opts.separateFiles = $('separateFiles').checked;
    save('separateFiles', opts.separateFiles ? '1' : '');
  }
  save('format', opts.format);
  save('speed', $('speed').value);
  $('go').disabled = true;
  try {
    // Garante que o script está ativo na aba antes de abrir a janela de progresso.
    const st = await send({ cmd: 'status' });
    if (st?.running) {
      $('go').disabled = false;
      show('Já existe uma exportação em andamento nesta aba.', 'err');
      return;
    }
    // A janela flutuante escolhe a pasta, inicia a exportação e mostra o progresso.
    const url = chrome.runtime.getURL('progress.html') +
      `?tab=${tabId}&cmd=${all ? 'exportAll' : 'export'}&opts=${encodeURIComponent(JSON.stringify(opts))}`;
    const cur = await chrome.windows.getCurrent();
    const width = 420;
    const height = 600;
    await chrome.windows.create({
      url,
      type: 'popup',
      width,
      height,
      left: Math.max(0, (cur.left ?? 0) + (cur.width ?? width) - width - 24),
      top: Math.max(0, (cur.top ?? 0) + 80),
      focused: true,
    });
    window.close();
  } catch (e) {
    $('go').disabled = false;
    show('Erro: ' + (e?.message || e), 'err');
  }
});

init().catch((e) => show('Erro: ' + (e?.message || e), 'err'));
