import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { valorarClases } from './valoracion'
import { hoyLocal, periodoQueContiene, venuePeriodRange } from './periodos'

export class FinDeSimulacion extends Error {
  constructor(public readonly resultado: number) {
    super('simulación terminada')
  }
}

async function firmaDelPeriodo(db: Prisma.TransactionClient, organizationId: string, venueIds: string[]): Promise<Map<string, string>> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  const venues = await db.venue.findMany({
    where: { id: { in: venueIds }, organizationId },
    select: { id: true, timezone: true },
    take: venueIds.length,
  })
  const firmas = new Map<string, string>()
  const ahora = new Date()
  for (const v of venues) {
    const tz = v.timezone || 'America/Mexico_City'
    const { from, to } = venuePeriodRange(periodoQueContiene(hoyLocal(tz, ahora), org.servicePayPeriodicity), tz)
    let despuesDe: string | undefined
    for (;;) {
      const page = await valorarClases(
        db,
        { venueId: v.id, organizationId, tz, desde: from, hasta: to, ahora },
        { despuesDe, limite: 1000 },
      )
      if (!page.length) break
      for (const c of page) firmas.set(c.classSessionId, `${c.estado}|${c.motivo ?? ''}|${c.monto?.toString() ?? ''}`)
      despuesDe = page[page.length - 1].classSessionId
    }
  }
  return firmas
}

/** «Cambia el pago de N clases» (spec §7.1): aplica el cambio en una transacción que SIEMPRE se revierte. */
export async function contarClasesQueCambian(
  organizationId: string,
  venueIds: string[],
  aplicar: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<number> {
  try {
    await prisma.$transaction(
      async tx => {
        const antes = await firmaDelPeriodo(tx, organizationId, venueIds)
        await aplicar(tx)
        const despues = await firmaDelPeriodo(tx, organizationId, venueIds)
        let cambian = 0
        for (const [id, f] of despues) if (antes.get(id) !== f) cambian++
        for (const id of antes.keys()) if (!despues.has(id)) cambian++
        throw new FinDeSimulacion(cambian)
      },
      { timeout: 20_000 },
    )
  } catch (e) {
    if (e instanceof FinDeSimulacion) return e.resultado
    throw e
  }
  return 0
}
