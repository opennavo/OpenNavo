// Seconds between requests for crawlers that honor the non-standard Crawl-delay directive.
export const CRAWL_DELAYS: Record<string, number> = { ClaudeBot: 10 };

// Append Crawl-delay after each run of User-agent lines naming a delayed crawler; inserting it
// inside the run would split the group for the agents listed after it.
export function withCrawlDelays(robotsTxt: string, delays: Record<string, number> = CRAWL_DELAYS): string {
  const lines = robotsTxt.split('\n');
  const out: string[] = [];
  let delay = 0;
  lines.forEach((line, index) => {
    out.push(line);
    const agent = /^user-agent:\s*(.+)$/i.exec(line.trim())?.[1]?.trim();
    if (!agent) return;
    delay = Math.max(delay, delays[agent] ?? 0);
    if (delay && !/^user-agent:/i.test((lines[index + 1] ?? '').trim())) {
      out.push(`Crawl-delay: ${delay}`);
      delay = 0;
    }
  });
  return out.join('\n');
}
