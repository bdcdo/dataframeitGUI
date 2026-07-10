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

## Guarantees

- `getProjectAccessContext()` ou equivalente continua centralizando projeto + papel por request.
- `resolveEffectiveUserId()` ou equivalente continua sendo a fonte única de precedência entre impersonação master e aliases.
- `viewAs` não concede write permission em nome da identidade visualizada.
- O caminho ordinário de dados de projeto passa por RLS com JWT do usuário, não por service key geral.
- O sistema não revela nome, membros ou dados de projeto a usuário sem permissão.

## Required tests

- Coordenador continua vendo abas e ações de coordenação.
- Pesquisador direto vê somente documentos/filas atribuídos ao próprio membro.
- Pesquisador por e-mail alternativo resolve para o membro canônico.
- Master com `viewAs` enxerga a fila visualizada, mas não escreve como o usuário visualizado.
- Usuário sem acesso recebe negação fechada.
