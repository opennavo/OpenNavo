export interface McpFunctionContext {
  request: Request;
  env: Record<string, string | undefined>;
}

export function onRequest(context: McpFunctionContext): Promise<Response>;
