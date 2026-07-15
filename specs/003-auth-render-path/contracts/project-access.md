# Contract — Project Access

## Purpose

Definir como a autenticação rápida preserva autorização por projeto, papéis, aliases de e-mail e impersonação/viewAs.

## Inputs

- `AuthUser`: ator real autenticado e perfil interno confirmado.
- `projectId`: projeto solicitado.
- `project_members`: membership e papel por projeto.
- `member_email_links`: vínculo de e-mail alternativo para membro canônico.
- `viewAs` ou `viewAsUser`: identidade visualizada por master/coordenador quando permitido.

## Outputs

| Scenario | Expected output |
|----------|-----------------|
| Criador do projeto | Acesso de coordenador |
| Membro com papel `coordenador` | Acesso de coordenador |
| Pesquisador direto | Acesso apenas às filas e ações permitidas ao próprio membro |
| Pesquisador por e-mail alternativo | Fila e trabalho escopados ao membro canônico |
| Master sem `viewAs` | Visibilidade master preservada |
| Master com `viewAs` | Leitura, navegação e escopo visual usam identidade visualizada; escrita não é concedida como visualizado |
| Usuário autenticado sem acesso | Negação fechada sem revelar dados do projeto |
| Falha técnica de query | Estado de falha, não “sem acesso” silencioso |

`getProjectAccessContext(projectId, user)` retorna uma união discriminada:

- `resolved`: contém `accountUserId` (conta real), `memberUserId` (membro canônico), `project`, `membershipRole`, `isMaster` e `isCoordinator`.
- `unavailable`: não contém dados parciais de autorização e deve interromper o consumidor por `requireResolvedProjectAccess`.

## Guarantees

- `getProjectAccessContext(projectId, user)` centraliza identidade canônica, projeto e papel por request.
- `resolveProjectQueueIdentity(access, viewAsUser)` é a fonte única de precedência entre o `memberUserId` canônico e a identidade visualizada por master.
- `accountUserId` continua sendo o ator real para ownership e auditoria; `memberUserId` escopa membership e filas de trabalho.
- Indisponibilidade de identidade, projeto, membership ou verificação de master sempre falha fechada; não existe modo fail-open.
- `viewAs` não concede write permission em nome da identidade visualizada; a projeção de identidade é separada do modo somente leitura dos controles, tratado na Comparacão pelo PR #445.
- O caminho ordinário de dados de projeto passa por RLS com JWT do usuário, não por service key geral.
- O sistema não revela nome, membros ou dados de projeto a usuário sem permissão.

## Required tests

- Coordenador continua vendo abas e ações de coordenação.
- Pesquisador direto vê somente documentos/filas atribuídos ao próprio membro.
- Pesquisador por e-mail alternativo resolve para o membro canônico.
- Master com `viewAs` enxerga a fila visualizada, mas não escreve como o usuário visualizado.
- Usuário sem acesso recebe negação fechada.
