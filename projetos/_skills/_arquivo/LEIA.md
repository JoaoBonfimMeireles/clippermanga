# Habilidades arquivadas

Arquivos desta pasta NÃO entram no prompt de nenhum agente. Nada foi apagado: para reativar uma habilidade, mova o
arquivo de volta para `projetos/_skills/<agente>/`.

Arquivadas na auditoria de 16/11/2026 (motivos em `AUDITORIA.md`, seção 7):

- `cortador/gestao-2097bb5f, 41feee13, 5f30238e, 75fe94ee, 85adf92e, ad8d8207, fd6ed781, 555860bd`: oito versões da
  mesma regra de "ampliação acima de 1,5x". O Cortador só escolhe o número do quadro e não mede pixels, e com a regra
  fixa de cobrir a altura da tela quase todo recorte de página de 720-800 px passa de 1,5x. A `75fe94ee` ainda mandava
  encolher o recorte com faixas, contra a regra fixa.
- `cortador/gestao-6ca8d4c4` (texto como imagem): virou a habilidade fixa "Escolha quadro de arte, nunca de texto".
- `cortador/gestao-7a7738c1` (um recorte = um quadro): virou "Juntar quadros só do mesmo momento" (montador). Nas
  correções à mão, o dono junta 2+ caixas da leitura em mais da metade dos casos, sempre do mesmo momento.
- `cortador/gestao-944cdef4` (pedaço de balão na borda): quem tira balão da borda é o código (`lib/crop-enforce.ts`).
- `cortador/tamanho-na-tela`, `cortador/trecho-largo-em-quadro-alto`: tamanho e quadro alto são garantidos em código;
  para quem escolhe o número do quadro sobrou "Evite quadro pequeno e quadro alto demais".
- `leitor/gestao-bc2d2f5d` (fala cortada em 10 s): o gestor viu o corte que ele mesmo fazia no texto da amostra
  (140 caracteres); as falas não estavam cortadas.
- `montador/gestao-23a1cc94`, `gestao-62ca9c20` (página sem arte): iguais entre si; entraram em "A imagem mostra o que
  a fala diz".
- `montador/ritmo-e-duracao`, `ordem-e-fidelidade`: repetiam o prompt da edição (ECONOMIA, FIDELIDADE) e a duração por
  impacto, que é calculada em código.
