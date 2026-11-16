'use client';
// Rolagem que segue o fim: se o usuário está encostado embaixo, novas linhas descem junto;
// se rolou pra cima (lendo o histórico), não mexe.
import { useLayoutEffect, useRef } from 'react';

export function useStickBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    };
    // dentro de <details> fechado não há altura; ao abrir, vai pro fim
    const det = el.closest('details');
    const onToggle = () => {
      if (det?.open && atBottom.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    det?.addEventListener('toggle', onToggle);
    return () => {
      el.removeEventListener('scroll', onScroll);
      det?.removeEventListener('toggle', onToggle);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  return ref;
}
