import { defineEventHandler, setHeaders } from 'h3';
import { createApiCatalog } from '../../utils/discovery';

export default defineEventHandler(event => {
  const config = useRuntimeConfig(event);
  setHeaders(event, {
    'Content-Type': 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  return createApiCatalog(config.public.apiBase);
});
