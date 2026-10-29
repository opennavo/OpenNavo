/** Stable, public discovery documents. Keep these values free of deployment-only hosts and credentials. */
export const PUBLIC_SITE = 'https://opennavo.com';
export const PUBLIC_API = 'https://api.opennavo.com';
export const API_CATALOG_URL = `${PUBLIC_SITE}/.well-known/api-catalog`;

/** RFC 9727 Linkset representation for the public API, docs, and MCP entry point. */
export const API_CATALOG = {
  linkset: [
    {
      anchor: API_CATALOG_URL,
      item: [
        {
          href: `${PUBLIC_API}/api/v1/openapi.yaml`,
          rel: 'describedby',
          type: 'application/vnd.oai.openapi',
          title: 'OpenNavo Public Read API'
        },
        {
          href: `${PUBLIC_SITE}/developers`,
          rel: 'documentation',
          type: 'text/html',
          title: 'OpenNavo developers'
        },
        {
          href: `${PUBLIC_SITE}/mcp`,
          rel: 'service',
          type: 'application/mcp',
          title: 'OpenNavo public MCP'
        }
      ]
    }
  ]
} as const;

/** MCP Server Card v1 experimental extension: one anonymous read-only remote. */
export const MCP_SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'com.opennavo/public-mcp',
  version: '1.0.0',
  title: 'OpenNavo Public MCP',
  description: 'Anonymous, read-only access to the public OpenNavo app catalog.',
  remotes: [{ type: 'streamable-http', url: `${PUBLIC_SITE}/mcp` }]
} as const;
