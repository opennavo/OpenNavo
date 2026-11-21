import { proxyToApi } from '../_shared/proxy.js';

export function onRequest(context) {
  return proxyToApi(context.request, context.env);
}
