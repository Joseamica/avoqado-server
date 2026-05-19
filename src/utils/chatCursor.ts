export interface ChatCursor {
  createdAt: Date
  id: string
}

// Encode (createdAt, id) as opaque base64url JSON. Per spec §Polling endpoint contract.
export function encodeCursor(cursor: ChatCursor): string {
  const payload = JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })
  return Buffer.from(payload).toString('base64url')
}

export function decodeCursor(encoded: string): ChatCursor {
  let json: string
  try {
    json = Buffer.from(encoded, 'base64url').toString('utf-8')
  } catch {
    throw new Error('Cursor inválido')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Cursor inválido')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('Cursor inválido')
  }
  const { createdAt, id } = parsed as { createdAt: string; id: string }
  const dt = new Date(createdAt)
  if (isNaN(dt.getTime())) throw new Error('Cursor inválido')
  return { createdAt: dt, id }
}
