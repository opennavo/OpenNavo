/** Command-K palette state shared by navigation search and keyboard shortcut. */
export function useCommandPalette() {
  const open = useState('command-palette:open', () => false);
  return { open };
}
