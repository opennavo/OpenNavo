// Local/CI Lighthouse compression proxy simulating production Caddy encode zstd gzip (ops/caddy/Caddyfile).
// Nitro Node serves precompressed assets but does not compress pages/payloads; direct measurements are slower than production.
// Run: UPSTREAM_PORT=3000 PORT=3100 node scripts/compress-proxy.mjs
import http from 'node:http';
import zlib from 'node:zlib';

const upstreamPort = Number(process.env.UPSTREAM_PORT ?? 3000);
const port = Number(process.env.PORT ?? 3100);
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/;

function pickEncoding(acceptEncoding) {
  if (/\bzstd\b/.test(acceptEncoding)) return 'zstd';
  if (/\bgzip\b/.test(acceptEncoding)) return 'gzip';
  return null;
}

http
  .createServer((request, response) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: upstreamPort, path: request.url, method: request.method, headers: request.headers },
      upstreamResponse => {
        const headers = { ...upstreamResponse.headers };
        const compressible = !headers['content-encoding'] && COMPRESSIBLE.test(String(headers['content-type'] ?? ''));
        const encoding = compressible ? pickEncoding(String(request.headers['accept-encoding'] ?? '')) : null;
        if (!encoding) {
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          upstreamResponse.pipe(response);
          return;
        }
        delete headers['content-length'];
        headers['content-encoding'] = encoding;
        headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding';
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(encoding === 'zstd' ? zlib.createZstdCompress() : zlib.createGzip()).pipe(response);
      }
    );
    upstream.on('error', () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  })
  .listen(port, '127.0.0.1', () => console.log(`compress proxy: http://localhost:${port} → 127.0.0.1:${upstreamPort}`));
