import { withHeaders } from './headers';
import { redirectFor, redirects } from './redirects';
import type { RedirectTable } from './redirects';

export async function handle(
  request: Request,
  env: Env,
  table: RedirectTable = redirects,
): Promise<Response> {
  const url = new URL(request.url);
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
  return withHeaders(await env.ASSETS.fetch(request), url.pathname);
}

// Content negotiation and the MCP route join here (ADR D7).
export default {
  fetch: (request, env): Promise<Response> => handle(request, env),
} satisfies ExportedHandler<Env>;
