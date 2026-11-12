// Service worker: grava os arquivos exportados direto no disco, na pasta escolhida
// (relativa à pasta de Downloads do Chrome), sem abrir a janela "Salvar como".

function toDataUrl(content, mime) {
  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd !== 'save') return;
  (async () => {
    try {
      const id = await chrome.downloads.download({
        url: toDataUrl(msg.content, msg.mime || 'text/plain;charset=utf-8'),
        filename: msg.filename, // ex.: "Quantopus Exporter/+5511999999999/WhatsApp - Ana - 2026-11-12.txt"
        conflictAction: 'uniquify',
        saveAs: false,
      });
      sendResponse({ ok: true, id });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // resposta assíncrona
});
