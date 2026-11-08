import { getAgents, getSite } from './content';
import { canonicalJson } from './data-api';
import { MCP_ACCESS } from './mcp-facts';
import { fillKnown } from './slots';
import { SURFACES } from './surfaces';

const CATALOG_SPEC_VERSION = '1.0';

const host = (): string => new URL(getSite().url).hostname;

interface CatalogEntry {
  identifier: string;
  displayName: string;
  description: string;
  type: string;
  url: string;
  representativeQueries: string[];
}

// The surfaces name what is cataloged; agents.yaml holds the words for each, keyed by surface id.
export function catalogEntries(): CatalogEntry[] {
  const { entries } = getAgents().catalog;
  const slots = { site: getSite().name, mcp_access: MCP_ACCESS };
  return SURFACES.flatMap((surface) => {
    if (surface.catalog === undefined) {
      return [];
    }
    const words = entries[surface.id];
    if (words === undefined) {
      throw new Error(`no catalog entry for ${surface.id} in agents.yaml`);
    }
    return [
      {
        identifier: `urn:air:${host()}:${surface.catalog.urn}`,
        displayName: fillKnown(words.name, slots),
        description: fillKnown(words.description, slots),
        type: surface.catalog.type,
        url: new URL(surface.catalog.path, getSite().url).href,
        representativeQueries: words.queries,
      },
    ];
  });
}

const agentCatalog = (): unknown => ({
  specVersion: CATALOG_SPEC_VERSION,
  host: {
    displayName: getSite().name,
    identifier: `did:web:${host()}`,
    documentationUrl: new URL('/agents/', getSite().url).href,
  },
  entries: catalogEntries(),
});

export const agentCatalogJson = (): string => canonicalJson(agentCatalog());
