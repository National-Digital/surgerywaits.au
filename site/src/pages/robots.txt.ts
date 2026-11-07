import { robotsTxt } from '../lib/robots';

export function GET(): Response {
  return new Response(robotsTxt(), { headers: { 'Content-Type': 'text/plain' } });
}
