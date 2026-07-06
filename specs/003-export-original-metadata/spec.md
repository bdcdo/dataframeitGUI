# Feature Specification: Documentos com exportação completa

**Feature Branch**: `003-export-original-metadata`

**Created**: 2026-07-06

**Status**: Draft

**Input**: User description: "Melhorar a experiência de Documentos e Exportar no dataframeitGUI. A plataforma deve preservar a linha original inteira do CSV importado junto a cada documento, inclusive colunas que também são mapeadas para texto, título e ID externo. A área de Documentos deve reunir lista, preview e exportação de forma mais intuitiva: a exportação fica no topo de Documentos em um card simples, usando o preview existente como base quando aplicável. Todos os membros do projeto devem poder acessar Documentos em modo leitura e baixar exportações; ações de gestão, como importar, excluir, restaurar ou apagar documentos, continuam restritas a coordenadores. A exportação deve priorizar simplicidade técnica: exportar sempre o conjunto completo equivalente ao modo atual “Ambos”, removendo a escolha de dataset e mantendo apenas a escolha de formato CSV/XLSX. Para CSV, manter um arquivo unificado com colunas combinadas; para XLSX, reaproveitar múltiplas abas. Não criar ZIP de CSVs, geração server-side nem jobs assíncronos nesta primeira versão. Documentos antigos sem linha original preservada continuam exportáveis, com colunas originais vazias. Não há requisito de migration nesta fase, salvo descoberta técnica posterior. O objetivo é facilitar análises posteriores preservando todos os campos da base original fornecida e tornando a exportação mais fácil de encontrar."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preservar a base original importada (Priority: P1)

Como coordenador que importa documentos por CSV, quero que todas as colunas da planilha original sejam preservadas junto a cada documento para que eu possa recuperar variáveis auxiliares em análises futuras, mesmo quando elas não são usadas diretamente na codificação.

**Why this priority**: Sem preservar a linha original, a exportação não consegue entregar os campos que o usuário forneceu na base inicial; depois do upload, essas informações ficam indisponíveis para auditoria e análise.

**Independent Test**: Importar um CSV com colunas extras além das colunas mapeadas para texto, título e ID externo; depois exportar os dados e verificar que todas as colunas da linha original aparecem no arquivo baixado.

**Acceptance Scenarios**:

1. **Given** um CSV com colunas `id_original`, `titulo`, `texto`, `tribunal` e `classe`, **When** o coordenador importa os documentos mapeando `texto` como conteúdo, `titulo` como título e `id_original` como ID externo, **Then** cada documento preserva também `tribunal`, `classe` e todas as demais colunas da linha original para exportação futura.
2. **Given** uma coluna do CSV que foi usada como título, texto ou ID externo, **When** qualquer membro autorizado exporta a base, **Then** essa coluna ainda aparece como parte da linha original preservada, sem depender apenas do campo normalizado da plataforma.

---

### User Story 2 - Encontrar exportação no topo de Documentos (Priority: P2)

Como membro do projeto que quer analisar os dados fora da plataforma, quero acessar Documentos e encontrar a exportação logo no topo da tela para não precisar saber que ela ficava escondida em outra área.

**Why this priority**: Exportar é uma ação natural do fluxo de Documentos: o usuário primeiro entende quais documentos compõem a base e depois baixa o conjunto completo para análise. Colocar a exportação no topo reduz descoberta por tentativa e erro.

**Independent Test**: Acessar a área Documentos de um projeto com documentos importados; verificar que há um card de exportação antes da lista, com escolha de formato e preview curto; baixar CSV e XLSX sem escolher dataset.

**Acceptance Scenarios**:

1. **Given** um projeto com documentos importados, **When** o usuário abre Documentos, **Then** a primeira seção de conteúdo apresenta um card simples de exportação com escolha entre CSV e XLSX.
2. **Given** que o usuário baixa a exportação, **When** o arquivo é aberto, **Then** ele contém o conjunto completo equivalente ao modo “Ambos”, com identificação suficiente para distinguir a origem de cada linha.
3. **Given** que o usuário visualiza o preview no card de exportação, **When** existem documentos e respostas suficientes para prévia, **Then** o preview mostra uma amostra coerente do arquivo que será baixado, reaproveitando o padrão de preview já usado em Documentos quando fizer sentido.

---

### User Story 3 - Consultar Documentos como membro do projeto (Priority: P3)

Como pesquisador ou outro membro do projeto, quero acessar Documentos em modo leitura para conferir a base que estou codificando ou revisando, sem receber permissões de coordenação.

**Why this priority**: A leitura dos documentos é parte do trabalho de todos os membros, enquanto importação e ações destrutivas continuam sendo responsabilidade de coordenação. Separar leitura de gestão simplifica permissões sem abrir configurações sensíveis.

**Independent Test**: Entrar como membro não coordenador de um projeto; acessar Documentos; confirmar que lista, preview e exportação estão disponíveis, enquanto importação, exclusão, restauração e apagamento não aparecem ou não são acionáveis.

**Acceptance Scenarios**:

1. **Given** um membro não coordenador com acesso ao projeto, **When** ele abre Documentos, **Then** ele vê a lista de documentos, consegue abrir preview e consegue baixar exportações.
2. **Given** esse mesmo membro não coordenador, **When** ele visualiza Documentos, **Then** ações de importação, exclusão, restauração e apagamento não ficam disponíveis.
3. **Given** um coordenador do projeto, **When** ele abre Documentos, **Then** ele continua podendo importar, excluir, restaurar e apagar documentos conforme as regras já existentes.

---

### User Story 4 - Exportar documentos antigos sem quebrar o fluxo (Priority: P4)

Como usuário de um projeto já existente, quero que documentos importados antes dessa melhoria continuem exportáveis para que a nova experiência de Documentos não bloqueie análises de bases antigas.

**Why this priority**: Projetos existentes podem não ter a linha original preservada. A melhoria deve ser incremental e não pode transformar dados antigos em erro de exportação.

**Independent Test**: Abrir Documentos em um projeto com documentos antigos sem linha original preservada; baixar CSV e XLSX; verificar que os arquivos são gerados normalmente e que as colunas da base original ficam vazias quando não existem para aqueles documentos.

**Acceptance Scenarios**:

1. **Given** um documento antigo sem linha original preservada, **When** o usuário exporta os dados do projeto, **Then** a linha correspondente continua aparecendo com os campos disponíveis da plataforma.
2. **Given** um projeto que mistura documentos antigos e novos, **When** o usuário baixa a exportação, **Then** documentos novos exibem colunas da base original e documentos antigos deixam essas colunas vazias sem impedir o download.

---

### Edge Cases

- CSVs com colunas vazias devem preservar a existência da coluna no conjunto exportado, mesmo quando uma linha específica não tem valor.
- CSVs com nomes de colunas repetidos ou incompatíveis com a exportação devem gerar nomes de coluna estáveis e distinguíveis no arquivo baixado.
- Projetos sem respostas individuais ou sem gabarito devem continuar baixando a exportação completa com os dados disponíveis e sem erro.
- Campos da base original com o mesmo nome de campos de controle da exportação devem ser diferenciados para evitar ambiguidade no arquivo final.
- Valores complexos de respostas ou gabarito devem continuar sendo representados de forma legível na exportação, como ocorre hoje.
- Usuários sem acesso ao projeto não devem conseguir visualizar Documentos nem baixar exportações.
- Um membro não coordenador não deve conseguir acionar ações de gestão de documentos por navegação direta, atalho ou estado residual da interface.
- Em reimportações que substituem documentos existentes, a linha original preservada deve refletir a nova linha importada; em duplicatas ignoradas, os dados preservados anteriormente devem permanecer inalterados.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema deve preservar, para cada documento importado por CSV, a linha original completa fornecida pelo usuário.
- **FR-002**: A preservação da linha original deve incluir também as colunas usadas para alimentar texto, título e ID externo do documento.
- **FR-003**: A importação por CSV deve continuar permitindo que o coordenador escolha quais colunas alimentam texto, título e ID externo do documento.
- **FR-004**: A área Documentos deve reunir lista, preview e exportação na mesma experiência de navegação.
- **FR-005**: A área Documentos deve exibir um card simples de exportação no topo da página, antes da lista de documentos.
- **FR-006**: O card de exportação deve permitir escolher apenas o formato do arquivo, entre CSV e XLSX.
- **FR-007**: A exportação deve incluir as colunas preservadas da base original nos arquivos baixados.
- **FR-008**: A exportação deve exportar sempre o conjunto completo equivalente ao modo atual “Ambos”, sem exigir escolha entre respostas individuais, gabarito ou ambos.
- **FR-009**: O CSV deve ser gerado como arquivo único com colunas combinadas e identificação da origem de cada linha.
- **FR-010**: O XLSX deve separar respostas individuais e gabarito em abas distintas quando ambos existirem.
- **FR-011**: Documentos sem linha original preservada devem continuar exportáveis, com células vazias nas colunas da base original que não existirem para esses documentos.
- **FR-012**: A exportação deve diferenciar colunas da base original quando seus nomes colidirem com colunas de controle, respostas ou gabarito.
- **FR-013**: A exportação deve manter informações suficientes para o usuário distinguir respostas individuais, registros de gabarito e a origem de cada linha no arquivo final.
- **FR-014**: Todos os membros do projeto devem poder acessar Documentos em modo leitura, visualizar preview de documentos e baixar exportações.
- **FR-015**: Ações de importação, exclusão, restauração e apagamento de documentos devem continuar restritas a coordenadores.
- **FR-016**: A experiência de Documentos deve deixar claro para membros não coordenadores quais ações são apenas de coordenação, preferindo ocultar ações indisponíveis a exibir controles inertes.
- **FR-017**: A melhoria não deve introduzir nesta versão exportação em ZIP, geração assíncrona, jobs de exportação ou novo fluxo de seleção de recortes.
- **FR-018**: A melhoria não deve exigir reconstrução retroativa da linha original para documentos já importados antes da preservação.

### Data and Export Rules

- A linha original preservada deve representar os valores textuais da linha do CSV conforme lidos na importação.
- A linha original preservada deve manter colunas mapeadas e não mapeadas.
- Campos vazios da linha original devem continuar distinguíveis como campos existentes sem valor, em vez de serem tratados como coluna inexistente.
- Colunas originais devem aparecer na exportação em ordem estável e previsível.
- Quando uma coluna original tiver o mesmo nome de uma coluna de controle, resposta ou gabarito, o arquivo exportado deve diferenciar os nomes de modo consistente.
- O CSV unificado deve repetir os dados originais do documento nas linhas associadas a esse documento, inclusive nas linhas de resposta individual e gabarito quando aplicável.
- O XLSX deve incluir as colunas originais nas abas em que elas ajudam a relacionar resposta/gabarito ao documento correspondente.

### Key Entities

- **Documento importado**: Unidade de análise criada a partir de uma linha do CSV, com conteúdo textual, título opcional, ID externo opcional e a linha original preservada.
- **Linha original do CSV**: Conjunto completo de pares coluna-valor fornecido pelo usuário na importação, preservado para auditoria e exportação posterior.
- **Área Documentos**: Experiência unificada para consultar documentos, visualizar preview, importar documentos quando o usuário for coordenador e baixar exportações.
- **Resposta individual**: Codificação humana ou gerada por LLM associada a um documento e a um conjunto de campos do schema do projeto.
- **Gabarito do revisor**: Resultado consolidado da revisão/comparação para um documento, exportado junto com as respostas individuais quando disponível.
- **Arquivo exportado**: Saída baixada pelo usuário em CSV ou XLSX contendo dados da base original preservada, respostas e gabarito disponível.
- **Membro do projeto**: Usuário com acesso ao projeto, autorizado a consultar documentos e exportações.
- **Coordenador do projeto**: Usuário com permissões de gestão sobre documentos, incluindo importação e ações destrutivas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Em um CSV de teste com pelo menos 5 colunas originais, incluindo 2 colunas não mapeadas para campos operacionais, 100% das colunas aparecem na exportação após o upload.
- **SC-002**: Usuários conseguem baixar a exportação completa a partir do topo de Documentos escolhendo apenas o formato do arquivo.
- **SC-003**: Um membro não coordenador consegue acessar Documentos, visualizar preview e baixar exportação sem ver ações de importação, exclusão, restauração ou apagamento.
- **SC-004**: Um coordenador mantém acesso às ações de gestão de documentos já existentes após a reorganização da experiência.
- **SC-005**: Projetos com documentos antigos sem linha original preservada geram CSV e XLSX sem erro e mantêm visíveis os dados disponíveis da plataforma.
- **SC-006**: Em um projeto com respostas individuais e gabarito, o arquivo exportado permite distinguir a origem de 100% das linhas.
- **SC-007**: A exportação de um projeto pequeno de validação, com até 50 documentos e respostas correspondentes, é concluída em até 10 segundos em uma conexão e máquina de desenvolvimento usuais.

## Assumptions

- A primeira versão prioriza simplicidade técnica e reaproveita o comportamento existente de exportação completa, em vez de criar ZIP, fila de exportação ou geração em segundo plano.
- A exportação completa é preferível a filtros na plataforma; o usuário fará recortes posteriores em ferramenta externa de análise.
- Colunas da base original são tratadas como dados do usuário e devem aparecer no export exatamente para fins de análise e auditoria, salvo ajustes necessários de nome para evitar colisão de cabeçalhos.
- A melhoria vale para novas importações por CSV; documentos antigos sem linha original preservada não serão retroativamente enriquecidos.
- Todos os membros do projeto podem consultar documentos, mas apenas coordenadores podem alterar a composição da base de documentos.
- A experiência unificada permanece em Configurações > Documentos nesta versão, mas deixa de tratar a leitura de Documentos como uma área exclusiva de coordenadores.
- Não há requisito de migration nesta especificação. A fase de planejamento técnico deve apenas verificar se a persistência e as permissões existentes já suportam o comportamento descrito; se descobrir lacuna real, a migration passa a ser consequência técnica, não premissa da feature.
- O alvo principal continua sendo uso em desktop, com foco em clareza e densidade de informação para análise.
