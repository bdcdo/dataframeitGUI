# Pacote, e não diretório solto: sem este arquivo o conftest.py daqui entra no
# sys.path como o módulo `conftest` e sombreia o de tests/, de que
# tests/test_auth.py importa TEST_JWT_SECRET (a coleta do pytest quebra).
