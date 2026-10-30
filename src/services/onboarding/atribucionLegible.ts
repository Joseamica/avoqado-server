/**
 * Cómo se lee la atribución del alta en los avisos al equipo («Nuevo registro directo», «Empezó el alta»).
 * `acquisitionUtm` guarda los UTMs de la lista cerrada y, desde D12 (28-oct-2026), `referrer`: el host de la página
 * de la que llegó al registro (p. ej. `avoqado.io`).
 */
export function utmLegible(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const partes = ['utm_source', 'utm_medium', 'utm_campaign']
    .map(k => (typeof u[k] === 'string' && u[k] ? `${k}=${u[k]}` : null))
    .filter(Boolean)
  return partes.length > 0 ? partes.join(' · ') : null
}

/** Un referente vacío NO prueba que escribió la dirección (`noreferrer`, políticas del navegador): se dice que no se sabe. */
export function referenteLegible(raw: unknown): string {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).referrer : null
  return typeof r === 'string' && r ? r : 'Origen no disponible'
}

/** Sólo el host, en minúsculas y sin puerto; cualquier otra cosa se descarta (la atribución vale menos que la cuenta). */
export function normalizarReferente(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let valor = raw.trim().toLowerCase()
  if (!valor) return undefined
  if (valor.includes('://')) {
    try {
      valor = new URL(valor).hostname
    } catch {
      return undefined
    }
  }
  valor = valor.split(':')[0]
  return /^[a-z0-9.-]{1,100}$/.test(valor) ? valor : undefined
}
