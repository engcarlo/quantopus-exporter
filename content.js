// Content script: lê a conversa aberta no WhatsApp Web e gera o arquivo de exportação.
// Nada é enviado para fora do navegador.
(() => {
  // Sem trava de "já carregado": depois que a extensão é recarregada, o script antigo
  // fica órfão (sem conexão com a extensão), mas a variável global continuaria marcada
  // e impediria o novo script de se registrar. O popup só reinjeta este arquivo quando
  // a aba não responde, então não há risco de listeners duplicados.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const job = { running: false, cancel: false };

  // Ritmo de carregamento do histórico: espera entre rolagens e pausa periódica.
  const PACING = { delay: 2000, pauseEvery: 50, pauseSeconds: 15 };
  const $main = () => document.querySelector('#main');

  // ---------- Leitura do DOM ----------

  function getChatName() {
    const header = $main()?.querySelector('header');
    if (!header) return 'conversa';
    const el =
      header.querySelector('span[dir="auto"][title]') ||
      header.querySelector('span[dir="auto"]');
    return ((el && (el.getAttribute('title') || el.textContent)) || 'conversa').trim();
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

  function parseRow(row) {
    const id = row.getAttribute('data-id') || '';
    const msg = {
      id,
      fromMe: id.startsWith('true_'),
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
  function fillGaps(msgs, chatName) {
    const myName = msgs.find((m) => m.fromMe && m.sender)?.sender || 'Você';
    let lastDate = '';
    let prev = null;
    for (const m of msgs) {
      if (m.date) lastDate = m.date;
      else m.date = lastDate;
      if (!m.sender && m.type !== 'sistema') {
        if (m.fromMe) m.sender = myName;
        else if (m.id.includes('@g.us')) m.sender = prev && !prev.fromMe && prev.sender ? prev.sender : '?';
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
    return '﻿' + rows.join('\r\n'); // BOM para o Excel abrir acentos corretamente
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

  function overlay() {
    let el = document.getElementById('wa-exp-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wa-exp-overlay';
      el.innerHTML =
        '<div class="wa-exp-title">Exportando conversa</div>' +
        '<div class="wa-exp-status"></div>' +
        '<button type="button">Parar e exportar o que já carregou</button>';
      el.querySelector('button').addEventListener('click', () => {
        job.cancel = true;
      });
      document.body.appendChild(el);
    }
    el.className = '';
    el.querySelector('.wa-exp-title').textContent = 'Exportando conversa';
    return el;
  }

  // ---------- Exportação ----------

  async function runExport(opts) {
    job.running = true;
    job.cancel = false;
    const ov = overlay();
    const status = ov.querySelector('.wa-exp-status');
    const chat = getChatName();
    const since = opts.since ? new Date(opts.since + 'T00:00:00') : null;
    const store = new Map();
    const order = [];

    try {
      status.textContent = 'Lendo mensagens visíveis…';
      merge(parseVisible(), store, order);

      const delay = Math.max(1500, Number(opts.delay) || PACING.delay);
      const maxMessages = Math.max(0, Number(opts.maxMessages) || 0);
      const limitLabel = maxMessages ? ` de até ${maxMessages}` : '';

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
          status.textContent = `Carregando histórico… ${order.length}${limitLabel} mensagens`;

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
              status.textContent = `Pausa curta (${s} s)… ${order.length}${limitLabel} mensagens até agora`;
              await sleep(1000);
            }
          }
        }
      }

      let msgs = fillGaps(order.map((id) => store.get(id)), chat);
      if (since) {
        msgs = msgs.filter((m) => {
          const d = parseDate(m.date);
          return !d || d >= since;
        });
      }
      if (maxMessages && msgs.length > maxMessages) msgs = msgs.slice(-maxMessages); // mantém as mais recentes
      if (!msgs.length) throw new Error('Nenhuma mensagem encontrada.');

      const meta = { chat, exportedAt: new Date().toLocaleString('pt-BR') };
      const base = `WhatsApp - ${chat}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      const stamp = new Date().toISOString().slice(0, 10);
      const format = opts.format || 'txt';
      const out = {
        txt: () => [toTXT(msgs, meta), 'text/plain;charset=utf-8'],
        html: () => [toHTML(msgs, meta), 'text/html;charset=utf-8'],
        csv: () => [toCSV(msgs), 'text/csv;charset=utf-8'],
        json: () => [toJSON(msgs, meta), 'application/json;charset=utf-8'],
      }[format];
      if (!out) throw new Error('Formato desconhecido: ' + format);
      const [content, mime] = out();
      download(`${base} - ${stamp}.${format}`, content, mime);

      ov.className = 'done';
      ov.querySelector('.wa-exp-title').textContent = 'Pronto!';
      status.textContent = `${msgs.length} mensagens exportadas em ${format.toUpperCase()}.`;
    } catch (err) {
      ov.className = 'done error';
      ov.querySelector('.wa-exp-title').textContent = 'Erro na exportação';
      status.textContent = err?.message || String(err);
    } finally {
      job.running = false;
      setTimeout(() => {
        if (!job.running) ov.remove();
      }, 6000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd === 'status') {
      const inChat = !!$main();
      sendResponse({ ok: true, inChat, chatName: inChat ? getChatName() : null, running: job.running });
    } else if (msg?.cmd === 'export') {
      if (job.running) sendResponse({ ok: false, error: 'Já existe uma exportação em andamento.' });
      else if (!$main()) sendResponse({ ok: false, error: 'Abra uma conversa no WhatsApp primeiro.' });
      else {
        runExport(msg.opts || {});
        sendResponse({ ok: true });
      }
    }
  });
})();
