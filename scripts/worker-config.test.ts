import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The file is JSONC: drop whole-line comments and trailing commas, then parse.
const text = readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8')
  .replace(/^\s*\/\/.*$/gmu, '')
  .replace(/,(\s*[}\]])/gu, '$1');
const config = JSON.parse(text) as {
  workers_dev?: boolean;
  assets?: { run_worker_first?: unknown; not_found_handling?: string };
};

describe('worker config', () => {
  it('routes every request through the Worker so headers and redirects always apply', () => {
    expect(config.assets?.run_worker_first).toBe(true);
  });

  it('is not served from a workers.dev address', () => {
    expect(config.workers_dev).toBe(false);
  });
});
