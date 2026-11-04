import type { Request, Response, NextFunction } from 'express'
import type { ExportRun } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import AppError, { BadRequestError } from '@/errors/AppError'
import { resolveRequestVenueId, resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { esSuperadminDeLaSesion } from '@/services/access/rolVigente'
import { exportRunService } from '@/services/exports/exportRun.service'
import { obtenerExportador } from '@/services/exports/exportadores/registry'
import type { Cursor, Exportador } from '@/services/exports/exportadores/types'
import { EXPORT_LIMITS, estadoVisible } from '@/services/exports/exportPolicy'
import { encodeExport, sendExport } from '@/services/dashboard/export.helpers'
import { signPrivateAttachmentUrl } from '@/services/privateStorage.service'
import { exportRunnerJob } from '@/jobs/export-runner.job'

const ROLES_QUE_VEN_TODO = new Set(['OWNER', 'ADMIN', 'SUPERADMIN'])

function ctx(req: Request) {
  const venueId = resolveRequestVenueId(req, req.authContext!)
  if (!venueId) throw new BadRequestError('No venue context for the request')
  return { venueId, staffId: req.authContext!.userId }
}

function vista(
  run: Pick<
    ExportRun,
    'status' | 'processedRows' | 'totalRows' | 'format' | 'cambioACsv' | 'esperandoCobros' | 'expiresAt' | 'failureCode' | 'kind'
  >,
) {
  return {
    kind: run.kind,
    status: estadoVisible(run, new Date()), // Codex r1 #8: un READY vencido se ve EXPIRED sin esperar a la limpieza
    processedRows: run.processedRows,
    totalRows: run.totalRows,
    format: run.format === 'XLSX' ? 'xlsx' : 'csv',
    ...(run.cambioACsv ? { changedToFormat: 'csv' as const } : {}),
    waitingForPayments: run.esperandoCobros,
    expiresAt: run.expiresAt,
    failureCode: run.failureCode,
  }
}

/** Común a «pedir» y «reintentar»: valida filtros (400), autoriza (403 del GET viejo), encola o arma aquí, y contesta. */
async function responderPedido(
  req: Request,
  res: Response,
  exp: Exportador<unknown, unknown>,
  i: { formato: 'csv' | 'xlsx'; columnas: string[]; filtrosCrudos: unknown; forzarSegundoPlano?: boolean },
): Promise<void> {
  const { venueId, staffId } = ctx(req)
  const filtros = exp.parsearFiltros(i.filtrosCrudos) // fechas inválidas ⇒ 400 aquí, no un pedido que truena en segundo plano
  const bloqueo = await exp.autorizar({ venueId, staffId, esSuperadmin: await esSuperadminDeLaSesion(req.authContext) }, filtros)
  if (bloqueo) {
    res.status(bloqueo.status).json(bloqueo.body)
    return
  }
  const r = await exportRunService.pedir({
    venueId,
    staffId,
    kind: exp.kind,
    formato: i.formato,
    columnas: i.columnas,
    filtros,
    forzarSegundoPlano: i.forzarSegundoPlano,
  })
  if (r.tipo === 'rechazo') {
    res.status(413).json({
      success: false,
      message: `El rango contiene ${r.filas.toLocaleString('en-US')} filas. El máximo por exporte es ${r.maximo.toLocaleString('en-US')}. Reduce el rango o filtra.`,
    })
    return
  }
  if (r.tipo === 'demasiadosVivos') {
    res.status(429).json({
      success: false,
      message: `Ya tienes ${EXPORT_LIMITS.VIVOS_POR_USUARIO} exportes armándose. Espera a que termine alguno.`,
    })
    return
  }
  if (r.tipo === 'encolado') {
    exportRunnerJob.despertar()
    res.status(202).json({
      success: true,
      data: { runId: r.runId, status: 'QUEUED', format: r.formato, ...(r.cambioAFormato ? { changedToFormat: r.cambioAFormato } : {}) },
    })
    return
  }
  // Carril directo (< 20,000 celdas): las mismas páginas, en esta petición, nunca más grandes que TAMANO_PAGINA.
  const corte = new Date()
  const filas: unknown[] = []
  let cursor: Cursor | null = null
  for (;;) {
    const p = await exp.pagina(venueId, filtros, corte, cursor, EXPORT_LIMITS.TAMANO_PAGINA)
    filas.push(...p)
    if (p.length < EXPORT_LIMITS.TAMANO_PAGINA) break
    cursor = exp.cursorDe(p[p.length - 1])
  }
  const encoded = await encodeExport(r.formato, {
    allColumns: exp.columnas,
    requestedColumnIds: i.columnas,
    rows: filas,
    title: exp.titulo,
  })
  sendExport(res, encoded, exp.nombreArchivo)
}

export async function pedirExporte(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const exp = obtenerExportador(req.params.kind)
    if (!exp) throw new AppError('Exporte no encontrado', 404, true, 'EXPORT_KIND_DESCONOCIDO')
    const body = (req.body ?? {}) as { format?: unknown; columns?: unknown; filters?: unknown }
    if (body.format !== 'csv' && body.format !== 'xlsx') throw new BadRequestError('format debe ser csv o xlsx')
    // Sólo ids conocidos, en el orden pedido y sin repetir: se guardan en la fila y en la huella del pedido.
    // Codex código r1 P1: lineal con Set (indexOf por elemento era cuadrático: 40k basura retenían el hilo ~2 s).
    const conocidas = new Set(exp.columnas.map(c => c.id))
    const columnas = Array.isArray(body.columns)
      ? [...new Set(body.columns.filter((c): c is string => typeof c === 'string' && conocidas.has(c)))]
      : exp.columnas.map(c => c.id)
    if (columnas.length === 0) throw new BadRequestError('No valid columns requested for export')
    await responderPedido(req, res, exp, { formato: body.format, columnas, filtrosCrudos: body.filters })
  } catch (e) {
    next(e)
  }
}

async function buscarRun(req: Request): Promise<ExportRun> {
  const { venueId, staffId } = ctx(req)
  const auth = req.authContext!
  const rol = await resolveUserRoleForVenue({
    userId: staffId,
    targetVenueId: venueId,
    tokenVenueId: auth.venueId,
    tokenRole: auth.role,
    req,
  })
  const veTodo = (await esSuperadminDeLaSesion(auth)) || ROLES_QUE_VEN_TODO.has(String(rol.role ?? ''))
  // Codex r2 R2: ninguna ruta entrega una fila sin dueño (persona borrada, SetNull), para NINGÚN rol; `venueId` de la URL ya
  // excluye las de sucursal borrada.
  const run = await prisma.exportRun.findFirst({
    where: { id: req.params.runId, venueId, requestedById: veTodo ? { not: null } : staffId },
  })
  if (!run) throw new AppError('Exporte no encontrado', 404, true, 'EXPORT_NO_ENCONTRADO')
  return run
}

export async function estadoExporte(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: vista(await buscarRun(req)) })
  } catch (e) {
    next(e)
  }
}

export async function descargarExporte(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const run = await buscarRun(req)
    if (estadoVisible(run, new Date()) === 'EXPIRED') {
      res.status(410).json({ success: false, message: 'Este archivo ya expiró; vuelve a exportarlo.' })
      return
    }
    if (run.status !== 'READY' || !run.filePath) {
      res.status(409).json({ success: false, message: 'El archivo todavía no está listo.' })
      return
    }
    // Codex r1 #5: el archivo guardado pasa el MISMO candado que el GET de hoy (plan, función, recorte de Gratis) antes de firmarse.
    const exp = obtenerExportador(run.kind)
    if (!exp) throw new AppError('Exporte no encontrado', 404, true, 'EXPORT_KIND_DESCONOCIDO')
    const { venueId, staffId } = ctx(req)
    const bloqueo = await exp.autorizar(
      { venueId, staffId, esSuperadmin: await esSuperadminDeLaSesion(req.authContext) },
      exp.parsearFiltros(run.params),
    )
    if (bloqueo) {
      res.status(bloqueo.status).json(bloqueo.body)
      return
    }
    // Codex r5 B2: `autorizar` pudo tardar y el pedido vencer mientras; se vuelve a mirar, y la URL nunca dura más que el pedido.
    if (!run.expiresAt || estadoVisible(run, new Date()) === 'EXPIRED') {
      res.status(410).json({ success: false, message: 'Este archivo ya expiró; vuelve a exportarlo.' })
      return
    }
    const url = await signPrivateAttachmentUrl(run.filePath, run.expiresAt) // min(10 min, vencimiento), attachment; nunca se guarda
    res.json({ success: true, data: { url, fileName: run.fileName ?? 'export' } })
  } catch (e) {
    next(e)
  }
}

export async function reintentarExporte(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const run = await buscarRun(req)
    const visible = estadoVisible(run, new Date()) // Codex r1 #8: también un READY vencido
    if (visible !== 'FAILED' && visible !== 'EXPIRED') {
      res.status(409).json({ success: false, message: 'Este archivo no necesita armarse otra vez.' })
      return
    }
    const exp = obtenerExportador(run.kind)
    if (!exp) throw new AppError('Exporte no encontrado', 404, true, 'EXPORT_KIND_DESCONOCIDO')
    await responderPedido(req, res, exp, {
      formato: run.format === 'XLSX' ? 'xlsx' : 'csv',
      columnas: run.columns,
      filtrosCrudos: run.params,
      forzarSegundoPlano: true,
    })
  } catch (e) {
    next(e)
  }
}

export async function listarExportes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, staffId } = ctx(req)
    const kind = String(req.query.kind) // la ruta ya exige ?kind= de un exportador real
    const runs = await prisma.exportRun.findMany({
      where: { venueId, requestedById: staffId, kind },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    })
    res.json({ success: true, data: runs.map(r => ({ id: r.id, fileName: r.fileName, createdAt: r.createdAt, ...vista(r) })) })
  } catch (e) {
    next(e)
  }
}
