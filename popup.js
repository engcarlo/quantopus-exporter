const $ = (id) => document.getElementById(id);
const WA = 'https://web.whatsapp.com/';

function show(text, isError = false) {
  $('msg').textContent = text;
  $('msg').className = isError ? 'err' : '';
}

// Envia mensagem ao content script; se ele ainda não estiver na aba (extensão
// instalada com o WhatsApp já aberto), injeta e tenta de novo.
async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function init() {
  const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  if (load('format')) $('format').value = load('format');
  if (load('speed')) $('speed').value = load('speed');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith(WA)) {
    show('Abra o WhatsApp Web nesta aba para exportar uma conversa.');
    const b = document.createElement('button');
    b.textContent = 'Abrir WhatsApp Web';
    b.onclick = () => chrome.tabs.create({ url: WA });
    document.body.appendChild(b);
    return;
  }

  let st;
  try {
    st = await send(tab.id, { cmd: 'status' });
  } catch (e) {
    show('Não consegui acessar a página. Recarregue o WhatsApp Web (F5) e tente de novo.', true);
    return;
  }

  if (!st?.inChat) {
    show('Clique em uma conversa no WhatsApp Web e abra este menu novamente.');
    return;
  }

  $('chatName').textContent = st.chatName || '—';
  $('form').classList.remove('hidden');
  if (st.running) {
    $('go').disabled = true;
    show('Já existe uma exportação em andamento nesta aba.');
  }

  $('go').addEventListener('click', async () => {
    const opts = {
      format: $('format').value,
      loadAll: $('loadAll').checked,
      since: $('since').value || null,
      delay: Number($('speed').value),
      maxMessages: parseInt($('maxMessages').value, 10) || 0,
    };
    try {
      localStorage.setItem('format', opts.format);
      localStorage.setItem('speed', $('speed').value);
    } catch {}
    $('go').disabled = true;
    try {
      const res = await send(tab.id, { cmd: 'export', opts });
      if (!res?.ok) {
        $('go').disabled = false;
        show(res?.error || 'Falha ao iniciar a exportação.', true);
        return;
      }
      show('Exportação iniciada! Acompanhe o progresso no canto da tela do WhatsApp. O arquivo será baixado automaticamente.');
    } catch (e) {
      $('go').disabled = false;
      show('Erro: ' + (e?.message || e), true);
    }
  });
}

init();
