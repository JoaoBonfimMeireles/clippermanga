'use client';
import { useEffect } from 'react';

/** Qualquer erro de tela (pacote que não carregou, resposta cortada do servidor em dev) tenta de novo sozinho uma vez antes de mostrar o erro. */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    let tried = false;
    try {
      tried = sessionStorage.getItem('erro-retry') === location.href;
      sessionStorage.setItem('erro-retry', tried ? '' : location.href);
    } catch {}
    if (tried) return;
    const t = setTimeout(() => location.reload(), 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="mx-auto max-w-xl space-y-3 p-6">
      <p className="font-medium">A tela falhou ao carregar. Tentando de novo sozinho…</p>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <button className="btn" onClick={() => location.reload()}>Recarregar</button>
      <button className="btn" onClick={reset}>Tentar sem recarregar</button>
    </div>
  );
}
