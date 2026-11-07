import { toolDataJson } from '../../lib/tool-data';

export function GET(): Response {
  return new Response(toolDataJson(), { headers: { 'Content-Type': 'application/json' } });
}
