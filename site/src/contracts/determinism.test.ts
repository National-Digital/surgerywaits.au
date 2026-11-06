import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const root = new URL('../../../', import.meta.url);
const dist = new URL('site/dist/', root);

function checksums(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dist, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath}/${entry.name}`)
      .sort()
      .map((file) => [
        file.slice(dist.pathname.length - 1),
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      ]),
  );
}

// Needs `npm run build` first, and builds again, so only the build jobs run it, with BUILD_TWICE=1.
describe('Determinism', () => {
  it('building the site twice gives byte-identical output', () => {
    expect(existsSync(dist), 'run `npm run build` before BUILD_TWICE=1 npm test').toBe(true);
    const first = checksums();
    expect(Object.keys(first).length).toBeGreaterThan(0);
    const build = spawnSync('npm', ['run', '--silent', 'build'], {
      cwd: root,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      // The build logs one line per page; keeping stdout would overflow the buffer.
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(build.error).toBeUndefined();
    expect(build.status, build.stderr).toBe(0);
    expect(checksums()).toEqual(first);
  }, 300_000);
});
