#!/usr/bin/env python3
"""
generate-report.py

Transforma o JSON produzido por fetch-open-comments.ts em um relatório .md
em formato conversacional, destacando a redação exata de cada pergunta e
agrupando discussões relacionadas (ex: múltiplos pesquisadores contestando
o mesmo veredito).

Uso:
    python3 generate-report.py <comments.json> <output.md>

O .md gerado tem blocos com diretivas em HTML comments; o apply-decisions.ts
consome esse mesmo formato (via JSON intermediário produzido pelo Claude).

Agrupamento (clusters por campo):
1. Cada `review` vira um cluster — arrasta junto todas as `duvida` com
   `extra.reviewId` igual ao `rawId` do review + `anotacao` do mesmo documento.
2. `duvida` órfãs (sem review correspondente no aberto) → cluster por reviewId.
3. `anotacao` restantes → cluster por documentId dentro do campo.
4. `sugestao` → um cluster por sugestão.

Para `(geral)` (notas e dificuldades): cada item um bloco; nota humana vira
"Nota de pesquisador", dificuldade LLM vira "Ambiguidade reportada pelo LLM".
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def pretty_author(email_local: str) -> str:
    """Tenta extrair um primeiro nome do email local part. Heurística."""
    if not email_local or email_local == "Anônimo":
        return email_local or "Anônimo"
    if "." in email_local:
        parts = [p for p in email_local.split(".") if p]
        alpha = [p for p in parts if p.isalpha()]
        if alpha:
            return max(alpha, key=len).capitalize()
    return email_local.capitalize()


NUMERO_EXTENSO_MASC = {
    1: "Um", 2: "Dois", 3: "Três", 4: "Quatro", 5: "Cinco",
    6: "Seis", 7: "Sete", 8: "Oito", 9: "Nove", 10: "Dez",
}
NUMERO_EXTENSO_FEM = {
    1: "Uma", 2: "Duas", 3: "Três", 4: "Quatro", 5: "Cinco",
    6: "Seis", 7: "Sete", 8: "Oito", 9: "Nove", 10: "Dez",
}


def n_palavras(n: int, singular: str, plural: str, fem: bool = False) -> str:
    tbl = NUMERO_EXTENSO_FEM if fem else NUMERO_EXTENSO_MASC
    extenso = tbl.get(n, str(n))
    return f"{extenso} {singular if n == 1 else plural}"


def format_verdict(v) -> str:
    """Vereditos de multi-select vêm como JSON dict. Resume em lista legível."""
    if v is None:
        return "—"
    if isinstance(v, str):
        s = v.strip()
        # Se for JSON serializado, tenta parsear
        if s.startswith("{") and s.endswith("}"):
            try:
                parsed = json.loads(s)
                return format_verdict(parsed)
            except Exception:
                pass
        return s or "—"
    if isinstance(v, dict):
        marcados = [k for k, val in v.items() if val is True]
        if not marcados:
            return "(nenhuma opção marcada)"
        if len(marcados) <= 3:
            return ", ".join(marcados)
        return f"{', '.join(marcados[:3])} e mais {len(marcados) - 3}"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v) or "—"
    return str(v)


def render_field_header(f: dict) -> list[str]:
    lines: list[str] = []
    lines.append(f"## `{f['name']}`")
    lines.append("")
    lines.append(f"**Pergunta:** {f['description']}")
    if f.get("help_text"):
        help_clean = f["help_text"].strip()
        lines.append(f"**Orientação aos pesquisadores:** {help_clean}")
    if f.get("options"):
        opts = " · ".join(f["options"])
        lines.append(f"**Opções:** {opts}")
    if f.get("subfields"):
        sub_lines = [f"{s['key']} ({s['label']})" for s in f["subfields"]]
        rule = f.get("subfield_rule") or "all"
        regra_txt = "todos obrigatórios" if rule == "all" else "pelo menos um"
        lines.append(f"**Subcampos:** {', '.join(sub_lines)} ({regra_txt})")
    lines.append("")
    return lines


def render_decision_block(heading: str, body_lines: list[str], ids: list[str]) -> list[str]:
    out: list[str] = []
    out.append(f"### {heading}")
    out.append("")
    out.extend(body_lines)
    out.append("")
    out.append("**Decisão:** <!-- aprovar | rejeitar | reformular | ignorar -->")
    out.append("**Mudança no schema:** <!-- descreva em português o que mudar, ou deixe vazio -->")
    out.append("**Nota ao resolver:** <!-- opcional: texto a registrar junto da resolução -->")
    out.append("")
    out.append(f"<!-- ids: {'; '.join(ids)} -->")
    out.append("")
    return out


def build_clusters(field_comments: list[dict]) -> list[dict]:
    clusters: list[dict] = []
    consumed: set[str] = set()

    reviews = [c for c in field_comments if c["source"] == "review"]
    duvidas = [c for c in field_comments if c["source"] == "duvida"]
    anotacoes = [c for c in field_comments if c["source"] == "anotacao"]
    sugestoes = [c for c in field_comments if c["source"] == "sugestao"]

    # 1. Cluster por review
    for r in reviews:
        if r["id"] in consumed:
            continue
        duvs = [
            d for d in duvidas
            if d["id"] not in consumed
            and d.get("extra", {}).get("reviewId") == r["rawId"]
        ]
        anots = [
            a for a in anotacoes
            if a["id"] not in consumed and a.get("documentId") == r.get("documentId")
        ]
        clusters.append({
            "type": "review",
            "anchor": r,
            "duvidas": duvs,
            "anotacoes": anots,
        })
        consumed.update([r["id"], *(d["id"] for d in duvs), *(a["id"] for a in anots)])

    # 2. Dúvidas órfãs — por reviewId
    by_review: dict[str, list[dict]] = {}
    for d in duvidas:
        if d["id"] in consumed:
            continue
        rid = d.get("extra", {}).get("reviewId") or d["rawId"]
        by_review.setdefault(rid, []).append(d)
    for rid, group in by_review.items():
        anots = [
            a for a in anotacoes
            if a["id"] not in consumed and a.get("documentId") == group[0].get("documentId")
        ]
        clusters.append({
            "type": "duvidas-orphans",
            "duvidas": group,
            "anotacoes": anots,
            "reviewId": rid,
        })
        consumed.update([*(d["id"] for d in group), *(a["id"] for a in anots)])

    # 3. Anotações avulsas — por documentId
    anot_by_doc: dict[str, list[dict]] = {}
    for a in anotacoes:
        if a["id"] in consumed:
            continue
        key = a.get("documentId") or f"solo-{a['id']}"
        anot_by_doc.setdefault(key, []).append(a)
    for group in anot_by_doc.values():
        clusters.append({"type": "anotacoes", "anotacoes": group})
        consumed.update(a["id"] for a in group)

    # 4. Sugestões
    for s in sugestoes:
        clusters.append({"type": "sugestao", "sugestao": s})

    return clusters


def render_review_cluster(cl: dict) -> list[str]:
    r = cl["anchor"]
    duvs = cl["duvidas"]
    anots = cl["anotacoes"]
    doc = r.get("documentTitle") or "(documento)"
    date = r["createdAt"][:10]
    verdict = format_verdict((r.get("extra") or {}).get("verdict"))
    reviewer = pretty_author(r.get("author"))

    n_q = len(duvs)
    n_a = len(anots)
    if n_q > 0:
        heading = (
            f"Review de **{reviewer}** em *{doc}* — contestado por "
            f"{n_palavras(n_q, 'pesquisador', 'pesquisadores')}"
        )
    else:
        heading = f"Review de **{reviewer}** em *{doc}*"

    body: list[str] = []
    body.append(
        f"Em {date}, **{reviewer}** revisou este documento e escolheu o veredito "
        f"**\"{verdict}\"**, deixando a seguinte observação:"
    )
    body.append("")
    for ln in r["text"].splitlines():
        body.append(f"> {ln}" if ln.strip() else ">")
    body.append("")

    if duvs:
        body.append(
            f"{n_palavras(n_q, 'pesquisador manifestou dúvida', 'pesquisadores manifestaram dúvida')} "
            f"sobre esse veredito:"
        )
        body.append("")
        for d in duvs:
            nm = pretty_author(d.get("author"))
            txt = d["text"].strip().replace("\n", " ")
            body.append(f"- **{nm}** — {txt}")
        body.append("")

    if anots:
        body.append(
            f"Além disso, {n_palavras(n_a, 'anotação', 'anotações', fem=True)} "
            f"no mesmo documento:"
        )
        body.append("")
        for a in anots:
            nm = pretty_author(a.get("author"))
            txt = a["text"].strip().replace("\n", " ")
            body.append(f"- **{nm}** — {txt}")
        body.append("")

    ids = [r["id"], *(d["id"] for d in duvs), *(a["id"] for a in anots)]
    return render_decision_block(heading, body, ids)


def render_duvidas_orphan_cluster(cl: dict) -> list[str]:
    duvs = cl["duvidas"]
    anots = cl.get("anotacoes", [])
    doc = duvs[0].get("documentTitle") or "(documento)"
    verdict = format_verdict((duvs[0].get("extra") or {}).get("verdict"))

    n_q = len(duvs)
    heading = (
        f"Dúvidas em *{doc}* sobre o veredito \"{verdict}\" "
        f"({n_palavras(n_q, 'pesquisador', 'pesquisadores')})"
    )

    body: list[str] = []
    for d in duvs:
        nm = pretty_author(d.get("author"))
        date = d["createdAt"][:10]
        txt = d["text"].strip().replace("\n", " ")
        body.append(f"- **{nm}** ({date}) — {txt}")
    body.append("")

    if anots:
        body.append(
            f"No mesmo documento há {n_palavras(len(anots), 'anotação', 'anotações', fem=True)}:"
        )
        body.append("")
        for a in anots:
            nm = pretty_author(a.get("author"))
            txt = a["text"].strip().replace("\n", " ")
            body.append(f"- **{nm}** — {txt}")
        body.append("")

    ids = [*(d["id"] for d in duvs), *(a["id"] for a in anots)]
    return render_decision_block(heading, body, ids)


def render_anotacoes_cluster(cl: dict) -> list[str]:
    anots = cl["anotacoes"]
    doc = anots[0].get("documentTitle") or "—"
    n = len(anots)

    if n == 1:
        a = anots[0]
        nm = pretty_author(a.get("author"))
        date = a["createdAt"][:10]
        heading = f"Anotação de **{nm}** em *{doc}* ({date})"
        body = [f"> {ln}" if ln.strip() else ">" for ln in a["text"].splitlines()]
        return render_decision_block(heading, body, [a["id"]])

    heading = f"{n_palavras(n, 'anotação', 'anotações', fem=True)} em *{doc}*"
    body: list[str] = []
    for a in anots:
        nm = pretty_author(a.get("author"))
        date = a["createdAt"][:10]
        txt = a["text"].strip().replace("\n", " ")
        body.append(f"- **{nm}** ({date}) — {txt}")
    body.append("")
    ids = [a["id"] for a in anots]
    return render_decision_block(heading, body, ids)


def render_sugestao_cluster(cl: dict) -> list[str]:
    s = cl["sugestao"]
    nm = pretty_author(s.get("author"))
    date = s["createdAt"][:10]
    changes = (s.get("extra") or {}).get("suggestedChanges") or {}
    changed_keys = (s.get("extra") or {}).get("changedKeys") or []
    current = (s.get("extra") or {}).get("currentField") or {}

    heading = f"Sugestão de schema por **{nm}** ({date})"
    body: list[str] = []
    body.append(f"Motivo: {s['text'].strip() or '(sem motivo)'}")
    body.append("")
    body.append(f"Alterações propostas em: {', '.join(changed_keys) or '(nenhuma)'}")
    body.append("")
    if changes:
        body.append("```json")
        body.append(json.dumps(changes, ensure_ascii=False, indent=2))
        body.append("```")
        body.append("")
    if current:
        body.append(
            f"Estado atual: description=\"{current.get('description','')}\"; "
            f"help_text=\"{current.get('help_text') or ''}\"; options={current.get('options')}"
        )
        body.append("")
    return render_decision_block(heading, body, [s["id"]])


def render_field_section(f: dict, field_comments: list[dict]) -> list[str]:
    lines = render_field_header(f)
    clusters = build_clusters(field_comments)
    for cl in clusters:
        if cl["type"] == "review":
            lines.extend(render_review_cluster(cl))
        elif cl["type"] == "duvidas-orphans":
            lines.extend(render_duvidas_orphan_cluster(cl))
        elif cl["type"] == "anotacoes":
            lines.extend(render_anotacoes_cluster(cl))
        elif cl["type"] == "sugestao":
            lines.extend(render_sugestao_cluster(cl))
    lines.append("---")
    lines.append("")
    return lines


def render_geral(comments: list[dict]) -> list[str]:
    lines: list[str] = []
    lines.append("## Notas gerais")
    lines.append("")
    lines.append(
        "Comentários não atrelados a uma pergunta específica. O pesquisador "
        "pode ter mencionado mais de uma pergunta — ao anotar, liste em "
        "`Campos mencionados:` quais perguntas a nota afeta."
    )
    lines.append("")

    for c in comments:
        nm = pretty_author(c.get("author"))
        date = c["createdAt"][:10]
        doc = c.get("documentTitle") or "—"
        if c["source"] == "nota":
            heading = f"Nota de pesquisador de **{nm}** ao codificar *{doc}* ({date})"
        elif c["source"] == "dificuldade":
            heading = f"Ambiguidade reportada pelo LLM em *{doc}* ({date})"
        else:
            heading = f"[{c['source']}] **{nm}** em *{doc}* ({date})"
        body = [f"> {ln}" if ln.strip() else ">" for ln in c["text"].splitlines()]
        body.append("")
        body.append("**Campos mencionados:** <!-- ex: q2, q14 -->")
        lines.extend(render_decision_block(heading, body, [c["id"]]))
    lines.append("---")
    lines.append("")
    return lines


def render(data: dict) -> str:
    project = data["project"]
    fields = data["fields"]
    comments = data["comments"]
    stats = data["stats"]

    by_field: dict[str, list[dict]] = {}
    for c in comments:
        by_field.setdefault(c["fieldName"], []).append(c)

    lines: list[str] = []
    lines.append(f"# Comentários em aberto — {project['name']}")
    lines.append("")
    n_fields = len([f for f in by_field if f != "(geral)"])
    n_geral = len(by_field.get("(geral)", []))
    src_summary = ", ".join(f"{v} {k}" for k, v in sorted(stats["bySource"].items()))
    lines.append(
        f"Projeto `{project['id']}` na versão do schema `{project['version']}`. "
        f"Gerado em {data['generatedAt'][:10]}."
    )
    lines.append("")
    lines.append(
        f"Há **{stats['totalOpen']} comentários em aberto** — "
        f"{n_fields} perguntas com comentários específicos e {n_geral} "
        f"nota(s) geral(is). Por fonte: {src_summary}."
    )
    lines.append("")
    lines.append(
        "Para cada bloco, preencha `Decisão:` dentro do comentário HTML "
        "(`<!-- ... -->`). Valores: **aprovar** (aplica a mudança e fecha), "
        "**rejeitar** (fecha sem mudar), **reformular** (fecha registrando uma "
        "nota com orientação), **ignorar** (pula — não fecha nada)."
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    for f in fields:
        if f["name"] not in by_field:
            continue
        lines.extend(render_field_section(f, by_field[f["name"]]))

    if "(geral)" in by_field:
        lines.extend(render_geral(by_field["(geral)"]))

    return "\n".join(lines) + "\n"


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "Uso: python3 generate-report.py <comments.json> <output.md>",
            file=sys.stderr,
        )
        sys.exit(1)
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    md = render(data)
    Path(sys.argv[2]).write_text(md, encoding="utf-8")
    print(f"Relatório gerado: {sys.argv[2]} ({len(md)} bytes)")


if __name__ == "__main__":
    main()
