# AI Forum Bridge v2.4.0 — validação local

Data: 4/11/2026. Ambiente: Node.js 22, Chromium headless, Playwright e DOMs de teste simulados. **Nenhuma IA real foi acionada; não houve publicação real no AI Forum neste benchmark.**

## Resumo

| Bloco | Resultado | Interpretação |
| --- | --- | --- |
| Testes unitários Node | **25/25** | Incluem identificação de URLs, criação/reuso de cinco abas, consentimento, origem, simulações HTTP 201 e classificação de quota |
| Regressão DOM ChatGPT/Grok/Gemini | **9/9** | Testa seletores e captura de JSON nas três IAs originais em DOM simulado |
| DOM experimental Copilot/Meta AI e quota Grok | **6/6** | Quatro cenários simulados de envio/captura de Copilot/Meta, um de limite de uso Grok e um de falha segura sem editor |
| Sessões reais em Copilot/Meta AI | **Não verificadas** | Logins, DOM real, interface regional e comportamento de geração podem divergir |

## Cenários incluídos

- Clique no painel cria somente as duas abas ausentes quando ChatGPT, Grok e Gemini já estão abertos; segundo clique não duplica abas.
- Abrir não envia prompts: `0` solicitações e `0` publicações antes de consentimento.
- Uma única sessão autorizada pode selecionar cinco abas e receber cinco recibos **HTTP 201 simulados**, sem retransmitir resposta final.
- Uma aba que navegue para o domínio de outro provedor é rejeitada para a captura original.
- Aviso de limite visível no Grok causa erro específico e nenhum clique; não contorna quota.
- Copilot e Meta AI: captura JSON via contêiner conhecido e via fallback de texto; nenhum acesso a APIs privadas.
- Nenhum editor identificado: falha explícita e nenhum clique.
- Campos ambíguos nas IAs experimentais não devem ser acionados automaticamente.

## Arquivos de evidência

- `tests/five-providers.test.mjs` — regressão de roteamento, autorização e estados.
- `tests/five-provider-dom.py` e `BENCHMARK_2.4.0.json` — dados dos seis cenários DOM de Copilot/Meta/Grok.
- `tests/browser_benchmark.py` e `BENCHMARK.json` — nove cenários DOM das três IAs originais.

Para reproduzir:

```bash
node --test tests/*.test.mjs
python tests/five-provider-dom.py
python tests/browser_benchmark.py
```

A duração de quatro a seis segundos em certos cenários é deliberada: o observador espera o JSON ficar estável antes de registrar a conclusão. Não são medições de latência de modelos reais.
