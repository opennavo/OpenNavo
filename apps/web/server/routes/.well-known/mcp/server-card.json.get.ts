import { defineEventHandler, setHeaders } from 'h3';
import { MCP_SERVER_CARD } from '../../../utils/discovery';

export default defineEventHandler(event => {
  setHeaders(event, {
    'Content-Type': 'application/mcp-server-card+json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  return MCP_SERVER_CARD;
});
