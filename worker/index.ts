import { isDataApi, withHeaders } from './headers';
import { redirectFor, redirects } from './redirects';
import type { RedirectTable } from './redirects';

const ALLOWED = 'GET, HEAD';
const ALLOWED_DATA_API = 'GET, HEAD, OPTIONS';

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

export async function handle(
  request: Request,
  env: Env,
  table: RedirectTable = redirects,
): Promise<Response> {
  const url = new URL(request.url);
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
  try {
    return withHeaders(await env.ASSETS.fetch(request), url.pathname, request.method);
  } catch {
    return serverError(url.pathname);
  }
}

// Content negotiation and the MCP route join here (ADR D7).
export default {
  fetch: (request, env): Promise<Response> => handle(request, env),
} satisfies ExportedHandler<Env>;
