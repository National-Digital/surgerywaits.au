// Fonts and bundled assets carry a content hash in their name, so they never change at an address.
const IMMUTABLE = /^\/(_astro|fonts)\//u;

// The page loads its own script, style, font and image only, and the page-view beacon's two hosts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
};

const isToolData = (pathname: string): boolean =>
  pathname.startsWith('/tool/') && pathname.endsWith('.json');

export const isDataApi = (pathname: string): boolean => pathname.startsWith('/data-api/');

const isContractSchema = (pathname: string): boolean =>
  pathname.startsWith('/contract/') && pathname.endsWith('.schema.json');

export const ALLOWED_DATA_API = 'GET, HEAD, OPTIONS';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const DATA_CACHE_CONTROL = 'public, max-age=3600';
export const MISSING_CACHE_CONTROL = 'no-store';

// Any site may read the data files and the schemas from a page, so each answer carries this.
export const ALLOW_ANY_ORIGIN = { 'Access-Control-Allow-Origin': '*' } as const;

// Data files stay out of search results.
export const DATA_API_HEADERS: Readonly<Record<string, string>> = {
  ...ALLOW_ANY_ORIGIN,
  'X-Robots-Tag': 'noindex',
};

export function cacheControl(pathname: string, status: number): string | undefined {
  if (status === 404) {
    return MISSING_CACHE_CONTROL;
  }
  if (status !== 200 && status !== 304) {
    return undefined;
  }
  if (IMMUTABLE.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  if (isDataApi(pathname)) {
    return DATA_CACHE_CONTROL;
  }
  if (pathname === '/robots.txt') {
    return 'public, max-age=14400';
  }
  return 'public, max-age=0, must-revalidate';
}

// A JSON client that asks for a missing data file gets JSON back, not the site's HTML page.
function dataApiNotFound(method: string): Response {
  return new Response(method === 'HEAD' ? null : '{"error":"not found"}', {
    status: 404,
    headers: { 'Content-Type': JSON_CONTENT_TYPE },
  });
}

// A copy with the headers set, because a response from the assets binding is immutable.
export function withHeaders(response: Response, pathname: string, method = 'GET'): Response {
  const source =
    isDataApi(pathname) && response.status === 404 ? dataApiNotFound(method) : response;
  const copy = new Response(source.body, source);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    copy.headers.set(name, value);
  }
  if (isDataApi(pathname)) {
    for (const [name, value] of Object.entries(DATA_API_HEADERS)) {
      copy.headers.set(name, value);
    }
    if (response.status === 200 && pathname.endsWith('.json')) {
      copy.headers.set('Content-Type', JSON_CONTENT_TYPE);
    }
  }
  if (isContractSchema(pathname)) {
    copy.headers.set(
      'Access-Control-Allow-Origin',
      ALLOW_ANY_ORIGIN['Access-Control-Allow-Origin'],
    );
  }
  if (isToolData(pathname)) {
    copy.headers.set('X-Robots-Tag', 'noindex');
  }
  // The site keeps no session, so no answer may set a cookie.
  copy.headers.delete('Set-Cookie');
  const cache = cacheControl(pathname, response.status);
  if (cache !== undefined) {
    copy.headers.set('Cache-Control', cache);
  }
  return copy;
}
