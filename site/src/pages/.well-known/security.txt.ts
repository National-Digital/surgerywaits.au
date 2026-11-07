import { securityTxt } from '../../lib/security-txt';

export function GET(): Response {
  return new Response(securityTxt(), { headers: { 'Content-Type': 'text/plain' } });
}
