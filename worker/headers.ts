// Fonts and bundled assets carry a content hash in their name, so they never change at an address.
const IMMUTABLE = /^\/(_astro|fonts)\//u;
const CRAWLER_FILES = /^\/(robots\.txt|sitemap[^/]*\.xml)$/u;

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

export function cacheControl(pathname: string, status: number): string | undefined {
  if (status === 404) {
    return 'no-store';
  }
  if (status !== 200 && status !== 304) {
    return undefined;
  }
  if (IMMUTABLE.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  return CRAWLER_FILES.test(pathname)
    ? 'public, max-age=3600'
    : 'public, max-age=0, must-revalidate';
}

// A copy with the headers set, because a response from the assets binding is immutable.
export function withHeaders(response: Response, pathname: string): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    copy.headers.set(name, value);
  }
  const cache = cacheControl(pathname, response.status);
  if (cache !== undefined) {
    copy.headers.set('Cache-Control', cache);
  }
  return copy;
}
