import { describe, expect, it } from 'vitest';
import { createApiCatalog } from '../server/utils/discovery';
import { renderLlms } from '../server/utils/llms';
import { publicApiSpecUrl } from '../server/utils/publicApiSpec';

describe('public API specification URL', () => {
  it.each([
    ['https://api.opennavo.com/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://api.opennavo.com/api/v1/', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://api.opennavo.com/api/v1///?secret=value#fragment', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['http://api.opennavo.com/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://api.example.test/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://opennavo.com.evil.test/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://evilopennavo.com/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://user:pass@api.opennavo.com/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://user@opennavo.com/api/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://@opennavo.com/custom/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['https://:@opennavo.com/custom/v1', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['garbage', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    [undefined, 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['', 'https://api.opennavo.com/api/v1/openapi.yaml'],
    ['   ', 'https://api.opennavo.com/api/v1/openapi.yaml']
  ])('resolves %s consistently in discovery documents', (apiBase, expected) => {
    expect(publicApiSpecUrl(apiBase)).toBe(expected);
    expect(createApiCatalog(apiBase).linkset[0].item[0].href).toBe(expected);
    expect(renderLlms('https://opennavo.com', apiBase)).toContain(`- Public API: <${expected}>`);
  });

  it.each([
    'https://admin.opennavo.com/api/v1',
    'https://api.opennavo.com:8443/api/v1',
    'https://api.opennavo.com:443/api/v1',
    'https://other.opennavo.com/api/v1',
    'https://opennavo.com/api/v1',
    'http://api.opennavo.com/api/v1',
    'https://api.opennavo.com/custom/v1',
    'https://api.opennavo.com/agent-api/v1',
    'https://api.opennavo.com/api/v2',
    'https://api.opennavo.com/api/v1/private',
    'https://api.opennavo.com/api/v1/openapi.yaml',
    'https://api.opennavo.com/',
    'https://@api.opennavo.com/api/v1',
    'https://:@api.opennavo.com/api/v1'
  ])('rejects %s and falls back to production in discovery documents', apiBase => {
    const expected = 'https://api.opennavo.com/api/v1/openapi.yaml';
    expect(publicApiSpecUrl(apiBase)).toBe(expected);
    expect(createApiCatalog(apiBase).linkset[0].item[0].href).toBe(expected);
    expect(renderLlms('https://opennavo.com', apiBase)).toContain(`- Public API: <${expected}>`);
  });
});
