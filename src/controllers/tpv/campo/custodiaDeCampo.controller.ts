/**
 * App de campo (bloque 0): custodia de SIMs desde el celular del promotor. El celular reintenta sin caché de
 * idempotencia, así que el estado de la SIM es la prueba: si ESTA persona ya aceptó/rechazó, el reintento es éxito.
 * El servicio ya revisa la persona (NOT_IN_YOUR_CUSTODY) antes de ALREADY_ACCEPTED / ALREADY_REJECTED.
 *
 * - La organización sale de la sucursal de la dirección, la que autorizó `checkPermission`, nunca del token (Codex C2).
 * - Cada SIM viaja con la `custodyVersion` que vio el celular y el servicio la exige DENTRO de su transacción
 *   (`versionEsperada`, Codex C3): si la recolectaron y se la volvieron a asignar, la decisión vieja no vale para la entrega
 *   nueva (`ASIGNACION_CAMBIO`, definitivo: el promotor decide otra vez). Una decisión ya aplicada sigue saliendo repetida.
 * - `VERSION_CONFLICT` del servicio (otra entrega le ganó la escritura) se relee: si ya quedó como pidió, es éxito; si no,
 *   `409 CUSTODIA_EN_PROCESO`, reintentable (Codex C6). El mapper de las terminales no cambia.
 * Las respuestas de error son `{ code, message }`, como las ventas y las checadas del celular.
 */
import { SerializedItemCustodyState } from '@prisma/client'
import { NextFunction, Request, Response } from 'express'
import { NotFoundError } from '@/errors/AppError'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'
import { simCustodyService } from '@/services/serialized-inventory/custody.service'
import prisma from '@/utils/prismaClient'

interface SimDelCelular {
  serialNumber: string
  custodyVersion: number
}
interface Fila {
  serialNumber: string
  status: 'ok' | 'error'
  code?: string
  message?: string
  repetida?: boolean
}

const EN_PROCESO = { code: 'CUSTODIA_EN_PROCESO', message: 'La SIM cambió mientras se guardaba. Reintenta en un momento.' }

async function actorDe(req: Request) {
  const venue = await prisma.venue.findUnique({ where: { id: req.params.venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  const { userId, role } = req.authContext!
  // El rol que `checkPermission` resolvió en ESA sucursal; el del token sólo si no lo dejó.
  return { staffId: userId, organizationId: venue.organizationId, role: (req as any).resolvedRole ?? role }
}

/** La SIM como la busca el servicio: de la organización y, si no, de una sucursal suya (las de antes). */
async function simDe(organizationId: string, serialNumber: string) {
  const select = { custodyState: true, assignedPromoterId: true, custodyVersion: true }
  const serial = { equals: serialNumber, mode: 'insensitive' as const }
  return (
    (await prisma.serializedItem.findFirst({ where: { organizationId, serialNumber: serial }, select })) ??
    prisma.serializedItem.findFirst({ where: { serialNumber: serial, venue: { organizationId } }, select })
  )
}

/** Tras un VERSION_CONFLICT: ¿la SIM ya quedó como pidió esta persona (la otra entrega ganó)? */
async function quedoComoPidio(organizationId: string, staffId: string, serialNumber: string, hecha: SerializedItemCustodyState) {
  const hoy = await simDe(organizationId, serialNumber)
  return hoy?.assignedPromoterId === staffId && hoy.custodyState === hecha
}

export async function aceptarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = await actorDe(req)
    const sims: SimDelCelular[] = req.body.sims
    const r = await simCustodyService.accept({
      actor,
      serialNumbers: sims.map(s => s.serialNumber),
      idempotencyRequestId: null,
      versionEsperada: Object.fromEntries(sims.map(s => [s.serialNumber, s.custodyVersion])),
    })
    const results: Fila[] = []
    for (const row of r.results) {
      const { serialNumber } = row
      if (row.status === 'ok') results.push({ serialNumber, status: 'ok', repetida: false })
      else if (row.code === 'ALREADY_ACCEPTED') results.push({ serialNumber, status: 'ok', repetida: true })
      else if (row.code === 'VERSION_CONFLICT') {
        results.push(
          (await quedoComoPidio(actor.organizationId, actor.staffId, serialNumber, 'PROMOTER_HELD'))
            ? { serialNumber, status: 'ok', repetida: true }
            : { serialNumber, status: 'error', ...EN_PROCESO },
        )
      } else results.push({ serialNumber, status: 'error', code: row.code, message: row.message })
    }

    const succeeded = results.filter(x => x.status === 'ok').length
    const summary = { total: results.length, succeeded, failed: results.length - succeeded }
    // Una SIM sin resolver hace reintentable toda la petición: el reintento devuelve las demás como repetidas.
    if (results.some(x => x.code === EN_PROCESO.code)) return res.status(409).json({ ...EN_PROCESO, summary, results })
    res.status(200).json({ summary, results })
  } catch (err) {
    next(err)
  }
}

export async function rechazarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = await actorDe(req)
    const sim: SimDelCelular = req.body
    const yaRechazada = () => res.status(200).json({ custodyState: 'PROMOTER_REJECTED', repetida: true })
    try {
      const r = await simCustodyService.reject({ actor, serialNumber: sim.serialNumber, versionEsperada: sim.custodyVersion })
      return res.status(200).json({ ...r, repetida: false })
    } catch (err) {
      if (!(err instanceof SimCustodyError)) throw err
      if (err.code === 'ALREADY_REJECTED') return yaRechazada()
      if (err.code === 'VERSION_CONFLICT') {
        if (await quedoComoPidio(actor.organizationId, actor.staffId, sim.serialNumber, 'PROMOTER_REJECTED')) return yaRechazada()
        return res.status(409).json(EN_PROCESO)
      }
      return res.status(err.httpStatus).json({ code: err.code, message: err.message })
    }
  } catch (err) {
    next(err)
  }
}
