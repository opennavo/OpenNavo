// Shared with the desktop app; each client persists its own local list.
export {
  BREWFILE_KEY,
  BREWFILE_MAX,
  addToBrewfileList,
  parseBrewfileList,
  removeFromBrewfileList,
  moveInBrewfileList
} from '@opennavo/shared';
export type { AddResult, BrewfileListItem } from '@opennavo/shared';
