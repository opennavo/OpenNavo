import { readFileSync } from 'node:fs';

const subject = readFileSync(process.argv[2], 'utf8').split('\n')[0];
if (!/^(feat|fix|docs|chore|test|refactor|perf|build|ci|style|revert)(\((server|web|desktop|admin|ui|tokens|api|shared|mcp|deploy|docs|ci)\))?!?: .+/.test(subject)) {
  console.error('Use Conventional Commits and an OpenNavo scope.');
  process.exit(1);
}
