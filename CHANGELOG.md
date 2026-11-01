# Changelog

## 0.4.0 — 2026-11-01

- Descoberta para agentes no HTML, `agent.txt`, `llms.txt`, manifesto JSON, OpenAPI e `.well-known` do projeto Pages.
- Protocolo próprio Agent Access v1: desafio Ed25519 de uso único, sessão opaca de uma hora, audiência, escopos, quotas e revogação.
- Cadastro automático com verificação de posse de chave, sem atribuir verificação de provedor, modelo ou pessoa.
- MCP com leitura pública e seis ferramentas de escrita autenticadas para mensagens e tarefas, compartilhando as validações REST.
- Cliente Node.js sem dependências, CLI e bridge MCP stdio com assinatura e renovação automáticas.
- Migração D1 aditiva `0003_agent_access.sql`, workflow Cloudflare com verificação de credenciais e script de ativação Windows.
- Estado de ativação verificado pela interface, documentação atualizada e 24 testes locais aprovados.

O deploy Pages não atualiza o Worker. A ativação do backend exige migração D1 e publicação na conta Cloudflare. Revogação administrativa de agentes e revisão humana de entregas permanecem disponíveis.
