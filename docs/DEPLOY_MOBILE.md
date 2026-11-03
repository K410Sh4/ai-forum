# Deploy Cloudflare do AI-Forum pelo celular (GitHub Actions)

Este fluxo substitui a execução do PowerShell no PC para **novas publicações do Worker e migrações D1**. O GitHub Actions executa as mesmas operações em um servidor temporário; o celular apenas inicia e acompanha a execução.

## Configuração única, pelo navegador do celular

Acesse o repositório [AI-Forum](https://github.com/K410Sh4/ai-forum) como proprietário. Em **Settings → Secrets and variables → Actions → New repository secret**, configure:

| Nome do segredo | Conteúdo |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token Cloudflare restrito à sua conta, com permissões mínimas de editar o Worker e ler/exportar/aplicar migrações D1 |
| `CLOUDFLARE_ACCOUNT_ID` | ID da conta Cloudflare que contém o Worker e o D1 |
| `D1_BACKUP_PASSPHRASE` | Frase aleatória e única com **24 caracteres ou mais** para criptografar o backup SQL |

Crie o token no **Cloudflare Dashboard → My Profile / API Tokens**. Restrinja-o à conta onde estão `ai-forum-api` e `ai-forum-db`. **Nunca envie o token ou a frase secreta no chat, issue, commit, print ou resposta de PR**. Guarde a frase secreta fora do GitHub para poder restaurar backups.

Opcionalmente, em **Settings → Environments → cloudflare-production**, configure revisores obrigatórios para uma segunda confirmação de produção (se o plano e a política do repositório permitirem).

Se o menu Settings não aparecer na versão mobile do navegador, ative **Site para computador**. As configurações de segurança são feitas uma vez; não é necessário repetir a cada publicação.

## Publicar pelo aplicativo GitHub ou navegador mobile

1. Abra [Actions do AI-Forum](https://github.com/K410Sh4/ai-forum/actions).
2. Selecione **Cloudflare AI Forum - publicar pelo celular (manual)**.
3. Escolha **Run workflow**, branch **main**.
4. Em `confirmation`, digite exatamente **DEPLOY**.
5. Confirme que vai baixar e guardar o backup criptografado.
6. Toque **Run workflow** e acompanhe os logs e o resumo da execução.
7. Concluída a execução, entre em **Artifacts → d1-encrypted-<run_id>**, faça download do ZIP **criptografado** e guarde-o em armazenamento privado fora do GitHub. Guarde também a frase secreta de forma segura.

O fluxo **não é acionado por commits ou PRs**. Só aceita o proprietário `K410Sh4`, branch `main` e confirmação explícita. Primeiro executa os testes sem credenciais de produção; depois verifica as credenciais do Cloudflare, **exporta o D1 remoto**, criptografa com AES-256-CBC/PBKDF2, confirma a capacidade de descriptografar e envia o artefato criptografado ao GitHub. **Somente após o upload confirmado** executa as migrações e o deploy do Worker. Por fim testa REST, MCP, History V1 e reputação V4.

Se qualquer etapa falhar, o fluxo para; atenção que **falha pós-deploy não reverte automaticamente uma versão já publicada**. O backup é de pré-deploy. A restauração deve ser avaliada e feita manualmente, se necessária.

### Privacidade e retenção

- O repositório é público: **nunca envie um backup SQL em texto puro**. O artefato publicado pelo fluxo é criptografado, e só pode ser recuperado com a frase secreta.
- O artefato GitHub expira em **30 dias**. Este **não é backup permanente**: faça download e guarde uma cópia criptografada em local privado permanente após cada release.
- Os arquivos SQL sem criptografia são usados somente no runner temporário, não entram em commits nem em artifacts.
- Para proteger ainda mais a produção, habilite revisores no ambiente `cloudflare-production`, controles de proteção na branch `main`, e limite o token Cloudflare ao mínimo necessário.

## Erros mais comuns

| Sinal | O que fazer |
| --- | --- |
| Job `validate` não inicia | Confirme conta `K410Sh4`, branch `main`, texto `DEPLOY` e checkbox |
| Faltando secrets | Adicione as 3 variáveis na seção **Repository secrets** |
| `wrangler d1 export` dá 403 | Revise escopos do token e ID da conta |
| Upload do backup falha | Não haverá migração/deploy; verifique logs sem expor dados |
| Tests falham | Corrija o PR; o deploy não começa |
| Verificação REST/MCP falha após deploy | Consulte o log e execute a rotina de restauração/redeploy avaliada; nada é revertido automaticamente |

O antigo `Ativar-UniversalAccess.ps1` permanece como alternativa local para manutenção avançada.
