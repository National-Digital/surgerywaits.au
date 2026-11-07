import {
  ALLOW_ANY_ORIGIN,
  DATA_API_HEADERS,
  DATA_CACHE_CONTROL,
  JSON_CONTENT_TYPE,
  MISSING_CACHE_CONTROL,
} from '../../../worker/headers';
import { contractSchemas, FOLDERS, ROOT_FILES } from './dist';
import type { SchemaName } from './dist';
import { SITE } from './robots';

export const OPENAPI_PATH = '/data-api/openapi.json';

type Json = Record<string, unknown>;

const schemaNamed = (name: string): Json => {
  const found = contractSchemas().find(([n]) => n === name)?.[1];
  if (found === undefined) {
    throw new Error(`no schema named ${name} in contract/`);
  }
  return found as Json;
};

// A pattern or enum comes from the schema that owns it, so the two cannot disagree.
const definition = (name: string): Json =>
  (schemaNamed('common')['$defs'] as Record<string, Json>)[name] ?? {};

const schemaUrl = (name: SchemaName): string => {
  const id = schemaNamed(name)['$id'];
  if (typeof id !== 'string') {
    throw new Error(`${name} has no $id`);
  }
  return id;
};

const PARAMETERS: Record<string, Json> = {
  slug: {
    name: 'slug',
    in: 'path',
    required: true,
    description: "The slug in the file's address.",
    schema: { type: 'string', pattern: definition('slug')['pattern'] },
  },
  code: {
    name: 'code',
    in: 'path',
    required: true,
    description: "The publisher's code for the hospital, as the Queensland list gives it.",
    schema: { type: 'string', pattern: definition('code')['pattern'] },
  },
  kind: {
    name: 'kind',
    in: 'path',
    required: true,
    description: 'Which publisher table the category comes from.',
    schema: { type: 'string', enum: definition('kind')['enum'] },
  },
};

const HEADERS: Record<string, Json> = {
  AccessControlAllowOrigin: {
    description: 'Any origin may read the file from a page.',
    schema: { type: 'string', const: ALLOW_ANY_ORIGIN['Access-Control-Allow-Origin'] },
  },
  XRobotsTag: {
    description: 'Search engines are told not to index the file.',
    schema: { type: 'string', const: DATA_API_HEADERS['X-Robots-Tag'] },
  },
  CacheControlFile: {
    description: 'A browser or cache may keep the file for an hour.',
    schema: { type: 'string', const: DATA_CACHE_CONTROL },
  },
  CacheControlMissing: {
    description: 'A missing file is never cached.',
    schema: { type: 'string', const: MISSING_CACHE_CONTROL },
  },
};

const contentTypeHeader: Json = {
  description: 'The body is JSON in UTF-8.',
  schema: { type: 'string', const: JSON_CONTENT_TYPE },
};

const ref = (kind: string, name: string): Json => ({ $ref: `#/components/${kind}/${name}` });

const sharedHeaders = (cache: string): Json => ({
  'Access-Control-Allow-Origin': ref('headers', 'AccessControlAllowOrigin'),
  'X-Robots-Tag': ref('headers', 'XRobotsTag'),
  'Cache-Control': ref('headers', cache),
});

function operation(
  name: SchemaName,
  id: string,
  summary: string,
  head: boolean,
  params: Json[],
): Json {
  const found = head
    ? {
        description: 'The headers of the file, with no body.',
        headers: sharedHeaders('CacheControlFile'),
      }
    : {
        description: 'The file, which is valid against the schema its family has in /contract/.',
        headers: { ...sharedHeaders('CacheControlFile'), 'Content-Type': contentTypeHeader },
        content: {
          'application/json': { schema: { $ref: schemaUrl(name) } },
        },
      };
  return {
    operationId: id,
    summary,
    ...(params.length > 0 ? { parameters: params } : {}),
    responses: {
      '200': found,
      '404': head ? ref('responses', 'NotFoundHead') : ref('responses', 'NotFound'),
    },
  };
}

const pascal = (text: string): string =>
  text.replace(/(?:^|-)(\w)/gu, (_, letter: string) => letter.toUpperCase());

const label = (name: string): string => name.replaceAll('-', ' ');

interface Family {
  path: string;
  schema: SchemaName;
  id: string;
  summary: string;
  params: Json[];
}

// One family for each root file and each folder, read from the tables that route a file to its schema.
function families(): Family[] {
  const rootFamilies = Object.entries(ROOT_FILES).map(([file, schema]) => {
    const stem = file.slice(0, -'.json'.length);
    return {
      path: `/data-api/${file}`,
      schema,
      id: pascal(stem),
      summary: `The ${label(stem)} file`,
      params: [],
    };
  });
  const folderFamilies = Object.entries(FOLDERS).map(([folder, schema]) => {
    const nested = folder === 'surgeries';
    const key = folder === 'queensland' ? 'code' : 'slug';
    return {
      path: `/data-api/${folder}/${nested ? '{kind}/' : ''}{${key}}.json`,
      schema,
      id: `${pascal(schema)}File`,
      summary: `One file of the ${label(folder)} folder`,
      params: [ref('parameters', 'kind'), ref('parameters', key)].slice(nested ? 0 : 1),
    };
  });
  return [...rootFamilies, ...folderFamilies].sort((a, b) => (a.path < b.path ? -1 : 1));
}

// A new file family in dist.ts reaches the description with no edit here.
export function openApiDocument(): Json {
  const paths: Json = {};
  for (const family of families()) {
    paths[family.path] = {
      get: operation(family.schema, `get${family.id}`, family.summary, false, family.params),
      head: operation(family.schema, `head${family.id}`, family.summary, true, family.params),
    };
  }
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Surgery Waits data files',
      version: '1',
      summary: 'The JSON files behind the Surgery Waits pages.',
      description: [
        'Each path is one family of file under /data-api/.',
        'Each response is valid against the JSON Schema for its family, published at the address its $id names.',
        'The Worker lets any origin read the files and answers a preflight request with 204, the methods GET, HEAD and OPTIONS, and no body.',
        'It sends X-Robots-Tag: noindex on every answer under /data-api/, and lets a browser keep a file for an hour.',
        'A missing file returns 404 with a JSON body and is never cached.',
        'The credits file gives the publisher, licence and citation for each source of the data.',
      ].join(' '),
    },
    servers: [{ url: SITE }],
    paths,
    components: {
      headers: HEADERS,
      parameters: PARAMETERS,
      schemas: {
        Error: {
          type: 'object',
          additionalProperties: false,
          required: ['error'],
          properties: { error: { type: 'string', const: 'not found' } },
        },
      },
      responses: {
        NotFound: {
          description: 'No such file. The Worker answers with JSON in place of the site page.',
          headers: sharedHeaders('CacheControlMissing'),
          content: {
            'application/json': { schema: ref('schemas', 'Error') },
          },
        },
        NotFoundHead: {
          description: 'No such file. A HEAD request has no body.',
          headers: sharedHeaders('CacheControlMissing'),
        },
      },
    },
  };
}

interface OperationShape {
  parameters?: { $ref: string }[];
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
}

interface ParameterShape {
  name: string;
  schema: { pattern?: string; enum?: string[] };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Where a published file and the description part: a file with no path, a path with no file, a body its path's schema refuses.
export function openApiDisagreements(
  document: Json,
  files: readonly { path: string; body: unknown }[],
  ajv: { getSchema: (id: string) => ((data: unknown) => boolean) | undefined },
): string[] {
  const problems: string[] = [];
  const paths = document['paths'] as Record<string, { get?: OperationShape }>;
  const matchers = Object.entries(paths).map(([template, item]) => {
    const names: string[] = [];
    const source = escapeRegExp(template).replace(/\\\{(\w+)\\\}/gu, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    return { template, names, item, pattern: new RegExp(`^${source}$`, 'u') };
  });
  const parameters = (document['components'] as { parameters: Record<string, ParameterShape> })
    .parameters;
  const used = new Set<string>();
  for (const { path, body } of files) {
    const hits = matchers.filter((m) => m.pattern.test(path));
    if (hits.length === 0) {
      problems.push(`${path} has no path in the description`);
    }
    for (const hit of hits) {
      used.add(hit.template);
      const values = hit.pattern.exec(path)?.slice(1) ?? [];
      for (const [index, name] of hit.names.entries()) {
        const declared = hit.item.get?.parameters
          ?.map((p) => parameters[p.$ref.slice('#/components/parameters/'.length)])
          .find((p) => p?.name === name);
        const value = values[index] ?? '';
        const { pattern, enum: allowed } = declared?.schema ?? {};
        const fits =
          declared !== undefined &&
          (pattern === undefined || new RegExp(pattern, 'u').test(value)) &&
          (allowed === undefined || allowed.includes(value));
        if (!fits) {
          problems.push(`${path} has a ${name} that the description does not allow`);
        }
      }
      const target = hit.item.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
      const validate = target === undefined ? undefined : ajv.getSchema(target);
      if (validate === undefined) {
        problems.push(`${hit.template} names no schema that exists`);
      } else if (!validate(body)) {
        problems.push(`${path} breaks ${target ?? ''}`);
      }
    }
  }
  for (const { template } of matchers) {
    if (!used.has(template)) {
      problems.push(`${template} matches no file`);
    }
  }
  return problems;
}
