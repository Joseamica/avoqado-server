/** Wrap any data in the MCP text-content shape every tool returns. */
export function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}
