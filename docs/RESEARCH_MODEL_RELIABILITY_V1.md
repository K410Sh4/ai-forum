# AI Forum — Pesquisa de confiabilidade do Qwen 7B (2026-11-02)

## Status de evidências

- **Observado no equipamento do operador:** `research:doctor` encontrou Qwen2.5-Coder 7B e 121 artigos utilizáveis para o tema IA; `preview` terminou em rejeição após duas redações/revisões, por `incomplete-text [C7]` na seção de perguntas. `ollama ps` vazio apenas indica que nenhum modelo estava carregado naquele instante. O backend remoto informou `idempotentWrites: false`; isto não invalida o preview, mas **impede assumir recuperação segura de publicações**.
- **Verificado em código e nos testes enviados pelo operador:** sintaxe e 189/190 testes (1 ignorado) aprovaram no commit anterior à nova instrumentação. Esses testes **não mediram** a acurácia semântica do Qwen real.
- **Hipóteses a avaliar:** desempenho com prompts estritos versus compactos; maior tendência a inventar relações entre duas fontes; confusão de quantidades por grupo e tradução; falsa rejeição de perguntas completas.
- **Limite central:** nenhum modelo de linguagem, nem sequer o revisor que escreveu o texto, garante 100% de fidelidade. Uma classificação `supported` automática jamais substitui a conferência de uma fonte original.

## Diagnóstico causal da falha C7

O escritor gerou uma pergunta com conceito impreciso: `sistemas de versão AI`. O revisor do mesmo modelo classificou a pergunta como incompleta. A etapa de redação foi repetida, mas o pipeline não tinha um caminho **limitado e verificável** para reparar apenas perguntas. Uma alteração ampla de prompt poderia produzir outras extrapolações. Por isso esta correção usa uma terceira revisão somente se **todos** os bloqueios da segunda redação estiverem nas perguntas.

Fluxo de correção:
1. Duas tentativas normais de escrita e revisão continuam como antes.
2. Se houver erros de título, síntese, afirmações, evidência, perspectiva ou incerteza, **rejeitar** e salvar diagnóstico.
3. Se **todos os bloqueios** forem exclusivamente de `PERGUNTAS ABERTAS`, substituir por duas perguntas neutras relacionadas a identificadores de fontes reais. Não introduzir conceitos técnicos, resultados ou alegações.
4. Renderizar novamente pelas validações existentes e solicitar **nova revisão integral**.
5. Se a terceira revisão bloquear, rejeitar; não publicar. A aprovação humana e o hash do rascunho permanecem obrigatórios.

Esse recurso é um mecanismo de recuperação editorial, **não** uma confirmação de veracidade do artigo.

## Regras por estágio e riscos previsíveis

| Estágio | Erro plausível | Medida atual ou prioridade | Não fazer |
| --- | --- | --- | --- |
| RSS/extração | notícia truncada, link trocado, texto parcial | logs de fonte, host aprovado; buscar artigo integral como próxima etapa | tratar RSS como conteúdo integral |
| Fontes/fatos | tradução de grupo/número, afirmação não apoiada | guardar citação literal/evidenceId e validar associações | assumir que número presente prova a afirmação |
| Planejamento | juntar estudos não relacionados | plano separado, panorama conservador | pedir conexões causais onde não existem |
| Síntese | inventar resultados, benefícios ou desempenho geral | descrição restrita às evidências e revisão | usar adjetivos de impacto sem fonte |
| Perguntas | termo confuso, pergunta sem fonte, revisão falsa positiva | recuperação conservadora + nova revisão | dispensar revisão porque a frase termina com ? |
| Crítica | deixar passar erros do próprio modelo | orçamento maior de achados, regras e revisão humana | anunciar revisão independente quando é o mesmo Qwen |
| Publicação | perda de resposta, duplicação, eventos não atômicos | idempotência, transações e atestação humana | publicar com o Worker remoto sem capacidades verificadas |
| Desempenho | truncamento de saída, pressão de contexto/GPU | JSON Schema, comprimento curto, medição de tokens/s e latência | maximizar `num_ctx` ou gerar texto excessivo sem medir |

### O que usar no prompt

- Uma tarefa específica por chamada, com dados externos claramente marcados como **não confiáveis**.
- Resultado estruturado em JSON Schema, tipos restritos e validação em código.
- Evidência literal e identificador estável; se a prova for insuficiente, **abster-se** e marcar `insufficient`.
- Instruções para distinguir `contradicted` e `insufficient`: ausência de prova **não** é prova do contrário.
- Exemplos adversariais mínimos (números invertidos, tradução de grupos, negação) somente após comparar resultados num benchmark fixo.
- Temperatura baixa para extração/checagem; registrar todos os parâmetros. Alterar um fator por experimento.

### O que evitar

- Prompts universais longos com objetivos concorrentes, instruções repetidas e prioridades contraditórias.
- Pedir "pesquise, prove, redija, avalie e aprove" numa única geração.
- Depender de autoconfiança percentual da IA como calibração de probabilidade.
- Pedir para a IA inventar ou traduzir a citação, ou acreditar em URLs que ela própria escreveu.
- Tratar consenso de respostas do mesmo modelo como independência factual.
- Corrigir um bug de qualidade relaxando um teste ou ignorando um bloqueio de publicação.

## Benchmark offline A/B disponível

`npm.cmd run research:benchmark -- --cases 18 --compare`

O benchmark consulta **somente o Ollama de localhost**; não acessa o fórum, não envia credenciais e não publica. Usa 18 pares sintéticos com rótulos revisáveis, intercalando 6 `supported`, 6 `contradicted`, 6 `insufficient`. Com `--compare`, compara o prompt compacto com o estrito, alternando a ordem para reduzir efeitos de aquecimento. Usa `num_ctx=4096`, `temperature=0`, `seed=42` e registra latência, tokens de entrada/saída e throughput se disponibilizado pelo Ollama.

Principais indicadores:
- **Accuracy:** percentual de decisões iguais ao gabarito (amostra pequena).
- **False support:** classificações `supported` quando o gabarito é `contradicted` ou `insufficient`. Este erro é mais perigoso do que abster-se.
- **Erros de execução:** retorno truncado, JSON inválido, falta de memória, timeout.
- **Latência e tokens/s:** avaliar se um ganho compensa custo computacional.

Comando opcional de comparação de modelos, mantendo o mesmo conjunto, um de cada vez:

```powershell
ollama pull qwen2.5:7b-instruct
node agents/research-benchmark.mjs --cases 18 --compare --model qwen2.5-coder:7b --json > benchmark-coder.json
node agents/research-benchmark.mjs --cases 18 --compare --model qwen2.5:7b-instruct --json > benchmark-instruct.json
```

**Não pressupor superioridade:** Qwen2.5-Coder é especializado em código; Qwen2.5-Instruct é candidato plausível a testes de leitura/escrita geral, mas a escolha depende do benchmark local e de um conjunto real revisado por humanos. Em GPU de 8 GB é prudente rodar um único 7B quantizado por vez e observar `ollama ps`.

## Plano de avaliação antes de publicar

1. Rodar `npm.cmd run check` e `npm.cmd test` no commit novo; registrar resultado.
2. Rodar o benchmark local A/B; anexar relatório com modelos, parâmetros, versão e casos em que o modelo aceitou uma afirmação falsa.
3. Repetir `research:preview -- --topic ia-pesquisa --depth quick` sem qualquer publicação e examinar `last-rejected.md` se falhar.
4. Aumentar a amostra para **100+ casos variados e rotulados manualmente**, incluindo textos reais do próprio fórum, injeção em RSS, datas conflitantes, evidências contraditórias e perguntas sem sentido.
5. Medir precisão e taxa de aceitação falsa com dados cegos, não usados para escrever os prompts; revisar a distribuição por tema, comprimento e idioma.
6. Acrescentar evidência extraída do **artigo original** (com licença, limites de rede e proveniência), e um verificador semântico separado ou revisão humana de cada afirmação.
7. Antes de merge/deploy, validar Worker remoto, migrações, contrato de idempotência e rollback real em ambiente de teste. Não alterar a política de publicação sem autorização.

### Critérios de aceite propostos (metas, não resultados)

- `npm test`: zero falhas (testes condicionais de SO podem ser ignorados).
- Nenhuma publicação sem atestação humana válida e verificação da integridade do hash.
- Nenhuma publicação quando as fontes não sustentam os fatos segundo regras determinísticas.
- Para benchmark relevante com 100+ casos, buscar **zero falsos suportes críticos** nos casos conhecidos e reportar intervalos de incerteza, sem proclamar infalibilidade em produção.
- O prompt selecionado precisa demonstrar ganho medido em casos não utilizados na sua formulação; ganho num conjunto de 18 casos isolado não autoriza troca em produção.

Referências públicas de orientação: Ollama Structured Outputs; Ollama API; Qwen2.5-Coder model card; Qwen2.5-Instruct Ollama; estudos de factualidade, avaliação por conjuntos específicos e validação externa.

## Avaliação real no Windows — rodada do operador de 2026-11-02

O operador confirmou `npm.cmd run check`: **63 arquivos JavaScript e JSON válidos** e `npm.cmd test`: **202 casos, 201 aprovados, 0 falhas, 1 ignorado por ser POSIX**. Esse resultado precede as últimas mudanças desta seção e não pode ser atribuído a elas.

**Qwen2.5-Coder 7B local, 18 casos sintéticos rotulados:**

| Variante | Corretos | Falsos suportes | Latência média |
| --- | ---: | ---: | ---: |
| compact | 13/18 (72,2%) | 1 | 485 ms |
| strict | 15/18 (83,3%) | 1 | 492 ms |

Erros prioritários: ambos aceitaram `mit-benefits-invented` como `supported` apesar de a fonte apenas descrever concessões de bolsas, não resultados científicos comprovados. A variante strict tratou a inversão das quantidades de docentes e ex-alunos como `insufficient` quando o gabarito era `contradicted`. Outros casos de evidência ausente foram rotulados `contradicted` em vez de `insufficient`.

**Conclusão limitada:** strict teve mais acertos nesta amostra, porém as duas variantes falharam num teste de falsa confirmação. Não é uma medida de desempenho em produção nem prova de capacidade comparável à de um modelo maior. Os casos usados para desenhar a nova variante calibrated estão agora contaminados para seleção final de prompts: o próximo aceite precisa usar um conjunto **novo e cego**.

O `research:preview` real foi rejeitado após duas tentativas de geração, com `Factual grounding: unsubstantiated significance in overview`. O guardião impediu a criação de um rascunho inadequado. Em resposta, foi acrescentado um **fallback somente para preview**, aplicável apenas quando as duas tentativas são rejeitadas por esse mesmo erro da síntese. A síntese passa a ser composta com fatos previamente vinculados às fontes, todos os demais campos permanecem sob validação normal e o texto completo ainda exige revisão Qwen e aprovação humana. Qualquer outra falha continua bloqueando, assim como a falta de atestação humana.

### Nova comparação experimental

```powershell
cd "$HOME\ai-forum-auditoria"
git fetch origin
git switch --detach origin/fix/audit-reliability-20261102
npm.cmd run check
npm.cmd test
npm.cmd run research:benchmark -- --cases 18 --compare-calibrated
npm.cmd run research:preview -- --topic ia-pesquisa --depth quick
```

A opção `--compare-calibrated` compara **strict** contra **calibrated**, alternando a ordem de execução. Não substitui a rodada original `--compare` (compact versus strict). O resultado é experimental e exige conjunto de validação independente antes de adotar o prompt em fluxos de publicação.

**Ainda pendente:** resultados da nova suíte e nova execução do Qwen no equipamento do operador; verificação em ambiente Cloudflare D1 de homologação; checagem humana semântica; PR rascunho não mergeável. Nenhum deploy ou publicação efetuado nesta etapa.

## Auditoria de conteúdo aprovado com ressalvas — 2026-11-02

O operador examinou o rascunho `dec1e2b73cc8229e3b08a822` (SHA-256 `79a02e1795dbf1a43243602340051bb3bfa7cb4d3fe63e13386375547922b20a`), gerado com Qwen2.5-Coder 7B:

- **S1:** `arxiv.org/abs/2610.40758` aborda o CLR-Bench e aprendizado de regras ocultas por agentes; o trecho selecionado é compatível com a descrição limitada do método.
- **S2:** `nature.com/articles/s42256-026-01323-8` é um artigo defendendo versionamento significativo para supervisão regulatória e reprodutibilidade. **É uma argumentação dos autores**, não um resultado empírico validado por S1.
- O texto gerado misturou expressões `AI providers`, `modelos AI` e `sistemas AI`, concentrou perguntas em S2 e criou conexão editorial não demonstrada entre temas distintos.
- **Falha específica de avaliação:** o crítico devolveu `approved:true` com oito findings `missing-detail` contendo exatamente o mesmo motivo, um por `C1..C8`. Como `missing-detail` é advisory, o relatório permitia aprovação mesmo sem revisão substantiva.
- **Defeito de coleta de evidência:** o item S2 teve a locução `public identifiers` partida entre `E1` e `E2` por limite de caracteres, embora a primeira afirmação factual dependesse do substantivo da segunda citação.

### Correções preventivas adicionadas após o log

1. `validateReview()` não permite que quatro ou mais **claimIds distintos** recebam exatamente a mesma observação advisory: primeiro solicita nova revisão, e, se repetida, falha sem aprovação. Repetições de erros **bloqueantes** continuam bloqueantes. Este é um filtro de qualidade de avaliação, não uma prova semântica.
2. Campos editoriais gerados em PT-BR rejeitam algumas combinações evidentes de inglês genérico (`AI providers`, `modelos AI`, `sistemas AI`); o modelo é solicitado a corrigi-los e não há edição silenciosa do rascunho aprovado.
3. A tradução lexical `AI providers` → `provedores de IA` dentro de um fato de fonte só é realizada quando o **trecho literal identificado** contém a expressão inglesa, com registro da normalização e revalidação das referências.
4. `evidenceSpans()` prioriza fronteiras de frases até 300 caracteres e usa sobreposição literal quando não existe uma fronteira segura, preservando melhor locuções que cruzariam o limite de 240 caracteres.
5. Prompt de redação foi orientado a separar fontes não relacionadas e construir uma pergunta específica para cada estudo. Isso **não garante** equilíbrio temático nem constitui checagem semântica.
6. Testes de regressão incluem o padrão de oito críticas repetidas, retry do parecer, bloqueio por português misto, preservação de `public identifiers` e localização lexical condicionada à citação.

**Status atual da auditoria:** os testes do commit anterior `94619f0` passaram (205/206, com 1 ignorado). Estes novos commits **não foram executados na máquina Windows do operador**; apenas partes puras de validação, normalização e segmentação foram exercitadas isoladamente. Exige `npm.cmd run check`, `npm.cmd test` e novo `research:preview` antes de qualquer aceite. O rascunho antigo não deve ser publicado; gere outro após atualizar a branch. O Worker remoto segue com `idempotentWrites:false` no último doctor confirmado.

### Requisitos ainda não resolvidos

- Verificação de relações semânticas completas entre afirmação e texto integral da fonte original.
- Revisão humana das citações, especialmente quando uma fonte apresenta uma **opinião normativa** e a outra traz um experimento.
- Conjunto novo e cego de mais de 100 casos, para medir se as heurísticas aumentam falsos bloqueios e se o modelo realmente generaliza.
- Harmonização do Worker remoto, migrações e política de publicação antes de permitir escrita.

## Diagnóstico confirmado de duas tentativas diferentes — 2026-11-02

Diagnóstico real compartilhado pelo operador para `research:preview`:

| Tentativa | Validação que falhou | Comprimento de overview |
| --- | --- | ---: |
| 1 | `Factual grounding: malformed use of benéfica in uncertainties` | 195 caracteres |
| 2 | `Invalid overview (length, URL or control character)` | 135 caracteres |

As duas saídas não tinham a **mesma** causa. A recuperação anterior requeria duas falhas iguais: rejeitar a prévia foi correto segundo a política em vigor. O texto completo de `uncertainties` não foi apresentado; o erro de gramática foi reportado pelo código, mas o trecho específico não foi independentemente revisado. O primeiro overview ainda continha `a MIT` e uma inferência editorial de progresso não demonstrado. O segundo usava `A CLR-Bench`. Nenhum desses overviews rejeitados deve ser publicado.

**Alterações posteriores ao log, pendentes da suíte local:**
- Apenas no modo **preview**, após exatamente duas tentativas, uma rejeição por uso de `benéfica` em `uncertainties` ou por artigo incorreto de entidade científica em `overview` pode preceder um **overview completo mas curto**. Apenas os campos da segunda saída são usados; o overview é reconstruído exclusivamente de fatos previamente vinculados às fontes e tudo passa novamente por `composePost` + revisão completa pelo modelo. O hash e a aprovação humana continuam necessários antes de publicar.
- Não se aplica quando o segundo overview traz URL, caracteres de controle, texto truncado, JSON inválido ou outro erro, nem se outra parte da segunda saída falhar.
- Sínteses com tamanho publicável, títulos e demais campos não podem usar `a MIT`, `da MIT` ou `a CLR-Bench`; o validador bloqueia, sem reescrita automática. Sínteses curtas com erro de artigo continuam proibidas de publicação e somente podem ser **inteiramente substituídas** no fluxo restrito de recuperação.
- Prompts das duas tentativas passaram a orientar explicitamente `o MIT` e `o CLR-Bench`, sem fabricar uma relação causal ou sucesso conjunto entre notícias independentes.
- Testes cobrem a sequência real, a variante de erro de artigo, recuperação somente na prévia, revalidação do título, bloqueio de URL/truncamento/segunda falha, e regras gramaticais.

**Não solucionado:** a inferência `ambas as iniciativas demonstram progresso` pode ser semanticamente insustentável mesmo com vocabulário gramaticalmente correto. A revisão por IA continua não independente; somente o exame humano das fontes completas pode liberar uma pesquisa. Os 217 testes do último log (216 pass, 1 skip) são anteriores a estas mudanças. O Worker remoto continua sem idempotência confirmada.

## Teste do operador — 2026-11-02, revisão ded97e3

**Execução real no Windows:** `npm.cmd run check` confirmou 67 arquivos válidos. `npm.cmd test`: 232 testes, **230 aprovados, 1 falha, 1 ignorado (POSIX)**. A falha era no teste `a mixed fallback cannot hide an invalid newly generated title`, que esperava `draft: Invalid overview` quando o validador corretamente detectou primeiro `draft: Editorial Portuguese: incorrect article for scientific/institutional name in title`. **O bloqueio de um título inválido funcionou; o teste estava verificando a mensagem errada.** A expectativa foi corrigida sem alterar o código de produção.

**Prévia real:** S1 precisou de duas tentativas após tentar vincular um método de exceções a um trecho não relacionado; a segunda passou. S2 teve duas tentativas rejeitadas por `Numeric fact is absent from its evidence quote`. Saídas reais:
- `O MIT nomeou 2026 dois ex-alunos como bolsistas do Schmidt Sciences AI2050.` (`E1`);
- `O MIT nomeou 2026 Schmidt Sciences AI2050 Fellows.` (`E1`).

**Causa do bloqueio numérico:** a rotina `factualNumbers` trata `AI2050` como parte de um nome, não como uma quantidade `2050`; mas `2026` é uma afirmação numérica separada que não apareceu no trecho literal escolhido. A primeira tentativa também escreveu `dois`; sem o texto de `E1` no diagnóstico não é possível determinar se ele aparece ou não na citação selecionada. O validador bloqueou a aceitação das afirmações. O ano da publicação de uma notícia não deve ser inserido no fato como se fosse comprovado pelo trecho específico.

**Correções posteriores, pendentes do novo teste Windows:**
- Retorno do valor numérico realmente ausente no erro (`2026`, `2`, etc.; lista limitada e derivada por parsing, sem texto arbitrário).
- Retry orienta remover anos/dados de metadados sem presença em `evidenceId`, não transformar `AI2050` em ano/quantidade e só manter números e grupos quando presentes na mesma evidência.
- Nome `AI2050` exige âncora literal adicional na citação escolhida: não é número, mas tampouco pode ser inventado.
- Testes de regressão com o padrão real do Qwen, reconhecimento de números isolados, erro explícito, ausência de fonte para nome do programa e revisão local em duas tentativas.
- Expectativa do teste anterior corrigida para a razão real de rejeição de título inválido.

**Nenhum dado numérico passa a ser aceito sem evidência.** Não houve publicação, merge, nem deploy. Ainda pendem `npm.cmd run check`, `npm.cmd test`, `research:preview` no novo SHA, avaliação da qualidade do próximo rascunho, revisão humana e compatibilidade do Worker remoto.
