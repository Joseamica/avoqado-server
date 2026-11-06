/**
 * What «Clientes» adds to the rows of ONE page (plan C1): each helper reads at most the page's ids, never the universe. The
 * statements that walk the universe live in `clientsQueries` (`clients.service.ts`) and nowhere else.
 */
import prisma from '../../utils/prismaClient'
import { MOTIVOS_DEL_ALTA } from './clientFacts'

/** The ✋ of a CRM account the caller may see (`scopeWhere(access, 'ver')`). */
export interface UsaEscritoVisible {
  usaManual: string | null
  usaManualPorque: string | null
  usaManualById: string | null
  usaManualAt: Date | null
}

/** The page's columns of «Usa», as `clientsQueries().page` selects them. */
export interface UsaDeLaFila {
  usaMedido: string
  usaVisto: string
  usaAviso: boolean
  usaEscrito: boolean
}

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

/** Who wrote each visible ✋ of the page, in ONE query (the author has no FK: the history never depends on the staff). */
export async function autoresDelUsa(visibles: UsaEscritoVisible[]): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(visibles.filter(account => account.usaManual && account.usaManualById).map(account => account.usaManualById!))]
  if (!ids.length) return new Map()
  const staff = await prisma.staff.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
    take: ids.length,
  })
  return new Map(staff.map(person => [person.id, { id: person.id, name: fullName(person) }]))
}

/**
 * The «Usa» cell: what is seen (written ?? measured), what was measured, whether a person wrote it and whether that differs
 * from the measure — all from the SQL columns the filter uses. Who, why and when only for an account in the caller's «Ver».
 */
export function usaDeLaFila(row: UsaDeLaFila, visible: UsaEscritoVisible | undefined, autores: Map<string, { id: string; name: string }>) {
  return {
    visto: row.usaVisto,
    medido: row.usaMedido,
    manual: row.usaEscrito,
    aviso: row.usaAviso,
    detalle:
      row.usaEscrito && visible?.usaManual
        ? {
            porque: visible.usaManualPorque,
            por: visible.usaManualById ? (autores.get(visible.usaManualById) ?? null) : null,
            at: visible.usaManualAt,
          }
        : null,
  }
}

/** The count of stalled signups by reason, every key present. `DE_OTRO` and `perdidos` arrive with task 5. */
export function conteosDe(row: Record<string, number | undefined> | undefined) {
  const of = (key: string) => row?.[key] ?? 0
  return {
    altaSinTarjeta: of('altaSinTarjeta'),
    porMotivo: {
      ...(Object.fromEntries(MOTIVOS_DEL_ALTA.map(motivo => [motivo, of(motivo)])) as Record<(typeof MOTIVOS_DEL_ALTA)[number], number>),
      SIN_MOTIVO: of('SIN_MOTIVO'),
      DE_OTRO: 0,
    },
    perdidos: 0,
  }
}
