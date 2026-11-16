// Texto que vai para a voz de IA: só palavras de narrador. Sons de luta ("pá!", "boom"), risadas escritas ("haha", "kkk"),
// gritos/grunhidos e marcações de cena "(risos)", "*soco*" viram ruído estranho na voz e não contam a história.
// O roteiro é instruído a não escrever isso (lib/narrator.ts); aqui é a rede de segurança para textos já gerados ou editados à mão.

// palavras que também existem na língua ("pá", "tum", "bum", "toc"...): só saem quando vêm com "!" (aí é o som, não a palavra)
const AMBIGUAS = ['p[aá]+', 'tum+', 'bum+', 'pum+', 'toc(?:\\s+toc)*', 'crack', 'baque', 'slash', 'splash', 'zum+'];
const SONS = ['pow', 'bam+', 'boo+m+', 'crash', 'bang', 'thud', 'paf', 'plaf', 'plof', 'vush', 'whoosh', 'swoosh', 'clank', 'bzz+t?', 'gr+r+h*', 'a*r+gh+', 'hmpf', 'ugh', 'tsc', 'p[uú]f', 'ploft?', 'cabum'];
// risadas escritas: kkk, haha, hehe, rsrs, hihi, ahahah, muahaha
const RISADA = '(?:k{3,}|(?:a?ha){2,}h?|(?:he){2,}h?|(?:hi){2,}h?|(?:rs){2,}|mu+a(?:ha)+h*|ah+a+h+a*)';

const ONO_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:${SONS.join('|')}|${RISADA})(?![\\p{L}\\p{N}])[!?.…]*|(?:${AMBIGUAS.join('|')})!+)`, 'giu');
const DIRECAO_RE = /\([^)]{0,60}\)|\[[^\]]{0,60}\]|\*[^*]{0,60}\*/g;
const MARCA = '\u0001';

export function cleanSpeechText(text: string): string {
  let t = text.replace(DIRECAO_RE, MARCA).replace(ONO_RE, MARCA);
  t = t.replace(new RegExp(`\\s*:\\s*${MARCA}`, 'g'), '.').replace(new RegExp(MARCA, 'g'), ' ');
  t = t
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/(^|[.!?…]\s*)[,;:]\s*/g, '$1') // vírgula que sobrou no começo da frase
    .replace(/,\s*([.!?…])/g, '$1')
    .replace(/([,;:])\s*\1+/g, '$1')
    .replace(/,\s*$/, '.')
    .trim();
  return t.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}
