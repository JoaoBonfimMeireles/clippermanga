# Mangá em Vídeo

App enxuto para transformar mangá em vídeo: importar capítulo (link ou imagens) → escolher páginas, ordem, duração
e área de foco com prévia ao lado → roteiro pela IA (opcional) → narração em texto ou voz → render MP4.

Depende do monorepo `../videos` (pacotes `@clipper/*`, `node_modules`, banco e `data/`): rode `npm install` lá.
Não há `npm install` aqui (o disco D: é exFAT, sem symlinks).

    npm run dev        # http://localhost:3100
    npm run typecheck

Projetos: `../videos/data/manga-studio/`. Vídeos: `../videos/data/output/manga-studio/`.
Voz (TTS): ponto de integração em `lib/voice.ts` (hoje gera silêncio).
