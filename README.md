# Mangá em Vídeo

Transforma capítulos de mangá/manhwa em vídeo narrado para o YouTube: importa as páginas, a IA lê, escreve o roteiro,
escolhe e recorta os quadros, você ajusta no editor, e o app renderiza o MP4, os shorts e o material de publicação.

Depende do monorepo `../videos` (pacotes `@clipper/*` e `node_modules`): rode `npm install` lá. Não há `npm install`
aqui (o disco D: é exFAT, sem symlinks).

    npm run dev        # http://localhost:3100
    npm run typecheck
    node ../videos/node_modules/tsx/dist/cli.mjs scripts/selftest.ts                 # testes locais, sem IA
    node ../videos/node_modules/tsx/dist/cli.mjs scripts/crop-report.ts projetos/<id> # qualidade dos recortes

Configuração: copie `.env.example` para `.env`. A IA usa primeiro os modelos grátis da OmniRoute e cai no Claude
(reserva paga, automática com `autoPaid`) quando eles esgotam.

## Fluxo

| Passo | Arquivo | O que faz |
|---|---|---|
| Importar | `lib/importer.ts` | baixa as páginas; modo teste de 1-2 capítulos (`lib/cut-profiles.ts`) |
| 1 · Roteiro | `lib/page-notes.ts`, `lib/script.ts` | Leitor (visão) descreve cada página uma vez; resumo, relevância e narração |
| 2 · Edição | `lib/autoedit.ts`, `lib/restyle.ts` | escolhe o quadro de cada fala, repete ou junta quadros; gera dúvidas |
| 3 · Validação | `lib/shot-check.ts`, `lib/manager.ts` | confere os recortes; o gestor audita uma amostra |
| 4 · Render | `lib/render.ts`, `lib/voice*.ts` | voz, FFmpeg, depois aprende com o que você editou (`lib/learning.ts`) |
| Depois | `lib/shorts*.ts`, `lib/publish.ts` | shorts e publicação |

Regras fixas dos recortes (altura cheia, piso de 30/40% da largura, esticar, balão das bordas) são garantidas em código,
em `lib/crop-enforce.ts`, no fim de cada passo que mexe neles.

## Onde ficam os dados

Tudo em `projetos/`: um diretório por projeto (`project.json`, páginas, vídeos, `.progress/`), mais:

- `_skills/<agente>/*.md`: habilidades de cada agente (entram no prompt). `_skills/_arquivo/` guarda as retiradas.
- `_aprendizado.json`: regras aprendidas das suas correções. `_perfis/`: perfis de corte por obra.
- `_gestao.json`: placar e auditorias do gestor (tela `/gestao`). `_revisoes.json`: revisões por tarefa.

O salvamento do editor manda só as partes que você mudou (`lib/shots-merge.ts`), para não gravar por cima do que um
job fez enquanto a tela estava aberta.

Auditoria de 16/11/2026, com achados, medições e pendências: `AUDITORIA.md`.
