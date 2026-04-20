/**
 * Token revocation registry.
 *
 * Blacklists JWT `jti` values so that previously-issued tokens can be invalidated
 * before their natural `exp`. Used by the impersonation flow to invalidate the
 * prior token on `/extend` and `/stop`.
 *
 * In-memory, per-process. Entries auto-expire so the store stays bounded.
 * For multi-instance deployments this is a best-effort layer; the real
 * enforcement is the JWT `exp` claim. Impersonation sessions are short
 * (15-45 min) so a cross-instance race window is acceptable in practice.
 */

interface RevocationBackend {
  revoke(jti: string, ttlSeconds: number): Promise<void>
  isRevoked(jti: string): Promise<boolean>
}

class InMemoryRevocationBackend implements RevocationBackend {
  private readonly store = new Map<string, number>() // jti -> expiresAt (ms)

  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000
    this.store.set(jti, expiresAt)
    // Opportunistic cleanup to avoid unbounded growth under heavy churn.
    if (this.store.size > 1000) this.cleanup()
  }

  async isRevoked(jti: string): Promise<boolean> {
    const expiresAt = this.store.get(jti)
    if (!expiresAt) return false
    if (Date.now() > expiresAt) {
      this.store.delete(jti)
      return false
    }
    return true
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [jti, expiresAt] of this.store.entries()) {
      if (now > expiresAt) this.store.delete(jti)
    }
  }
}

let backend: RevocationBackend = new InMemoryRevocationBackend()

/**
 * Revoke a JWT `jti` so subsequent requests with that token are rejected.
 * @param jti - The `jti` claim of the token to revoke.
 * @param ttlSeconds - How long to remember the revocation. Set to remaining token lifetime.
 */
export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  if (!jti || ttlSeconds <= 0) return
  await backend.revoke(jti, ttlSeconds)
}

/**
 * Check whether a `jti` has been revoked.
 * @param jti - The `jti` claim to check.
 * @returns true if revoked, false otherwise.
 */
export async function isJtiRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false
  return backend.isRevoked(jti)
}

/** For tests: reset the singleton backend. */
export function _resetTokenRevocationBackendForTests(): void {
  backend = new InMemoryRevocationBackend()
}
