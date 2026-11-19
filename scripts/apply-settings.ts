// Aplica config/app-settings.json (configurações de IA e de render exportadas do database.db) no banco desta máquina
// (../videos/data/database.db). Use depois de instalar numa máquina nova: npm run settings
import fs from 'node:fs';
import path from 'node:path';

process.env.CLIPPER_ROOT ??= path.resolve(process.cwd(), '../videos');
const { saveAppSettings } = await import('@clipper/shared/server');
const file = path.join(process.cwd(), 'config', 'app-settings.json');
const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const saved = saveAppSettings(settings);
console.log(`Configurações aplicadas (${Object.keys(settings).length}): IA = ${saved.aiProvider}, claude-code = ${(saved as unknown as Record<string, unknown>).claudeCodeModel}`);
