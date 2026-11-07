import { toolPlacesJson } from '../../lib/tool-data';

export function GET(): Response {
  return new Response(toolPlacesJson(), { headers: { 'Content-Type': 'application/json' } });
}
