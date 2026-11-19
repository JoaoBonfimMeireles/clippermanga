// mkdir que aguenta falha momentânea do disco (no D: em exFAT, com vários renders e o antivírus, o mkdir às vezes dá ENOENT
// mesmo com a pasta-pai existindo): recria o pai e tenta de novo algumas vezes antes de desistir.
import fs from 'node:fs';
import path from 'node:path';

export async function mkdirRetry(dir: string, tries = 8): Promise<void> {
  for (let t = 1; ; t++) {
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.mkdirSync(dir, { recursive: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (t >= tries || !(code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 250 * t));
    }
  }
}
