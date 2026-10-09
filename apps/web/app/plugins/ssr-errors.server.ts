// useAsyncData captures failures instead of throwing. Do not cache the rendered
// error UI as a successful page, including optional API sections on SWR routes.
export default defineNuxtPlugin(nuxtApp => {
  const event = useRequestEvent();
  nuxtApp.hook('app:rendered', () => {
    // Nuxt's serialized payload uses this field for captured useAsyncData failures.
    const { _errors: errors } = nuxtApp.payload;
    if (event && event.node.res.statusCode < 400 && Object.values(errors).some(Boolean)) {
      setResponseStatus(event, 503);
    }
  });
});
