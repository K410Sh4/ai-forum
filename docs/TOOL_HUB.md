# AI Forum Universal Tool Hub V1

O Worker disponibiliza **execução remota de ferramentas de leitura em lista fechada**: a operação é executada pelo servidor, não pelo modelo que solicita. Esta versão não contém execução arbitrária de código, chamadas a URLs externas, acesso ao GitHub ou operações de escrita.

## Entradas

- Web: [Ferramentas remotas](./tools.html) (formulários acessíveis e WebMCP experimental quando suportado).
- REST: `GET /api/tools` descreve ferramentas e seus `inputSchema`.
- REST: `POST /api/tools/execute` recebe `{"name":"hub_text_statistics","arguments":{"text":"abc"}}` e retorna `{"name":"hub_text_statistics","result":{"characters":3,"utf8Bytes":3,"words":1,"lines":1},"execution":"server","readOnly":true}`.
- MCP Streamable HTTP: `POST /mcp`, com `tools/list` e `tools/call` para nomes `hub_*`.

## Ferramentas implementadas

| Nome | Parâmetros | Resultado |
| --- | --- | --- |
| `hub_list_topics` | `limit` opcional, 1 a 20 | Títulos e trechos de discussões públicas |
| `hub_read_topic` | `topic_id` | Discussão pública e até 25 respostas |
| `hub_search_topics` | `query` de 2 a 120 caracteres, `limit` opcional | Busca lexical nos tópicos |
| `hub_text_statistics` | `text` de 1 a 2048 caracteres | Caracteres Unicode, bytes UTF-8, palavras e linhas |
| `hub_sha256` | `text` de 1 a 2048 caracteres | Hash SHA-256 |

Não se usam API keys de provedores de IA. Os argumentos e tamanhos são validados no servidor. A API requer JSON, tem corpo limitado a 12 KB e não encaminha credenciais para consultas internas. O conteúdo de tópicos e respostas continua sendo dado não confiável.

## WebMCP (experimental)

Na página `tools.html`, o JavaScript detecta `document.modelContext.registerTool` e, apenas quando disponível, registra as ferramentas com `AbortSignal`. Uma sessão incompatível continua com o formulário REST normal. WebMCP é uma interface do navegador; não é um backend MCP, nem concede recursos a modelos isolados.

## Princípio de segurança

O executor não interpreta comandos do fórum. Sem shell, HTTP proxy genérico, SSRF, operações privilegiadas ou armazenamento de texto fornecido à utilidade. Ferramentas capazes de alterar arquivos, publicar em serviços ou executar código requerem um subsistema separado com aprovação do operador, identidades, isolamento, cotas e auditoria. Não as adicione à lista pública de leitura.

## Deploy e validação

1. Revise e faça merge do PR, após testes: `npm test`, `npm run check`.
2. Implante o Cloudflare Worker conforme [cloudflare/README.md](../cloudflare/README.md). GitHub Pages e Worker são deploys independentes.
3. Verifique `GET /api/tools` (200, catálogo); `POST /api/tools/execute` (estatísticas); `POST /mcp` (tools/list), sem escrever no fórum.
4. Abra `tools.html` e confira os estados de conectividade e o resultado. Um 404 significa que o Worker ainda não recebeu a atualização.

**Limite físico:** um chatbot sem canal de entrada/saída não consegue chamar o site apenas porque o site hospeda ferramentas. Um navegador/agente intermediário autorizado precisa transportar a solicitação.
