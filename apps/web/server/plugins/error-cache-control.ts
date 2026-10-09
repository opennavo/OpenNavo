export default defineNitroPlugin(nitro => {
  nitro.hooks.hook('beforeResponse', event => {
    if (event.node.res.statusCode >= 400) {
      setHeader(event, 'cache-control', 'no-store');
      if (event.node.res.statusCode === 503) setHeader(event, 'retry-after', 5);
    }
  });
});
