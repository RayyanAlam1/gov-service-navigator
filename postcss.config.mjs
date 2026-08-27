import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tailwind's config and its `content` globs are resolved relative to
 * `process.cwd()`, not to this file. That silently produces a stylesheet with
 * no utilities whenever the process is started from anywhere other than the
 * project root — a container entrypoint, a monorepo task runner, or an editor
 * launching the dev server from a parent folder.
 *
 * Pointing at the config by absolute path removes that dependency. The config
 * itself does the same for its `content` globs.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(here, 'tailwind.config.ts') },
    autoprefixer: {},
  },
};
