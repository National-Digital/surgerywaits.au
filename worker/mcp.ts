import { SITE } from '../site/src/lib/robots';
import {
  argumentProblem,
  compareHospitals,
  explainUrgency,
  getWait,
  inputSchema,
  listProcedures,
  SPECS,
  ToolProblem,
} from './mcp-tools';
import type { Reader } from './mcp-tools';

export const MCP_PATH = '/mcp';
export const MCP_CARD_PATH = '/mcp/server-card';
const MCP_CARD_TYPE = 'application/mcp-server-card+json';

// The current revision, then the handshake revisions a client may still speak.
export const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18'];
export const PROTOCOL_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];

// Browser pages that may call the route, by exact origin. A request with no Origin is not a browser's.
export const BROWSER_ORIGINS: readonly string[] = [
  SITE,
  'https://claude.ai',
  'https://chatgpt.com',
];
export const MAX_BODY_BYTES = 16_384;

// The deploy sets SURGERYWAITS_RELEASE to the release number; anything else reads as a local run.
export const DEV_RELEASE = '0.0.0-dev';
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
interface Released {
  SURGERYWAITS_RELEASE?: string;
  SURGERYWAITS_COMMIT?: string;
}
// The Worker's Env type does not declare the two variables, which only a deploy sets.
export function releaseOf(env?: object): string {
  const value = (env as Released | undefined)?.SURGERYWAITS_RELEASE;
  return value !== undefined && RELEASE.test(value) ? value : DEV_RELEASE;
}

// The header names the release and the full commit it was built from, and is left off a local run.
export function releaseHeader(env?: object): string | null {
  const commit = (env as Released | undefined)?.SURGERYWAITS_COMMIT;
  const release = releaseOf(env);
  return release === DEV_RELEASE || commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)
    ? null
    : `v${release} (${commit})`;
}

const SERVER = {
  name: 'au.surgerywaits/mcp',
  title: 'SurgeryWaits',
  description:
    'Published planned surgery waiting times at Australian public hospitals, by hospital and state.',
};
const INSTRUCTIONS = [
  `Read-only published waiting times for planned surgery at Australian public hospitals, from SurgeryWaits (${SITE}).`,
  'Where an answer carries figures, quote each with its period, the release date and the credit the answer gives.',
  'Where a figure is not published, say so with its reason. It is not zero.',
  'Hospitals are ordered by one published median only. That is not a judgement of quality and is not clinical advice.',
  'Private hospitals are not included.',
].join(' ');

export const TOOLS = [
  {
    name: 'surgerywaits_get_wait',
    title: 'Get the wait for a surgery',
    description:
      'The published median wait, the share who waited more than 365 days and the number of surgeries for one surgery, at one public hospital, in one state, or across Australia (give neither). Each figure carries its period and release date. A withheld figure comes back as not published with its reason and no number.',
  },
  {
    name: 'surgerywaits_compare_hospitals',
    title: 'Compare hospitals near a place',
    description:
      'Public hospitals within a distance of an Australian suburb or town, ordered by published median wait for one surgery, shortest first. Hospitals with a withheld or unreported figure, or that have closed, are listed apart and not ranked.',
  },
  {
    name: 'surgerywaits_list_procedures',
    title: 'Find a surgery by name',
    description:
      'The surgeries that have published waiting times, with the slug each other tool takes. Give words from the name, or leave the query out for the full list.',
  },
  {
    name: 'surgerywaits_explain_urgency',
    title: 'Explain an urgency category',
    description:
      'What urgency category 1, 2 or 3 means for planned surgery, the recommended time for it, and who decides it.',
  },
].map((tool) => ({
  ...tool,
  inputSchema: inputSchema(
    Object.entries(SPECS).find(([name]) => name === tool.name)?.[1] ?? {
      properties: {},
      required: [],
    },
  ),
  annotations: {
    title: tool.title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}));

type Runner = (read: Reader, args: never) => Promise<unknown>;
const RUN: Record<string, Runner> = {
  surgerywaits_get_wait: getWait,
  surgerywaits_compare_hospitals: compareHospitals,
  surgerywaits_list_procedures: listProcedures,
  surgerywaits_explain_urgency: explainUrgency,
};

const NOINDEX = { 'X-Robots-Tag': 'noindex' };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...NOINDEX };

const ERR = {
  parse: -32700,
  request: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
  header: -32020,
  version: -32022,
} as const;

type Id = string | number | null;

function rpcError(
  status: number,
  id: Id,
  code: number,
  message: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }),
    { status, headers: { ...JSON_HEADERS, ...headers } },
  );
}

function cors(origin: string | null): Record<string, string> {
  if (origin === null) {
    return { Vary: 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'Retry-After',
    Vary: 'Origin',
  };
}

// The words a log line may hold. Anything a caller typed that is not on a list becomes "other".
const LOG_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
  'notifications/initialized',
]);
const LOG_TOOLS: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));
const LOG_HTTP: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'OPTIONS', 'DELETE', 'PUT']);

interface UsageLine {
  event: 'mcp';
  http: string;
  status: number;
  protocol: string;
  method: string;
  tool: string | null;
  outcome: 'ok' | 'tool_error' | 'rpc_error' | 'refused';
  code?: number;
}

function usageLine(
  request: Request,
  response: Response,
  call: { method?: unknown; tool?: unknown; outcome: UsageLine['outcome']; code?: number },
): UsageLine {
  const version = request.headers.get('mcp-protocol-version') ?? '';
  const method =
    typeof call.method === 'string' && LOG_METHODS.has(call.method) ? call.method : 'other';
  return {
    event: 'mcp',
    http: LOG_HTTP.has(request.method) ? request.method : 'other',
    status: response.status,
    protocol: PROTOCOL_VERSIONS.includes(version) ? version : 'other',
    method,
    tool:
      method === 'tools/call'
        ? typeof call.tool === 'string' && LOG_TOOLS.has(call.tool)
          ? call.tool
          : 'other'
        : null,
    outcome: call.outcome,
    ...(call.code === undefined ? {} : { code: call.code }),
  };
}

function log(line: UsageLine): void {
  try {
    // The one place the Worker writes a log line, and every field of it is from a fixed list.
    // eslint-disable-next-line no-console -- the log line is the one output, and every field is from a fixed list
    console.log(JSON.stringify(line));
  } catch {
    // A log line is not worth a failed answer.
  }
}

// The body as text, or null past the limit, without reading more than the limit allows.
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return null;
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const next = await reader?.read();
    if (next === undefined || next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader?.cancel();
      return null;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Parsed data files by path, held only once settled, so no request waits on another's fetch.
const parsed = new Map<string, unknown>();
export const clearDataCache = (): void => {
  parsed.clear();
};

function readerFor(env: Env, request: Request): Reader {
  const origin = new URL(request.url).origin;
  // A file asked for twice in one request is fetched once.
  const pending = new Map<string, Promise<unknown>>();
  return (path) => {
    if (!/^\/data-api\/[a-z0-9/-]+\.json$/u.test(path)) {
      throw new RangeError(`not a data file: ${path}`);
    }
    if (parsed.has(path)) {
      return Promise.resolve(parsed.get(path));
    }
    const inFlight = pending.get(path);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const found = env.ASSETS.fetch(new Request(`${origin}${path}`)).then(async (response) => {
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`data file ${path} answered ${String(response.status)}`);
      }
      const value: unknown = await response.json();
      // A missing or failed file is asked for again next time.
      parsed.set(path, value);
      return value;
    });
    pending.set(path, found);
    return found;
  };
}

const serverInfo = (env?: object): { name: string; title: string; version: string } => ({
  name: SERVER.name,
  title: SERVER.title,
  version: releaseOf(env),
});

// The spec sends a header value that is not plain ASCII as =?base64?...?=.
function decodeHeaderValue(value: string | null): string | null {
  const match = value === null ? null : /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u.exec(value);
  if (match === null || value === null) {
    return value;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(match[1] ?? ''), (char) => char.charCodeAt(0)),
    );
  } catch {
    return value;
  }
}

function modern<T extends Record<string, unknown>>(result: T, listed = false): T {
  return {
    resultType: 'complete',
    ...result,
    ...(listed ? { ttlMs: 3_600_000, cacheScope: 'public' } : {}),
  };
}

interface Done {
  response: Response;
  outcome: UsageLine['outcome'];
  code?: number;
  tool?: unknown;
}
interface Served {
  response: Response;
  call: Parameters<typeof usageLine>[2];
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  id: Id,
  isModern: boolean,
  read: Reader,
  info: ReturnType<typeof serverInfo>,
): Promise<Done> {
  const ok = (
    result: Record<string, unknown>,
    outcome: UsageLine['outcome'] = 'ok',
    tool?: unknown,
  ): Done => ({
    response: new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: isModern
          ? {
              ...result,
              _meta: {
                ...(isObject(result['_meta']) ? result['_meta'] : {}),
                'io.modelcontextprotocol/serverInfo': info,
              },
            }
          : result,
      }),
      { headers: JSON_HEADERS },
    ),
    outcome,
    tool,
  });
  const fail = (status: number, code: number, message: string, tool?: unknown): Done => ({
    response: rpcError(status, id, code, message),
    outcome: 'rpc_error' as const,
    code,
    tool,
  });
  switch (method) {
    case 'ping':
      return ok({});
    case 'initialize': {
      const asked = params['protocolVersion'];
      return ok({
        protocolVersion:
          typeof asked === 'string' && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
        instructions: INSTRUCTIONS,
      });
    }
    case 'server/discover':
      return isModern
        ? ok(
            modern(
              {
                supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
                capabilities: { tools: { listChanged: false } },
                instructions: INSTRUCTIONS,
              },
              true,
            ),
          )
        : fail(200, ERR.method, 'Method not found');
    case 'tools/list':
      return ok(isModern ? modern({ tools: TOOLS }, true) : { tools: TOOLS });
    case 'tools/call': {
      const name = params['name'];
      const spec = typeof name === 'string' && Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
      if (typeof name !== 'string' || spec === undefined) {
        return fail(200, ERR.params, 'Unknown tool', name);
      }
      const args = params['arguments'] ?? {};
      const problem = argumentProblem(spec, args);
      if (problem !== undefined) {
        return fail(200, ERR.params, `Invalid arguments: ${problem}`, name);
      }
      try {
        const answer = await (
          RUN[name] ?? ((): Promise<never> => Promise.reject(new Error('no runner')))
        )(read, args as never);
        const text = JSON.stringify(answer, null, 2);
        return ok(
          isModern
            ? modern({ content: [{ type: 'text', text }] })
            : { content: [{ type: 'text', text }] },
          'ok',
          name,
        );
      } catch (error) {
        if (!(error instanceof ToolProblem)) {
          return { ...fail(200, ERR.internal, 'The server could not answer just now.', name) };
        }
        const text = JSON.stringify({
          problem: error.message,
          ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
        });
        return ok(
          {
            ...(isModern ? { resultType: 'complete' } : {}),
            isError: true,
            content: [{ type: 'text', text }],
          },
          'tool_error',
          name,
        );
      }
    }
    default:
      return fail(isModern ? 404 : 200, ERR.method, 'Method not found');
  }
}

async function serve(request: Request, env: Env, origin: string | null): Promise<Served> {
  const extra = cors(origin);
  const withCors = (response: Response): Response => {
    for (const [name, value] of Object.entries(extra)) {
      response.headers.set(name, value);
    }
    return response;
  };
  const refuse = (response: Response, code?: number): Served => ({
    response: withCors(response),
    call: { outcome: 'refused' as const, ...(code === undefined ? {} : { code }) },
  });
  const text = await readBody(request);
  if (text === null) {
    return refuse(rpcError(413, null, ERR.request, 'The request body is too large.'), ERR.request);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(rpcError(400, null, ERR.parse, 'The body is not JSON.'), ERR.parse);
  }
  if (!isObject(body) || body['jsonrpc'] !== '2.0' || typeof body['method'] !== 'string') {
    return refuse(
      rpcError(400, null, ERR.request, 'The body is not one JSON-RPC request.'),
      ERR.request,
    );
  }
  const rawId = body['id'];
  const hasId = Object.hasOwn(body, 'id');
  if (hasId && typeof rawId !== 'string' && typeof rawId !== 'number') {
    return refuse(
      rpcError(400, null, ERR.request, 'The id is not a string or a number.'),
      ERR.request,
    );
  }
  const id: Id = hasId ? (rawId as string | number) : null;
  const method = body['method'];
  const params = isObject(body['params']) ? body['params'] : {};
  if (body['params'] !== undefined && !isObject(body['params'])) {
    return refuse(rpcError(400, id, ERR.request, 'The params are not an object.'), ERR.request);
  }

  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !PROTOCOL_VERSIONS.includes(version)) {
    return {
      response: withCors(
        rpcError(400, id, ERR.version, 'Unsupported protocol version', {
          supported: PROTOCOL_VERSIONS,
          requested: version.slice(0, 40),
        }),
      ),
      call: { method, outcome: 'rpc_error' as const, code: ERR.version },
    };
  }
  const isModern = version === MODERN_VERSION;
  if (version === null && method !== 'initialize') {
    return {
      response: withCors(
        rpcError(400, id, ERR.header, 'The MCP-Protocol-Version header is required.'),
      ),
      call: { method, outcome: 'rpc_error' as const, code: ERR.header },
    };
  }
  // The spec sets no header rules for a notification, so none are checked.
  if (!hasId) {
    return {
      response: withCors(new Response(null, { status: 202, headers: NOINDEX })),
      call: { method, outcome: 'ok' as const },
    };
  }
  if (isModern) {
    if (method === 'initialize') {
      return {
        response: withCors(
          rpcError(
            400,
            id,
            ERR.params,
            `initialize is not used with protocol version ${MODERN_VERSION}. Send server/discover.`,
            { supported: PROTOCOL_VERSIONS },
          ),
        ),
        call: { method, outcome: 'rpc_error' as const, code: ERR.params },
      };
    }
    const meta = isObject(params['_meta']) ? params['_meta'] : {};
    const sent = meta['io.modelcontextprotocol/protocolVersion'];
    if (typeof sent !== 'string' || !isObject(meta['io.modelcontextprotocol/clientCapabilities'])) {
      return {
        response: withCors(
          rpcError(
            400,
            id,
            ERR.params,
            'The _meta needs io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities.',
          ),
        ),
        call: { method, outcome: 'rpc_error' as const, code: ERR.params },
      };
    }
    const named = method === 'tools/call' ? params['name'] : undefined;
    const mismatch =
      sent !== MODERN_VERSION
        ? 'The _meta protocol version does not match the header.'
        : request.headers.get('mcp-method') !== method
          ? 'The Mcp-Method header does not match the body.'
          : method === 'tools/call' && decodeHeaderValue(request.headers.get('mcp-name')) !== named
            ? 'The Mcp-Name header does not match the body.'
            : undefined;
    if (mismatch !== undefined) {
      return {
        response: withCors(rpcError(400, id, ERR.header, `Header mismatch: ${mismatch}`)),
        call: { method, outcome: 'rpc_error' as const, code: ERR.header },
      };
    }
  }
  const done = await dispatch(
    method,
    params,
    id,
    isModern,
    readerFor(env, request),
    serverInfo(env),
  );
  return {
    response: withCors(done.response),
    call: {
      method,
      tool: done.tool,
      outcome: done.outcome,
      ...(done.code === undefined ? {} : { code: done.code }),
    },
  };
}

// A POST serves JSON-RPC. The spec's GET stream is gone from 2026-07-28, so GET, like anything else, is a 405.
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const allowed =
    origin === null || BROWSER_ORIGINS.includes(origin) || origin === new URL(request.url).origin;
  const finish = (
    response: Response,
    call: Parameters<typeof usageLine>[2] = { outcome: 'refused' },
  ): Response => {
    log(usageLine(request, response, call));
    return response;
  };
  if (!allowed) {
    return finish(rpcError(403, null, ERR.request, 'This origin may not call the server.'));
  }
  const extra = cors(origin);
  if (request.method === 'OPTIONS') {
    return finish(
      new Response(null, {
        status: 204,
        headers: {
          ...extra,
          ...NOINDEX,
          Allow: 'POST, OPTIONS',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
          'Access-Control-Max-Age': '86400',
        },
      }),
    );
  }
  if (request.method !== 'POST') {
    return finish(
      new Response('Method not allowed', {
        status: 405,
        headers: {
          ...extra,
          ...NOINDEX,
          Allow: 'POST, OPTIONS',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      }),
    );
  }
  try {
    const { response, call } = await serve(request, env, origin);
    return finish(response, call);
  } catch {
    return finish(
      rpcError(500, null, ERR.internal, 'The server could not answer just now.', undefined, extra),
      { outcome: 'rpc_error', code: ERR.internal },
    );
  }
}

export function serverCard(env?: object): Record<string, unknown> {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    ...SERVER,
    version: releaseOf(env),
    websiteUrl: `${SITE}/`,
    remotes: [
      {
        type: 'streamable-http',
        url: `${SITE}${MCP_PATH}`,
        supportedProtocolVersions: PROTOCOL_VERSIONS,
      },
    ],
  };
}

const CARD_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

export async function handleCard(request: Request, env?: object): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...CARD_CORS, 'Access-Control-Max-Age': '86400' },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: {
        ...CARD_CORS,
        Allow: 'GET, HEAD, OPTIONS',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
  const body = JSON.stringify(serverCard(env), null, 2);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const tag = `"${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
  const headers = { ...CARD_CORS, ...NOINDEX, ETag: tag, Vary: 'Accept' };
  if ((request.headers.get('if-none-match') ?? '').split(/\s*,\s*/u).includes(tag)) {
    return new Response(null, { status: 304, headers });
  }
  // A browser that asks for HTML gets plain JSON so it renders.
  const accept = request.headers.get('accept') ?? '';
  const type =
    accept.includes(MCP_CARD_TYPE) || !accept.includes('text/html')
      ? MCP_CARD_TYPE
      : 'application/json';
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { ...headers, 'Content-Type': `${type}; charset=utf-8` },
  });
}
