import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createEvent, getResponseHeader } from 'h3';
import { describe, expect, it } from 'vitest';
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
    const { event, socket } = eventFor('/.well-known/api-catalog');
    try {
      const body = await apiCatalog(event);
      expect(getResponseHeader(event, 'content-type')).toBe(
        'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'
      );
      expect(body.linkset[0].item.map(item => item.href)).toEqual([
        'https://api.opennavo.com/api/v1/openapi.yaml',
        'https://opennavo.com/developers',
        'https://opennavo.com/mcp'
      ]);
    } finally {
      socket.destroy();
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
