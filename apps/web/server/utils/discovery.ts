import { publicApiSpecUrl } from './publicApiSpec';

/** Stable, public discovery documents. Keep these values free of deployment-only hosts and credentials. */
export const PUBLIC_SITE = 'https://opennavo.com';

/**
 * RFC 9727 API catalog as an RFC 9264 linkset (application/linkset+json, Appendix A.1 shape): one
 * link context object anchored at the public API base, with each relation type as a top-level member
 * whose value is an array of target objects.
 */
export function createApiCatalog(apiBase?: string) {
  const specUrl = publicApiSpecUrl(apiBase);
  return {
    linkset: [
      {
        anchor: specUrl.replace(/\/openapi\.yaml$/, ''),
        'service-desc': [{ href: specUrl, type: 'application/vnd.oai.openapi', title: 'OpenNavo Public Read API' }],
        'service-doc': [{ href: `${PUBLIC_SITE}/developers`, type: 'text/html', title: 'OpenNavo developers' }],
        // Streamable HTTP MCP endpoint; there is no registered media type for it, so none is claimed.
        service: [{ href: `${PUBLIC_SITE}/mcp`, title: 'OpenNavo public MCP' }]
      }
    ]
  } as const;
}

export const API_CATALOG = createApiCatalog();

/** MCP Server Card v1 experimental extension: one anonymous read-only remote. */
export const MCP_SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'com.opennavo/public-mcp',
  version: '1.0.0',
  title: 'OpenNavo Public MCP',
  description: 'Anonymous, read-only access to the public OpenNavo app catalog.',
  remotes: [{ type: 'streamable-http', url: `${PUBLIC_SITE}/mcp` }]
} as const;
