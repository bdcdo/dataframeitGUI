# Quickstart: validar pré-registro e vínculo de e-mails

**Feature**: `002-preregister-members`

## Setup

```bash
cd frontend && npm run dev
# Supabase remoto já linkado; aplicar migrations novas:
export SUPABASE_ACCESS_TOKEN=$(grep SUPABASE_ACCESS_TOKEN .env.local | cut -d= -f2)
npx supabase link --project-ref nryebmwlmxuwvynfuzsv && npx supabase db push
```

São necessárias 2+ contas de e-mail de teste (aliases Gmail `+sufixo` funcionam no Clerk dev).

## US1 — Pré-registro (P1)

1. Como coordenador, em `/projects/<id>/config/members`, adicionar um e-mail que nunca criou conta → linha aparece com badge **Pendente**.
2. Rodar o sorteio (ou atribuição manual) incluindo o pendente → atribuições criadas normalmente.
3. Corrigir o e-mail do pendente (ação de editar) → e-mail atualizado.
4. Em janela anônima, criar conta no Clerk com o e-mail pré-registrado → no primeiro acesso, o projeto aparece na home e as atribuições em "minhas análises"; badge some da lista de membros (recarregar como coordenador).
5. Remover um pendente com atribuições → atribuições `pendente` somem do documento (volta ao pool do sorteio).

## US2 — Vínculo de e-mails (P2)

1. Num membro existente, "Vincular e-mail" com um e-mail **sem conta** → aparece como e-mail adicional na lista.
2. Criar conta com esse segundo e-mail → a conta nova vê o projeto e exatamente as mesmas atribuições do membro (acessa "como" ele); fora do projeto, conta independente.
3. Vincular um e-mail que **já é outro membro do mesmo projeto** → dialog de unificação com contagens (atribuições migradas, docs com resposta de ambos, papel resultante); confirmar → lista mostra um membro só, atribuições somadas, respostas preservadas.
4. Tentar vincular e-mail já vinculado a outro membro → erro indicando o membro.
5. Desvincular o e-mail adicional → conta do e-mail perde acesso ao projeto; histórico do membro intacto.

## Testes automatizados

```bash
cd frontend && npx vitest run   # unit: validação de e-mail, resolução de identidade efetiva, preview de unificação
```

Pontos críticos a cobrir: colisão `UNIQUE(document_id, user_id, type)` na unificação; recálculo de `is_latest`; RLS — conta vinculada lê o projeto mas não outros; pendente não aparece como ativo.
