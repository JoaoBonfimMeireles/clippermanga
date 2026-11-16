'use client';
// Escolha da voz do vídeo: cada opção tem uma amostra de ~10 s (gerada na primeira vez e guardada).
import { useRef, useState } from 'react';
import { VOICES } from '@/lib/voices';

export function VoicePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);

  const play = async (id: string) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    setError('');
    setLoading(id);
    try {
      const r = await fetch(`/api/voices?sample=${id}`);
      if (!r.ok) throw new Error(await r.text());
      const a = new Audio(URL.createObjectURL(await r.blob()));
      audio.current = a;
      a.onended = () => setPlaying(null);
      await a.play();
      setPlaying(id);
    } catch (e) {
      setError(`${VOICES.find((v) => v.id === id)?.name}: ${(e as Error).message}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-2 text-sm">
      <p className="font-medium">Voz do narrador</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {VOICES.filter((v) => !v.hidden).map((v) => (
          <div key={v.id} className={`flex items-center gap-2 rounded-md border px-2 py-1 ${value === v.id ? 'border-primary bg-primary/10' : ''}`}>
            <button className="btn px-2 py-0.5" title="Ouvir amostra (~10 s)" disabled={loading !== null} onClick={() => play(v.id)}>
              {loading === v.id ? '…' : playing === v.id ? '⏸' : '▶'}
            </button>
            <button className="min-w-0 flex-1 text-left" onClick={() => onChange(v.id)}>
              <span className="block truncate">{v.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{v.note}</span>
            </button>
            {value === v.id && <span className="text-xs text-primary">✓</span>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">A primeira amostra de cada voz leva alguns segundos para ser gerada.</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
