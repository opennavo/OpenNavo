import { BRAND_FACTS } from '../../shared/utils/brandFacts';
import { siteMessage } from './siteCopy';

const DEFAULT_PUBLIC_API_BASE = 'https://api.opennavo.com/api/v1';

function publicApiSpecUrl(apiBase?: string): string {
  if (!apiBase?.trim()) return `${DEFAULT_PUBLIC_API_BASE}/openapi.yaml`;
  try {
    const url = new URL(apiBase);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/openapi.yaml`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return `${DEFAULT_PUBLIC_API_BASE}/openapi.yaml`;
  }
}

/**
 * A short English orientation, sharing the site's identity and linking stable public pages and interfaces.
 * Laid out as llmstxt.org describes: the name as H1, the one-sentence definition as the summary blockquote,
 * a detail line, then the pages and developer interfaces under H2 headings.
 */
export function renderLlms(siteUrl: string, apiBase?: string): string {
  const origin = new URL(siteUrl).origin;
  const message = (key: string) => siteMessage('en-US', key);
  const links = [
    [BRAND_FACTS.name, '/'],
    [message('nav.download'), '/download'],
    [message('nav.apps'), '/apps'],
    [message('nav.security'), '/security'],
    [message('nav.about'), '/about']
  ];
  return [
    `# ${BRAND_FACTS.name}`,
    '',
    `> ${message(BRAND_FACTS.definitionKey)}`,
    '',
    `${message('package.info.license')}: ${BRAND_FACTS.license}`,
    '',
    '## Main pages',
    '',
    ...links.map(([label, path]) => `- [${label}](${origin}${path})`),
    '',
    '## Developer interfaces',
    '',
    `- MCP: <${origin}/mcp>`,
    `- Public API: <${publicApiSpecUrl(apiBase)}>`,
    `- Developer documentation: <${origin}/developers>`,
    ''
  ].join('\n');
}
