// Local MCP client configuration presets. Every preset launches the app binary itself with the `mcp`
// subcommand, using the absolute path the running app reports (never a guessed /Applications path).

export type McpClient = 'claude' | 'cursor' | 'codex' | 'generic';

export const MCP_CLIENTS: readonly McpClient[] = ['claude', 'cursor', 'codex', 'generic'];

/** Server name the presets register; one entry per Mac is enough. */
export const MCP_SERVER_NAME = 'opennavo';

/** localStorage key holding the binary path the last copied configuration pointed at. */
export const MCP_COPIED_PATH_KEY = 'opennavo.mcp.copiedPath';

/** TOML basic string: escape backslashes, quotes and control characters. */
function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/** Configuration text for one client, ready to paste. */
export function mcpConfig(client: McpClient, commandPath: string): string {
  const server = { command: commandPath, args: ['mcp'] };
  switch (client) {
    case 'claude':
    case 'cursor':
      // claude_desktop_config.json and Cursor's mcp.json share the mcpServers shape.
      return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2);
    case 'codex':
      // ~/.codex/config.toml
      return `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${tomlString(commandPath)}\nargs = ["mcp"]\n`;
    case 'generic':
      return JSON.stringify(server, null, 2);
  }
}

/** The path the last copied configuration used, or null when nothing was copied (or storage is off). */
export function copiedMcpPath(): string | null {
  try {
    return localStorage.getItem(MCP_COPIED_PATH_KEY);
  } catch {
    return null;
  }
}

export function rememberCopiedMcpPath(commandPath: string): void {
  try {
    localStorage.setItem(MCP_COPIED_PATH_KEY, commandPath);
  } catch {
    /* Without storage the moved-app hint is simply unavailable. */
  }
}

/** True when a configuration was copied for a different binary path: the app has moved since. */
export function mcpAppMoved(commandPath: string | null, copied: string | null = copiedMcpPath()): boolean {
  return commandPath !== null && copied !== null && copied !== commandPath;
}
