/**
 * Planes editables (B4): UNA sola lectura pública de los planes pagados, para todo lector (correos, DASHBOARD, presentación, MCP).
 *
 * Sale de `ofertaVigente()` y copia SÓLO los campos públicos: nada de `stripePriceId` ni del nombre del producto de Stripe.
 * Dinero en centavos (netos y con IVA); quien lo muestra convierte a pesos. `offerVersion` es el número de la vigente
 * únicamente si la publicó el editor (2 o más); con la v1, el respaldo o sin versiones es `null` (paridad con lo de hoy).
 * Si la vigente está dañada lanza lo que lanza `ofertaVigente` (503 `PLAN_NOT_CONFIGURED`): nunca el respaldo.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { ofertaVigente, type PlanPagadoDeLaVersion, type PrecioDeLaVersion } from './planOffer'

type Db = Prisma.TransactionClient | PrismaClient

export interface PrecioPublico {
  netCents: number
  grossCents: number
}

export interface PlanPagadoPublico {
  displayName: string
  onSale: boolean
  requiresCard: boolean
  trialDays: number
  monthly: PrecioPublico
  annual: PrecioPublico
}

export interface PlanesPublicos {
  /** Número de la vigente SÓLO si la publicó el editor (≥ 2); `null` con la v1, el respaldo o sin versiones. */
  offerVersion: number | null
  FREE: { displayName: string }
  PRO: PlanPagadoPublico
  PREMIUM: PlanPagadoPublico
}

const precio = (p: PrecioDeLaVersion): PrecioPublico => ({ netCents: p.netCents, grossCents: p.grossCents })

export function planPagadoPublico(plan: PlanPagadoDeLaVersion): PlanPagadoPublico {
  return {
    displayName: plan.displayName,
    onSale: plan.onSale,
    requiresCard: plan.requiresCard,
    trialDays: plan.trialDays,
    monthly: precio(plan.monthly),
    annual: precio(plan.annual),
  }
}

export async function planesPublicos(db?: Db): Promise<PlanesPublicos> {
  const vigente = await ofertaVigente(db)
  const { definition } = vigente
  return {
    offerVersion: !vigente.respaldo && vigente.number >= 2 ? vigente.number : null,
    FREE: { displayName: definition.FREE.displayName },
    PRO: planPagadoPublico(definition.PRO),
    PREMIUM: planPagadoPublico(definition.PREMIUM),
  }
}
