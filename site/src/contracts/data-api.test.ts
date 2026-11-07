import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { canonicalJson, dataApiPaths } from '../lib/data-api';
import { contractSchemas, distDirectory, schemaFor } from '../lib/dist';
import { stateChartFiles } from '../lib/state-chart';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const read = (file: string): string => readFileSync(new URL(file, dist), 'utf8');
const built = (folder: string, ending: string): string[] =>
  readdirSync(new URL(folder, dist), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(ending))
    .sort();

describe('the built data files', () => {
  const paths = dataApiPaths();

  it('holds exactly the files of the dist, none else', () => {
    expect(built('data-api/', '.json').filter((file) => file !== 'openapi.json')).toEqual(paths);
  });

  it('publishes each file with the same content as the dist file, keys sorted', () => {
    for (const path of paths) {
      const raw: unknown = JSON.parse(readFileSync(`${distDirectory()}/${path}`, 'utf8'));
      const published = read(`data-api/${path}`);
      expect(JSON.parse(published) as unknown, path).toEqual(raw);
      expect(published, path).toBe(canonicalJson(JSON.parse(published)));
    }
  });

  it('publishes the schemas under the addresses their ids name', () => {
    const published = built('contract/', '.schema.json');
    expect(published).toEqual(
      contractSchemas()
        .map(([name]) => `${name}.schema.json`)
        .sort(),
    );
    for (const [name, schema] of contractSchemas()) {
      expect((JSON.parse(read(`contract/${name}.schema.json`)) as { $id: string }).$id).toBe(
        `https://surgerywaits.au/contract/${name}.schema.json`,
      );
      expect(read(`contract/${name}.schema.json`), name).toBe(canonicalJson(schema));
    }
  });

  it('validates every published file against the published schema for its family', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    for (const file of built('contract/', '.schema.json')) {
      ajv.addSchema(JSON.parse(read(`contract/${file}`)) as object);
    }
    for (const path of paths) {
      const validate = ajv.getSchema(
        `https://surgerywaits.au/contract/${schemaFor(path)}.schema.json`,
      );
      expect(validate, path).toBeDefined();
      const ok = validate?.(JSON.parse(read(`data-api/${path}`))) === true;
      expect(ok ? [] : validate?.errors, path).toEqual([]);
    }
  });

  it('keeps the data files, the schemas and the charts out of every sitemap', () => {
    const sitemaps = readdirSync(dist).filter((file) => /^sitemap.*\.xml$/u.test(file));
    expect(sitemaps.length).toBeGreaterThan(0);
    for (const file of sitemaps) {
      expect(read(file), file).not.toMatch(/\/(data-api|contract|charts)\//u);
    }
  });

  it('publishes one chart for each procedure with a state comparison', () => {
    const files = stateChartFiles();
    expect(built('charts/', '.svg')).toEqual(files.map((f) => `${f.slug}.svg`).sort());
    for (const { slug, svg } of files) {
      expect(read(`charts/${slug}.svg`), slug).toBe(svg);
    }
  });
});
