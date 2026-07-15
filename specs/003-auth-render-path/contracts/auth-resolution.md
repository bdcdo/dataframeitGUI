# Contract — Auth Resolution

## Purpose

Definir o comportamento observável da resolução de identidade autenticada em páginas protegidas, sem prescrever a implementação interna.

## Inputs

- Sessão Clerk presente ou ausente.
- Claim/metadata que aponta para o UUID Supabase interno.
- Registro persistido de vínculo Clerk↔Supabase.
- Perfil interno em `profiles`.
- Request server-side de layout, page ou Server Action protegida.

## Outputs

| Condition | Output |
|-----------|--------|
| Sem sessão Clerk | `signed-out`, redireciona para `/auth/login` |
| Sessão Clerk com vínculo interno ativo | `authenticated`, retorna `AuthUser` com `id`, `email`, `clerkId`, `isMaster` |
| Sessão Clerk com vínculo ausente, pendente ou divergente | `access-completion-required`, redireciona para conclusão/reparo |
| Sessão Clerk sem e-mail utilizável | `technical-sync-failure`, mostra estado recuperável não técnico |
| Falha técnica na verificação de vínculo | `technical-sync-failure`, fail-closed |
| Falha técnica na verificação de `master_users` | `technical-sync-failure`, fail-closed; não autentica com `isMaster=false` |

## Guarantees

- A identidade autenticada é resolvida uma vez por request protegida representativa e reutilizada por layouts, pages e helpers do mesmo render.
- A resolução não usa service key como substituto ordinário para autorização de dados de projeto.
- A ausência de vínculo não cria ou repara registros silenciosamente dentro do render protegido.
- O retorno distingue ator autenticado real de identidade efetiva de projeto.

## Failure handling

- Estados recuperáveis encaminham para conclusão de acesso com ação de retry idempotente.
- Erros técnicos não revelam tokens, claims, IDs internos sensíveis ou links de diagnóstico ao usuário final.
- Em dúvida, o contrato falha fechado: sem identidade interna confirmada, não há acesso a dados protegidos.

## Regression checks

- Deve existir teste ou checagem que falhe se layouts/pages protegidos reintroduzirem full remote user lookup repetido por leitura de dados.
- Deve existir teste ou checagem que falhe se o caminho ordinário voltar a depender de token customizado legado no render path.
