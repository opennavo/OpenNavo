// Export Markdown rendering (markdown-it + DOMPurify, about 47 KB brotli) separately from the main entry.
// Every page imports the main entry; including the renderer there would download it everywhere.
export { default as OnMarkdown } from './components/OnMarkdown.vue';
export type { OnMarkdownProps } from './components/OnMarkdown.vue';
export { renderMarkdown } from './utils/markdown';
export type { RenderMarkdownOptions } from './utils/markdown';
