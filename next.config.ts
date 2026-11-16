import { createRequire } from 'node:module';
import path from 'node:path';
import type { NextConfig } from 'next';

// Este app fica fora do monorepo, mas usa os pacotes (packages/*) e o node_modules de ../videos.
const videos = path.resolve(import.meta.dirname, process.env.VIDEOS_DIR ?? '../videos');
const modules = path.join(videos, 'node_modules');

// O Next decide o que é dependência externa (react, next...) resolvendo só em "node_modules" a partir deste app;
// sem node_modules aqui ele empacotaria uma segunda cópia do React. Inclui o node_modules do monorepo nessa busca.
const req = createRequire(path.join(modules, 'next', 'package.json'));
const wc = req('next/dist/build/webpack-config') as Record<string, { modules?: string[] }>;
for (const k of ['NODE_RESOLVE_OPTIONS', 'NODE_ESM_RESOLVE_OPTIONS', 'NODE_BASE_RESOLVE_OPTIONS', 'NODE_BASE_ESM_RESOLVE_OPTIONS']) {
  const o = wc[k];
  if (o?.modules && !o.modules.includes(modules)) o.modules.push(modules);
}

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingRoot: path.dirname(videos),
  experimental: { externalDir: true, webpackMemoryOptimizations: true },
  devIndicators: false,
  webpack: (config, { isServer, nextRuntime, dev }) => {
    // o cache em disco do webpack não consegue fazer snapshot dos pacotes de ../videos (só gera aviso e atrasa o build)
    if (!dev) config.cache = false;
    // Sem node_modules neste app, o Next não troca o runtime JSX pelo React embutido dele no servidor
    // (RSC/SSR) e o app carregaria duas cópias do React. Faz a troca na mão, por camada.
    if (!isServer) {
      // navegador: o React embutido do Next (next/dist/compiled/react)
      const c = (f: string) => path.join(modules, 'next', 'dist', 'compiled', 'react', f);
      config.module.rules.push({
        issuerLayer: 'app-pages-browser',
        resolve: {
          alias: {
            'react/jsx-runtime$': c('jsx-runtime.js'),
            'react/jsx-dev-runtime$': c('jsx-dev-runtime.js'),
            react$: c('index.js'),
            [path.join(modules, 'react', 'jsx-runtime.js')]: c('jsx-runtime.js'),
            [path.join(modules, 'react', 'jsx-dev-runtime.js')]: c('jsx-dev-runtime.js'),
            [path.join(modules, 'react', 'index.js')]: c('index.js'),
          },
        },
      });
    }
    if (isServer && nextRuntime === 'nodejs') {
      const v = (layer: string, name: string) => path.join(modules, 'next', 'dist', 'server', 'route-modules', 'app-page', 'vendored', layer, `${name}.js`);
      for (const layer of ['rsc', 'ssr']) {
        config.module.rules.push({
          issuerLayer: layer,
          resolve: {
            alias: {
              'react/jsx-runtime$': v(layer, 'react-jsx-runtime'),
              'react/jsx-dev-runtime$': v(layer, 'react-jsx-dev-runtime'),
              react$: v(layer, 'react'),
              'react-dom$': v(layer, 'react-dom'),
              // o SWC pode importar o runtime JSX pelo caminho absoluto
              [path.join(modules, 'react', 'jsx-runtime.js')]: v(layer, 'react-jsx-runtime'),
              [path.join(modules, 'react', 'jsx-dev-runtime.js')]: v(layer, 'react-jsx-dev-runtime'),
              [path.join(modules, 'react', 'index.js')]: v(layer, 'react'),
            },
          },
        });
      }
    }
    // exFAT: readlink devolve EISDIR, e não há symlinks a seguir
    config.resolve.symlinks = false;
    config.resolve.modules = [...(config.resolve.modules ?? ['node_modules']), modules];
    config.resolveLoader = { ...config.resolveLoader, modules: [...(config.resolveLoader?.modules ?? ['node_modules']), modules] };
    config.plugins = config.plugins.filter((p: object) => p?.constructor?.name !== 'TraceEntryPointsPlugin');
    return config;
  },
};

export default nextConfig;
