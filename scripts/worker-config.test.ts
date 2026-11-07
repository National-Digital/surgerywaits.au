import { readFileSync } from 'node:fs';
import { type ParseError, parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

// The file is JSONC, so a real parser handles comments in strings and trailing commas.
const text = readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8');
const errors: ParseError[] = [];
const config = parse(text, errors, { allowTrailingComma: true }) as {
  workers_dev?: boolean;
  assets?: { run_worker_first?: unknown; not_found_handling?: string };
};

describe('worker config', () => {
  it('parses without an error', () => {
    expect(errors).toEqual([]);
  });

  it('routes every request through the Worker so headers and redirects always apply', () => {
    expect(config.assets?.run_worker_first).toBe(true);
  });

  it('is not served from a workers.dev address', () => {
    expect(config.workers_dev).toBe(false);
  });
});
