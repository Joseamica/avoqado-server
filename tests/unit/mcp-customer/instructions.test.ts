/**
 * Server instructions per connection role (src/mcp/instructions.ts): customers get the
 * "product yes / internals no" boundary; a platform SUPERADMIN gets internals access instead.
 */
import { buildMcpInstructions } from '../../../src/mcp/instructions'

describe('buildMcpInstructions', () => {
  const customer = buildMcpInstructions({ isSuperAdmin: false })
  const admin = buildMcpInstructions({ isSuperAdmin: true })

  // NEW
  it('every connection is told to answer product questions from avoqado_help, never by inventing', () => {
    for (const text of [customer, admin]) {
      expect(text).toMatch(/avoqado_help/)
      expect(text).toMatch(/do not invent/i)
    }
  })

  it('a customer connection carries the BOUNDARY: no architecture / infra / code, redirect to support', () => {
    expect(customer).toMatch(/BOUNDARY/)
    expect(customer).toMatch(/architecture/i)
    expect(customer).toMatch(/hola@avoqado\.io/)
    expect(customer).not.toMatch(/avoqado_internal_docs/)
    expect(customer).not.toMatch(/SUPERADMIN/)
  })

  it('a superadmin connection is allowed to discuss internals via avoqado_internal_docs and has no boundary clause', () => {
    expect(admin).toMatch(/SUPERADMIN/)
    expect(admin).toMatch(/avoqado_internal_docs/)
    expect(admin).not.toMatch(/BOUNDARY/)
  })

  // REGRESSION — the data rules that came from the $461k pasted-report incident are unchanged
  it('keeps the live-data rules (source of truth, unverified pasted numbers, scope, pesos) for everyone', () => {
    for (const text of [customer, admin]) {
      expect(text).toMatch(/SOURCE OF TRUTH/)
      expect(text).toMatch(/UNVERIFIED/)
      expect(text).toMatch(/Fitpass/)
      expect(text).toMatch(/currency returned by the tool in major units/)
    }
  })
})

describe('instrucciones del catálogo de directorio', () => {
  const text = buildMcpInstructions({ isSuperAdmin: false, directory: true, directoryTier: 1 })

  it('con la tanda base prendida no promete lo que todavía no expone', () => {
    const base = buildMcpInstructions({ isSuperAdmin: false, directory: true, directoryTier: 0 })
    expect(base).toMatch(/sales summaries, the product catalog and ingredient inventory/)
    expect(base).not.toMatch(/reservations, customers/)
    expect(base).toMatch(/does not execute payments or refunds/)
  })

  it('describe la operación diaria y ya no la limita a ventas, productos e inventario', () => {
    expect(text).not.toMatch(/only sales summaries, product catalog and ingredient inventory/)
    expect(text).toMatch(/reservations/)
    expect(text).toMatch(/customers/)
  })

  it('sigue declarando lo que el directorio nunca ofrece', () => {
    expect(text).toMatch(/does not execute payments or refunds/)
    expect(text).toMatch(/government identifiers/)
    expect(text).toMatch(/subscriptions/)
    expect(text).toMatch(/without switching endpoint or requesting broader access/)
  })

  it('no afirma que una plataforma lo certificó', () => {
    expect(text).toMatch(/Do not claim this catalog is certified or verified/)
    expect(text).not.toMatch(/avoqado_internal_docs/)
  })
})
