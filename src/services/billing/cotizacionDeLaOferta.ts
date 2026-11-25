/**
 * Planes editables (B2, Task 3): la cotización que el alta publica en `progress`, con un comprobante firmado por plan y
 * periodicidad. Sólo existe con una versión que publicó el editor (`versionQueCobra()`); sin ella devuelve `null` y la
 * respuesta de hoy no cambia.
 */
import { cotizarOpcion, opcionDelAlta, type OpcionCotizada } from './opcionesDeCompra'
import { versionQueCobra, type OfertaVigente, type Periodicidad, type PlanPagado } from './planOffer'

export interface PlanCotizado {
  displayName: string
  onSale: boolean
  requiresCard: boolean
  trialDays: number
  monthly: OpcionCotizada | null
  annual: OpcionCotizada | null
}

export interface OfertaDelAlta {
  versionNumber: number
  free: { displayName: string }
  planes: Record<PlanPagado, PlanCotizado>
}

const TIERS: PlanPagado[] = ['PRO', 'PREMIUM']
const PERIODOS: Periodicidad[] = ['monthly', 'annual']

/** Firma las ocho opciones de una versión ya leída (quien llama la lee una sola vez). */
export function cotizarOferta(vigente: OfertaVigente, organizationId: string, ahora: Date = new Date()): OfertaDelAlta {
  const alcance = `org:${organizationId}`
  const planes = {} as Record<PlanPagado, PlanCotizado>
  for (const tier of TIERS) {
    const plan = vigente.definition[tier]
    const cotizado: PlanCotizado = {
      displayName: plan.displayName,
      onSale: plan.onSale,
      requiresCard: plan.requiresCard,
      trialDays: plan.trialDays,
      monthly: null,
      annual: null,
    }
    for (const interval of PERIODOS) {
      const opcion = opcionDelAlta(vigente, tier, interval, ahora)
      if (opcion) cotizado[interval] = cotizarOpcion(opcion, { versionNumber: vigente.number, tier, interval, alcance }, ahora)
    }
    planes[tier] = cotizado
  }
  return { versionNumber: vigente.number, free: { displayName: vigente.definition.FREE.displayName }, planes }
}

export async function cotizacionDelAlta(organizationId: string, ahora: Date = new Date()): Promise<OfertaDelAlta | null> {
  const vigente = await versionQueCobra()
  return vigente ? cotizarOferta(vigente, organizationId, ahora) : null
}
