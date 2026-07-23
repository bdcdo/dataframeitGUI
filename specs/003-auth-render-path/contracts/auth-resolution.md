# Contract — Auth Resolution

## Purpose

Definir o comportamento observável da resolução de identidade autenticada em páginas protegidas, sem prescrever a implementação interna.

## Inputs

- Estado atual da conta Clerk, inclusive ID do primário e status de verificação.
- Claim/metadata `supabase_uid` que aponta para o UUID Supabase interno.
- `clerk_user_mapping` com UUID, `access_sync_version`, geração e estado de exclusão.
- Perfil interno em `profiles`.
- Request server-side de layout, page ou Server Action protegida.

## Outputs

| Condition | Output |
|-----------|--------|
| Sem sessão Clerk | `signed-out`, redireciona para `/auth/login` |
| Sessão Clerk com primário verificado, mapping concluído e metadata coerente | `authenticated`, retorna `AuthUser` com `id`, `email`, `clerkId`, `isMaster` |
| Mapping/metadata ausente ou `access_sync_version = 0` | `access-completion-required` com `link-pending` |
| Mapping concluído e metadata divergente | `access-completion-required` com `link-divergent` |
| Sessão Clerk sem ID primário verificado | `technical-sync-failure`, sem escolher o primeiro endereço nem expor `actorEmail` |
| Falha técnica na verificação de vínculo | `technical-sync-failure`, fail-closed |
| Falha técnica na verificação de `master_users` | `technical-sync-failure`, fail-closed; não autentica com `isMaster=false` |

## Guarantees

- A identidade autenticada é resolvida uma vez por request protegida representativa e reutilizada por layouts, pages e helpers do mesmo render.
- A resolução não usa service key como substituto ordinário para autorização de dados de projeto.
- A ausência de vínculo não cria ou repara registros silenciosamente dentro do render protegido.
- O retorno distingue ator autenticado real de identidade efetiva de projeto.
- Metadata nunca é aceita isoladamente: mapping atual, marker concluído e claim precisam concordar; a RLS repete essa regra em `clerk_uid()`.
- O estado atual do Clerk é a autoridade sobre o e-mail. `profiles.email` não substitui o primário verificado.

## Failure handling

- Estados recuperáveis encaminham para conclusão de acesso com ação de retry idempotente.
- Erros técnicos não revelam tokens, claims, IDs internos sensíveis ou links de diagnóstico ao usuário final.
- Em dúvida, o contrato falha fechado: sem identidade interna confirmada, não há acesso a dados protegidos.
- A exclusão e a perda de primário são reconciliadas fora do render por marker `0` e remoção de aliases; token antigo deixa de satisfazer `clerk_uid()`.

## Regression checks

- Deve existir teste ou checagem que falhe se layouts/pages protegidos reintroduzirem full remote user lookup repetido por leitura de dados.
- Deve existir teste ou checagem que falhe se o caminho ordinário voltar a depender de token customizado legado no render path.
