/**
 * App de campo (bloque 0): custodia de SIMs desde el celular del promotor. El celular reintenta sin caché de
 * idempotencia, así que el estado de la SIM es la prueba: si ESTA persona ya aceptó/rechazó, el reintento es éxito.
 * El servicio ya revisa la persona (NOT_IN_YOUR_CUSTODY) antes de ALREADY_ACCEPTED / ALREADY_REJECTED.
 *
 * - La organización sale de la sucursal de la dirección, la que autorizó `checkPermission`, nunca del token (Codex C2).
 * - Cada SIM viaja con la `custodyVersion` que vio el celular (Codex C3): si la recolectaron y se la volvieron a asignar, la
 *   decisión vieja no vale para la entrega nueva (`ASIGNACION_CAMBIO`, definitivo: el promotor decide otra vez).
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

const ASIGNACION_CAMBIO = {
  code: 'ASIGNACION_CAMBIO',
  message: 'Esta SIM se recolectó y se te volvió a asignar. Revísala otra vez antes de aceptarla o rechazarla.',
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

/**
 * Lo que dice la SIM HOY de lo que pide el celular: ya quedó como pidió (`repetida`), o es otra entrega (`cambio`).
 * `null`: le toca decidir al servicio (que también da NOT_FOUND / NOT_IN_YOUR_CUSTODY / INVALID_STATE).
 * ponytail: se lee antes de llamar al servicio, que relee por su cuenta; una reasignación en esos milisegundos la acepta el
 * servicio. Cerrarlo del todo pide que el servicio reciba la versión esperada.
 */
async function segunHoy(
  organizationId: string,
  staffId: string,
  sim: SimDelCelular,
  hecha: SerializedItemCustodyState,
): Promise<'repetida' | 'cambio' | null> {
  const hoy = await simDe(organizationId, sim.serialNumber)
  if (!hoy || hoy.assignedPromoterId !== staffId) return null
  if (hoy.custodyState === hecha) return 'repetida'
  if (hoy.custodyState === 'PROMOTER_PENDING' && hoy.custodyVersion !== sim.custodyVersion) return 'cambio'
  return null
}

export async function aceptarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = await actorDe(req)
    const sims: SimDelCelular[] = req.body.sims
    const filas: (Fila | null)[] = []
    for (const sim of sims) {
      const hoy = await segunHoy(actor.organizationId, actor.staffId, sim, 'PROMOTER_HELD')
      if (hoy === 'repetida') filas.push({ serialNumber: sim.serialNumber, status: 'ok', repetida: true })
      else if (hoy === 'cambio') filas.push({ serialNumber: sim.serialNumber, status: 'error', ...ASIGNACION_CAMBIO })
      else filas.push(null)
    }

    const porAceptar = sims.flatMap((_, i) => (filas[i] === null ? [i] : [])) // posiciones en la petición
    const r = porAceptar.length
      ? await simCustodyService.accept({ actor, serialNumbers: porAceptar.map(i => sims[i].serialNumber), idempotencyRequestId: null })
      : { results: [] }
    for (const [k, row] of r.results.entries()) {
      const sim = sims[porAceptar[k]]
      let fila: Fila
      if (row.status === 'ok') fila = { serialNumber: row.serialNumber, status: 'ok', repetida: false }
      else if (row.code === 'ALREADY_ACCEPTED') fila = { serialNumber: row.serialNumber, status: 'ok', repetida: true }
      else if (row.code === 'VERSION_CONFLICT') {
        fila =
          (await segunHoy(actor.organizationId, actor.staffId, sim, 'PROMOTER_HELD')) === 'repetida'
            ? { serialNumber: row.serialNumber, status: 'ok', repetida: true }
            : { serialNumber: row.serialNumber, status: 'error', ...EN_PROCESO }
      } else fila = { serialNumber: row.serialNumber, status: 'error', code: row.code, message: row.message }
      filas[porAceptar[k]] = fila
    }

    const results = filas as Fila[]
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

    const hoy = await segunHoy(actor.organizationId, actor.staffId, sim, 'PROMOTER_REJECTED')
    if (hoy === 'repetida') return yaRechazada()
    if (hoy === 'cambio') return res.status(409).json(ASIGNACION_CAMBIO)
    try {
      const r = await simCustodyService.reject({ actor, serialNumber: sim.serialNumber })
      return res.status(200).json({ ...r, repetida: false })
    } catch (err) {
      if (!(err instanceof SimCustodyError)) throw err
      if (err.code === 'ALREADY_REJECTED') return yaRechazada()
      if (err.code === 'VERSION_CONFLICT') {
        if ((await segunHoy(actor.organizationId, actor.staffId, sim, 'PROMOTER_REJECTED')) === 'repetida') return yaRechazada()
        return res.status(409).json(EN_PROCESO)
      }
      return res.status(err.httpStatus).json({ code: err.code, message: err.message })
    }
  } catch (err) {
    next(err)
  }
}
