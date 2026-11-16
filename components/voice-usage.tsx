'use client';
// Painel de uso das vozes (TTS): o que cada provedor/voz já narrou, quanto gastou, velocidade e falhas,
// com destaques automáticos (mais usada, mais rápida, mais confiável, mais econômica).
import { useEffect, useState } from 'react';
import type { VoiceStats } from '@/lib/voice-usage';

type Data = { usage: Record<string, VoiceStats>; voices: { id: string; name: string; provider: string; note: string }[]; chain: string[] };

const PROVIDER: Record<string, { label: string; free: string }> = {
  gemini: { label: 'Gemini', free: '~10 pedidos/dia por modelo × 2 modelos (blocos de 5 min) ≈ 100 min/dia' },
  fishaudio: { label: 'Fish Audio', free: 'modelo s2.1-pro-free (limite do plano grátis do Fish)' },
  elevenlabs: { label: 'ElevenLabs', free: '~10 mil caracteres/mês no plano grátis ≈ 10 min' },
  edge: { label: 'Microsoft', free: 'ilimitada' },
  gtts: { label: 'Google Tradutor', free: 'ilimitada' },
};

const min = (s: number) => (s / 60).toFixed(1);
const today = () => new Date().toISOString().slice(0, 10);

export function VoiceUsage() {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    fetch('/api/usage/voices').then(async (r) => r.ok && setD(await r.json()));
  }, []);
  if (!d) return null;

  const rows = d.voices.map((v) => {
    const s = d.usage[v.id];
    const audio = s?.audioSec ?? 0;
    return {
      v,
      s,
      audio,
      todayMin: s?.days[today()]?.audioSec ?? 0,
      okRate: s && s.requests ? s.ok / s.requests : null,
      // segundos de processamento por minuto de áudio
      speed: s && audio > 0 ? s.ms / 1000 / (audio / 60) : null,
      // caracteres de texto por minuto de áudio (o que as cotas por caractere contam)
      charsPerMin: s && audio > 0 ? s.chars / (audio / 60) : null,
      // pedidos por minuto de áudio (o que as cotas por pedido contam, ex.: Gemini)
      reqPerMin: s && audio > 0 ? s.ok / (audio / 60) : null,
    };
  });
  const used = rows.filter((r) => r.audio > 0);
  const best = <K extends 'speed' | 'okRate' | 'audio'>(k: K, lower: boolean) =>
    used.filter((r) => r[k] != null).sort((a, b) => ((a[k] as number) - (b[k] as number)) * (lower ? 1 : -1))[0]?.v.id;
  const fastest = best('speed', true);
  const reliable = best('okRate', false);
  const most = best('audio', false);
  // econômica = a que rende mais áudio por unidade de cota do seu provedor (pedido no Gemini, caractere nos outros)
  const cheapest = used.filter((r) => r.v.provider !== 'edge' && r.v.provider !== 'gtts').sort((a, b) => (a.v.provider === 'gemini' ? a.reqPerMin! / 10 : a.charsPerMin! / 1000) - (b.v.provider === 'gemini' ? b.reqPerMin! / 10 : b.charsPerMin! / 1000))[0]?.v.id;
  const badge = (id: string) =>
    [id === most && 'mais usada', id === fastest && 'mais rápida', id === reliable && 'mais confiável', id === cheapest && 'mais econômica'].filter(Boolean) as string[];

  return (
    <section className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">Vozes (narração)</h2>
        <span className="text-xs text-muted-foreground">
          Fila de reserva: {d.chain.map((id) => d.voices.find((v) => v.id === id)?.name ?? id).join(' → ')}. Quando uma acaba a cota, a próxima continua do ponto onde parou.
        </span>
      </div>
      <div className="max-h-[60vh] overflow-auto rounded border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {['Voz', 'Provedor', 'Narrado (min)', 'Hoje (min)', 'Pedidos', 'Sucesso', 'Sem cota', 'Caract./min áudio', 'Processa (s por min)', 'Plano grátis', 'Destaque'].map((h) => (
                <th key={h} className="px-2 py-1 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.v.id} className="border-t" title={r.s?.lastError ? `Último erro: ${r.s.lastError}` : r.v.note}>
                <td className="whitespace-nowrap px-2 py-1 font-medium">{r.v.name}</td>
                <td className="whitespace-nowrap px-2 py-1">{PROVIDER[r.v.provider]?.label ?? r.v.provider}</td>
                <td className="px-2 py-1 tabular-nums">{min(r.audio)}</td>
                <td className="px-2 py-1 tabular-nums">{min(r.todayMin)}</td>
                <td className="px-2 py-1 tabular-nums">{r.s?.requests ?? 0}</td>
                <td className="px-2 py-1 tabular-nums">{r.okRate == null ? '—' : `${Math.round(r.okRate * 100)}%`}</td>
                <td className="px-2 py-1 tabular-nums">{r.s?.quotaHits ?? 0}</td>
                <td className="px-2 py-1 tabular-nums">{r.charsPerMin == null ? '—' : Math.round(r.charsPerMin)}</td>
                <td className="px-2 py-1 tabular-nums">{r.speed == null ? '—' : r.speed.toFixed(1)}</td>
                <td className="px-2 py-1 text-muted-foreground">{PROVIDER[r.v.provider]?.free ?? ''}</td>
                <td className="whitespace-nowrap px-2 py-1">
                  {badge(r.v.id).map((b) => (
                    <span key={b} className="mr-1 rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                      {b}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Os números entram a cada narração gerada (áudios já guardados não contam de novo). "Caract./min" é o que os planos por caractere (ElevenLabs, Fish) cobram por minuto de vídeo; o Gemini conta por pedido. Passe o mouse numa linha para ver o último erro.
      </p>
    </section>
  );
}
