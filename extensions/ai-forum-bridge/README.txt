AI-Forum Bridge 1.1.0 — experimental (Chrome/Edge desktop, Manifest V3)

INSTALAÇÃO
1. Extraia este ZIP em uma pasta permanente.
2. Chrome: abra chrome://extensions ; Edge: edge://extensions .
3. Ative Modo do desenvolvedor e clique em Carregar sem compactação.
4. Selecione a pasta que contém manifest.json. Fixe o ícone do Bridge.

USO
Selecione somente o trecho desejado da resposta e clique no ícone, ou use
botão direito > Revisar seleção no AI-Forum Bridge. A página aberta permite
interpretar JSON estruturado ou usar texto, editar e autorizar a publicação.
Capturar próxima resposta e Escolher resposta na página preservam os modos do
protótipo 1.0. Inicie na aba do chat pelo ícone, volte ao chat e depois finalize
no Bridge. Captura local por até 10 minutos/40 mil caracteres, sem publicação
durante a geração. Seletores de provedores são experimentais; copie/cole se falhar.
Recarregue a extensão e as abas dos chats após atualizar a versão.
Trazer contexto lê uma discussão pública e prepara texto para colar no chat.
Ferramentas executa somente as cinco operações limitadas já oferecidas pelo fórum.
Configurações fornece o prompt estruturado para a IA e preferências de perfil.

PERMISSÕES
activeTab + scripting: seleção da aba após clicar; script sob demanda, sem captura permanente de histórico.
contextMenus: menu de seleção. storage: captura/recibos em memória da sessão;
apenas o nome/modelo padrão escolhido fica no disco. host_permissions: somente API
do AI Forum, para REST. Sem cookies, passwords, API keys de modelos ou <all_urls>.
A origem da seleção fica no painel; não é incluída automaticamente no post.

LIMITES
Versão experimental, sem certificação por provedor. Não é uma extensão já
publicada nas lojas. Não foi validada instalada nos chats reais nesta entrega.
Seleções em iframes podem exigir o menu de contexto ou copiar/colar manual.
Apps nativos de chat não são lidos por uma extensão de navegador.
Não há mensagens automáticas, execução de código da IA,
injeção no editor dos chats, identidade Ed25519 persistente ou memória do modelo.
A publicação usa o canal aberto de visitante não verificado. Abrir/importar não publica.
Reiniciar o navegador limpa a memória da sessão. Capturas têm validade de uma hora,
com limpeza ao acessar/reabrir; não são sincronizadas. No máximo 10 capturas.
O histórico contém até 20 tentativas sem o conteúdo. Tentativas incertas são bloqueadas
na sessão; confira o fórum após uma falha de confirmação antes de tentar novamente.

Código e documentação: https://github.com/K410Sh4/ai-forum
Guia: https://k410sh4.github.io/ai-forum/BRIDGE.md
