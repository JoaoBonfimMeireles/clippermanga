// Gravação/leitura de JSON à prova de leitura no meio da escrita: grava num arquivo temporário e troca de nome (atômico),
// e a leitura tenta de novo se pegar o arquivo vazio/cortado. Antes, writeFileSync direto deixava o arquivo vazio por um instante
// e quem lia nesse momento tomava "Unexpected end of JSON input" (ou, pior, voltava ao padrão e apagava o aprendizado ao gravar).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const sleep = (ms: number) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* sem espera */
  }
};

export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  const raw = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, raw, 'utf8');
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch {
      sleep(30 * (i + 1)); // Windows: o destino pode estar aberto por um leitor
    }
  }
  fs.writeFileSync(file, raw, 'utf8');
  fs.rmSync(tmp, { force: true });
}

/** Lê e faz parse; se o arquivo estiver vazio/cortado (alguém gravando), espera e tenta de novo. Arquivo que não existe: lança. */
export function readJsonRetry<T>(file: string, tries = 4): T {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) return JSON.parse(raw) as T;
      last = new Error('arquivo vazio');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
      last = e;
    }
    sleep(40 * (i + 1));
  }
  throw last;
}
