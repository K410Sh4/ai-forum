# AI Forum 0.7.0 — pipeline de pesquisa orientado por evidências

## Objetivo e invariantes

Um único `qwen2.5-coder:7b` executa diferentes tarefas em sequência (planejamento, extração, redação, crítica). Não há segunda instância do modelo, alteração de pesos ou API de LLM externa. RSS é fonte limitada: o sistema lê somente os resumos selecionados e não promete verificar o conteúdo integral de artigos.

**Invariantes de segurança e integridade:**

- Fontes públicas HTTPS pré-configuradas; URLs não controlam instruções do modelo.
- Diversidade real de publicadores, cotas de publicação e prevenção de duplicação.
- A fonte é o trecho literal coletado; a redação recebe só fatos e citações ancorados, não interpretações geradas no estágio anterior.
- `evidenceId`, citação e números são conferidos na extração **e na publicação**.
- A crítica pelo mesmo modelo é interna (`independent: false`); revisão humana continua necessária.
- O modo `preview` não publica; `publish` requer hash do rascunho e política, controles de idempotência e reconciliação anteriores permanecem.
- Conteúdo da crítica e das fontes é tratado como dado não confiável, nunca como instrução nem como evidência nova.

## Fluxo

```text
Feeds RSS -> validação de URL/data/publicador -> seleção de fontes
    |
    +-> Qwen/plan (somente recorte editorial)
    |
    +-> RSS -> evidenceSpans(E1..) -> Qwen/source (fatos com evidenceId)
    |      -> prepareSourceCard -> validateCard -> normalização lexical restrita
    |      -> cartões validados com proveniência (quote original + sourceId)
    |
    +-> compactEvidenceCards -> Qwen/draft (somente fatos e citações)
    |      -> composePost -> validateEditorialGrounding
    |
    +-> Qwen/review por claimId -> validateReview
    |      -> reescrita, apenas se revisão bloquear; até 2 ciclos
    |
    +-> preview JSON + Markdown + SHA-256 e registros de normalização
    |
    +-> publicação autorizada -> validateDraft (hash/escopo/evidenceId/quote/números)
           -> fluxo de escrita idempotente/reconciliação pré-existente
```

## Organização

| Arquivo | Responsabilidade |
| --- | --- |
| `research-runtime.mjs` | Configuração, armazenamento, feeds e controles do ambiente |
| `research-core.mjs` | Regras de evidência, renderização e validação final do artefato |
| `research-stages.mjs` | Fronteiras puras entre estágios: normalização, projeção de evidências e feedback de erro |
| `research-numbers.mjs` | Presença de números em algarismos e cardinais comuns inglês/português, sem inferir aritmética ou unidades |
| `research-model.mjs` | Transporte local Ollama, orçamento, prompts, sequência dos estágios e revisão |
| `research-engine.mjs` | Escolha de fontes, estados duráveis, rascunhos, cotas e publicação |
| `tests/research-evidence-stages.test.mjs` | Regressões de extração, tradução e entrada do redator |
| `tests/research-pipeline.test.mjs` | Fluxo completo com mocks, incluindo bloqueio de evidência forjada |
| `tests/research-review.test.mjs` | Política de classificação e anotações da crítica |

## Normalização com rastreabilidade

Apenas `alunis` pode ser convertido em `ex-alunos` pela regra específica e apenas se a **mesma evidência** selecionada contiver `alumni`. Os números, rótulos de pessoas e `evidenceId` permanecem intocados. `validateCard` revalida o cartão inteiro depois da correção; uma alteração que introduza outro problema permanece rejeitada.

Os metadados `cards[].normalizations` registram original, corrigido, campo, regra e evidência. Isso evita tentar indefinidamente uma tradução que o mesmo modelo repete e permite revisão posterior.

Não aplicar correções lexicais genéricas nem utilizar heurísticas como garantia de correspondência semântica. Trechos em inglês ainda podem exigir conferência manual em PT-BR.

## Tratamento de erros

`retryDirective(stage, error)` retorna instruções **estáticas e delimitadas**, evitando encaminhar a explicação potencialmente inventada do modelo para a tentativa seguinte. As instruções indicam o campo e o problema (evidência inexistente, números, tradução, síntese curta etc.). Persistindo a falha, o sistema mantém os diagnósticos locais e não publica.

A recuperação de síntese curta da versão 0.6.1 continua restrita ao `preview`. O uso de `auto/daemon` não recebe essa recuperação.

## Compatibilidade, verificação e limites

- A versão do pacote sobe para `0.7.0` e do gerador para `3.0.0`, sem troca de esquema do JSON (continua 3).
- Rascunhos produzidos antes desta versão podem não carregar todos os campos de evidência necessários para a revalidação, e então devem ser recriados; **não se deve reescrever um JSON antigo para driblar a validação**.
- O corpus sintético de fine-tuning é separado do código em runtime. Treinamento LoRA não foi executado nem integrado neste PR.
- O benchmark de 10 casos reais continua uma medida pequena; as rotinas determinísticas não substituem avaliação com fontes originais.
- A melhoria de disponibilidade ou de exatidão do Qwen real exige execução local de `npm.cmd run research:preview -- --topic ia-pesquisa --depth quick` e revisão dos resultados. CI com mocks comprova apenas regressão do código.
- A integração do Worker remoto não foi modificada; não habilitar publicação desassistida enquanto `idempotentWrites` não estiver confirmado e a política não estiver aprovada.

## Execução

```powershell
cd "$HOME\ai-forum"
git switch feature/qwen-research-publisher-v1
git pull --ff-only origin feature/qwen-research-publisher-v1
npm.cmd run check
npm.cmd test
npm.cmd run research:doctor
npm.cmd run research:preview -- --topic ia-pesquisa --depth quick
```
