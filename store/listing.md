# Textos para a Chrome Web Store / Edge Add-ons

Copie cada bloco para o campo correspondente no painel do desenvolvedor.

---

## Nome
Quantopus Exporter: exporte conversas do WhatsApp Web

## Resumo (até 132 caracteres — vem do `description` do manifest)
Exporte a conversa aberta no WhatsApp Web para TXT, HTML, CSV ou JSON. 100% local. Não afiliada ao WhatsApp ou à Meta.

## Categoria
Produtividade (Productivity → Tools / Workflow & Planning)

## Idioma
Português (Brasil)

## Descrição detalhada

Salve suas conversas do WhatsApp Web em um arquivo, direto do computador, em poucos cliques.

COMO FUNCIONA
1. Abra o WhatsApp Web e clique na conversa que quer salvar.
2. Clique no ícone da extensão, escolha o formato e clique em "Exportar".
3. Acompanhe o progresso no canto da tela. O arquivo é baixado automaticamente.

FORMATOS
• TXT — no mesmo estilo da exportação do celular (data, hora, remetente e mensagem).
• HTML — página com balões de chat, fácil de ler e imprimir. Tema claro e escuro.
• CSV — abre direto no Excel e no Google Planilhas, com acentos corretos.
• JSON — dados estruturados para quem quer analisar ou integrar com outros sistemas.

RECURSOS
• Carrega o histórico completo da conversa, ou só a partir de uma data.
• Limite opcional de número de mensagens.
• Mantém emojis, quebras de linha e mensagens respondidas (citações).
• Identifica fotos, vídeos, áudios, documentos, figurinhas e mensagens apagadas.
• Ritmo de carregamento cuidadoso, com pausas automáticas.
• Botão para parar a qualquer momento e exportar o que já foi carregado.

PRIVACIDADE EM PRIMEIRO LUGAR
Tudo é processado no seu navegador. A extensão não tem servidor, não coleta dados, não envia mensagens e não compartilha nada com ninguém. O arquivo gerado fica só no seu computador.

LIMITAÇÕES
• Arquivos de mídia (fotos, vídeos, áudios) não são baixados — aparecem como marcadores, com a legenda quando houver.
• Só é possível exportar o histórico que o WhatsApp Web consegue carregar a partir do celular.

AVISO
Esta extensão é um projeto independente e não é afiliada, associada, autorizada ou endossada pelo WhatsApp LLC ou pela Meta Platforms, Inc. "WhatsApp" é marca registrada de seus respectivos proprietários e é usada aqui apenas para indicar compatibilidade.

---

## Imagens

| Campo | Arquivo / tamanho |
|---|---|
| Ícone da loja | `icons/128.png` (128×128) |
| Imagem promocional pequena | `store/promo-440x280.png` (440×280) |
| Capturas de tela (1 a 5) | **Você precisa tirar**: 1280×800 ou 640×400, PNG/JPEG |

Sugestões de capturas (sem dados reais de pacientes/clientes — use uma conversa de teste):
1. O popup aberto sobre o WhatsApp Web.
2. O painel de progresso "Carregando histórico…".
3. O arquivo HTML exportado aberto no navegador.
4. O CSV aberto no Excel.

---

## Aba "Práticas de privacidade"

### Finalidade única
Exportar a conversa aberta no WhatsApp Web para um arquivo local (TXT, HTML, CSV ou JSON) no computador do usuário.

### Justificativa da permissão `scripting`
Usada apenas para injetar o script de leitura na aba do WhatsApp Web quando ela já estava aberta antes da instalação da extensão, evitando que o usuário precise recarregar a página.

### Justificativa da permissão de host (`https://web.whatsapp.com/*`)
Necessária para ler as mensagens da conversa que o usuário abriu e gerar o arquivo de exportação. A extensão não acessa nenhum outro site.

### Código remoto
Não. Todo o código está incluído no pacote da extensão.

### Uso de dados — marque
- [x] Comunicações pessoais (o conteúdo das conversas é lido para gerar o arquivo)

### Certificações — marque as três
- [x] Não vendo nem transfiro dados de usuários a terceiros, fora dos casos de uso aprovados.
- [x] Não uso nem transfiro dados de usuários para fins não relacionados à finalidade única do item.
- [x] Não uso nem transfiro dados de usuários para determinar a capacidade de crédito ou para fins de empréstimo.

### URL da política de privacidade
Ative o GitHub Pages no repositório (Settings → Pages → Branch `main`, pasta `/docs`) e cole o link:
`https://<seu-usuario>.github.io/quantopus-exporter/privacy-policy.html`
