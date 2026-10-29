import { defineEventHandler, setHeaders } from 'h3';
import { API_CATALOG } from '../../utils/discovery';

export default defineEventHandler(event => {
  setHeaders(event, {
    'Content-Type': 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  return API_CATALOG;
});
