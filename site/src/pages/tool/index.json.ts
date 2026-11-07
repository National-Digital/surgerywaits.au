import { toolIndexJson } from '../../lib/tool-data';

export function GET(): Response {
  return new Response(toolIndexJson(), { headers: { 'Content-Type': 'application/json' } });
}
