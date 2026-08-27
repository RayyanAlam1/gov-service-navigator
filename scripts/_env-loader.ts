/**
 * Env loading for CLI scripts.
 *
 * Next.js loads .env files itself for the app; standalone scripts (migrate,
 * seed, ingest, eval) do not get that for free. Node 20.6+ has `--env-file`
 * but it takes a single path and fails hard on a missing file, so this does
 * the same layered resolution Next uses, without adding a dotenv dependency.
 *
 * Precedence (later does NOT override earlier — first definition wins, which
 * matches Next and means a real shell variable always beats a file):
 *   process.env  >  .env.local  >  .env.<NODE_ENV>  >  .env
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes, honouring escapes only inside double quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values end at an inline comment.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFiles(cwd: string = process.cwd()): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const candidates = ['.env.local', `.env.${nodeEnv}`, '.env'];

  for (const file of candidates) {
    const full = path.resolve(cwd, file);
    if (!existsSync(full)) continue;
    const values = parseEnvFile(readFileSync(full, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
