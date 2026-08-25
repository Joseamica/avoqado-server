/**
 * User-facing MCP errors. Lives in its own module (no service imports) so the instrumentation
 * layer can recognise it WITHOUT pulling in guard.ts → access.service → prisma.
 *
 * A ScopeError's message is written for the operator ("este local no está en tu alcance…") and is
 * SAFE to hand to the AI client verbatim. Anything else that a tool throws (Prisma validation,
 * a TypeError, a provider SDK failure) is NOT — see instrument.ts, which replaces those with a
 * generic message + reference id for non-superadmin connections.
 */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeError'
  }
}

/**
 * Shapes that only ever come from Avoqado's internals — an ORM/SQL/driver/filesystem error, never
 * a message written for the operator. Used to redact the `ok:false` errors that ~68 tools return
 * from a `catch` (those never reach the thrown-error path, so `sanitizeThrownError` cannot see
 * them). Denylist by SHAPE, not allowlist: the tools deliberately surface Spanish service messages
 * to the operator ("No hay nada por retirar"), and blanket-redaction would destroy that UX.
 */
const INTERNAL_ERROR_SHAPES: RegExp[] = [
  /\bprisma\.[a-zA-Z]+\./i, // Invalid `prisma.venue.findMany()` invocation
  /\bPrisma[A-Za-z]*(Error|ClientKnownRequestError)\b/,
  /\bP\d{4}\b/, // Prisma error codes: P1001 (unreachable), P2002 (unique), P2003 (FK)…
  /\b(findMany|findUnique|findFirst|createMany|updateMany|upsert|\$transaction|\$queryRaw)\b/,
  /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|JOIN)\b.*\b(FROM|WHERE|VALUES|SET)\b/i,
  /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|EPIPE)\b/,
  /\b\d{1,3}(\.\d{1,3}){3}:\d{2,5}\b/, // host:port
  /(postgres(ql)?|redis|amqps?):\/\//i,
  /\bnode_modules\b|\bat [A-Za-z_$][\w$]*\s*\(|\.[jt]s:\d+:\d+/, // stack frames
  /\/(Users|home|app|usr|var)\//, // absolute filesystem paths
  /\bColumn\b|\brelation "[^"]+" does not exist|\bconstraint\b/i,
  /Argument `[a-zA-Z_]+`|Unknown arg(ument)? `/,
]

/** True when the text carries an internal shape that must not reach a customer's assistant. */
export function looksInternal(message: string): boolean {
  return INTERNAL_ERROR_SHAPES.some(p => p.test(message))
}

/** The customer-safe replacement for an internal error, carrying a reference id for support. */
export function genericErrorMessage(toolName: string, ref: string): string {
  return `No pude completar "${toolName}" por un error interno de Avoqado (ref ${ref}). Vuelve a intentarlo; si persiste, escribe a hola@avoqado.io citando la referencia.`
}
