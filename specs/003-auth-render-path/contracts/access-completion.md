# Contract — Access Completion

## Purpose

Definir o estado de conclusão/reparo de acesso apresentado ao usuário quando há sessão válida, mas o vínculo interno necessário para páginas protegidas ainda não está pronto.

## Inputs

- Ator autenticado; o e-mail primário verificado é opcional porque a falha pode ocorrer antes de obtê-lo.
- Motivo classificado: `link-pending`, `link-divergent`, `sync-temporary-failure` ou `unknown-recoverable`.
- URL pretendida antes do bloqueio, quando segura para preservar.
- Resultado da tentativa idempotente de reparo.

## User-visible states

| State | Message intent | Primary action |
|-------|----------------|----------------|
| `link-pending` | A conta entrou, mas o acesso ainda está sendo preparado | Tentar novamente |
| `link-divergent` | A plataforma precisa confirmar o vínculo correto da conta | Tentar reparar acesso |
| `sync-temporary-failure` | Houve instabilidade temporária ao confirmar o acesso | Tentar novamente |
| `unknown-recoverable` | Não foi possível concluir o acesso agora | Tentar novamente e mostrar orientação de suporte se persistir |

Uma conta ativa sem projeto não entra neste contrato: o dashboard mostra seu estado vazio normal.

## Guarantees

- A tela usa linguagem clara em pt-BR e não exige documentação externa.
- A ação principal é segura para retry e não duplica `profiles`, `clerk_user_mapping` ou memberships.
- O foco inicial, labels e botões são acessíveis por teclado e preservam WCAG 2.1 AA.
- O usuário nunca vê instruções de token, claims, debug links ou nomes de tabelas como solução ordinária.

## Success transitions

- Retry confirma vínculo ativo → redireciona para `nextUrl` seguro ou dashboard.
- Retry falha por instabilidade → mantém estado recuperável e orienta nova tentativa.
- Retry falha de forma persistente → mostra orientação curta para suporte, sem detalhes sensíveis.

## Rejected behavior

- Páginas protegidas não fazem reparo silencioso durante o render.
- Usuário autenticado com link pendente não deve ser enviado de volta para login como se estivesse signed out.
- Falha técnica não deve virar `notFound()` de projeto quando o problema é sincronização de identidade.
- Ausência de primário verificado não deve escolher um endereço secundário; permanece `sync-temporary-failure` até o estado Clerk ser válido.
