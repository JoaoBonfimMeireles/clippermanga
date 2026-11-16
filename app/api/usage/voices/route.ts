// GET /api/usage/voices → uso registrado de cada voz (TTS) + catálogo (provedor, observação de cota).
import { readVoiceUsage } from '@/lib/voice-usage';
import { VOICE_CHAIN, VOICES } from '@/lib/voices';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { usage: readVoiceUsage(), voices: VOICES.filter((v) => !v.hidden).map(({ id, name, provider, note }) => ({ id, name, provider, note })), chain: VOICE_CHAIN },
    { headers: { 'cache-control': 'no-store, private' } },
  );
}
