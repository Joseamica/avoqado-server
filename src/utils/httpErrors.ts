export const isJsonBodyParseError = (err: Error): err is Error & { status: number; type: string; body?: unknown } => {
  const bodyParseError = err as Error & { status?: number; type?: string; body?: unknown }
  return bodyParseError instanceof SyntaxError && bodyParseError.status === 400 && bodyParseError.type === 'entity.parse.failed'
}
