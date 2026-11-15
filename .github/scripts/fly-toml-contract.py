"""Contrato estático de um fly.toml, conferido sobre o TOML parseado.

Uso: python3 fly-toml-contract.py <fly.toml> '<bloco> <chave> = <valor>'...

Cada diretiva nomeia o bloco em que a chave tem de estar: `[http_service]
min_machines_running = 1` exige a chave nessa tabela, com esse valor e esse
tipo (`true` não casa com `1`). Uma tabela (`[x]`) confere só as chaves
listadas. Um array de tabelas (`[[x]]`) tem de ter exatamente um elemento, com
exatamente as chaves listadas: um `[[vm]]` a mais, ou um `cpus`/`cpu_kind`
dentro dele, mudaria a Machine sem passar pelo contrato.

À parte das diretivas, todo `auto_stop_machines` do arquivo, em qualquer bloco
(um `[[services]]` separado, por exemplo), tem de ser "off" ou false: "stop"
derrubou o site em 2026-08-10 e "suspend" em 2026-11-03 (motivos no comentário
do auto_stop_machines em frontend/fly.toml). Lista do que se aceita, e não do
que se proíbe: o flyctl também lê 'stop' (string literal) e true (o stop
legado).

Parser de verdade (tomllib, stdlib desde o Python 3.11), e não grep por linha:
o grep casava texto dentro de string e o `sed 's/#.*//'` cortava `#` dentro de
string, e nenhum dos dois sabia a que bloco uma linha pertence.
"""

import re
import sys
import tomllib


def fail(message: str) -> None:
    print(f"{path}: {message}", file=sys.stderr)
    sys.exit(1)


def same(actual: object, expected: object) -> bool:
    return type(actual) is type(expected) and actual == expected


def auto_stops(node: object, where: str):
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{where}.{key}" if where else key
            if key == "auto_stop_machines":
                yield here, value
            yield from auto_stops(value, here)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from auto_stops(value, f"{where}[{index}]")


path, *directives = sys.argv[1:]

expected: dict[tuple[bool, str], dict[str, object]] = {}
for directive in directives:
    match = re.fullmatch(r"(\[\[?)([A-Za-z_]+)(\]\]?) (.+)", directive)
    if not match or len(match[1]) != len(match[3]):
        sys.exit(f"diretiva mal formada: {directive}")
    expected.setdefault((match[1] == "[[", match[2]), {}).update(
        tomllib.loads(match[4])
    )

try:
    with open(path, "rb") as file:
        config = tomllib.load(file)
except (OSError, tomllib.TOMLDecodeError) as error:
    fail(f"não deu para ler o TOML: {error}")

for (is_array, name), wanted in expected.items():
    header = f"[[{name}]]" if is_array else f"[{name}]"
    block = config.get(name)
    if is_array:
        count = len(block) if isinstance(block, list) else 0
        if count != 1:
            fail(f"precisa de exatamente um {header}, tem {count}")
        block = block[0]
        extra = sorted(block.keys() - wanted.keys())
        if extra:
            fail(f"{header} com chave fora do contrato: {', '.join(extra)}")
    elif not isinstance(block, dict):
        fail(f"sem a tabela {header}")
    for key, value in wanted.items():
        if not same(block.get(key), value):
            fail(f"{header} {key} = {block.get(key)!r}, o contrato exige {value!r}")

for where, value in auto_stops(config, ""):
    if not (same(value, "off") or same(value, False)):
        fail(
            f'{where} = {value!r}: scale-to-zero; todo auto_stop_machines tem de ser "off"'
        )
