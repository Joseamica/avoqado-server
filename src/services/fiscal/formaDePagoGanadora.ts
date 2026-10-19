/**
 * Anexo 20 (Guía de llenado, FormaPago): «la clave de la forma de pago con la que se liquida la mayor cantidad del pago».
 * Es el cuerpo de `formaGanadoraDelTicket` (`cfdiGlobal.service.ts`, C1/H4 + ronda 1 I3), movido TAL CUAL para que la factura
 * individual use la MISMA regla (tarjetas de regalo, auditoría r1 B-2) sin que `cfdi.service.ts` importe `cfdiGlobal.service.ts`
 * (que ya lo importa a él: sería un ciclo). Suma POR FORMA (`mapFormaPago`); a igual suma gana la forma con el cobro suelto mayor;
 * si también empata, la clave SAT menor (ni la hora ni el id deciden). '99' y `[]` si no hay cobros.
 * Recibe cobros YA elegibles: el filtro `esCobroElegible` lo aplica quien llama (vive en `cfdi.service.ts`).
 */
import type { PaymentMethod } from '@prisma/client'
import { mapFormaPago } from './satCatalog'

export interface CobroConForma {
  method: PaymentMethod
  tenderSatFormaPago?: string | null
  amount?: unknown
}

const aCentavos = (d: unknown): number => Math.round(Number(d ?? 0) * 100)
const porClave = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function formaGanadoraDeCobros<T extends CobroConForma>(cobros: readonly T[]): { forma: string; pagos: T[] } {
  const grupos = new Map<string, { sumaCents: number; mayorCents: number; pagos: T[] }>()
  for (const p of cobros) {
    const forma = mapFormaPago(p.method, p.tenderSatFormaPago)
    const g = grupos.get(forma) ?? { sumaCents: 0, mayorCents: 0, pagos: [] }
    const cents = aCentavos(p.amount)
    grupos.set(forma, { sumaCents: g.sumaCents + cents, mayorCents: Math.max(g.mayorCents, cents), pagos: [...g.pagos, p] })
  }
  const [ganadora] = [...grupos].sort(([fa, a], [fb, b]) => b.sumaCents - a.sumaCents || b.mayorCents - a.mayorCents || porClave(fa, fb))
  return ganadora ? { forma: ganadora[0], pagos: ganadora[1].pagos } : { forma: '99', pagos: [] }
}
