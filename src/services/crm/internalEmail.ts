/**
 * The internal tests of the funnel, run in production (founder, 2-nov): an Avoqado address or Resend's test inbox. No real
 * prospect writes from these domains, so the CRM takes them in ARCHIVED and without «Nuevo prospecto» — they are still
 * found by a search and can be brought back. Exact domains only: `noavoqado.io` is a prospect.
 */
const TEST_DOMAINS = new Set(['avoqado.io', 'resend.dev'])

export function esCorreoDePrueba(email: string | null | undefined): boolean {
  const clean = email?.trim().toLowerCase() ?? ''
  const at = clean.lastIndexOf('@')
  return at > 0 && TEST_DOMAINS.has(clean.slice(at + 1))
}
