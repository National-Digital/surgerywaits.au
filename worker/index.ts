import { ALLOWED_DATA_API, isDataApi, SECURITY_HEADERS, withHeaders } from './headers';
import { handleCard, handleMcp, MCP_CARD_PATH, MCP_PATH } from './mcp';
import { redirectFor, redirects } from './redirects';
import type { RedirectTable } from './redirects';
import {
  prefersMarkdown,
  TWIN_REDIRECT_STATUS,
  twinAddressFor,
  twinPathOf,
  withPathname,
} from './twins';

const ALLOWED = 'GET, HEAD';

// A static site takes no input, so any method but GET and HEAD is refused, and OPTIONS under /data-api/ only.
function methodNotAllowed(pathname: string): Response {
  return withHeaders(
    new Response('Method not allowed', {
      status: 405,
      headers: {
        Allow: isDataApi(pathname) ? ALLOWED_DATA_API : ALLOWED,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    }),
    pathname,
  );
}

// The preflight a browser sends before a cross-origin read; the answer is cached for a day.
function preflight(pathname: string): Response {
  return withHeaders(
    new Response(null, {
      status: 204,
      headers: {
        Allow: ALLOWED_DATA_API,
        'Access-Control-Allow-Methods': ALLOWED_DATA_API,
        'Access-Control-Allow-Headers': 'Accept, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    }),
    pathname,
  );
}

function serverError(pathname: string): Response {
  return withHeaders(
    new Response('Internal server error', {
      status: 500,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    }),
    pathname,
  );
}

// A request that prefers Markdown for a page gets the page's twin, and any other answer is the page itself.
async function negotiated(request: Request, env: Env, url: URL): Promise<Response | undefined> {
  const twin = twinPathOf(url.pathname);
  if (twin === undefined || !prefersMarkdown(request.headers.get('Accept'))) {
    return undefined;
  }
  const answer = await env.ASSETS.fetch(new Request(withPathname(url, twin), request));
  if (answer.status !== 200 && answer.status !== 304) {
    return undefined;
  }
  const response = withHeaders(answer, twin, request.method);
  response.headers.set('Vary', 'Accept');
  response.headers.set('Content-Location', twin);
  return response;
}

// The redirect keeps the query of the request.
function withLocation(url: URL, pathname: string): string {
  const location = withPathname(url, pathname);
  location.search = url.search;
  return location.href;
}

const SITE_HOST = 'surgerywaits.au';
const WWW_HOST = `www.${SITE_HOST}`;
const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([SITE_HOST, WWW_HOST]);
const WWW_CACHE_CONTROL = 'public, max-age=86400';

// The www host answers every request with a permanent redirect to the same address on the apex.
function toApex(url: URL): Response {
  const location = new URL(url.href);
  location.hostname = SITE_HOST;
  location.port = '';
  location.protocol = 'https:';
  return new Response(null, {
    status: 301,
    headers: { ...SECURITY_HEADERS, Location: location.href, 'Cache-Control': WWW_CACHE_CONTROL },
  });
}

async function route(
  request: Request,
  env: Env,
  table: RedirectTable = redirects,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname === MCP_PATH ||
    url.pathname === `${MCP_PATH}/` ||
    url.pathname === MCP_CARD_PATH
  ) {
    const answer =
      url.pathname !== MCP_CARD_PATH ? await handleMcp(request, env) : await handleCard(request);
    // The slash form takes the headers of the route itself.
    return withHeaders(
      answer,
      url.pathname === `${MCP_PATH}/` ? MCP_PATH : url.pathname,
      request.method,
    );
  }
  if (request.method === 'OPTIONS' && isDataApi(url.pathname)) {
    return preflight(url.pathname);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(url.pathname);
  }
  const target = redirectFor(url.pathname, table);
  if (target !== undefined) {
    const location = new URL(target, url);
    location.search = url.search;
    return withHeaders(
      new Response(null, {
        status: 301,
        headers: { Location: location.href, 'Cache-Control': 'public, max-age=3600' },
      }),
      url.pathname,
    );
  }
  const folderForm = twinAddressFor(url.pathname);
  if (folderForm !== undefined) {
    return withHeaders(
      new Response(null, {
        status: TWIN_REDIRECT_STATUS,
        headers: {
          Location: withLocation(url, folderForm),
          'Cache-Control': 'public, max-age=3600',
        },
      }),
      url.pathname,
    );
  }
  try {
    const twin = await negotiated(request, env, url);
    if (twin !== undefined) {
      return twin;
    }
    return withHeaders(await env.ASSETS.fetch(request), url.pathname, request.method);
  } catch {
    return serverError(url.pathname);
  }
}

// A preview or any other host must never be indexed, whatever it serves.
export async function handle(
  request: Request,
  env: Env,
  table: RedirectTable = redirects,
): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname.replace(/\.$/u, '');
  const response = host === WWW_HOST ? toApex(url) : await route(request, env, table);
  if (!PRODUCTION_HOSTS.has(host)) {
    response.headers.set('X-Robots-Tag', 'noindex');
  }
  return response;
}

export default {
  fetch: (request, env): Promise<Response> => handle(request, env),
} satisfies ExportedHandler<Env>;
