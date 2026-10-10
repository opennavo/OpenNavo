import { withCrawlDelays } from '../utils/crawlDelay';

// @nuxtjs/robots cannot emit Crawl-delay, so add it to the generated robots.txt.
export default defineNitroPlugin(nitroApp => {
  nitroApp.hooks.hook('robots:robots-txt', context => {
    context.robotsTxt = withCrawlDelays(context.robotsTxt);
  });
});
