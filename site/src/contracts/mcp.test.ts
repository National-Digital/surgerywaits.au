import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handle } from '../../../worker/index';
import { assetsOver } from './mcp-fixture';
import {
  BROWSER_ORIGINS,
  clearDataCache,
  MAX_BODY_BYTES,
  MODERN_VERSION,
  PROTOCOL_VERSIONS,
  serverCard,
} from '../../../worker/mcp';
import { SECURITY_HEADERS } from '../../../worker/headers';
import { getPrivacy } from '../lib/content';
import { SURFACES, surfaceBodyProblem, surfaceOf } from '../lib/surfaces';

const asked: string[] = [];
const env = {
  ASSETS: assetsOver(new URL('../../../pipeline/dist-fixture/', import.meta.url), asked),
} as never;
const URL_MCP = 'https://surgerywaits.au/mcp';
const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

function rpc(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  id: number | null = 1,
): Request {
  const name = typeof params['name'] === 'string' ? { 'Mcp-Name': params['name'] } : {};
  return new Request(URL_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN_VERSION,
      'Mcp-Method': method,
      ...name,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(id === null ? {} : { id }),
      method,
      params: { _meta: meta, ...params },
    }),
  });
}
const call = (name: string, args: unknown, headers: Record<string, string> = {}): Request =>
  rpc('tools/call', { name, arguments: args }, headers);
interface Reply {
  result: {
    resultType?: string;
    protocolVersion: string;
    supportedVersions: string[];
    _meta: Record<string, { name: string }>;
    tools: {
      name: string;
      annotations: Record<string, unknown>;
      inputSchema: Record<string, unknown>;
    }[];
    content: { text: string }[];
    isError?: boolean;
  };
  error: { code: number };
  remotes: unknown[];
  description: string;
}
const json = async (response: Response): Promise<Reply> =>
  JSON.parse(await response.text()) as Reply;

beforeEach(clearDataCache);
afterEach(() => vi.restoreAllMocks());

describe('the MCP route', () => {
  it('answers server/discover with the current version and the identity the card gives', async () => {
    const response = await handle(rpc('server/discover'), env);
    expect(response.status).toBe(200);
    const { result } = await json(response);
    expect(result.supportedVersions).toEqual(PROTOCOL_VERSIONS);
    expect(result.resultType).toBe('complete');
    expect(result._meta['io.modelcontextprotocol/serverInfo']?.name).toBe(serverCard()['name']);
  });

  it('carries the server identity in _meta on every modern result', async () => {
    const calls = [
      rpc('ping'),
      rpc('tools/list'),
      call('surgerywaits_explain_urgency', { category: '1' }),
      call('surgerywaits_get_wait', { procedure: 'no-such-surgery-anywhere' }),
    ];
    for (const request of calls) {
      const { result } = await json(await handle(request, env));
      expect(result._meta['io.modelcontextprotocol/serverInfo']?.name).toBe(serverCard()['name']);
    }
  });

  it('lists the four tools, each read-only, closed to unknown arguments', async () => {
    const { result } = await json(await handle(rpc('tools/list'), env));
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'surgerywaits_compare_hospitals',
      'surgerywaits_explain_urgency',
      'surgerywaits_get_wait',
      'surgerywaits_list_procedures',
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
  });

  it('calls a tool and returns a withheld figure as not published', async () => {
    const response = await handle(
      call('surgerywaits_get_wait', { procedure: 'hysterectomy', hospital: 'armidale' }),
      env,
    );
    const answer = JSON.parse((await json(response)).result.content[0]?.text ?? '') as Record<
      string,
      unknown
    >;
    expect(answer['median_wait']).toMatchObject({
      status: 'not_published',
      value: null,
      reason: 'not_published_by_aihw',
    });
  });

  it('returns a surgery it cannot match as a tool error, and a bad argument as a JSON-RPC error', async () => {
    const miss = await json(
      await handle(call('surgerywaits_get_wait', { procedure: 'xyzzy' }), env),
    );
    expect(miss.result.isError).toBe(true);
    const bad = await handle(
      call('surgerywaits_get_wait', { procedure: 'cataract', extra: 1 }),
      env,
    );
    expect((await json(bad)).error.code).toBe(-32602);
    const unknown = await json(await handle(call('nope', {}), env));
    expect(unknown.error.code).toBe(-32602);
  });

  it('refuses a malformed body, a batch, a missing or mismatched header and an unknown version or method', async () => {
    const post = (
      body: string,
      headers: Record<string, string> = { 'MCP-Protocol-Version': MODERN_VERSION },
    ): Promise<Response> => handle(new Request(URL_MCP, { method: 'POST', body, headers }), env);
    const cases: [Promise<Response>, number, number][] = [
      [post('{'), 400, -32700],
      [post('[]'), 400, -32600],
      [post('{"jsonrpc":"2.0","id":1}'), 400, -32600],
      [post('{"jsonrpc":"2.0","id":{},"method":"ping"}'), 400, -32600],
      [post('{"jsonrpc":"2.0","id":1,"method":"ping"}', {}), 400, -32020],
      [
        post('{"jsonrpc":"2.0","id":1,"method":"ping"}', { 'MCP-Protocol-Version': '1900-01-01' }),
        400,
        -32022,
      ],
      [handle(rpc('tools/list', {}, { 'Mcp-Method': 'ping' }), env), 400, -32020],
      [handle(call('surgerywaits_get_wait', {}, { 'Mcp-Name': 'other' }), env), 400, -32020],
      [handle(rpc('resources/list'), env), 404, -32601],
    ];
    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      expect((await json(response)).error.code).toBe(code);
    }
  });

  it('rejects a modern request whose _meta lacks the version or the client capabilities with 400 and -32602', async () => {
    const send = (metaValue: unknown): Promise<Response> =>
      handle(
        new Request(URL_MCP, {
          method: 'POST',
          headers: { 'MCP-Protocol-Version': MODERN_VERSION, 'Mcp-Method': 'ping' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            params: metaValue === undefined ? {} : { _meta: metaValue },
          }),
        }),
        env,
      );
    const version = 'io.modelcontextprotocol/protocolVersion';
    const capabilities = 'io.modelcontextprotocol/clientCapabilities';
    for (const bad of [
      undefined,
      {},
      { [capabilities]: {} },
      { [version]: MODERN_VERSION },
      { [version]: MODERN_VERSION, [capabilities]: 'none' },
    ]) {
      const response = await send(bad);
      expect(response.status).toBe(400);
      expect((await json(response)).error.code).toBe(-32602);
    }
    const mismatched = await send({ [version]: '2025-11-25', [capabilities]: {} });
    expect(mismatched.status).toBe(400);
    expect((await json(mismatched)).error.code).toBe(-32020);
  });

  it('answers initialize under a modern header with an error that names the supported versions', async () => {
    const response = await handle(rpc('initialize'), env);
    expect(response.status).toBe(400);
    const { error } = (await json(response)) as unknown as {
      error: { code: number; data: { supported: string[] } };
    };
    expect(error.code).toBe(-32602);
    expect(error.data.supported).toEqual(PROTOCOL_VERSIONS);
  });

  it('serves /mcp/ as it serves /mcp', async () => {
    const request = new Request(`${URL_MCP}/`, rpc('tools/list'));
    const response = await handle(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await json(response)).result.tools).toHaveLength(4);
    expect((await handle(new Request(`${URL_MCP}/`), env)).status).toBe(405);
  });

  it('reads each data file once and answers the next call from memory', async () => {
    const run = (): Promise<Response> =>
      handle(
        call('surgerywaits_compare_hospitals', { procedure: 'cataract', locality: 'Armidale' }),
        env,
      );
    asked.length = 0;
    const first = await (await run()).text();
    const fetched = asked.length;
    expect(fetched).toBeGreaterThan(0);
    expect(await (await run()).text()).toBe(first);
    expect(asked).toHaveLength(fetched);
  });

  it('never makes one request wait on a fetch that another request started', async () => {
    const stalled: string[] = [];
    // The first request's fetches never settle, as if its client had gone.
    const hung = {
      ASSETS: {
        fetch: (r: Request): Promise<Response> => {
          stalled.push(new URL(r.url).pathname);
          return new Promise<Response>(() => undefined);
        },
      },
    };
    const args = { procedure: 'cataract', locality: 'Armidale' };
    void handle(call('surgerywaits_compare_hospitals', args), hung);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stalled.length).toBeGreaterThan(0);
    const answer = await handle(call('surgerywaits_compare_hospitals', args), env);
    expect(answer.status).toBe(200);
  });

  it('accepts a notification with 202 and no body', async () => {
    const response = await handle(rpc('notifications/initialized', {}, {}, null), env);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('accepts a notification with 202 although its _meta and Mcp-Method headers are missing or wrong', async () => {
    const send = (headers: Record<string, string>): Promise<Response> =>
      handle(
        new Request(URL_MCP, {
          method: 'POST',
          headers: { 'MCP-Protocol-Version': MODERN_VERSION, ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }),
        env,
      );
    expect((await send({})).status).toBe(202);
    expect((await send({ 'Mcp-Method': 'ping' })).status).toBe(202);
  });

  it('decodes an Mcp-Name sent in the base64 form before comparing it', async () => {
    const encoded = `=?base64?${btoa('surgerywaits_explain_urgency')}?=`;
    const same = await json(
      await handle(
        call('surgerywaits_explain_urgency', { category: '1' }, { 'Mcp-Name': encoded }),
        env,
      ),
    );
    expect(same.result.content).toHaveLength(1);
    const upper = `=?BASE64?${btoa('surgerywaits_explain_urgency')}?=`;
    const raw = await handle(
      call('surgerywaits_explain_urgency', { category: '1' }, { 'Mcp-Name': upper }),
      env,
    );
    expect(raw.status).toBe(400);
    const other = `=?base64?${btoa('surgerywaits_get_wait')}?=`;
    const response = await handle(
      call('surgerywaits_explain_urgency', { category: '1' }, { 'Mcp-Name': other }),
      env,
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe(-32020);
  });

  it('still serves a client that opens with initialize', async () => {
    const legacy = (method: string, headers: Record<string, string> = {}): Request =>
      new Request(URL_MCP, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: { protocolVersion: '2025-06-18' },
        }),
      });
    const init = await json(await handle(legacy('initialize'), env));
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const list = await json(
      await handle(legacy('tools/list', { 'MCP-Protocol-Version': '2025-06-18' }), env),
    );
    expect(list.result.tools).toHaveLength(4);
    expect(list.result.resultType).toBeUndefined();
  });

  it('refuses a body over the limit without reading past it', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      pad: 'x'.repeat(MAX_BODY_BYTES),
    });
    const response = await handle(
      new Request(URL_MCP, {
        method: 'POST',
        body,
        headers: { 'MCP-Protocol-Version': MODERN_VERSION },
      }),
      env,
    );
    expect(response.status).toBe(413);
  });

  it('refuses a Content-Length over the limit without reading the body', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('{}'));
      },
    });
    const response = await handle(
      new Request(URL_MCP, {
        method: 'POST',
        body,
        duplex: 'half',
        headers: {
          'MCP-Protocol-Version': MODERN_VERSION,
          'Content-Length': String(MAX_BODY_BYTES + 1),
        },
      } as RequestInit),
      env,
    );
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it('stops reading a streamed body that passes the limit and cancels it', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const response = await handle(
      new Request(URL_MCP, {
        method: 'POST',
        body,
        duplex: 'half',
        headers: { 'MCP-Protocol-Version': MODERN_VERSION },
      } as RequestInit),
      env,
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(MAX_BODY_BYTES / 4096 + 4);
  });

  it('reads only the data files of this site through the assets binding', async () => {
    asked.length = 0;
    await handle(
      call('surgerywaits_compare_hospitals', { procedure: 'cataract', locality: 'Armidale' }),
      env,
    );
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(url).toMatch(/^https:\/\/surgerywaits\.au\/data-api\/[a-z0-9/-]+\.json$/u);
    }
  });
});

describe('methods', () => {
  it('answers every method but POST and OPTIONS with 405 and Allow', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const response = await handle(new Request(URL_MCP, { method }), env);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
    }
  });

  it('answers a GET for an event stream with 405 too', async () => {
    const response = await handle(
      new Request(URL_MCP, { headers: { Accept: 'text/event-stream' } }),
      env,
    );
    expect(response.status).toBe(405);
  });

  it('keeps no cookie and no cache on any answer, and sets the security headers', async () => {
    for (const response of [
      await handle(rpc('ping'), env),
      await handle(new Request(URL_MCP), env),
    ]) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    }
  });
});

describe('CORS', () => {
  const from = (origin: string | null, method = 'POST'): Request => {
    const base = method === 'POST' ? rpc('ping') : new Request(URL_MCP, { method });
    const headers = new Headers(base.headers);
    if (origin !== null) {
      headers.set('Origin', origin);
    }
    return new Request(URL_MCP, {
      method,
      headers,
      body:
        method === 'POST'
          ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: meta } })
          : null,
    });
  };

  it('lets in no Origin, this site, Claude and ChatGPT, and echoes the origin exactly', async () => {
    for (const origin of [null, ...BROWSER_ORIGINS]) {
      const response = await handle(from(origin), env);
      expect(response.status, String(origin)).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
      expect(response.headers.get('Vary')).toContain('Origin');
    }
  });

  it('lets in a request whose Origin is the origin it was sent to, such as a preview or local run', async () => {
    for (const origin of ['http://localhost:8787', 'https://preview.example.test']) {
      const request = new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: { ...Object.fromEntries(rpc('ping').headers), Origin: origin },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: meta } }),
      });
      const response = await handle(request, env);
      expect(response.status, origin).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    const crossed = new Request('http://localhost:8787/mcp', {
      method: 'POST',
      headers: { Origin: 'https://preview.example.test' },
      body: '{}',
    });
    expect((await handle(crossed, env)).status).toBe(403);
  });

  it('refuses any other origin with 403 before the body is read', async () => {
    for (const origin of [
      'https://example.com',
      'https://claude.ai.example.com',
      'http://claude.ai',
      'https://www.chatgpt.com',
      'null',
    ]) {
      const response = await handle(from(origin), env);
      expect(response.status, origin).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('answers the preflight for an allowed origin only', async () => {
    const ok = await handle(from('https://claude.ai', 'OPTIONS'), env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(ok.headers.get('Access-Control-Allow-Headers')).toMatch(/MCP-Protocol-Version/iu);
    expect((await handle(from('https://example.com', 'OPTIONS'), env)).status).toBe(403);
  });
});

describe('the logging allow-list', () => {
  const typed = [
    'Zebrafish-Kneecap-7731',
    'Wollongong 2500',
    'SecretBrowser',
    'sess-abc-secret',
    'claude.ai',
    '203.0.113.9',
  ];

  async function logged(request: Request): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => void lines.push(String(line)));
    await (await handle(request, env)).text();
    return lines;
  }

  it('logs the tool name, the method and the status, and nothing a person typed', async () => {
    const lines = await logged(
      call(
        'surgerywaits_compare_hospitals',
        { procedure: 'Zebrafish-Kneecap-7731', locality: 'Wollongong 2500' },
        {
          Origin: 'https://claude.ai',
          'CF-Connecting-IP': '203.0.113.9',
          'Mcp-Session-Id': 'sess-abc-secret',
          'User-Agent': 'Mozilla/5.0 SecretBrowser/1.0',
        },
      ),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'mcp',
      http: 'POST',
      status: 200,
      protocol: MODERN_VERSION,
      method: 'tools/call',
      tool: 'surgerywaits_compare_hospitals',
      outcome: 'tool_error',
    });
    for (const word of typed) {
      expect(lines.join('\n')).not.toContain(word);
    }
  });

  it('writes the fields the privacy page describes, and no address or content', async () => {
    const lines = await logged(call('surgerywaits_compare_hospitals', { procedure: 'x' }));
    const fields = Object.keys(JSON.parse(lines[0] ?? '') as Record<string, unknown>);
    expect(fields).toEqual([
      'event',
      'http',
      'status',
      'protocol',
      'method',
      'tool',
      'outcome',
      'code',
    ]);
    expect(
      fields.filter((f) => /ip|address|agent|origin|session|body|arg|query|content/iu.test(f)),
    ).toEqual([]);
    const copy = getPrivacy()
      .sections.flatMap((x) => x.paragraphs)
      .join(' ');
    expect(copy).toContain('one usage line for each request to the MCP endpoint at /mcp');
    expect(copy).toContain('which method or tool the request named and how the request ended');
    expect(copy).toContain('It holds no IP address and no content of the request.');
    expect(copy).not.toContain('writes no log');
  });

  it('turns off the device features the privacy page names', () => {
    const policy = SECURITY_HEADERS['Permissions-Policy'] ?? '';
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=()');
    const copy = getPrivacy()
      .sections.flatMap((x) => x.paragraphs)
      .join(' ');
    expect(copy).toContain(
      'turns off access to device features, such as the camera and the microphone',
    );
  });

  it('writes a tool or method a caller invented as other', async () => {
    const lines = await logged(call('Zebrafish-Kneecap-7731', { procedure: 'Wollongong 2500' }));
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      tool: 'other',
      outcome: 'rpc_error',
      code: -32602,
    });
    const method = await logged(
      rpc('Zebrafish-Kneecap-7731', {}, { 'Mcp-Method': 'Zebrafish-Kneecap-7731' }),
    );
    expect(JSON.parse(method[0] ?? '')).toMatchObject({ method: 'other', tool: null });
    expect(lines.concat(method).join('\n')).not.toContain('Zebrafish');
  });

  it('logs a refused, a malformed and a wrong-method request without the origin, version or body', async () => {
    const lines = [
      ...(await logged(
        new Request(URL_MCP, {
          method: 'POST',
          body: '{"secret":"Zebrafish-Kneecap-7731"',
          headers: { Origin: 'https://evil.example', 'MCP-Protocol-Version': 'Zebrafish-7731' },
        }),
      )),
      ...(await logged(
        new Request(URL_MCP, {
          method: 'POST',
          body: '{"secret":"Zebrafish-Kneecap-7731"',
          headers: { 'MCP-Protocol-Version': 'Zebrafish-7731' },
        }),
      )),
      ...(await logged(new Request(`${URL_MCP}?q=Zebrafish-Kneecap-7731`, { method: 'GET' }))),
    ];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(
        expect.arrayContaining(['event', 'http', 'status', 'protocol', 'method', 'outcome']),
      );
      expect(line).not.toMatch(/Zebrafish|evil\.example/u);
    }
  });
});

describe('the server card', () => {
  const card = (init: RequestInit = {}): Promise<Response> =>
    handle(new Request('https://surgerywaits.au/mcp/server-card', init), env);

  it('serves the card as JSON that names the endpoint and the supported versions', async () => {
    const response = await card();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'application/mcp-server-card+json; charset=utf-8',
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await json(response);
    expect(body.remotes).toEqual([
      {
        type: 'streamable-http',
        url: 'https://surgerywaits.au/mcp',
        supportedProtocolVersions: PROTOCOL_VERSIONS,
      },
    ]);
    expect(body.description.length).toBeLessThanOrEqual(100);
  });

  it('answers a conditional request with 304, a browser with plain JSON, and a preflight with 204', async () => {
    const tag = (await card()).headers.get('ETag') ?? '';
    expect((await card({ headers: { 'If-None-Match': tag } })).status).toBe(304);
    expect((await card({ headers: { Accept: 'text/html' } })).headers.get('Content-Type')).toMatch(
      /^application\/json/u,
    );
    expect((await card({ method: 'OPTIONS' })).status).toBe(204);
  });

  it('refuses any other method', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await card({ method });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    }
  });

  it('is a surface, and its body passes the surface check', async () => {
    expect(SURFACES.map((s) => s.id)).toContain('mcp-server-card');
    expect(surfaceOf('/mcp/server-card')?.id).toBe('mcp-server-card');
    expect(surfaceBodyProblem('/mcp/server-card', await (await card()).text())).toBeUndefined();
  });
});
