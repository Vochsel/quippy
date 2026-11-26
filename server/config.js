// Node runtime configuration: loads `.env`, then builds the shared config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../core/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  ...buildConfig(process.env),
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.QUIPPY_DATA_DIR || path.join(ROOT, 'data'),
};

fs.mkdirSync(config.dataDir, { recursive: true });
