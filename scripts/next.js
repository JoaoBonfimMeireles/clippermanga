#!/usr/bin/env node
// Roda o Next do monorepo ../videos (VIDEOS_DIR para outro lugar) neste app, com o shim de exFAT,
// CLIPPER_ROOT apontando para o monorepo (banco, configurações de IA e data/ são os mesmos) e NODE_PATH
// para os plugins (PostCSS/Tailwind) acharem o node_modules de lá.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const videos = path.resolve(app, process.env.VIDEOS_DIR ?? '../videos');
const shim = path.join(videos, 'scripts', 'exfat-fs-shim.cjs').replace(/\\/g, '/');
const nextBin = path.join(videos, 'node_modules', 'next', 'dist', 'bin', 'next');
const heap = process.argv[2] === 'build' ? ' --max-old-space-size=8192' : '';
const env = {
  ...process.env,
  CLIPPER_ROOT: videos,
  NODE_PATH: path.join(videos, 'node_modules'),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${shim}"${heap}`.trim(),
};
// build com o servidor no ar apaga a pasta .next que ele usa (500 em tudo): avisa e não deixa
if (process.argv[2] === 'build') {
  const busy = await new Promise((res) => {
    const c = net.connect({ port: 3100, host: '127.0.0.1' });
    c.on('connect', () => (c.destroy(), res(true)));
    c.on('error', () => res(false));
  });
  if (busy) {
    console.error(['', '⛔ Há um servidor rodando na porta 3100. Pare-o (Ctrl+C no terminal dele) antes de rodar o build,', '   senão a pasta .next é apagada embaixo dele e as páginas dão 500.', ''].join('\n'));
    process.exit(1);
  }
}
const child = spawn(process.execPath, [nextBin, process.argv[2], app, ...process.argv.slice(3)], { stdio: 'inherit', env, cwd: app });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
