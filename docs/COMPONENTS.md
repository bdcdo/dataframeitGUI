# Catalogo de Componentes

## shell/

### Header.tsx
Logo + nome do projeto + UserMenu. Fixo no topo, 48px.

### ProjectTabs.tsx
Tabs horizontais: Docs | Codificar | Comparar | Stats | Config.
Coordenadores veem tudo, pesquisadores nao veem Config.

### UserMenu.tsx
Dropdown: nome, email, logout.

## coding/

### CodingPage.tsx
Orquestra: DocumentNav + DocumentReader + QuestionBanner.

### DocumentReader.tsx
Area de texto rolavel, max-w-prose centralizado, fonte legivel.

### QuestionBanner.tsx
Banner fixo na parte inferior. Props: fields, currentIndex, answers, onAnswer, onNavigate.
Posicao fixed, max-h-[40vh], animacao slide horizontal (Framer Motion).

### ProgressDots.tsx
Dots clicaveis: preenchido=respondida, vazio=pendente, maior=atual.

### FieldRenderer.tsx
Renderiza campo Pydantic: single->radio, multi->checkbox, text->textarea.
Props: field (PydanticField), value, onChange.

### DocumentNav.tsx
Info bar: titulo doc + navegacao < N/M >.

## compare/

### ComparePage.tsx
Orquestra: texto + banner comparacao.

### ResponseCard.tsx
Card de resposta. LLM: borda teal + badge desatualizada. Humano: borda cinza.
Justificativa colapsavel.

### VerdictPanel.tsx
Botoes de veredito (1-9, Ambiguo, Pular) + campo comentario.

### CompareFilter.tsx
Filtro: todos campos, so ALTA, campo especifico.

### KeyboardShortcuts.tsx
Hook useEffect para atalhos: 1-9, a, s, t, n, p.

## schema/

### PydanticEditor.tsx
Monaco editor Python + botoes validar/salvar.

### PromptEditor.tsx
Monaco editor texto.

### LlmControl.tsx
Config LLM (provider, model, temperature, thinking) + botoes rodar + barra progresso.

### ValidationStatus.tsx
Badge OK/erro + lista de campos alterados.

## documents/

### DocumentList.tsx
Tabela de documentos com busca.

### DocumentUpload.tsx
Drag-and-drop CSV + preview + mapeamento de colunas.

### DocumentPreview.tsx
Modal com texto completo.

## assignments/

### AssignmentTable.tsx
Grid editavel (docs x pesquisadores). Clique em celula faz toggle.

### RandomizeDialog.tsx
Modal: config sorteio (N pesq/doc, balancear, seed).

## stats/

### StatsOverview.tsx
3 stat cards: codificadas, concordancia, revisoes.

### FieldProgress.tsx
Tabela progresso por campo com barra.

### VerdictChart.tsx
Grafico barras recharts: vereditos por campo.

## members/

### MemberList.tsx
Lista de membros + role dropdown.

### AddMemberDialog.tsx
Modal: adicionar membro por email.

## export/

### ExportPage.tsx
Botoes download CSV/Markdown + preview markdown renderizado.
