import { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { venueHasServicePayAccess } from '../../services/dashboard/staffPay/acceso'
import * as niveles from '../../services/dashboard/staffPay/niveles.service'
import * as tablas from '../../services/dashboard/staffPay/tablas.service'
import * as reporte from '../../services/dashboard/staffPay/reporte.service'
import * as ajustes from '../../services/dashboard/staffPay/ajustesClase.service'
import { hoyLocal } from '../../services/dashboard/staffPay/periodos'
import * as periodos from '../../services/dashboard/staffPay/periodosGuardados'
import * as cierre from '../../services/dashboard/staffPay/cierre.service'
import * as manuales from '../../services/dashboard/staffPay/ajustesManuales.service'
import * as recibos from '../../services/dashboard/staffPay/recibos.service'
import { sendExport } from '../../services/dashboard/export.helpers'

export function ctx(req: Request): { venueId: string; userId: string } {
  const venueId = req.params.venueId
  if (!venueId) throw new BadRequestError('Venue ID requerido en la ruta')
  const { userId } = (req as any).authContext
  return { venueId, userId }
}

export async function getAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json({ enabled: await venueHasServicePayAccess(venueId) })
  } catch (error) {
    next(error)
  }
}

export async function orgDeVenue(venueId: string): Promise<{ organizationId: string; tz: string }> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
  return { organizationId: v.organizationId, tz: v.timezone || 'America/Mexico_City' }
}

export async function listLevels(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json(await niveles.listarNiveles((await orgDeVenue(venueId)).organizationId))
  } catch (e) {
    next(e)
  }
}

export async function createLevel(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    res.status(201).json(
      await niveles.crearNivel({
        organizationId: (await orgDeVenue(venueId)).organizationId,
        name: req.body.name,
        actorId: userId,
        venueId,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function updateLevel(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { name, sortOrder, archived } = req.body
    res.json(
      await niveles.editarNivel({
        organizationId: (await orgDeVenue(venueId)).organizationId,
        levelId: req.params.levelId,
        name,
        sortOrder,
        archived,
        actorId: userId,
        venueId,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function assignLevel(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { staffId, payLevelId, effectiveFrom, simular } = req.body
    res.json(
      await niveles.asignarNivel({
        organizationId: (await orgDeVenue(venueId)).organizationId,
        staffId,
        payLevelId,
        effectiveFrom,
        actorId: userId,
        venueId,
        soloSimular: !!simular,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function currentAssignments(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    const { organizationId, tz } = await orgDeVenue(venueId)
    res.json(await niveles.nivelesVigentes(organizationId, (req.query.fecha as string) || hoyLocal(tz)))
  } catch (e) {
    next(e)
  }
}

export async function assignmentHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json(await niveles.historialDeNivel((await orgDeVenue(venueId)).organizationId, req.params.staffId))
  } catch (e) {
    next(e)
  }
}

export async function listTables(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    const { tz } = await orgDeVenue(venueId)
    res.json(await tablas.listarTablas(venueId, (req.query.fecha as string) || hoyLocal(tz)))
  } catch (e) {
    next(e)
  }
}

export async function createTable(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { name, productIds } = req.body
    res
      .status(201)
      .json(
        await tablas.crearTabla({ venueId, organizationId: (await orgDeVenue(venueId)).organizationId, name, productIds, actorId: userId }),
      )
  } catch (e) {
    next(e)
  }
}

export async function publishVersion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { effectiveFrom, countMode, maxCount, cells, simular } = req.body
    res.json(
      await tablas.publicarVersion({
        venueId,
        organizationId: (await orgDeVenue(venueId)).organizationId,
        tableId: req.params.tableId,
        effectiveFrom,
        countMode,
        maxCount,
        // Sólo las tres llaves de cada celda: nada extra del body llega al createMany.
        cells: (cells as tablas.CeldaInput[]).map(({ payLevelId, count, amount }) => ({ payLevelId, count, amount })),
        actorId: userId,
        soloSimular: !!simular,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function archiveTable(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    res.json(await tablas.archivarTabla({ venueId, tableId: req.params.tableId, archivedFrom: req.body.archivedFrom, actorId: userId }))
  } catch (e) {
    next(e)
  }
}

export async function tableHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json(await tablas.historialDeTabla(venueId, req.params.tableId))
  } catch (e) {
    next(e)
  }
}

// Reporte del periodo abierto. `req.query` ya viene parseado por validateRequest (reporteQuerySchema / cursorQuerySchema);
// aun así se pasan campos explícitos, nunca el objeto entero.
function consultaPaginada(req: Request): { fecha?: string; sede?: string; offset: number; limit: number } {
  const q = req.query as { fecha?: string; sede?: string; offset?: number | string; limit?: number | string }
  return { fecha: q.fecha, sede: q.sede, offset: Number(q.offset ?? 0), limit: Number(q.limit ?? 50) }
}
function consultaConCursor(req: Request): { fecha?: string; sede?: string; despuesDe?: string; limit: number } {
  const q = req.query as { fecha?: string; sede?: string; cursor?: string; limit?: number | string }
  return { fecha: q.fecha, sede: q.sede, despuesDe: q.cursor, limit: Number(q.limit ?? 50) }
}

export async function getReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { fecha, sede, offset, limit } = consultaPaginada(req)
    res.json(await reporte.reportePeriodo({ userId, venueId, fecha, sede, offset, limit }))
  } catch (e) {
    next(e)
  }
}

export async function getStaffDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { fecha, sede, despuesDe, limit } = consultaConCursor(req)
    res.json(await reporte.detallePersona({ userId, venueId, staffId: req.params.staffId, fecha, sede, despuesDe, limit }))
  } catch (e) {
    next(e)
  }
}

export async function getExceptions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { fecha, sede, despuesDe, limit } = consultaConCursor(req)
    res.json(await reporte.excepcionesPeriodo({ userId, venueId, fecha, sede, despuesDe, limit }))
  } catch (e) {
    next(e)
  }
}

export async function getOrphans(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { fecha, sede, offset, limit } = consultaPaginada(req)
    res.json(await reporte.huerfanasPeriodo({ userId, venueId, fecha, sede, offset, limit }))
  } catch (e) {
    next(e)
  }
}

// Tarjeta y ajustes de una clase (spec §5.4). El service busca la clase por id Y sede.
export async function getClassPay(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json(await ajustes.pagoDeClase(venueId, req.params.sessionId))
  } catch (e) {
    next(e)
  }
}

export async function putClassPayAdjustments(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    // Campos explícitos: nada extra del body llega al service.
    const { payCountOverride, payAmountOverride, payExcluded, reason } = req.body
    res.json(
      await ajustes.guardarAjusteDeClase({
        venueId,
        classSessionId: req.params.sessionId,
        payCountOverride,
        payAmountOverride,
        payExcluded,
        reason,
        actorId: userId,
      }),
    )
  } catch (e) {
    next(e)
  }
}

// ── Fase 2: cerrar y pagar. Los errores de los services llevan su `code` (PERIODO_CERRADO, HUELLA_CAMBIO…): pasan a
// `next` tal cual. Los parámetros SÓLO para pruebas (ahora, tamLote, entreLotes, trasPreparar) jamás salen de la petición. ──
const manejar = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await fn(req))
  } catch (e) {
    next(e)
  }
}

export const listPeriods = manejar(req =>
  periodos.listarPeriodos({ ...ctx(req), antesDe: req.query.antesDe ? String(req.query.antesDe) : undefined, limit: 24 }),
)
export const patchPeriodicity = manejar(req => periodos.cambiarPeriodicidad({ ...ctx(req), periodicidad: req.body.periodicidad }))
export const getClosePreview = manejar(req => cierre.previewCierre({ ...ctx(req), fecha: String(req.query.fecha) }))
export const postClose = manejar(req => {
  const { fecha, huellaEsperada, confirmarHuerfanas } = req.body
  return cierre.cerrarPeriodo({ ...ctx(req), fecha, huellaEsperada, confirmarHuerfanas })
})
export const postPaid = manejar(req => {
  const { staffId, nota } = req.body
  return recibos.marcarPagado({ ...ctx(req), periodId: req.params.periodId, staffId, nota })
})
export const postAdjustment = manejar(req => {
  // Campos explícitos: nada extra del body (p. ej. una huellaEsperada) llega al service.
  const { sede, staffId, amount, reason, fecha, clientKey } = req.body
  return manuales.agregarAjusteManual({ ...ctx(req), sede, staffId, amount, reason, fecha, clientKey })
})
export const getReceipt = manejar(req =>
  recibos.reciboDePersona({
    ...ctx(req),
    staffId: req.params.staffId,
    fecha: String(req.query.fecha),
    cursor: req.query.cursor ? String(req.query.cursor) : undefined,
    limit: Number(req.query.limit ?? 100),
  }),
)

export async function getReceiptExport(req: Request, res: Response, next: NextFunction) {
  try {
    const { encoded, nombre } = await recibos.exportarRecibo({
      ...ctx(req),
      staffId: req.params.staffId,
      fecha: String(req.query.fecha),
      format: req.query.format as 'pdf' | 'xlsx',
    })
    sendExport(res, encoded, nombre)
  } catch (e) {
    next(e)
  }
}
