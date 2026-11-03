# Auditoria de fontes primárias — pesquisa Qwen (2026-11-02)

**Alvo:** PR #22, branch `fix/audit-reliability-20261102`, base `feature/qwen-research-publisher-v1`.
**Estado:** revisão documental e regressões determinísticas; **não é aprovação de um rascunho produzido pelo Qwen**. Nenhuma publicação ou deploy autorizado.

## Fontes primárias inspecionadas

| Fonte | URL canônica | Fatos que a fonte efetivamente sustenta | Afirmações que exigem cautela |
| --- | --- | --- | --- |
| MIT News, 30/10/2026 | https://news.mit.edu/2026/mit-affiliates-named-schmidt-sciences-ai2050-fellows-1030 | Cinco docentes do MIT e dois ex-alunos adicionais foram nomeados para a coorte **2026** de AI2050 Fellows; a iniciativa é da Schmidt Sciences. | Não converter **AI2050** em ano 2050 nem tratar o título/dateline como prova de que um `evidenceId` específico contém o número 2026. O artigo também menciona um antigo pós-doutorando separadamente; não somá-lo automaticamente aos dois ex-alunos. |
| Nature Machine Intelligence, 02/11/2026 | https://doi.org/10.1038/s42256-026-01323-8 | Os autores defendem identificação/versionamento público mais significativo quando fornecedores alteram modelos e integrações. | É um **argumento/proposta** sobre governança e reprodutibilidade, não demonstração experimental de superioridade de modelos, nem prova de que todos os fornecedores se comportam igualmente. |
| CLR-Bench (arXiv 2610.40758), 29/10/2026 | https://arxiv.org/abs/2610.40758 | Artigo apresenta um currículo de regras latentes com 20 cadeias em 10 domínios; avalia seis métodos; relata resultados diferentes conforme o modelo e a metodologia. | Não extrapolar uma acurácia de uma combinação método/modelo para todos os agentes. Não chamar aprendizagem de regra inferida de mera memorização de exceções sem verificar qual experimento corresponde à afirmação. É um **preprint**; publicação no arXiv não equivale à certificação por pares. |

## Evidência selecionada versus contexto externo

O modelo recebe trechos reduzidos extraídos de feeds. Um número verdadeiro na página original pode estar **ausente do trecho literal selecionado pelo `evidenceId`**. Por isso, é correto que a validação atual recuse uma afirmação sobre o ano 2026 caso a citação selecionada contenha apenas a contagem de docentes e ex-alunos. O responsável deve selecionar uma evidência específica que inclua a data, ou omiti-la naquele fato.

A verificação de número+grupo também recusa inverter **cinco docentes/dois ex-alunos** para **dois docentes/cinco ex-alunos**, mesmo que ambos os numerais apareçam na fonte.

O teste `tests/research-primary-source-facts.test.mjs` fixa trechos curtos verificados nessas fontes e prova **somente** que alguns erros numéricos previsíveis são recusados. Não prova fidelidade semântica geral. A rotina `validateSourceClaimGrounding` tem heurísticas específicas de nomes/quantidades e não substitui leitura crítica da fonte.

## O que não foi possível certificar nesta revisão

1. O arquivo de rascunho do Windows `data/research-drafts/08f32b9914647f6362d75fa2.json`, citado no log do operador, não está anexado a esta revisão nem disponível no GitHub; portanto **não foi auditado proposição a proposição**.
2. Uma leitura limitada de resumos e páginas públicas não certifica resultados científicos detalhados, condições experimentais e interpretações de figuras e tabelas. Em especial, o artigo Nature pode apresentar restrições de acesso ao corpo completo.
3. A suíte D1 usa uma réplica SQLite local; **o comportamento do D1 remoto com falhas reais ainda depende de validação isolada em staging**, sem migração ou publicação no banco de produção.
4. Não foi feito ensaio de integração com o Worker de produção nem comparação de seu commit implantado; o PR não deve ser promovido à `main` por essa razão.
5. Os testes de CI comprovam correção nos caminhos exercitados, não aprovação independente do conteúdo gerado.

## Gate de aprovação (ainda fechado)

- CI Windows/Linux, Node 22/24/26: verificar resultados do commit final e registrar link de execução.
- Eventos: teste de paginação de 100 registros mistos e totalmente ocultos em `tests/publication-integrity.test.mjs`.
- Banco D1 de staging: backup isolado, falha forçada de evento, retry concorrente e idempotência com a mesma chave.
- Revisão humana: carregar rascunho final e evidências originais, revisar cada `statement`, `overview`, `perspectives` e `questions`, com status individual por fonte.
- Só depois: avaliar a integração na branch de pesquisa. **Não realizar merge em main nem publicar automaticamente.**

## Acompanhamento

Os riscos F01 (semântica além de heurísticas) e F03 (divergência código/deploy) seguem **abertos**. Nenhum resultado desse documento deve ser anunciado como validação factual automática ou release em produção.
