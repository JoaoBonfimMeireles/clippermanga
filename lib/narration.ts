// Narração gravada pelo usuário (microfone). Fica em <projeto>/narration/: uma gravação por parte (WAV mono
// 48 kHz, sem efeitos) e index.json com os efeitos de voz. Separado do project.json de propósito: o editor grava
// o projeto inteiro com frequência e não pode apagar uma gravação recém-chegada.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration } from './media';
import { projectDir } from './store';
import { fxFilter, normalizeFx, type NarrationData, type Recording, type VoiceFx } from './voice-fx';

const dirOf = (projectId: string) => path.join(projectDir(projectId), 'narration');
const indexOf = (projectId: string) => path.join(dirOf(projectId), 'index.json');
const safeId = (id: string) => id.replace(/[^\w-]/g, '');

export function readNarration(projectId: string): NarrationData {
  try {
    const d = JSON.parse(fs.readFileSync(indexOf(projectId), 'utf8')) as NarrationData;
    return { fx: normalizeFx(d.fx), items: d.items ?? {} };
  } catch {
    return { fx: normalizeFx(null), items: {} };
  }
}

function writeNarration(projectId: string, d: NarrationData) {
  fs.mkdirSync(dirOf(projectId), { recursive: true });
  const f = indexOf(projectId);
  const tmp = `${f}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  try {
    fs.renameSync(tmp, f);
  } catch {
    fs.writeFileSync(f, fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
  }
}

/** Salva a gravação de uma parte: converte o que veio do navegador (webm/ogg) para WAV, aparando o silêncio das pontas. */
export async function saveRecording(projectId: string, shotId: string, data: Buffer, ext: string): Promise<Recording> {
  const id = safeId(shotId);
  const dir = dirOf(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `${id}.upload.${ext.replace(/[^a-z0-9]/gi, '') || 'webm'}`);
  fs.writeFileSync(raw, data);
  const rel = `narration/${id}_${Date.now().toString(36)}.wav`;
  const out = path.join(projectDir(projectId), rel);
  try {
    // apara silêncio longo no começo e no fim (o tempo até apertar espaço), mantendo um respiro curto
    await runFfmpeg([
      '-i', raw,
      '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.25,areverse',
      '-ar', '48000', '-ac', '1', out,
    ]);
  } finally {
    fs.rmSync(raw, { force: true });
  }
  let dur = (await audioDuration(out));
  if (!dur || dur < 0.2) {
    // gravação quase vazia (só silêncio): guarda sem aparar, para não perder nada
    fs.writeFileSync(raw, data);
    await runFfmpeg(['-i', raw, '-ar', '48000', '-ac', '1', out]);
    fs.rmSync(raw, { force: true });
    dur = (await audioDuration(out));
  }
  const rec: Recording = { file: rel, dur, at: new Date().toISOString() };
  const d = readNarration(projectId);
  const old = d.items[shotId];
  d.items[shotId] = rec;
  writeNarration(projectId, d);
  if (old && old.file !== rel) fs.rmSync(path.join(projectDir(projectId), old.file), { force: true });
  return rec;
}

export function deleteRecording(projectId: string, shotId: string) {
  const d = readNarration(projectId);
  const old = d.items[shotId];
  if (!old) return;
  delete d.items[shotId];
  writeNarration(projectId, d);
  fs.rmSync(path.join(projectDir(projectId), old.file), { force: true });
}

export function setVoiceFx(projectId: string, fx: Partial<VoiceFx>): VoiceFx {
  const d = readNarration(projectId);
  d.fx = normalizeFx(fx);
  writeNarration(projectId, d);
  return d.fx;
}

/**
 * Gravação com os efeitos aplicados (WAV 48 kHz estéreo), em cache por gravação+efeitos.
 * Usado na prévia e no render, para soarem iguais.
 */
export async function processedRecording(projectId: string, shotId: string, fxIn?: Partial<VoiceFx>): Promise<{ file: string; dur: number } | null> {
  const d = readNarration(projectId);
  const rec = d.items[shotId];
  if (!rec) return null;
  const src = path.join(projectDir(projectId), rec.file);
  if (!fs.existsSync(src)) return null;
  const fx = normalizeFx(fxIn ?? d.fx);
  const filter = fxFilter(fx);
  const key = createHash('sha1').update(`${rec.file}\n${filter}`).digest('hex').slice(0, 16);
  const out = path.join(dirOf(projectId), 'fx', `${safeId(shotId)}_${key}.wav`);
  if (!fs.existsSync(out)) {
    // limpa versões antigas desta parte (efeitos trocados)
    const fxDir = path.dirname(out);
    fs.mkdirSync(fxDir, { recursive: true });
    for (const f of fs.readdirSync(fxDir)) if (f.startsWith(`${safeId(shotId)}_`)) fs.rmSync(path.join(fxDir, f), { force: true });
    const tmp = `${out}.tmp.wav`;
    await runFfmpeg(['-i', src, '-af', filter, '-ar', '48000', '-ac', '2', tmp]);
    fs.renameSync(tmp, out);
  }
  return { file: out, dur: (await audioDuration(out)) };
}
