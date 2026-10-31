import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createEvent, getResponseHeader } from 'h3';
import { describe, expect, it, vi } from 'vitest';
import apiCatalog from '../server/routes/.well-known/api-catalog.get';
import serverCard from '../server/routes/.well-known/mcp/server-card.json.get';

function eventFor(path: string) {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.url = path;
  request.headers = { accept: '*/*' };
  return { event: createEvent(request, new ServerResponse(request)), socket };
}

describe('public discovery documents', () => {
  it('serves the RFC 9727 API catalog linkset with its profile content type', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://api.example.test/api/v1' } }));
    const { event, socket } = eventFor('/.well-known/api-catalog');
    try {
      const body = await apiCatalog(event);
      expect(getResponseHeader(event, 'content-type')).toBe(
        'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'
      );
      // RFC 9727 Appendix A.1 / RFC 9264 Section 4.2: the API base is the link context and each
      // relation is a top-level member holding an array of target objects; no nested "item" list.
      expect(body).toEqual({
        linkset: [
          {
            anchor: 'https://api.opennavo.com/api/v1',
            'service-desc': [
              {
                href: 'https://api.opennavo.com/api/v1/openapi.yaml',
                type: 'application/vnd.oai.openapi',
                title: 'OpenNavo Public Read API'
              }
            ],
            'service-doc': [
              { href: 'https://opennavo.com/developers', type: 'text/html', title: 'OpenNavo developers' }
            ],
            service: [{ href: 'https://opennavo.com/mcp', title: 'OpenNavo public MCP' }]
          }
        ]
      });
      for (const context of body.linkset) {
        expect(context.anchor).not.toBe('https://opennavo.com/.well-known/api-catalog');
        expect(context).not.toHaveProperty('item');
        for (const [relation, targets] of Object.entries(context)) {
          if (relation === 'anchor') continue;
          expect(Array.isArray(targets)).toBe(true);
          for (const target of targets as { href: string; type?: string }[]) {
            expect(new URL(target.href).protocol).toBe('https:');
            expect(target.type).not.toBe('application/mcp');
          }
        }
      }
    } finally {
      socket.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('serves a public MCP Server Card with only the public remote', async () => {
    const { event, socket } = eventFor('/.well-known/mcp/server-card.json');
    try {
      const body = await serverCard(event);
      expect(getResponseHeader(event, 'content-type')).toBe('application/mcp-server-card+json; charset=utf-8');
      expect(body.name).toBe('com.opennavo/public-mcp');
      expect(body.remotes).toEqual([{ type: 'streamable-http', url: 'https://opennavo.com/mcp' }]);
      expect(JSON.stringify(body)).not.toMatch(/admin|oauth/i);
    } finally {
      socket.destroy();
    }
  });
});
