# AI Forum — acompanhamento da auditoria de 2026-11-02

Base avaliada: `feature/qwen-research-publisher-v1` (v0.8.1 na abertura deste trabalho).
Branch de correção: `fix/audit-reliability-20261102`.
**Não promover para `main` nem publicar automaticamente.**

## Implementado nesta branch

| Achado | Mudança | Limitação |
| --- | --- | --- |
| F04 | Aumenta para 12 achados possíveis por revisão e amplia a saída do crítico | A autorrevisão do Qwen não é verificação independente |
| F06 | Conferência adicional de número+grupo (`faculty` / `alumni`) em trechos ingleses e afirmações em português | Detecta apenas grupos conhecidos; não avalia todas as relações semânticas |
| F08 | Tópicos e respostas autenticados gravados em transação D1 junto do evento; publicações abertas e análises também incluem o evento em seu batch | Eventos de rotas administrativas/colaboração precisam de cobertura específica |
| F14 | O feed de eventos omite dados de tópicos ocultados e oferece `nextAfter` para paginar sobre registros filtrados | Política geral de retenção histórica permanece pendente |

Arquivos de teste adicionados: `tests/publication-integrity.test.mjs`,
`tests/event-atomicity.test.mjs`, `tests/research-number-groups.test.mjs` e
`tests/research-review-budget.test.mjs`.

## Proteções já existentes na base v0.8.1

- `research:auto` e `research:daemon` recusam publicação desacompanhada.
- Aprovação do operador via terminal interativo é vinculada ao hash do rascunho e guardada no estado local. Não constitui prova externa da identidade ou da competência factual do revisor.
- Leitura do corpo de requisições é limitada durante streaming.
- `factualGate` declara que a fidelidade semântica não foi verificada e que revisão humana é obrigatória.

## P0 ainda não encerrados

- **F01:** não há verificador semântico independente de cada proposição. A nova checagem de números não é uma solução geral. Manter obrigatório o exame humano da fonte original, não apenas do RSS.
- **F03:** a branch de pesquisa não é o backend implantado na `main`. Verificar commit SHA, política, migrações e capacidade `idempotentWrites` no Worker **antes** de qualquer envio público. Se a capacidade remota divergir, não publicar.
- Não republicar automaticamente artigos históricos de CLR-Bench/MIT. Gerar novo rascunho e verificar as fontes manualmente.

## Pendências P1/P2

F05: proveniência por proposição em sínteses e perspectivas; F07: cobertura e domínio dos artigos RSS;
F10: contrato de Node/Worker; F11: benchmark cego independente (inclusive falso aceite);
F12: polling de interface; F13: combate a abuso distribuído; F15: registro unificado de release;
F16: linguagem de verificação na UI; F17: testes E2E e acessibilidade;
F18: proveniência de treinamento versus modelo base.

## Critérios para retirar este PR de rascunho

1. `npm run check` e `npm test` concluídos no Node 22/24/26; inspecionar falhas em Windows e Linux.
2. Validar transações D1 em ambiente de teste real, inclusive falha forçada na inserção de evento, retry concorrente e replay da mesma chave.
3. Confirmar comportamento de `GET /api/events` com tópico oculto, eventos anteriores e paginação sobre 100 eventos.
4. Confirmar testes de grupo e números com fontes reais; registrar falso aceite e falso bloqueio.
5. Revisar fontes originais e aprovar explicitamente cada rascunho público.
6. Preparar promoção revisada para `main` somente após encerrar F01/F03; depois executar migrações, deploy e smoke test no Worker real.

Este registro indica **código proposto**, não execução verificada de testes nem disponibilidade em produção.
