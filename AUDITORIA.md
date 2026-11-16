# Auditoria do app Mangá em Vídeo (Fable)

Data: 16/11/2026. Base: commit `b2e4912`. Tudo aqui foi medido no código e nos dados de `projetos/` (9 projetos,
`editlog.jsonl`, `jobs.json`, `_gestao.json`, `_aprendizado.json`, `_revisoes.json`). Nenhum render, import ou job de IA
foi rodado. O `.env` não foi lido.

> As seções 1 a 6 são o diagnóstico e o plano (fases A e B). A seção 7 ("O que foi feito") e as seguintes são
> preenchidas na entrega (fase D).

## 1. Resumo executivo

1. **A queda do Cortador (100 → 65 → 41 em `solo-swordmaster`) é erro de medição, não piora do corte.** O placar é
   `100 − (partes que você corrigiu ÷ total)`. Dois salvamentos em massa feitos pelo próprio app foram contados como
   correção sua: 584 partes às 15:23 e 506 às 15:47 de 15/11. O segundo é o efeito da "mudança de regra" que você
   lembrava: a regra nova do piso passou a esticar ~490 recortes, e uma tela aberta com dados antigos gravou por cima
   (esticar 1,25 → 1), o que entrou no log como 488 "correções" de `stretch`. Sem os dois lotes, você corrigiu à mão
   188 de 1.664 partes: o Cortador estaria em **~89**, não 41.
2. **O mesmo defeito apaga trabalho dos jobs.** O editor envia a linha do tempo inteira a cada salvamento. Se um job
   (validar, aplicar estilo, piso de tamanho) mexeu no projeto depois que a tela carregou, o salvamento desfaz o que o
   job fez. No caso acima, 106 trocas de página e 560 recortes foram revertidos em silêncio.
3. **O gestor (Opus) vem criando regras a partir desse ruído e de um critério que contradiz a sua regra fixa.** 8 das
   11 regras `gestao-*` do Cortador tratam de "ampliação acima de 1,5x". Com páginas de 720 a 800 px de largura e a
   regra fixa "o recorte cobre a altura inteira da tela", quase todo recorte passa de 1,5x (93% no `Mansion`, 68% no
   `Tomb Raider King`). Não é defeito de corte, é a resolução da fonte. Uma delas (`gestao-75fe94ee`) manda usar
   recorte encolhido com faixas, o oposto da regra 3. E o Cortador nem tem como obedecer: ele só escolhe o número do
   quadro, não mede pixels.
4. **Essas regras empurraram as regras fixas para fora do prompt.** O bloco de habilidades é cortado em 6.000
   caracteres e os arquivos entram em ordem alfabética. O Cortador tem 8.450 caracteres: as duas habilidades do fim
   (`tamanho-na-tela` e `trecho-largo-em-quadro-alto`, justamente o piso de 40% e o quadro alto) não chegam à IA.
5. **A causa principal do retrabalho nos recortes está no Leitor, não no Cortador.** Nas suas correções manuais o
   recorte da IA é igual à caixa do Leitor (mediana 1,00) e o seu recorte final é 1,2 a 1,6 vezes maior. Em mais da
   metade das correções ele junta duas ou mais caixas do Leitor (43 de 98 no `Mansion`, 14 de 26 no `Tomb Raider
   King`, 101 de 188 no `solo-swordmaster`). O Leitor é instruído a fragmentar ("evite caixa com altura maior que
   1,7x a largura: divida"; "quadro alto vira trechos largos ou quase quadrados"), e você prefere a cena completa,
   mais alta (altura de 1,2 a 1,8x a largura nos webtoons). O Leitor nunca recebe o que o aprendizado descobriu
   sobre o seu gosto: as 30 regras de `_aprendizado.json` vão só para quem escolhe o número do quadro.
6. **Custo.** No lote grande mais recente (`Tomb Raider King`, 732 páginas, 1.485 partes, vídeo de ~3 h) os três
   passos de IA gastaram **56% de uma sessão de 5 h**: leitura + roteiro 31%, edição 19%, validação 6%. Por regra de
   três, um vídeo de 1h30 (~900 partes) fica em **~34%**, acima da meta de 30%. O gasto está nos tokens de saída do
   Haiku: a validação devolve ~40 tokens úteis por chamada e consome ~1.345 (o resto é raciocínio do modelo). Além
   disso `MANGA_FORCE_CLAUDE=1` está ligado: a cadeia grátis da OmniRoute não é usada em quase nada.
7. **Tempo.** Do import ao MP4, o mesmo lote levou ~6 h de máquina: roteiro 36 min, edição 133 min, validação 49 min,
   render 143 min. Na edição, o que pesa é o "aplicar estilo": uma chamada por página, em fila (~580 chamadas). A
   validação também é em fila (~250 chamadas). Ambas podem rodar 4 a 6 ao mesmo tempo. A geração de voz é o maior
   tempo do primeiro render (~15 s por fala, em fila), mas voz está fora do escopo.

## 2. Mapa do sistema (como entendi)

```
importar ─► LEITOR (visão, 1x por página)        page-notes.ts  → page-notes.json (caixas, o que mostra, impacto, falas)
            │
            ├─► resumo e relevância por capítulo   script.ts      (texto, Haiku)
            ├─► ROTEIRO por página                 script.ts      (texto, Sonnet) → pageScript
            │
            ├─► EDIÇÃO: escolhe quadro por número  autoedit.ts    (texto, Haiku; recebe skills cortador+montador,
            │                                                      aprendizado, perfil de cortes)
            ├─► ESTILO: por fala, quadro(s) ou     restyle.ts     (texto, Haiku, 1 chamada por página; gera dúvidas)
            │   "repetir a imagem anterior"
            ├─► PISO (sem IA)                      crop-enforce.ts (tira balão das bordas, cobre a altura, 30/40%)
            ├─► VALIDAÇÃO                          shot-check.ts  (visão, Haiku, 6 recortes por chamada)
            ├─► PISO de novo, GESTOR audita        manager.ts     (Opus, 1 chamada, 14 partes de amostra)
            │
            └─► RENDER: PISO, voz, FFmpeg, depois APRENDIZADO (Opus) com o que você editou   render.ts, learning.ts
                └─► shorts (Diretor), publicação
```

Quem decide o recorte, na prática:

| Etapa | Vê a imagem? | O que controla |
|---|---|---|
| Leitor | sim | a **caixa** de cada quadro (é ela que vira o recorte) |
| Edição ("Cortador/Montador") | não | **qual** quadro, close sim/não, texto, impacto |
| Estilo | não | quadro único, **junção de quadros vizinhos** ou repetir a imagem |
| Piso (`crop-enforce`) | pixels, sem IA | bordas, altura cheia, piso de largura, esticar |
| Validação | sim (recorte reduzido) | reprova e troca por outro quadro ou amplia 15% |

Consequência: regra de geometria (tamanho, largura total, ampliação) escrita para o "Cortador" não tem efeito. Só o
Leitor e o código mexem em geometria.

## 3. Causa raiz da queda do Cortador

Evidência (projeto `089ffff3`, `solo-swordmaster`):

| Momento (UTC, 15/11) | O que houve | Placar gravado |
|---|---|---|
| 11:21 | fim da edição com IA; nenhuma correção ainda | 100 |
| 14:36–15:47 | job "validar" rodando | |
| 15:23:49.228 | **um** salvamento com 584 partes mudadas (`focus` 560, `rotate` 259, `pageId` 106) | |
| 15:47:02 | auditoria no fim da validação | **65** (584 ÷ 1.664 = 35%) |
| 15:47:03.504 | **um** salvamento com 506 partes mudadas: `stretch` 1,2–1,25 → 1 em 488 | |
| 15:47:03.524 | 58 respostas de dúvida (em 51 o palpite da IA estava certo) | |
| 16:23 | auditoria manual | **41** (união dos três lotes ≈ 59%) |

Cadeia de causas:

1. `lib/manager.ts:107-118` (`readLog`) conta toda linha do `editlog.jsonl` como correção sua. O filtro de "lote do
   app" que existe em `lib/learning.ts:120-126` (mais de 200 mudanças no mesmo instante) não é usado no placar.
2. `app/api/projects/[id]/route.ts:36-41` grava no log a diferença entre o que está no disco e o que a tela mandou.
   `components/video-editor.tsx:237-241`, `studio.tsx:100-103`, `final-studio.tsx:32-35` e
   `doubts-modal.tsx:65` mandam **todas** as partes. Se a tela está desatualizada, a diferença é o trabalho do job.
3. O editor só segura o salvamento enquanto roda `restyle` (`video-editor.tsx:238`), não durante `check`, `edit` ou
   `render` (que também regravam recortes).
4. A "mudança de regra": o piso de 40% passou a aplicar esticar; a validação termina chamando `enforceProject`
   (`shot-check.ts:186`), o modal de dúvidas estava com as partes de antes e gravou `stretch` antigo por cima.
5. `manager.ts:134`: responder uma dúvida conta como correção do Cortador mesmo quando o palpite da IA era o certo.

É artefato de medição ou as regras pioraram o corte? As duas coisas, separadas:

- O número 41 é artefato. O valor comparável é ~89.
- As regras novas do gestor não melhoraram nada (o Cortador não consegue cumpri-las) e uma delas piorou o prompt:
  empurrou o piso de tamanho para fora do limite de 6.000 caracteres.
- O histórico não dizia com qual critério cada ponto foi medido, então 100 e 41 pareciam comparáveis.

Outros projetos, para comparação: `Mansion` 100 → 97 e `Tomb Raider King` 100 → 84 → 100 → 100 mostram o mesmo
padrão de "100 logo depois da edição" (não houve tempo de corrigir), ou seja, o 100 também não significa corte bom.
No `Tomb Raider King` o teste de 2 capítulos terminou com "0 correções suas" e nenhuma regra de perfil.

## 4. Achados

Severidade: C = crítica, A = alta, M = média, B = baixa. Esforço: P, M, G.

### 4.1 Medição e gestor

| # | Sev | Onde | Evidência | Impacto | Correção | Esf |
|---|---|---|---|---|---|---|
| 1 | C | `components/*` (4 telas) + `app/api/projects/[id]/route.ts:30-57` | 584 + 506 partes regravadas por tela desatualizada | perde trabalho dos jobs; contamina placar e aprendizado | tela envia só as partes que mudou (`changedIds`/`removedIds`); servidor mescla sobre a versão do disco | M |
| 2 | C | `lib/manager.ts:107-138` | placar 41 com 188 correções reais | placar inútil; auditoria diz "o dono corrigiu" o que o app mudou | ignorar lotes do app; dúvida só conta quando o palpite errou | P |
| 3 | A | `lib/manager.ts:38-44, 291` | histórico sem critério | pontos incomparáveis | gravar versão do critério, partes corrigidas e contagens automáticas em cada ponto | P |
| 4 | A | `lib/manager.ts:194-205`, `crop-quality.ts:23` | 8 regras sobre ampliação > 1,5x; 93% dos recortes do `Mansion` "borrados" | regras impossíveis e contraditórias com a regra 3 | "borrado" deixa de ser problema por si; o gestor recebe as regras fixas e o que cada agente controla; proposta exige 3+ exemplos com correção manual | M |
| 5 | A | `lib/skills.ts:49-54` | Cortador com 8.450 caracteres, corte em 6.000, ordem alfabética | piso de 40% e quadro alto fora do prompt | regras fixas primeiro, `gestao-*` depois, no máximo 4 por agente, sem cortar no meio | P |
| 6 | M | `lib/manager.ts:233` | só as 15 últimas recusas vão ao gestor; a mesma ideia voltou 8 vezes "reformulada" | regra recusada volta com outro texto | mandar também os títulos das aprovadas e arquivadas; pedir que diga qual habilidade existente já cobre | P |
| 7 | M | `lib/stage-review.ts:55` + `review.ts:67` | lições de `stage-leitura` e `stage-roteiro` ficam em chaves que nenhum prompt lê | 2 chamadas de Opus por lote cujo resultado só aparece no log | entregar as lições ao Leitor e ao roteiro | P |
| 8 | M | `lib/cut-profiles.ts:340-342` | teste do `Tomb Raider King`: "0 correções" | perfil não aprende quando as partes do teste são recriadas (ids novos) | não resolvido aqui; ver pendências | M |
| 9 | B | `lib/learning.ts:126` | lotes de 30 a 200 mudanças passam como correção (ex.: 158 no `Regressed`) | regra 27 do aprendizado ("stretch sempre 1") nasceu disso | mesmo filtro do item 2 | P |

### 4.2 Recortes

| # | Sev | Onde | Evidência | Impacto | Correção | Esf |
|---|---|---|---|---|---|---|
| 10 | C | `lib/page-notes.ts:64, 70`; skills `leitor/quadro-alto-em-trechos`, `caixa-da-cena` | seu recorte = 1,2–1,6x a caixa do Leitor; junta 2+ caixas em >50% das correções | recorte "muito próximo", sem a cena | caixa = cena completa do quadro; só dividir acima de 1,9x; trechos altos (1,2–1,7x), nunca "quase quadrados" | P |
| 11 | A | `lib/learning.ts:220-226`, `page-notes.ts:537` | regras 3–8, 20, 26–28 do aprendizado são de geometria e vão para quem não mexe em geometria | o gosto aprendido não chega ao Leitor | regras marcadas `GEOMETRIA:` vão para o Leitor; as demais para edição/estilo | M |
| 12 | A | `lib/restyle.ts:24-40, 138` | o estilo não sabe o formato dos quadros; regra `gestao-7a7738c1` ("um recorte = um quadro") contra as regras 14, 16 e 17 do aprendizado ("cena geral") | recorte baixo e largo ampliado 2,5x em vez da cena | dizer o formato de cada quadro; regra única: junta quadros vizinhos do **mesmo momento**, nunca de momentos diferentes | P |
| 13 | A | `lib/autoedit.ts:44-51` | três limites diferentes de altura (1,7x, 2,4x, "ALTO") e "não busque preencher a tela" | instrução contraditória; ~3 mil tokens por chamada | um limite só (1,9x, o seu), sem repetições | M |
| 14 | M | `lib/autoedit.ts:36-37, 85` | "balão quase nunca" dito três vezes; propaganda duas | tokens e diluição | uma vez cada | P |
| 15 | M | `lib/crop-enforce.ts:25, 306-310` | a meta de 40% é tratada como piso: estica até 41,5% | 35% dos recortes do `solo` esticados; você reclama de "esticado", mas também estica à mão (15 para cima, 17 para baixo) | **não mexi: precisa da sua decisão** (pergunta 1) | P |
| 16 | M | `scripts/crop-report.ts` | não mede balão nem recorte "apertado" | sem número para as dores 1 e 3 | medir fração de balão/branco e recortes "baixos e ampliados" | M |
| 17 | B | `lib/crop-enforce.ts:28` | cita `scripts/crop-eval.ts`, que não existe | calibração não reproduzível | registrar; o relatório novo cobre parte | P |
| 18 | B | `lib/crop-quality.ts:16-17` vs regra 3 | `maxStretch: 1.9` como último recurso; a regra diz ≤ 1,4 | hoje 0% das partes passa de 1,4 | manter (só entra para não furar o piso de 30%); documentado | – |

### 4.3 Custo e velocidade

Consumo medido (campo `quotaUsed` dos jobs, lote `Tomb Raider King`, tudo no Claude):

| Passo | Chamadas | Entrada | Saída | % da sessão de 5 h | Tempo |
|---|---|---|---|---|---|
| Leitura (Haiku, visão) + roteiro (Sonnet) | 199 + 62 | 2,7 M | 1,9 M | 31% | 36 min |
| Edição + estilo (Haiku, texto) | 679 | 3,4 M | 545 k | 19% | 133 min |
| Validação (Haiku, visão) | 325 | 957 k | 437 k | 6% | 49 min |
| Gestor (Opus) | ~6 | ~40 k | ~15 k | ~1% | 3 min |
| Render (sem IA; voz à parte) | | | | ~0% | 143 min |

| # | Sev | Onde | Evidência | Impacto | Correção | Esf |
|---|---|---|---|---|---|---|
| 19 | A | `lib/restyle.ts:112-185` | ~580 chamadas em fila, uma por página | ~1 h a mais por lote | 5 páginas ao mesmo tempo | M |
| 20 | A | `lib/shot-check.ts:64-93` | ~250 chamadas em fila | ~35 min a mais | 4 lotes ao mesmo tempo | P |
| 21 | A | `lib/autoedit.ts:626, 646-650, 684`; `restyle.ts:90, 138` | até ~20 mil caracteres de regras no começo da mensagem do usuário, em toda chamada | 3,4 M tokens de entrada, só 594 k do cache | pôr as regras fixas do job no `system` (é o que o CLI guarda em cache) | P |
| 22 | A | provedor `claude-code` em `../videos` (não editado) | validação: ~1.345 tokens de saída para ~40 úteis | o raciocínio do Haiku é a maior parte da saída | **pendente, precisa do seu ok** (seção 9) | P |
| 23 | A | configuração | logs: "teste: só Claude (MANGA_FORCE_CLAUDE=1)" em todos os lotes recentes | nada vai para a cadeia grátis | decisão sua (pergunta 2) | – |
| 24 | M | `lib/crop-enforce.ts:389-449` | o piso roda 3 a 4 vezes por lote, 1 a 3 FFmpeg por parte, em fila | 2 a 5 min por rodada em 1.500 partes | guardar o resultado por recorte e rodar 6 ao mesmo tempo | P |
| 25 | M | `lib/autoedit.ts:653-772` | edição em fila por causa da "história até aqui" | 40 a 80 min | rodar por capítulo em paralelo (não feito: muda continuidade) | G |
| 26 | M | `lib/manager.ts`, rota de jobs | auditoria do gestor roda depois da edição **e** depois da validação | 2 chamadas de Opus por lote; a primeira sempre dá 100 | auditar só depois da validação | P |
| 27 | B | `lib/omniroute.ts` | sem registro de erro e latência por modelo | não dá para ordenar a cadeia por dados | gravar contadores por modelo (seção 9) | M |

### 4.4 Código

| # | Sev | Onde | Evidência | Correção | Esf |
|---|---|---|---|---|---|
| 28 | M | `lib/page-notes.ts:193-203`, `jobs.ts:119-126` | escrita "tmp + rename" repetida 4 vezes, cada uma de um jeito | usar `writeJsonAtomic` | P |
| 29 | M | `lib/autoedit.ts:143-148, 304, 506-514`, `crop-quality.ts:106` | variáveis mortas (`ef`, `void aspect`, `SECONDS_PER_CHAPTER`, `void m`) | limpar | P |
| 30 | M | `README.md` | "voz: hoje gera silêncio"; projetos em `../videos/data` | reescrever | P |
| 31 | M | `components/video-editor.tsx` (1.582 linhas, 31 `useState`) | qualquer tecla re-renderiza tudo; `edit()` copia todas as partes | plano de divisão na seção 9; não refatorei sem teste | G |
| 32 | B | `lib/manager.ts:158` e `215` | "imagem repetida" medida de dois jeitos | unificar | P |
| 33 | B | sem testes | nada cobre `crop-enforce`, mescla de partes, placar | teste da mescla e do filtro em `scripts/selftest.ts` | P |

## 5. Como o gestor gerencia o Haiku e os grátis (avaliação)

O ciclo placar → auditoria → proposta → habilidade existe e grava tudo, mas hoje não fecha:

- **Entrada ruim.** A amostra de 14 partes prioriza "borrado" (peso 2) e "dono corrigiu" (peso 2 por agente). Os dois
  sinais estavam errados (itens 2 e 4).
- **Destino errado.** As propostas vão para o agente "cortador", que não controla geometria. Nenhuma proposta jamais
  foi para o Leitor por causa de caixa pequena, que é o problema real.
- **Sem critério de aceite.** Bastam "2+ exemplos" numa amostra de 14, escolhida pelos piores casos. Resultado: 12
  regras aprovadas em 3 dias, 8 sobre o mesmo assunto.
- **Sem poda.** Nada sai. Uma habilidade aprovada vale para todas as obras para sempre.
- **Contaminação entre obras.** Regras `gestao-*` são globais e nasceram de uma obra só (`solo-swordmaster`,
  `Mansion`, `Tomb Raider King`), com exemplos daquela obra no texto ("HOTEL LEVIATHAN"). Os perfis de corte fazem
  isso direito (global só com 2+ obras), mas ainda estão vazios.
- **Sem medir o efeito.** Depois de aprovar uma regra ninguém confere se a taxa de correção caiu.

Melhorias aplicadas: ver seção 7. Propostas que ficaram para depois: seção 9.

## 6. Plano (fase B)

Ordem por ganho ÷ (risco × esforço). ★ = muda comportamento visível.

| Lote | Conteúdo | Itens | Risco |
|---|---|---|---|
| 1 | Placar confiável e fim da gravação por cima | 1, 2, 3, 9, 33 | médio (telas), coberto por teste da mescla |
| 2 ★ | Habilidades: ordem e limite no prompt, reescrita curta, arquivo das `gestao-*` redundantes | 5, 10 (skills), 12 (skill) | baixo; um commit só, reversível |
| 3 ★ | Prompts de corte: Leitor, edição, estilo, gestor, aprendizado | 4, 6, 7, 10, 11, 12, 13, 14 | médio; só vale para leituras e edições novas |
| 4 | Velocidade e custo: regras no `system`, estilo e validação em paralelo, piso com memória, uma auditoria por lote | 19, 20, 21, 24, 26 | médio |
| 5 | Relatório de recortes, limpeza, README | 16, 28, 29, 30 | baixo |

Não entram: voz/TTS, publicação, `../videos`, política de esticar (item 15), edição em paralelo por capítulo (25),
divisão do `video-editor.tsx` (31).

## 7. O que foi feito (estado em 16/11/2026, trabalho interrompido pelo limite de uso)

| Commit | Lote | Conteúdo |
|---|---|---|
| `45667ed` | 1 | Telas mandam só as partes alteradas e o servidor mescla (`lib/shots-merge.ts`); placar ignora lotes do app; histórico com critério e etapa; `scripts/selftest.ts` |
| `98bb834` | 2 ★ | Habilidades reescritas e ordenadas; 18 arquivos movidos para `projetos/_skills/_arquivo/` (nada apagado; ver `LEIA.md` lá) |
| `2d91b75` | 3 ★ | Prompts do Leitor, edição, estilo, gestor, aprendizado e perfis; regras fixas do job no `system` (cache) |

Placar recalculado com o critério novo: `solo-swordmaster` Cortador 92 (139 partes corrigidas à mão), não 41.

Para desfazer um lote: `git revert <commit>`. Os lotes 2 e 3 mexem em prompts/habilidades e podem ser revertidos um a um.

## 8. Pendente (não feito)

- **Lote 4 (velocidade/custo)**: só `lib/pool.ts` foi criado e ainda não é usado. Falta: estilo (`restyle.ts`) e validação
  (`shot-check.ts`) em paralelo, memória do piso (`crop-enforce.ts`), auditoria do gestor só depois da validação.
- **Lote 5**: relatório de balão/recorte apertado em `scripts/crop-report.ts`, limpeza de código morto, README.
- Itens 8, 15, 22, 23, 25, 27 e 31 da seção 4.
- **Nada disto foi testado com IA nem no navegador**: só `npm run typecheck` e `scripts/selftest.ts`.

## 9. Como validar (1 capítulo)

1. `npm run typecheck` e `node ../videos/node_modules/tsx/dist/cli.mjs scripts/selftest.ts`.
2. Importe 1 capítulo novo (a leitura antiga fica em cache e não usa o prompt novo do Leitor), rode roteiro, edição e validação.
3. Com a validação rodando, edite uma parte no editor: ao terminar, os recortes trocados pela validação devem continuar lá.
4. Em `/gestao`, confira a linha "no render" do histórico e se as propostas citam 3+ correções suas.
5. Compare no log do job "tokens de entrada (… do cache)" da edição com um lote antigo.

## 10. Perguntas para você

1. Esticar: o piso obrigatório é 30% e 40% é meta. Quer que o app só estique abaixo de 30% (hoje estica até 41,5%)?
2. `MANGA_FORCE_CLAUDE=1` está ligado: é de propósito? Com ele a cadeia grátis não é usada.
3. Posso testar `MAX_THINKING_TOKENS=0` para o Haiku (exige mexer em `../videos` ou no `.env`)? É o maior corte de custo possível.
