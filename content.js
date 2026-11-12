// Content script: lê a conversa aberta no WhatsApp Web e gera o arquivo de exportação.
// Nada é enviado para fora do navegador.
(() => {
  // Sem trava de "já carregado": depois que a extensão é recarregada, o script antigo
  // fica órfão (sem conexão com a extensão), mas a variável global continuaria marcada
  // e impediria o novo script de se registrar. O popup só reinjeta este arquivo quando
  // a aba não responde, então não há risco de listeners duplicados.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const job = { running: false, cancel: false, progress: {} };

  // Ritmo de carregamento do histórico: espera entre rolagens e pausa periódica.
  const PACING = { delay: 2000, pauseEvery: 50, pauseSeconds: 15 };
  const $main = () => document.querySelector('#main');

  // ---------- Leitura do DOM ----------

  // Caracteres invisíveis de direção de texto que o WhatsApp põe em volta de números.
  const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;
  const clean = (s) => (s || '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();
  // Comparação "solta": só letras e dígitos, ignorando emojis, pontuação e maiúsculas.
  const loose = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  function getChatName() {
    const header = $main()?.querySelector('header');
    if (!header) return 'conversa';
    const el =
      header.querySelector('span[dir="auto"][title]') ||
      header.querySelector('span[dir="auto"]');
    if (!el) return 'conversa';
    // textOf inclui os emojis (que são <img alt>), ao contrário de textContent.
    return clean(el.getAttribute('title') || textOf(el)) || 'conversa';
  }

  function findScroller() {
    const main = $main();
    if (!main) return null;
    const pref = main.querySelector('[data-testid="conversation-panel-messages"]');
    if (pref && pref.scrollHeight > pref.clientHeight) return pref;
    let best = null;
    for (const d of main.querySelectorAll('div')) {
      if (d.scrollHeight <= d.clientHeight + 10) continue;
      const oy = getComputedStyle(d).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && (!best || d.scrollHeight > best.scrollHeight)) best = d;
    }
    return best;
  }

  // Texto de um nó, trocando <img alt="😀"> (emojis) pelo caractere e <br> por quebra de linha.
  function textOf(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'IMG') out += n.getAttribute('alt') || '';
        else if (n.tagName === 'BR') out += '\n';
        else out += textOf(n);
      }
    }
    return out;
  }

  // data-pre-plain-text = "[14:32, 05/11/2026] Fulano: "
  const PRE_RE = /^\[([^,\]]+),\s*([^\]]+)\]\s*([\s\S]*?):\s*$/;
  const TIME_RE = /^\d{1,2}:\d{2}(\s?[ap]\.?\s?m\.?)?$/i;

  function detectType(row) {
    const has = (sel) => !!row.querySelector(sel);
    if (has('[data-icon*="recalled"]')) return 'apagada';
    if (has('audio, [data-icon*="audio-play"], [data-icon*="ptt"], [data-icon="audio-download"]')) return 'audio';
    if (has('[data-icon*="document"], [data-icon*="doc-"]')) return 'documento';
    if (has('video, [data-icon="media-play"], [data-icon*="video-pip"]')) return 'video';
    if (has('[data-icon*="vcard"]')) return 'contato';
    if (has('[data-icon*="location"]')) return 'localizacao';
    if (has('img[src^="blob:"]')) return 'imagem';
    return 'texto';
  }

  // Quem enviou a mensagem. O data-id antigo começava com "true_"/"false_"; nas versões
  // atuais é só um código, então usamos as marcas da bolha: "rabicho" de saída/entrada,
  // status de entrega (só mensagens enviadas têm) e, por fim, o alinhamento à direita.
  const STATUS_RE = /^\s*(entregue|lida|enviada|pendente|delivered|read|sent|pending|entregado|leído|enviado|pendiente)\s*$/i;
  function isFromMe(row, id) {
    if (id.startsWith('true_')) return true;
    if (id.startsWith('false_')) return false;
    if (row.querySelector('[data-testid="tail-out"], [data-icon="tail-out"], .message-out')) return true;
    if (row.querySelector('[data-testid="tail-in"], [data-icon="tail-in"], .message-in')) return false;
    if ([...row.querySelectorAll('[aria-label]')].some((e) => STATUS_RE.test(e.getAttribute('aria-label')))) return true;
    const main = $main();
    const bubble = row.querySelector('[data-pre-plain-text]') || row.querySelector('[data-testid="msg-container"]');
    if (main && bubble) {
      const m = main.getBoundingClientRect();
      const b = bubble.getBoundingClientRect();
      if (b.width) return m.right - b.right < b.left - m.left;
    }
    return false;
  }

  function parseRow(row) {
    const id = row.getAttribute('data-id') || '';
    const msg = {
      id,
      fromMe: isFromMe(row, id),
      date: '',
      time: '',
      sender: '',
      type: detectType(row),
      text: '',
      quote: '',
    };

    const preEl = row.querySelector('[data-pre-plain-text]');
    if (preEl) {
      const m = PRE_RE.exec(preEl.getAttribute('data-pre-plain-text') || '');
      if (m) {
        let a = m[1].trim();
        let b = m[2].trim();
        if (/[/.\-]/.test(a) && !/[/.\-]/.test(b)) [a, b] = [b, a]; // alguns idiomas invertem
        msg.time = a;
        msg.date = b;
        msg.sender = m[3].trim();
      }
      const spans = [...preEl.querySelectorAll('span.selectable-text')].filter(
        (s) => !s.closest('[role="button"]') && !s.parentElement?.closest('span.selectable-text')
      );
      msg.text = spans.map(textOf).join('\n').trim();
    }

    const quoteEl = row.querySelector('[role="button"] .quoted-mention');
    if (quoteEl) msg.quote = textOf(quoteEl).trim();

    if (!msg.time) {
      const times = [...row.querySelectorAll('span')]
        .map((s) => s.textContent.trim())
        .filter((t) => TIME_RE.test(t));
      if (times.length) msg.time = times[times.length - 1];
    }

    if (!preEl && msg.type === 'texto') {
      // Mensagem de sistema (entrou no grupo, criptografia etc.) ou sticker.
      msg.type = row.querySelector('img') ? 'sticker' : 'sistema';
      if (msg.type === 'sistema') {
        msg.text = textOf(row).replace(msg.time, '').trim();
      }
    }
    return msg;
  }

  function parseVisible() {
    const main = $main();
    if (!main) return [];
    return [...main.querySelectorAll('div[data-id]')]
      .filter((el) => !el.parentElement?.closest('div[data-id]'))
      .map(parseRow)
      .filter((m) => m.text || m.type !== 'sistema');
  }

  // Junta o que está visível agora com o que já foi coletado, preservando a ordem.
  function merge(list, store, order) {
    const firstKnown = list.findIndex((m) => store.has(m.id));
    if (firstKnown === -1) {
      if (order.length === 0) order.push(...list.map((m) => m.id));
      else order.unshift(...list.map((m) => m.id));
    } else {
      const before = list.slice(0, firstKnown).map((m) => m.id);
      order.unshift(...before);
      for (const m of list.slice(firstKnown)) if (!store.has(m.id)) order.push(m.id);
    }
    for (const m of list) store.set(m.id, m);
  }

  function clickLoadOlder() {
    const main = $main();
    if (!main) return;
    const btn = [...main.querySelectorAll('button, div[role="button"]')].find((b) =>
      /mensagens mais antigas|mensagens anteriores|older messages|mensajes anteriores|mensajes m[aá]s antiguos/i.test(
        b.textContent || ''
      )
    );
    if (btn) btn.click();
  }

  // ---------- Datas ----------

  function parseDate(s) {
    const m = (s || '').match(/(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})/);
    if (!m) return null;
    const [, a, b, c] = m;
    if (a.length === 4) return new Date(+a, +b - 1, +c);
    let y = +c;
    if (c.length === 2) y += 2000;
    const lang = document.documentElement.lang || navigator.language || '';
    const monthFirst = /^en(-US)?$/i.test(lang);
    const [d, mo] = monthFirst ? [+b, +a] : [+a, +b];
    return new Date(y, mo - 1, d);
  }

  function oldestDate(store, order) {
    for (const id of order) {
      const d = parseDate(store.get(id)?.date);
      if (d) return d;
    }
    return null;
  }

  // Preenche data/remetente que o WhatsApp não expõe em mídias e stickers.
  function fillGaps(msgs, chatName, isGroup = false) {
    const myName = msgs.find((m) => m.fromMe && m.sender)?.sender || 'Você';
    let lastDate = '';
    let prev = null;
    for (const m of msgs) {
      if (m.date) lastDate = m.date;
      else m.date = lastDate;
      if (!m.sender && m.type !== 'sistema') {
        if (m.fromMe) m.sender = myName;
        else if (isGroup || m.id.includes('@g.us')) m.sender = prev && !prev.fromMe && prev.sender ? prev.sender : '?';
        else m.sender = chatName;
      }
      prev = m;
    }
    let nextDate = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].date) nextDate = msgs[i].date;
      else msgs[i].date = nextDate;
    }
    return msgs;
  }

  // ---------- Formatos ----------

  const TYPE_LABEL = {
    imagem: 'imagem',
    video: 'vídeo',
    audio: 'áudio',
    documento: 'documento',
    sticker: 'figurinha',
    contato: 'contato',
    localizacao: 'localização',
    apagada: 'mensagem apagada',
  };

  const bodyOf = (m) => {
    const tag = TYPE_LABEL[m.type] ? `<${TYPE_LABEL[m.type]}>` : '';
    return [tag, m.text].filter(Boolean).join(' ');
  };

  function toTXT(msgs, meta) {
    const lines = [
      `Conversa: ${meta.chat}`,
      ...(meta.number ? [`Número: ${meta.number}`] : []),
      ...(meta.isGroup ? ['Tipo: grupo'] : []),
      `Exportada em: ${meta.exportedAt}`,
      `Mensagens: ${msgs.length}`,
      '',
    ];
    for (const m of msgs) {
      const q = m.quote ? `[respondendo a: "${m.quote.replace(/\s+/g, ' ').slice(0, 120)}"] ` : '';
      if (m.type === 'sistema') lines.push(`${m.date} ${m.time} - ${m.text}`);
      else lines.push(`${m.date} ${m.time} - ${m.sender}: ${q}${bodyOf(m)}`);
    }
    return lines.join('\r\n');
  }

  function toCSV(msgs) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['data', 'hora', 'remetente', 'enviada_por_mim', 'tipo', 'texto', 'citacao'].join(';')];
    for (const m of msgs) {
      rows.push(
        [m.date, m.time, m.sender, m.fromMe ? 'sim' : 'nao', m.type, m.text, m.quote].map(esc).join(';')
      );
    }
    return '\uFEFF' + rows.join('\r\n'); // BOM para o Excel abrir acentos corretamente
  }

  function toJSON(msgs, meta) {
    return JSON.stringify(
      {
        ...meta,
        total: msgs.length,
        messages: msgs.map(({ id, fromMe, date, time, sender, type, text, quote }) => ({
          id,
          fromMe,
          date,
          time,
          sender,
          type,
          text,
          quote: quote || undefined,
        })),
      },
      null,
      2
    );
  }

  function toHTML(msgs, meta) {
    const e = (s) =>
      String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    let lastDate = null;
    const parts = [];
    for (const m of msgs) {
      if (m.date && m.date !== lastDate) {
        parts.push(`<div class="day"><span>${e(m.date)}</span></div>`);
        lastDate = m.date;
      }
      if (m.type === 'sistema') {
        parts.push(`<div class="sys">${e(m.text)}</div>`);
        continue;
      }
      const tag = TYPE_LABEL[m.type] ? `<div class="media">${e(TYPE_LABEL[m.type])}</div>` : '';
      const quote = m.quote ? `<div class="quote">${e(m.quote)}</div>` : '';
      const who = m.fromMe ? '' : `<div class="who">${e(m.sender)}</div>`;
      parts.push(
        `<div class="msg ${m.fromMe ? 'me' : 'them'}">${who}${quote}${tag}` +
          `<div class="txt">${e(m.text).replace(/\n/g, '<br>')}</div>` +
          `<div class="time">${e(m.time)}</div></div>`
      );
    }
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(meta.chat)} — WhatsApp</title>
<style>
  :root { --bg:#efeae2; --me:#d9fdd3; --them:#fff; --ink:#111b21; --mute:#667781; --accent:#00a884; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b141a; --me:#005c4b; --them:#202c33; --ink:#e9edef; --mute:#8696a0; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14.5px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { position:sticky; top:0; background:var(--accent); color:#fff; padding:12px 16px; }
  header h1 { margin:0; font-size:17px; } header p { margin:2px 0 0; font-size:12px; opacity:.85; }
  main { max-width:860px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:4px; }
  .msg { max-width:min(75%,560px); padding:6px 9px 4px; border-radius:8px; box-shadow:0 1px .5px rgba(0,0,0,.13); word-wrap:break-word; }
  .me { align-self:flex-end; background:var(--me); } .them { align-self:flex-start; background:var(--them); }
  .who { font-size:12.5px; font-weight:600; color:var(--accent); }
  .quote { border-left:3px solid var(--accent); padding:3px 7px; margin:2px 0 4px; font-size:13px; color:var(--mute); background:rgba(0,0,0,.05); border-radius:4px; }
  .media { font-size:12px; color:var(--mute); font-style:italic; }
  .time { font-size:11px; color:var(--mute); text-align:right; }
  .day { text-align:center; margin:10px 0; } .day span { background:var(--them); color:var(--mute); font-size:12px; padding:4px 10px; border-radius:7px; }
  .sys { align-self:center; font-size:12px; color:var(--mute); text-align:center; max-width:90%; }
</style></head>
<body><header><h1>${e(meta.chat)}</h1><p>${msgs.length} mensagens · exportada em ${e(meta.exportedAt)}</p></header>
<main>
${parts.join('\n')}
</main></body></html>`;
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // ---------- Painel de progresso ----------

  function overlay(title, cancelLabel) {
    let el = document.getElementById('wa-exp-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wa-exp-overlay';
      el.innerHTML =
        '<div class="wa-exp-title"></div>' +
        '<div class="wa-exp-bar indeterminate"><i></i></div>' +
        '<div class="wa-exp-status"></div>' +
        '<button type="button" class="wa-exp-cancel"></button>';
      el.querySelector('.wa-exp-cancel').addEventListener('click', () => {
        job.cancel = true;
      });
      document.body.appendChild(el);
    }
    el.className = '';
    el.querySelector('.wa-exp-title').textContent = title;
    el.querySelector('.wa-exp-status').textContent = '';
    const bar = el.querySelector('.wa-exp-bar');
    bar.className = 'wa-exp-bar indeterminate';
    bar.firstElementChild.style.width = '';
    el.querySelector('.wa-exp-cancel').textContent = cancelLabel;
    return el;
  }

  // ---------- Identificação da conversa (número / grupo) ----------

  // O data-id das mensagens traz o identificador da conversa:
  //   "false_5511999999999@c.us_3EB0…"           → conversa individual (número)
  //   "false_120363…@g.us_3EB0…_5511…@c.us"       → grupo
  //   "false_123456789@lid_3EB0…"                 → contato com ID oculto (sem número)
  function chatIdentity(msgs, chatName) {
    const ids = msgs.map((m) => m.id || '');
    const header = $main()?.querySelector('header');
    if (ids.some((id) => id.includes('@g.us')) || header?.querySelector('[data-icon*="group"]')) {
      return { isGroup: true, number: '' };
    }
    for (const id of ids) {
      const jid = /^(?:true|false)_(\d{8,15})@c\.us(?:_|$)/.exec(id)?.[1];
      if (jid) return { isGroup: false, number: '+' + jid };
    }
    // Contato não salvo: o próprio título da conversa é o número.
    const title = clean(chatName);
    if (/^[\d\s()+\-.]+$/.test(title)) {
      const digits = title.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) return { isGroup: false, number: '+' + digits };
    }
    // Remetente das mensagens recebidas em conversa individual com contato não salvo.
    for (const m of msgs) {
      if (m.fromMe || !m.sender) continue;
      const s = clean(m.sender);
      if (/^\+?[\d\s()\-.]+$/.test(s)) {
        const digits = s.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) return { isGroup: false, number: '+' + digits };
      }
      break;
    }
    return { isGroup: false, number: '' };
  }

  const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  const today = () => new Date().toISOString().slice(0, 10);

  function fileBase(info) {
    const parts = ['WhatsApp'];
    if (info.isGroup) parts.push('Grupo');
    else if (info.number && info.number !== '+' + info.chat.replace(/\D/g, '')) parts.push(info.number);
    parts.push(info.chat);
    return safeSeg(parts.join(' - '));
  }

  // Pasta de cada conversa: o número; grupos e contatos sem número visível usam o nome.
  function folderName(info) {
    if (info.isGroup) return safeSeg(`Grupo - ${info.chat}`);
    if (info.number) return info.number;
    return safeSeg(`Sem número - ${info.chat}`);
  }

  const FORMATS = {
    txt: { mime: 'text/plain;charset=utf-8', build: (msgs, meta) => toTXT(msgs, meta) },
    html: { mime: 'text/html;charset=utf-8', build: (msgs, meta) => toHTML(msgs, meta) },
    csv: { mime: 'text/csv;charset=utf-8', build: (msgs) => toCSV(msgs) },
    json: { mime: 'application/json;charset=utf-8', build: (msgs, meta) => toJSON(msgs, meta) },
  };

  // ---------- Painel "Dados do contato" (número e grupo) ----------

  // O data-id das mensagens atuais não traz mais o número. Ele aparece no painel de
  // dados do contato, que abrimos e fechamos em seguida (sem efeito na conversa).
  const PHONE_RE = /\+\d{1,3}[\d\s().\-]{7,18}\d/;
  const GROUP_RE = /\b(grupo|group)\s*·|\b\d+\s+(membros|members|participantes|participants|miembros)\b/i;
  const CLOSE_RE = /^(fechar|close|cerrar)$/i;

  // Texto do painel lateral direito (tudo que está à direita da área de mensagens).
  function drawerTexts(mainRight) {
    const main = $main();
    const out = [];
    for (const el of document.querySelectorAll('span, div, h1, h2')) {
      if (el.children.length > 2 || main?.contains(el) || el.closest('#wa-exp-overlay')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || r.left < mainRight - 5) continue;
      const t = clean(el.textContent);
      if (t && t.length < 120) out.push(t);
    }
    return out;
  }

  function closeDrawer(mainRight) {
    const btn = [...document.querySelectorAll('[aria-label]')].find(
      (e) => CLOSE_RE.test((e.getAttribute('aria-label') || '').trim()) && e.getBoundingClientRect().left >= mainRight - 5
    );
    if (btn) realClick(btn);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  async function readContactInfo() {
    const main = $main();
    const btn =
      main?.querySelector('header [data-testid="conversation-info-header-button"]') ||
      main?.querySelector('header [role="button"]');
    if (!main || !btn) return { number: '', isGroup: false };
    const label = btn.getAttribute('aria-label') || '';
    let isGroup = /grupo|group/i.test(label);
    let number = '';
    const mainRight = main.getBoundingClientRect().right;

    realClick(btn);
    const t0 = Date.now();
    let opened = false;
    while (Date.now() - t0 < 6000) {
      await sleep(400);
      const right = $main()?.getBoundingClientRect().right ?? mainRight;
      if (right >= mainRight - 5) continue; // painel ainda não abriu
      const texts = drawerTexts(right);
      if (!texts.length) continue;
      opened = true;
      // Grupo primeiro: a lista de membros de um grupo também tem números.
      if (texts.some((t) => GROUP_RE.test(t))) { isGroup = true; break; }
      const hit = texts.find((t) => PHONE_RE.test(t));
      if (hit) { number = '+' + hit.match(PHONE_RE)[0].replace(/\D/g, ''); break; }
    }
    const rightNow = $main()?.getBoundingClientRect().right ?? mainRight;
    if (opened || rightNow < mainRight - 5) {
      closeDrawer(rightNow);
      for (let i = 0; i < 10 && ($main()?.getBoundingClientRect().right ?? mainRight) < mainRight - 5; i++) await sleep(200);
    }
    return { number: isGroup ? '' : number, isGroup };
  }

  // ---------- Salvar no disco ----------

  const DEFAULT_FOLDER = 'Quantopus Exporter';

  // Cada segmento de caminho precisa ser um nome válido de pasta/arquivo no Windows.
  const safeSeg = (s) => safeName(String(s)).replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || '_';
  const safePath = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).map(safeSeg).join('/');

  const joinPath = (...parts) => parts.filter(Boolean).join('/');
  const subfolder = (opts) => safePath(opts.folder ?? DEFAULT_FOLDER);

  // Destino escolhido na janela do Quantopus: "dir" (pasta do computador, gravada pela
  // própria janela) ou "downloads" (chrome.downloads, pelo service worker).
  // Destino único: Downloads/<pasta>/… via chrome.downloads (service worker).
  const destOf = () => ({ mode: 'downloads', name: 'Downloads' });

  // Avisa a janela de progresso de cada arquivo salvo (só para o registro).
  function notifySaved(where) {
    try { chrome.runtime.sendMessage({ cmd: 'progress', saved: where }).catch(() => {}); } catch {}
  }

  // Converte bytes em base64 (para mandar binários, como o .zip, ao service worker).
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Salva em Downloads/<path> via service worker (chrome.downloads). content pode ser
  // texto ou Blob (binário). Se o service worker falhar, usa o download comum.
  async function saveFile(dest, path, content, mime) {
    try {
      const msg = { cmd: 'save', filename: path, mime };
      if (content instanceof Blob) msg.base64 = bytesToBase64(new Uint8Array(await content.arrayBuffer()));
      else msg.content = content;
      const res = await chrome.runtime.sendMessage(msg);
      if (res?.ok) return { ok: true, where: `Downloads/${path}` };
      throw new Error(res?.error || 'falha ao salvar');
    } catch (err) {
      download(path.split('/').pop(), content, mime);
      return { ok: false, where: 'Downloads', error: err?.message || String(err) };
    }
  }

  const destLabel = (dest, base) => joinPath(dest?.name || 'Downloads', base);

  // ---------- Progresso (janela do Quantopus + painel da página) ----------

  function progress(update) {
    Object.assign(job.progress, update);
    const p = job.progress;
    // Barra do painel na página.
    const bar = document.querySelector('#wa-exp-overlay .wa-exp-bar');
    if (bar) {
      if (p.total) {
        bar.classList.remove('indeterminate');
        bar.firstElementChild.style.width = Math.min(100, Math.round(((p.current || 0) / p.total) * 100)) + '%';
      } else bar.classList.add('indeterminate');
      if (p.done) { bar.classList.remove('indeterminate'); if (!p.error) bar.firstElementChild.style.width = '100%'; }
    }
    // Janela do Quantopus (se estiver aberta).
    try { chrome.runtime.sendMessage({ cmd: 'progress', ...p }).catch(() => {}); } catch {}
  }

  // ---------- Coleta de uma conversa ----------

  // Lê a conversa aberta (rolando o histórico conforme as opções) e devolve as mensagens.
  async function collectChat(opts, report, contactInfo = null) {
    const chat = getChatName();
    const since = opts.since ? new Date(opts.since + 'T00:00:00') : null;
    const store = new Map();
    const order = [];

    let contact = contactInfo;
    if (!contact) {
      report('Lendo número do contato…');
      contact = await readContactInfo();
    }

    report('Lendo mensagens visíveis…');
    merge(parseVisible(), store, order);

    const delay = Math.max(1500, Number(opts.delay) || PACING.delay);
    const maxMessages = Math.max(0, Number(opts.maxMessages) || 0);
    const limitLabel = maxMessages ? ` de até ${maxMessages}` : '';
    let partial = false;

    if ((opts.loadAll || since) && !(maxMessages && order.length >= maxMessages)) {
      const sc = findScroller();
      if (!sc) throw new Error('Não encontrei a área de mensagens da conversa.');
      // Considera que chegou ao início após ~10 s sem novas mensagens.
      const stableLimit = Math.max(4, Math.ceil(10000 / delay));
      let stable = 0;
      let loads = 0;
      while (!job.cancel) {
        const prevH = sc.scrollHeight;
        const prevCount = order.length;
        sc.scrollTop = 0;
        clickLoadOlder();
        await sleep(delay);
        if (!$main() || getChatName() !== chat) throw new Error('A conversa foi trocada durante a exportação.');
        merge(parseVisible(), store, order);
        loads++;
        report(`Carregando histórico… ${order.length}${limitLabel} mensagens`);

        if (maxMessages && order.length >= maxMessages) break;
        if (since) {
          const oldest = oldestDate(store, order);
          if (oldest && oldest < since) break;
        }
        if (sc.scrollHeight === prevH && order.length === prevCount) {
          if (++stable >= stableLimit) break;
        } else stable = 0;

        // Pausa periódica para não puxar o histórico inteiro de uma vez.
        if (loads % PACING.pauseEvery === 0) {
          for (let s = PACING.pauseSeconds; s > 0 && !job.cancel; s--) {
            report(`Pausa curta (${s} s)… ${order.length}${limitLabel} mensagens até agora`);
            await sleep(1000);
          }
        }
      }
      partial = job.cancel;
    }

    let msgs = order.map((id) => store.get(id));
    const fallback = chatIdentity(msgs, chat);
    const identity = {
      isGroup: contact.isGroup || fallback.isGroup,
      number: contact.isGroup || fallback.isGroup ? '' : contact.number || fallback.number,
    };
    msgs = fillGaps(msgs, chat, identity.isGroup);
    if (since) {
      msgs = msgs.filter((m) => {
        const d = parseDate(m.date);
        return !d || d >= since;
      });
    }
    if (maxMessages && msgs.length > maxMessages) msgs = msgs.slice(-maxMessages); // mantém as mais recentes
    return { chat, ...identity, msgs, partial };
  }

  function buildFile(info, format) {
    const fmt = FORMATS[format];
    if (!fmt) throw new Error('Formato desconhecido: ' + format);
    const meta = {
      chat: info.chat,
      number: info.number || undefined,
      isGroup: info.isGroup,
      exportedAt: new Date().toLocaleString('pt-BR'),
    };
    return { name: `${fileBase(info)} - ${today()}.${format}`, content: fmt.build(info.msgs, meta), mime: fmt.mime };
  }

  // ---------- Exportar a conversa aberta ----------

  async function runExport(opts) {
    job.running = true;
    job.cancel = false;
    const ov = overlay('Exportando conversa', 'Parar e exportar o que já carregou');
    const status = ov.querySelector('.wa-exp-status');
    try {
      const dest = destOf(opts);
      job.progress = {};
      progress({ chat: getChatName(), current: 0, total: 0, text: 'Começando…' });
      const info = await collectChat(opts, (t) => { status.textContent = t; progress({ text: t }); });
      if (!info.msgs.length) throw new Error('Nenhuma mensagem encontrada.');
      const format = opts.format || 'txt';
      const file = buildFile(info, format);
      const path = joinPath(subfolder(opts), folderName(info), file.name);
      status.textContent = 'Salvando…';
      const saved = await saveFile(dest, path, file.content, file.mime);
            if (saved.ok) notifySaved(saved.where);
      finish(ov, 'Pronto!', `${info.msgs.length} mensagens exportadas em ${format.toUpperCase()}.\n` +
        (saved.ok ? `Salvo em ${saved.where}` : `Salvo na pasta padrão de downloads (${saved.error}).`), false, 10000);
    } catch (err) {
      finish(ov, 'Erro na exportação', err?.message || String(err), true);
    } finally {
      job.running = false;
    }
  }

  function finish(ov, title, text, isError = false, keepMs = 6000) {
    ov.className = isError ? 'done error' : 'done';
    ov.querySelector('.wa-exp-title').textContent = title;
    ov.querySelector('.wa-exp-status').textContent = text;
    progress({ done: true, error: isError, title, text });
    setTimeout(() => {
      if (!job.running) ov.remove();
    }, keepMs);
  }

  // ---------- Lista de conversas (painel da esquerda) ----------

  const $pane = () => document.querySelector('#pane-side');

  function paneScroller() {
    const pane = $pane();
    if (!pane) return null;
    if (pane.scrollHeight > pane.clientHeight + 10) return pane;
    for (const d of pane.querySelectorAll('div')) {
      if (d.scrollHeight > d.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(d).overflowY)) return d;
    }
    return pane;
  }

  const UNREAD_RE = /n[ãa]o lida|unread|no le[ií]d/i;

  // Conversas visíveis no painel, em ordem visual (a lista é virtualizada).
  function listChats() {
    const pane = $pane();
    if (!pane) return [];
    return [...pane.querySelectorAll('[role="listitem"], [role="row"]')]
      .filter((r) => !r.parentElement?.closest('[role="listitem"], [role="row"]'))
      .map((row) => {
        const titleEl = row.querySelector('span[title]');
        if (!titleEl) return null;
        const unread = [...row.querySelectorAll('[aria-label]')].some((e) => UNREAD_RE.test(e.getAttribute('aria-label')));
        return { row, titleEl, title: clean(titleEl.getAttribute('title')), unread, top: row.getBoundingClientRect().top };
      })
      .filter((c) => c && c.title)
      .sort((a, b) => a.top - b.top);
  }

  const isOpen = (entry) => !!$main() && loose(getChatName()) === loose(entry.title) && loose(entry.title) !== '';

  // Simula um clique "de verdade" (ponteiro + mouse + click), no centro do elemento.
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 80);
    const y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', ptr));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  function pressEnter(el) {
    el.focus?.({ preventScroll: true });
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function waitOpen(entry, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(250);
      if (isOpen(entry)) return true;
    }
    return false;
  }

  // Abre uma conversa da lista. Tenta vários alvos e formas de clique, porque o
  // WhatsApp Web muda a estrutura da lista com frequência.
  async function openChat(entry) {
    if (isOpen(entry)) return true;
    entry.row.scrollIntoView({ block: 'center' });
    await sleep(400);
    // A lista é virtualizada: depois de rolar, o elemento pode ter sido recriado.
    entry = listChats().find((c) => c.title === entry.title) || entry;

    const t = entry.titleEl;
    const candidates = [
      t.closest('[role="gridcell"]'),
      t.closest('[tabindex]'),
      t.closest('[role="button"]'),
      entry.row.querySelector('[tabindex]'),
      entry.row.firstElementChild,
      entry.row,
      t,
    ].filter((el, i, arr) => el && entry.row.contains(el) && arr.indexOf(el) === i);

    for (const el of candidates) {
      realClick(el);
      if (await waitOpen(entry, 2500)) {
        await sleep(1500); // deixa as mensagens renderizarem
        return true;
      }
    }
    for (const el of candidates.slice(0, 2)) {
      pressEnter(el);
      if (await waitOpen(entry, 2500)) {
        await sleep(1500);
        return true;
      }
    }
    return false;
  }

  async function waitCancellable(seconds, report, label) {
    for (let s = seconds; s > 0 && !job.cancel; s--) {
      report(`${label} (${s} s)…`);
      await sleep(1000);
    }
  }

  // ---------- Exportar todas as conversas ----------

  async function runExportAll(opts) {
    job.running = true;
    job.cancel = false;
    const ov = overlay('Exportando todas as conversas', 'Parar e salvar o que já exportou');
    const status = ov.querySelector('.wa-exp-status');
    const format = opts.format || 'txt';
    const maxChats = Math.max(0, Number(opts.maxChats) || 0);
    const base = subfolder(opts);
    const dest = destOf(opts);
    const index = [];
    const seen = new Set();
    let exported = 0;
    let saveFails = 0;
    let openFails = 0;
    let abortReason = '';
    // Padrão: um único .zip no fim (o Chrome pergunta no máximo uma vez).
    // Opcional: cada conversa salva na hora (exige desligar "Perguntar onde salvar").
    const asZip = !opts.separateFiles;
    const zipEntries = [];

    // Total de conversas da lista (o WhatsApp informa em aria-rowcount).
    const listTotal = () => Number($pane()?.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')) || 0;
    const counts = () => ({
      exported,
      skipped: index.filter((r) => /^pulada|^sem mensagens/.test(r.status)).length,
      failed: index.filter((r) => /^erro/.test(r.status)).length,
    });
    job.progress = {};
    progress({ current: 0, total: listTotal(), chat: 'Preparando a lista de conversas…', text: '', ...counts() });

    try {
      const sc = paneScroller();
      if (!sc) throw new Error('Não encontrei a lista de conversas.');
      sc.scrollTop = 0;
      await sleep(1200);

      while (!job.cancel) {
        if (maxChats && exported >= maxChats) break;
        const next = listChats().find((c) => !seen.has(c.title));
        if (!next) {
          const prev = sc.scrollTop;
          sc.scrollTop = prev + sc.clientHeight * 0.8;
          await sleep(1200);
          if (sc.scrollTop === prev) break; // fim da lista
          continue;
        }
        seen.add(next.title);
        const n = seen.size;
        const total = Math.max(listTotal(), n);
        const prefix = `Conversa ${n}${total ? ` de ${total}` : ''} · ${next.title}`;
        progress({
          current: maxChats ? exported + 1 : n,
          total: maxChats ? Math.min(total, maxChats) : total,
          chat: next.title,
          ...counts(),
        });
        const report = (t) => {
          status.textContent = `${prefix}\n${t}\n${exported} exportada(s) até agora`;
          progress({ text: t, ...counts() });
        };

        if (opts.skipUnread && next.unread) {
          index.push({ chat: next.title, status: 'pulada: mensagens não lidas' });
          continue;
        }

        report('Abrindo…');
        if (!(await openChat(next))) {
          index.push({ chat: next.title, status: 'erro: não abriu' });
          // Se várias seguidas não abrem, o WhatsApp mudou algo: para em vez de percorrer a lista toda.
          if (++openFails >= 3) {
            abortReason = 'Não consegui abrir as conversas automaticamente (3 tentativas seguidas falharam). ' +
              'O WhatsApp Web pode ter mudado; atualize a extensão ou exporte as conversas uma a uma.';
            break;
          }
          continue;
        }
        openFails = 0;

        report('Lendo número do contato…');
        const contact = await readContactInfo();
        if (contact.isGroup && !opts.includeGroups) {
          index.push({ chat: next.title, isGroup: true, status: 'pulada: grupo' });
          continue;
        }

        try {
          const info = await collectChat(opts, report, contact);
          if (!info.msgs.length) {
            index.push({ chat: info.chat, number: info.number, isGroup: info.isGroup, status: 'sem mensagens' });
          } else {
            const file = buildFile(info, format);
            const inner = joinPath(folderName(info), file.name); // <número>/<arquivo>
            if (asZip) {
              // Guarda para o .zip final (um único download, sem uma janela por arquivo).
              zipEntries.push({ name: inner, data: file.content });
              exported++;
              index.push({
                chat: info.chat, number: info.number, isGroup: info.isGroup, count: info.msgs.length,
                file: inner, status: info.partial ? 'parcial' : 'ok',
              });
            } else {
              // Salva já, arquivo por arquivo: Downloads/<pasta>/<número>/<arquivo>.
              report('Salvando…');
              const saved = await saveFile(dest, joinPath(base, inner), file.content, file.mime);
              if (saved.ok) notifySaved(saved.where);
              else saveFails++;
              exported++;
              index.push({
                chat: info.chat, number: info.number, isGroup: info.isGroup, count: info.msgs.length,
                file: saved.ok ? saved.where : file.name,
                status: (info.partial ? 'parcial' : 'ok') + (saved.ok ? '' : ' (salvo na pasta padrão de downloads)'),
              });
            }
          }
        } catch (err) {
          index.push({ chat: next.title, status: 'erro: ' + (err?.message || err) });
        }

        // Pausa entre conversas, e uma pausa maior a cada 10 exportadas.
        if (!job.cancel) {
          if (exported && exported % 10 === 0) await waitCancellable(30, report, 'Pausa longa');
          else await waitCancellable(Math.round((Number(opts.delay) || PACING.delay) / 500), report, 'Próxima conversa em');
        }
      }

      if (!index.length) throw new Error(abortReason || 'Nenhuma conversa encontrada na lista.');

      // Índice da execução: todas as conversas encontradas e o que aconteceu com cada uma.
      status.textContent = asZip ? 'Montando o arquivo .zip…' : 'Salvando o índice…';
      progress({ text: status.textContent, ...counts() });
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const indexCsv =
        '\uFEFF' +
        [['conversa', 'numero', 'grupo', 'mensagens', 'arquivo', 'status'].join(';')]
          .concat(index.map((r) => [r.chat, r.number, r.isGroup ? 'sim' : 'nao', r.count ?? '', r.file ?? '', r.status].map(esc).join(';')))
          .join('\r\n');
      const stamp = new Date().toLocaleString('sv-SE').replace(/:/g, '-').slice(0, 16);
      let savedTo = destLabel(dest, base);
      if (asZip) {
        if (zipEntries.length) {
          const zip = makeZip([...zipEntries, { name: `indice ${stamp}.csv`, data: indexCsv }]);
          const zipPath = joinPath(base, `Quantopus - conversas ${stamp}.zip`);
          const saved = await saveFile(dest, zipPath, zip, 'application/zip');
          if (saved.ok) notifySaved(saved.where);
          savedTo = saved.ok ? saved.where : 'Downloads';
        }
      } else {
        await saveFile(dest, joinPath(base, `indice ${stamp}.csv`), indexCsv, 'text/csv;charset=utf-8');
      }

      const skipped = index.length - exported;
      const summary = `${exported} conversa(s) salva(s) em ${savedTo}` +
        (skipped ? `\n${skipped} pulada(s) ou com erro (veja o índice).` : '') +
        (saveFails ? `\n${saveFails} foram para a pasta padrão de downloads.` : '');
      if (!exported && !abortReason) throw new Error('Nenhuma conversa foi exportada (veja o índice).');
      if (abortReason) finish(ov, 'Exportação interrompida', `${abortReason}\n\n${summary}`, true, 30000);
      else finish(ov, 'Pronto!', summary, false, 15000);
    } catch (err) {
      finish(ov, 'Erro na exportação', err?.message || String(err), true, 15000);
    } finally {
      job.running = false;
    }
  }

  // ---------- ZIP (sem compressão, sem dependências) ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeZip(entries) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // nomes em UTF-8
      local.setUint16(8, 0, true); // sem compressão
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(local.buffer), name, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);

      offset += 30 + name.length + data.length;
    }

    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // ---------- Mensagens do popup ----------

  // Só a cópia mais recente deste script responde. Se ele for injetado de novo na mesma
  // aba (extensão recarregada), a cópia anterior fica muda em vez de rodar em paralelo.
  const instance = {};
  window.__quantopusInstance = instance;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (window.__quantopusInstance !== instance) return;
    if (msg?.cmd === 'status') {
      const inChat = !!$main();
      sendResponse({
        ok: true,
        inChat,
        hasList: !!$pane(),
        chatName: inChat ? getChatName() : null,
        running: job.running,
        version: chrome.runtime.getManifest().version,
      });
    } else if (msg?.cmd === 'export' || msg?.cmd === 'exportAll') {
      const all = msg.cmd === 'exportAll';
      if (job.running) sendResponse({ ok: false, error: 'Já existe uma exportação em andamento.' });
      else if (!all && !$main()) sendResponse({ ok: false, error: 'Abra uma conversa no WhatsApp primeiro.' });
      else if (all && !$pane()) sendResponse({ ok: false, error: 'Não encontrei a lista de conversas do WhatsApp.' });
      else {
        (all ? runExportAll : runExport)(msg.opts || {});
        sendResponse({ ok: true });
      }
    } else if (msg?.cmd === 'cancel') {
      job.cancel = true;
      sendResponse({ ok: true });
    }
  });
})();
