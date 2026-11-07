import { describe, expect, it } from 'vitest';
import DataPassport from '../components/DataPassport.astro';
import { getAgents, label } from './content';
import { readCredits } from './credits';
import { contractSchemas } from './dist';
import { llmsFullTxt, llmsTxt } from './llms';
import { SURFACES, schemaNote, surfaceBodyProblem } from './surfaces';
import { render, textsOf } from './test-render';

describe('llms.txt', () => {
  it('passes the body check of its surface', () => {
    expect(surfaceBodyProblem('/llms.txt', llmsTxt())).toBeUndefined();
    expect(surfaceBodyProblem('/llms-full.txt', llmsFullTxt())).toBeUndefined();
  });

  it('is rejected by the surface check when the format fails', () => {
    expect(surfaceBodyProblem('/llms.txt', '## Pages\n')).toBe('no H1 on the first line');
    expect(surfaceBodyProblem('/llms.txt', '# Name\n\n## Pages\n')).toBe('no blockquote summary');
    expect(surfaceBodyProblem('/llms.txt', '# Name\n\n> Summary\n')).toBe('no H2 section');
  });

  it('registers both files once, as plain text', () => {
    for (const path of ['/llms.txt', '/llms-full.txt']) {
      expect(SURFACES.filter((s) => s.expected?.().includes(path) === true)).toHaveLength(1);
    }
  });

  it('lists no address twice', () => {
    const urls = [...llmsTxt().matchAll(/\]\((https?:[^)]+)\)/gu)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(10);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('writes no double colon and no bare placeholder in a schema line', () => {
    for (const line of llmsTxt()
      .split('\n')
      .filter((l) => l.includes('.schema.json)'))) {
      expect(line.split(': ').length, line).toBe(2);
      const outsideCode = line
        .split('`')
        .filter((_, i) => i % 2 === 0)
        .join('');
      expect(outsideCode, line).not.toMatch(/[<>]/u);
    }
  });

  it('lists each file from the surfaces registry and nothing it cannot resolve', () => {
    const body = llmsTxt();
    for (const surface of SURFACES) {
      for (const { path } of surface.listed?.() ?? []) {
        expect(body, path).toContain(`https://surgerywaits.au${path}`);
      }
    }
  });
});

describe('the lines about listed files', () => {
  it('has a note in agents.yaml for each file that a surface lists', () => {
    const { notes } = getAgents().llms;
    const listing = SURFACES.filter((surface) => surface.group !== undefined);
    expect(listing.length).toBeGreaterThan(0);
    for (const surface of listing) {
      const listed = surface.listed?.() ?? [];
      expect(listed.length, surface.id).toBeGreaterThan(0);
      for (const { id, note } of listed) {
        expect(note ?? notes[id], id).toBeTruthy();
      }
    }
  });

  it('gives each listed path its own note, and each schema the text of its description', () => {
    const seen = new Map<string, string>();
    for (const surface of SURFACES) {
      for (const { id, path, note } of surface.listed?.() ?? []) {
        const text = note ?? getAgents().llms.notes[id] ?? '';
        expect(seen.has(text), `${path} repeats the note of ${seen.get(text) ?? ''}`).toBe(false);
        seen.set(text, path);
      }
    }
    const schemas = contractSchemas();
    expect(schemas.length).toBeGreaterThan(10);
    for (const [name, schema] of schemas) {
      expect(llmsTxt(), name).toContain(
        `/contract/${name}.schema.json): ${schemaNote(name, schema)}\n`,
      );
    }
  });

  it('describes the shared definitions and the manifest as what they are', () => {
    const body = llmsTxt();
    expect(body).toContain('/contract/common.schema.json): Definitions that the other schemas');
    expect(body).toContain('The site publishes no file of this kind.');
  });

  it('keeps the plain-text file free of phrases that only hold on a web page', () => {
    const full = llmsFullTxt();
    for (const phrase of [
      'its entry above',
      'This page',
      'foot of every page',
      'under the chart',
    ]) {
      expect(full, phrase).not.toContain(phrase);
    }
  });

  it('lists the OpenAPI description with its note', () => {
    expect(llmsTxt()).toContain(
      '- [OpenAPI description](https://surgerywaits.au/data-api/openapi.json): ',
    );
  });
});

describe('the credit lines of llms-full.txt', () => {
  const credits = readCredits();
  const lines = llmsFullTxt()
    .split('\n')
    .filter((line) => line.startsWith('  - ') || /^- [^[]/u.test(line));

  it('hold no release token of ten digits', () => {
    expect(lines.length).toBeGreaterThan(credits.length);
    for (const line of lines) {
      expect(line, line).not.toMatch(/\d{10}/u);
    }
  });

  it('say what the data passport shows for each dataset', async () => {
    const html = await render(DataPassport, { sources: credits.map((c) => c.slug) });
    const shown = textsOf(html, 'dd');
    expect(shown).toHaveLength(credits.length * 6);
    const full = llmsFullTxt();
    credits.forEach((credit, i) => {
      const [title = '', publisher = '', version = '', released = '', licence = '', citation = ''] =
        shown.slice(i * 6, i * 6 + 6);
      expect(full).toContain(`- ${title}\n`);
      expect(full).toContain(
        `  - ${label('passport_publisher')}: ${publisher} (${credit.publisher.url})\n`,
      );
      expect(full).toContain(`  - ${label('passport_version')}: ${version}\n`);
      expect(full).toContain(`  - ${label('passport_released')}: ${released}\n`);
      expect(full).toContain(`  - ${label('passport_licence')}: ${licence}\n`);
      expect(full).toContain(`  - ${label('passport_citation')}: ${citation}\n`);
    });
  });
});
