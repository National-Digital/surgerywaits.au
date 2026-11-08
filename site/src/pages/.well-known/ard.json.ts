import { agentCatalogJson } from '../../lib/agent-catalog';

export const GET = (): Response =>
  new Response(agentCatalogJson(), { headers: { 'Content-Type': 'application/json' } });
