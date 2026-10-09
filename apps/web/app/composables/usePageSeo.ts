// Central page metadata (05 §6.1); M2-08 adds canonical, structured data, share images here.
export function usePageSeo(options: {
  title: MaybeRefOrGetter<string>;
  description?: MaybeRefOrGetter<string | undefined>;
  /** Search and Brewfile pages: noindex, follow. */
  noindex?: boolean;
}) {
  useSeoMeta({
    title: () => toValue(options.title),
    description: () => toValue(options.description),
    robots: options.noindex ? 'noindex, follow' : undefined
  });
}
