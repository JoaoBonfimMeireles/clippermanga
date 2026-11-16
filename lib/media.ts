// Atalhos rápidos para o que antes exigia um processo externo (ffprobe) ou ler arquivos inteiros.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { probe } from '@clipper/video-processing';

/**
 * Duração de um WAV lendo só o cabeçalho (microssegundos, contra ~50-100 ms de um ffprobe no Windows).
 * Qualquer coisa fora do PCM/float simples (ou cabeçalho estranho) cai no ffprobe, que é o resultado de referência.
 */
function wavHeaderDuration(file: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    const fileSize = fs.fstatSync(fd).size;
    let off = 12;
    let byteRate = 0;
    let format = 0;
    while (off + 8 <= n) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        format = buf.readUInt16LE(off + 8);
        byteRate = buf.readUInt32LE(off + 16);
      } else if (id === 'data') {
        // 1 = PCM, 3 = float, 0xFFFE = extensible (PCM dentro); o ffmpeg às vezes grava tamanho 0/-1 em streaming
        if (!byteRate || ![1, 3, 0xfffe].includes(format)) return null;
        const avail = fileSize - (off + 8);
        const bytes = size === 0 || size === 0xffffffff || size > avail ? avail : size;
        return bytes / byteRate;
      }
      off += 8 + size + (size & 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Duração (s) de um áudio: WAV pelo cabeçalho; o resto (ou WAV incomum) pelo ffprobe. */
export async function audioDuration(file: string, signal?: AbortSignal): Promise<number> {
  if (/\.wav$/i.test(file)) {
    const d = wavHeaderDuration(file);
    if (d !== null && Number.isFinite(d) && d > 0) return d;
  }
  return (await probe(file, signal)).duration;
}

// sha1 do conteúdo, lembrado por caminho + tamanho + data: o render montava a chave do cache de cada parte
// lendo o áudio inteiro de todas as partes, a cada render
const g = globalThis as unknown as { __mangaFileHash?: Map<string, { key: string; hash: string }> };
const hashes = (g.__mangaFileHash ??= new Map());

export function fileHash(file: string): string {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = hashes.get(file);
  if (hit?.key === key) return hit.hash;
  const hash = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  hashes.set(file, { key, hash });
  if (hashes.size > 20000) hashes.delete(hashes.keys().next().value!);
  return hash;
}
