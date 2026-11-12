const $ = (id) => document.getElementById(id);
const WA = 'https://web.whatsapp.com/';
let tabId = null;

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

function setReady(ready, chatName) {
  $('go').disabled = !ready;
  $('chatName').textContent = chatName || '—';
}

const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

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
  setReady(false);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  if (!tab?.url?.startsWith(WA)) {
    show('Abra o WhatsApp Web nesta aba para exportar uma conversa.');
    action('Abrir WhatsApp Web', () => chrome.tabs.create({ url: WA }));
    return;
  }

  let st;
  try {
    st = await send({ cmd: 'status' });
  } catch {
    show('Não consegui me conectar à página do WhatsApp Web. Recarregue a página e abra este menu de novo.', 'err');
    action('Recarregar WhatsApp Web', async () => {
      await chrome.tabs.reload(tabId);
      window.close();
    });
    return;
  }

  if (!st?.inChat) {
    show('Clique em uma conversa no WhatsApp Web e abra este menu de novo.');
    return;
  }

  setReady(!st.running, st.chatName);
  if (st.running) show('Já existe uma exportação em andamento nesta aba.');
}

$('go').addEventListener('click', async () => {
  const opts = {
    format: $('format').value,
    loadAll: $('loadAll').checked,
    since: $('since').value || null,
    delay: Number($('speed').value),
    maxMessages: parseInt($('maxMessages').value, 10) || 0,
  };
  save('format', opts.format);
  save('speed', $('speed').value);
  $('go').disabled = true;
  try {
    const res = await send({ cmd: 'export', opts });
    if (!res?.ok) {
      $('go').disabled = false;
      show(res?.error || 'Falha ao iniciar a exportação.', 'err');
      return;
    }
    show('Exportação iniciada! Acompanhe o progresso no canto da tela do WhatsApp. O arquivo será baixado automaticamente.', 'ok');
  } catch (e) {
    $('go').disabled = false;
    show('Erro: ' + (e?.message || e), 'err');
  }
});

init().catch((e) => show('Erro: ' + (e?.message || e), 'err'));
