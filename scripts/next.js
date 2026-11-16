#!/usr/bin/env node
// Roda o Next do monorepo ../videos (VIDEOS_DIR para outro lugar) neste app, com o shim de exFAT,
// CLIPPER_ROOT apontando para o monorepo (banco, configurações de IA e data/ são os mesmos) e NODE_PATH
// para os plugins (PostCSS/Tailwind) acharem o node_modules de lá.
import { spawn } from 'node:child_process';
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
const child = spawn(process.execPath, [nextBin, process.argv[2], app, ...process.argv.slice(3)], { stdio: 'inherit', env, cwd: app });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
