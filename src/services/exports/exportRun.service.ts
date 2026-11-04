import { createHash } from 'node:crypto'
import { NotificationChannel, type ExportRun } from '@prisma/client'
import logger from '@/config/logger'
import { FRONTEND_URL } from '@/config/env'
import prismaReal from '@/utils/prismaClient'
import {
  abrirEscrituraPrivada,
  buildPrivateFilePath,
  deletePrivateFile,
  deletePrivateFolder,
  savePrivateFileAtPath,
} from '@/services/privateStorage.service'
import { createNotification, getUserNotificationPreferences, isInQuietHours } from '@/services/dashboard/notification.dashboard.service'
import emailService, { type ExportResultEmailData } from '@/services/email.service'
import { conNegocio } from '@/services/demo/candadoDemo'
import { admitePorMemoria, decidirCarril, EXPORT_LIMITS, memoriaEstimadaMb } from './exportPolicy'
import { esperarTurno as esperarTurnoReal } from './exportSemaforo'
import { EscritorCsv, abrirLibroXlsx, type LibroXlsx } from './exportEscritores'
import { obtenerExportador } from './exportadores/registry'
import type { Cursor, Exportador } from './exportadores/types'
import type { CabeceraXlsx } from './xlsxDesdeMatriz'

const LEASE_MS = 2 * 60_000
const MAX_INTENTOS = 2
export const MAX_AVISOS = 5
const DIA_MS = 24 * 3600 * 1000
export const ESPERA_MAX_POR_MEMORIA_MS = 5 * 60_000
const CANDIDATOS_POR_RECLAMO = 10
const LOTE_DE_LIMPIEZA = 200
/**
 * Codex r4 (rediseño de la familia «archivo que sobrevive a la limpieza»): ningún intento trabaja cerca o después del
 * vencimiento. El reclamo sólo toma pedidos con `expiresAt > ahora + 1 h`; los que ya no cumplen eso los cierra la limpieza
 * como FAILED `VENCIO_SIN_ARMARSE`. Así un intento sólo escribe (a) mientras la fila sigue RUNNING con su lease vigente, y la
 * limpieza no borra la carpeta de un RUNNING, o (b) unos minutos después de perder la cerca (lease 2 min con latido ≤ 30 s,
 * subida del Excel 60 s, CSV abortado por el latido). El caso (b) queda cubierto porque el FAILED se marca AL FINAL de la
 * pasada (su carpeta se borra en la siguiente, un día después). Lo que aun así nazca después de esa limpieza lo borra la
 * regla del bucket a los 8 días de nacer (Codex r5 B1, `scripts/exportes-regla-de-borrado.ts`): el código ya no lo persigue.
 */
export const MARGEN_DE_VENCIMIENTO_MS = 60 * 60_000
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const SIN_RESPUESTA = Symbol('sin-respuesta')

export interface DepsExportRun {
  prisma: typeof prismaReal
  ahora: () => Date
  esperarTurno: (alEsperar: () => Promise<void>) => Promise<{ esperoMs: number; forzado: boolean }>
  rssMb: () => number
  rutaDelArchivo: (scope: string, nombre: string) => string
  abrirEscritura: (path: string, contentType: string) => NodeJS.WritableStream
  guardarArchivo: (path: string, buffer: Buffer, contentType: string) => Promise<void>
  borrarArchivo: (path: string) => Promise<void>
  /** Borra la carpeta entera del pedido (todos sus intentos): la limpieza (Codex r2 R3). */
  borrarCarpeta: (scope: string) => Promise<void>
  abrirLibro: (c: CabeceraXlsx) => LibroXlsx
  notificar: (n: Parameters<typeof createNotification>[0]) => Promise<unknown>
  /** Codex r3 N3: la preferencia de la persona ANTES de mandar la campanita (apagada ⇒ omitida; horas de silencio ⇒ se aplaza). */
  campanitaSegunPreferencia: (staffId: string, venueId: string) => Promise<'mandar' | 'apagada' | 'silencio'>
  enviarCorreo: (to: string, data: ExportResultEmailData) => Promise<boolean>
  enlaceDelPedido: (venueSlug: string, runId: string) => string
  campanitaMaxMs: number
  correoMaxMs: number
  /** Cada cuánto se renueva el lease mientras se espera el cierre o la subida (≤ 30 s; el lease dura 2 min). */
  latidoMs: number
  exportador: (kind: string) => Exportador<unknown, unknown> | null
}

const defaults: DepsExportRun = {
  prisma: prismaReal,
  ahora: () => new Date(),
  esperarTurno: alEsperar => esperarTurnoReal({ alEsperar }),
  rssMb: () => process.memoryUsage().rss / 1e6,
  rutaDelArchivo: buildPrivateFilePath,
  abrirEscritura: abrirEscrituraPrivada,
  guardarArchivo: savePrivateFileAtPath,
  borrarArchivo: deletePrivateFile,
  borrarCarpeta: deletePrivateFolder,
  abrirLibro: c => abrirLibroXlsx(c),
  notificar: createNotification,
  // Las mismas dos reglas que `createNotification` (`notification.dashboard.service.ts:85-96`), leídas ANTES de gastar un intento.
  campanitaSegunPreferencia: async (staffId, venueId) => {
    const p = await getUserNotificationPreferences(staffId, venueId, 'EXPORT_READY')
    if (!p.enabled) return 'apagada'
    return isInQuietHours(p.quietStart || undefined, p.quietEnd || undefined) ? 'silencio' : 'mandar'
  },
  enviarCorreo: (to, data) => emailService.sendExportResultEmail(to, data),
  // El enlace abre el DASHBOARD (pide sesión y permiso); nunca una liga de Storage.
  enlaceDelPedido: (slug, runId) => `${FRONTEND_URL.replace(/\/+$/, '')}/venues/${slug}/exports/${runId}`,
  campanitaMaxMs: 10_000,
  correoMaxMs: 20_000,
  latidoMs: 30_000,
  exportador: obtenerExportador,
}

export type ResultadoPedido =
  | { tipo: 'directo'; formato: 'csv' | 'xlsx'; filas: number }
  | { tipo: 'encolado'; runId: string; formato: 'csv' | 'xlsx'; cambioAFormato?: 'csv'; reutilizado: boolean }
  | { tipo: 'rechazo'; filas: number; maximo: number }
  | { tipo: 'demasiadosVivos' }

export interface Pedido {
  venueId: string
  staffId: string
  kind: string
  formato: 'csv' | 'xlsx'
  columnas: string[]
  filtros: unknown
  /** El reintento del enlace: siempre en segundo plano (contesta 202), aunque hoy quepa en el carril directo. */
  forzarSegundoPlano?: boolean
}

export interface Reclamo {
  runId: string
  attempt: number
  venueId: string | null
}

function estable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(estable)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map(k => [k, estable((v as Record<string, unknown>)[k])]),
    )
  return v
}

/** Identidad del pedido: la MISMA sucursal, exporte, formato, columnas y filtros (Codex r1 #2: sin sucursal, A y B se mezclaban). */
export function huellaDe(i: { venueId: string; kind: string; formato: string; columnas: string[]; filtros: unknown }): string {
  return createHash('sha256')
    .update(JSON.stringify(estable({ ...i, columnas: [...i.columnas].sort() })))
    .digest('hex')
}

const columnasPedidas = (exp: Exportador<unknown, unknown>, columnas: string[]) => exp.columnas.filter(c => columnas.includes(c.id))

/** Carpeta del pedido. 🔴 Nunca sin id: `exports/` a secas borraría los exportes de TODOS los negocios. */
function carpetaDe(runId: string): string {
  if (!runId) throw new Error('EXPORT_RUN_SIN_ID')
  return `exports/${runId}`
}

async function aLoMas<T>(p: Promise<T>, ms: number): Promise<T | typeof SIN_RESPUESTA> {
  let reloj: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<typeof SIN_RESPUESTA>(r => (reloj = setTimeout(() => r(SIN_RESPUESTA), ms)))])
  } finally {
    clearTimeout(reloj)
  }
}

/** true si la promesa se cumplió a tiempo y no dijo `false` (el correo devuelve `false` cuando no salió). */
async function logrado(p: Promise<unknown>, ms: number): Promise<boolean> {
  p.catch(() => undefined) // si se abandona por el plazo, su falla no queda sin atender
  try {
    const r = await aLoMas(p, ms)
    return r !== SIN_RESPUESTA && r !== false
  } catch {
    return false
  }
}

class LeasePerdido extends Error {
  constructor() {
    super('LEASE_PERDIDO')
  }
}

export function crearExportRunService(overrides: Partial<DepsExportRun> = {}) {
  const d: DepsExportRun = { ...defaults, ...overrides }

  async function pedir(i: Pedido): Promise<ResultadoPedido> {
    const exp = d.exportador(i.kind)
    if (!exp) throw new Error(`EXPORT_KIND_DESCONOCIDO:${i.kind}`)
    const cols = columnasPedidas(exp, i.columnas)
    const corte = d.ahora()
    const filas = await exp.contar(i.venueId, i.filtros, corte) // fuera del candado: puede tardar
    const dec = decidirCarril({ filas, columnas: Math.max(cols.length, 1), formato: i.formato })
    if (dec.carril === 'rechazo') return { tipo: 'rechazo', filas: dec.filas, maximo: dec.maximo }
    if (dec.carril === 'directo' && !i.forzarSegundoPlano) return { tipo: 'directo', formato: dec.formato, filas }
    const formato = dec.formato
    const cambioAFormato = dec.carril === 'segundoPlano' ? dec.cambioAFormato : undefined
    const huella = huellaDe({ venueId: i.venueId, kind: i.kind, formato, columnas: i.columnas, filtros: i.filtros })

    // Codex r1 #3: comprobar y crear bajo el candado de la persona (sin Redis): dos clics simultáneos ⇒ un pedido; nunca más de 3 vivos.
    return d.prisma.$transaction(async (tx): Promise<ResultadoPedido> => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`export:${i.staffId}`}))::text`
      // Codex r4 (duda al aplicar): un pedido a menos de MARGEN_DE_VENCIMIENTO ya no se reclama; no se reutiliza ni cuenta para el tope.
      const vigente = { expiresAt: { gt: new Date(+corte + MARGEN_DE_VENCIMIENTO_MS) } }
      const vivo = await tx.exportRun.findFirst({
        where: { requestedById: i.staffId, venueId: i.venueId, huella, status: { in: ['QUEUED', 'RUNNING'] }, ...vigente },
      })
      if (vivo) return { tipo: 'encolado', runId: vivo.id, formato, cambioAFormato, reutilizado: true }
      const vivos = await tx.exportRun.count({ where: { requestedById: i.staffId, status: { in: ['QUEUED', 'RUNNING'] }, ...vigente } })
      if (vivos >= EXPORT_LIMITS.VIVOS_POR_USUARIO) return { tipo: 'demasiadosVivos' }
      const run = await tx.exportRun.create({
        data: {
          venueId: i.venueId,
          requestedById: i.staffId,
          kind: i.kind,
          format: formato === 'xlsx' ? 'XLSX' : 'CSV',
          cambioACsv: !!cambioAFormato,
          params: i.filtros as object,
          columns: i.columnas,
          huella,
          totalRows: filas,
          corte,
          expiresAt: new Date(+corte + EXPORT_LIMITS.RETENCION_DIAS * DIA_MS),
        },
      })
      return { tipo: 'encolado', runId: run.id, formato, cambioAFormato, reutilizado: false }
    })
  }

  /** Borra un archivo y SÓLO entonces suelta su ruta (Codex r1 #7): si el borrado falla, la limpieza diaria lo reintenta. */
  async function soltarArchivo(runId: string, path: string): Promise<boolean> {
    try {
      await d.borrarArchivo(path)
    } catch {
      logger.warn('[exportes] no se pudo borrar un archivo; queda para la limpieza', { runId })
      return false
    }
    await d.prisma.exportRun.updateMany({ where: { id: runId, filePath: path }, data: { filePath: null } })
    return true
  }

  async function reclamarSiguiente(): Promise<Reclamo | null> {
    const ahora = d.ahora()
    // Agotados (2 intentos con el lease vencido) ⇒ FAILED por CAS; su correo lo manda barrerAvisos en esta misma vuelta.
    const agotados = await d.prisma.exportRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: ahora }, attempts: { gte: MAX_INTENTOS } },
      take: CANDIDATOS_POR_RECLAMO,
    })
    for (const r of agotados) {
      const { count } = await d.prisma.exportRun.updateMany({
        where: { id: r.id, status: 'RUNNING', attempts: r.attempts, leaseExpiresAt: { lt: ahora } },
        data: { status: 'FAILED', failureCode: 'REINTENTOS_AGOTADOS', finishedAt: ahora, leaseExpiresAt: null, esperandoCobros: false },
      })
      if (count === 1 && r.filePath) await soltarArchivo(r.id, r.filePath)
    }
    // Codex r4: nunca se reclama un pedido a menos de 1 h de vencer (ni uno ya vencido): lo cierra la limpieza como VENCIO_SIN_ARMARSE.
    const vigenteHasta = new Date(+ahora + MARGEN_DE_VENCIMIENTO_MS)
    const candidatos = await d.prisma.exportRun.findMany({
      where: { expiresAt: { gt: vigenteHasta }, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', leaseExpiresAt: { lt: ahora } }] },
      orderBy: { createdAt: 'asc' },
      take: CANDIDATOS_POR_RECLAMO,
    })
    for (const c of candidatos) {
      let format = c.format
      let cambioACsv = c.cambioACsv
      if (format === 'XLSX') {
        const est = memoriaEstimadaMb({ filas: c.totalRows, columnas: c.columns.length, formato: 'xlsx' })
        if (!admitePorMemoria({ estimadoMb: est, rssMb: d.rssMb() })) {
          if (+ahora - +c.createdAt < ESPERA_MAX_POR_MEMORIA_MS) continue // no bloquea a los de atrás
          format = 'CSV' // lleva 5 min sin memoria: mejor un CSV hoy que un Excel nunca
          cambioACsv = true
        }
      }
      // Codex r1 #4: CAS — sólo gana si sigue con el intento leído Y (QUEUED o con el lease VENCIDO en este instante).
      // Codex r4: y si sigue lejos de vencer (la condición del candidato, repetida en el WHERE).
      const { count } = await d.prisma.exportRun.updateMany({
        where: {
          id: c.id,
          attempts: c.attempts,
          expiresAt: { gt: vigenteHasta },
          OR: [{ status: 'QUEUED' }, { status: 'RUNNING', leaseExpiresAt: { lt: ahora } }],
        },
        data: {
          status: 'RUNNING',
          format,
          cambioACsv,
          attempts: c.attempts + 1,
          leaseExpiresAt: new Date(+ahora + LEASE_MS),
          heartbeatAt: ahora,
          startedAt: c.startedAt ?? ahora,
          processedRows: 0,
          esperandoCobros: false,
        },
      })
      if (count === 1) return { runId: c.id, attempt: c.attempts + 1, venueId: c.venueId }
    }
    return null
  }

  async function procesar(runId: string, attempt: number): Promise<void> {
    const run = await d.prisma.exportRun.findUnique({ where: { id: runId } })
    // Codex r1 #4: sólo trabaja el intento que reclamó; uno tardío con otro intento no toca NADA.
    if (!run || run.status !== 'RUNNING' || run.attempts !== attempt) return
    const exp = d.exportador(run.kind)
    const filtros = run.params as unknown
    const cols = exp ? columnasPedidas(exp, run.columns) : []
    const ext = run.format === 'XLSX' ? 'xlsx' : 'csv'
    const fileName = `${exp?.nombreArchivo ?? 'export'}-${run.corte.toISOString().slice(0, 10)}.${ext}`
    let path: string | null = null
    let escritor: EscritorCsv | null = null
    let libro: LibroXlsx | null = null
    let subido = false // el objeto de ESTE intento ya existe en Storage (CSV cerrado o Excel subido)

    // Toda escritura lleva ESTE intento en el WHERE: si no afecta filas, otro se quedó el pedido.
    const latir = async (data: Record<string, unknown> = {}) => {
      const ahora = d.ahora()
      const { count } = await d.prisma.exportRun.updateMany({
        where: { id: runId, status: 'RUNNING', attempts: attempt },
        data: { ...data, heartbeatAt: ahora, leaseExpiresAt: new Date(+ahora + LEASE_MS) },
      })
      if (count !== 1) throw new LeasePerdido()
    }

    /** Mantiene vivo el lease mientras espera algo largo (cerrar el CSV o el Excel, subirlo). Si un latido pierde la cerca, aborta. */
    const conLatido = async <T>(espera: Promise<T>, abortar: () => void): Promise<T> => {
      let perdido: unknown
      const reloj = setInterval(() => {
        latir().catch(e => {
          perdido ??= e
          abortar()
        })
      }, d.latidoMs)
      try {
        const r = await espera
        if (perdido) throw perdido
        return r
      } catch (e) {
        throw perdido ?? e
      } finally {
        clearInterval(reloj)
      }
    }

    try {
      if (!exp || !run.venueId) throw new Error('EXPORT_KIND_DESCONOCIDO')
      if (run.filePath) await d.borrarArchivo(run.filePath) // parcial de un intento que murió; si falla, el catch conserva su ruta
      path = d.rutaDelArchivo(`${carpetaDe(run.id)}/${attempt}`, fileName) // Codex r2 R3: carpeta del pedido = `exports/<runId>/`, sin sucursal (puede volverse null)
      await latir({ filePath: path }) // 🔴 la ruta se anota ANTES del primer byte
      const encabezados = cols.map(c => c.label)
      if (run.format === 'CSV') escritor = new EscritorCsv(d.abrirEscritura(path, 'text/csv; charset=utf-8'), encabezados)
      else libro = d.abrirLibro({ encabezados, formatos: cols.map(c => c.numFmt), hoja: exp.titulo })

      let cursor: Cursor | null = null
      let hechas = 0
      for (;;) {
        let pauso = false
        await d.esperarTurno(async () => {
          pauso = true
          await latir({ esperandoCobros: true })
        })
        const pagina = await exp.pagina(run.venueId, filtros, run.corte, cursor, EXPORT_LIMITS.TAMANO_PAGINA)
        if (pagina.length > 0) {
          const celdas = pagina.map(f => cols.map(c => c.value(f) ?? ''))
          if (escritor) await escritor.agregar(celdas)
          else libro!.agregar(celdas)
          hechas += pagina.length
          cursor = exp.cursorDe(pagina[pagina.length - 1])
        }
        await latir({ processedRows: hechas, ...(pauso ? { esperandoCobros: false } : {}) })
        if (pagina.length < EXPORT_LIMITS.TAMANO_PAGINA) break
      }

      let bytes: number
      if (escritor) {
        const e = escritor
        bytes = await conLatido(
          e.cerrar().then(b => {
            subido = true
            return b
          }),
          () => e.abortar(),
        )
      } else {
        const l = libro!
        const buffer = await conLatido(l.cerrar(), () => l.abortar())
        // Una subida en curso no se cancela: si la cerca se pierde mientras sube, se marca al terminar y el catch borra SU parcial.
        await conLatido(
          d.guardarArchivo(path, buffer, XLSX_CONTENT_TYPE).then(() => {
            subido = true
          }),
          () => undefined,
        )
        bytes = buffer.length
      }
      const { count } = await d.prisma.exportRun.updateMany({
        where: { id: runId, status: 'RUNNING', attempts: attempt },
        data: {
          status: 'READY',
          processedRows: hechas,
          filePath: path,
          fileName,
          fileBytes: bytes,
          finishedAt: d.ahora(),
          leaseExpiresAt: null,
          esperandoCobros: false,
        },
      })
      if (count !== 1) throw new LeasePerdido()
    } catch (e) {
      escritor?.abortar()
      libro?.abortar()
      if (e instanceof LeasePerdido) {
        logger.warn('[exportes] otro intento se quedó el pedido; éste se detiene', { runId, intento: attempt })
        // Codex r1 #4: sin la cerca no se toca la fila. Si su subida ya terminó, borra SU parcial: la ruta es de este intento
        // (`…/<runId>/<attempt>/…`) y nunca es la del otro, que anota la suya.
        if (subido && path)
          await d.borrarArchivo(path).catch(() => logger.warn('[exportes] no se pudo borrar el parcial de un intento sin cerca', { runId }))
        return
      }
      logger.warn('[exportes] armado falló', { runId, kind: run.kind, codigo: String((e as Error).message ?? '').slice(0, 60) })
      // El parcial (o el del intento muerto, si fue lo que falló) se borra; si el borrado falla, su ruta se conserva (Codex r1 #7).
      const pendiente = path ?? run.filePath
      const borrado = pendiente
        ? await d.borrarArchivo(pendiente).then(
            () => true,
            () => false,
          )
        : true
      await d.prisma.exportRun.updateMany({
        where: { id: runId, status: 'RUNNING', attempts: attempt },
        data: {
          status: 'FAILED',
          failureCode: 'ARMADO_FALLO',
          finishedAt: d.ahora(),
          leaseExpiresAt: null,
          filePath: borrado ? null : pendiente,
          esperandoCobros: false,
        },
      })
    }
    // Codex r3: `procesar` NO avisa. El único que avisa es `barrerAvisos`, que el cocinero corre justo después de cada pedido
    // (Tarea 9): un solo camino, sin gastar dos intentos seguidos ante el mismo fallo.
  }

  /**
   * Bandeja en la fila (Codex r1 #6): manda lo que falte, cada envío con plazo, y anota cada uno al lograrlo.
   * Techo declarado (Codex r2 R4): AL MENOS UNA VEZ para campanita y correo. Si el proceso muere entre mandar y anotar, se
   * repite; la idempotencyKey evita el correo repetido sólo dentro de las 24 h que Resend la guarda. El fallo (FAILED) se
   * avisa sólo por correo en esta fase. Codex r3 N3: campanita apagada ⇒ omitida; horas de silencio ⇒ aplazada sin gastar
   * intentos. Un pedido que sólo espera el silencio NO tapa a los demás: el barrido recorre la bandeja con un cursor (Codex r4).
   */
  async function avisar(r: ExportRun): Promise<void> {
    if (r.status !== 'READY' && r.status !== 'FAILED') return
    const debeCampanita = r.status === 'READY' && !r.campanitaAt
    if ((!debeCampanita && r.correoAt) || r.avisoIntentos >= MAX_AVISOS) return
    // Codex r3 N3: la preferencia se lee ANTES de gastar un intento (ya no se adivina por el texto del error). Si la lectura
    // falla o no contesta a tiempo, se intenta mandar y `createNotification` decide: si lanza, cuenta como un fallo normal.
    let campanita: 'mandar' | 'apagada' | 'silencio' | null = null // null: no se debe campanita (o no hay a quién)
    if (debeCampanita && r.requestedById && r.venueId) {
      const p = d.campanitaSegunPreferencia(r.requestedById, r.venueId)
      p.catch(() => undefined) // si se abandona por el plazo, su falla no queda sin atender
      const leida = await aLoMas(p, d.campanitaMaxMs).catch((): typeof SIN_RESPUESTA => SIN_RESPUESTA)
      campanita = leida === SIN_RESPUESTA ? 'mandar' : leida
    }
    // Horas de silencio: la campanita se aplaza. Si es lo ÚNICO pendiente, se sale ANTES del CAS: esperar no gasta intentos.
    if (campanita === 'silencio' && r.correoAt) return
    const { count } = await d.prisma.exportRun.updateMany({
      where: { id: r.id, avisoIntentos: r.avisoIntentos },
      data: { avisoIntentos: r.avisoIntentos + 1 },
    })
    if (count !== 1) return // otro proceso está avisando este mismo pedido
    const marcar = (data: { campanitaAt?: Date; correoAt?: Date }) => d.prisma.exportRun.updateMany({ where: { id: r.id }, data })
    if (!r.requestedById || !r.venueId) {
      // Persona o sucursal borradas (SetNull): no hay a quién avisar.
      await marcar({ ...(debeCampanita ? { campanitaAt: d.ahora() } : {}), ...(r.correoAt ? {} : { correoAt: d.ahora() }) })
      return
    }
    const titulo = d.exportador(r.kind)?.titulo ?? 'Exporte'
    if (campanita === 'apagada') {
      await marcar({ campanitaAt: d.ahora() }) // la persona APAGÓ este tipo: omitida, sin llamarla ni reintentarla (Codex r2 R4)
    } else if (campanita === 'mandar') {
      const ok = await logrado(
        d.notificar({
          recipientId: r.requestedById,
          venueId: r.venueId,
          type: 'EXPORT_READY',
          title: 'Tu archivo está listo',
          message: `${titulo}: ${r.processedRows.toLocaleString('es-MX')} filas. Disponible 7 días.`,
          actionUrl: `exports/${r.id}`, // RELATIVO: el DASHBOARD le antepone la ruta del negocio del aviso
          actionLabel: 'Descargar',
          entityType: 'ExportRun',
          entityId: r.id,
          channels: [NotificationChannel.IN_APP], // el correo bueno va abajo; sin esto, una preferencia con EMAIL lo duplica
        }),
        d.campanitaMaxMs,
      )
      if (ok) await marcar({ campanitaAt: d.ahora() })
      else logger.info('[exportes] campanita pendiente', { runId: r.id })
    }
    // 'silencio' con el correo aún pendiente: este intento es del correo; la campanita espera a que acabe el silencio.
    if (!r.correoAt) {
      const [staff, venue] = await Promise.all([
        d.prisma.staff.findUnique({ where: { id: r.requestedById }, select: { email: true } }),
        d.prisma.venue.findUnique({ where: { id: r.venueId }, select: { slug: true, name: true } }),
      ])
      if (!staff?.email || !venue) {
        await marcar({ correoAt: d.ahora() }) // no hay a quién escribir
        return
      }
      const ok = await logrado(
        d.enviarCorreo(staff.email, {
          estado: r.status === 'READY' ? 'READY' : 'FAILED',
          venueName: venue.name,
          titulo,
          filas: r.processedRows,
          formato: r.format === 'XLSX' ? 'xlsx' : 'csv',
          expiresAt: r.expiresAt,
          url: d.enlaceDelPedido(venue.slug, r.id),
          idempotencyKey: `export-${r.id}-${r.status}`,
        }),
        d.correoMaxMs,
      )
      if (ok) await marcar({ correoAt: d.ahora() })
      else logger.warn('[exportes] correo pendiente', { runId: r.id })
    }
  }

  /**
   * Codex r4 (regresión de N3): cursor del barrido, en memoria del servicio (un solo proceso; sin columnas nuevas). Sin él,
   * diez pedidos esperando el silencio ocupaban los 10 lugares de cada vuelta y el aviso de otra persona nunca salía. Avanza
   * al último id visto AUNQUE su campanita se haya aplazado; al llegar al final (menos de 10) vuelve al principio. Si el
   * proceso reinicia empieza de cero: sólo cambia el orden, no lo que se avisa.
   */
  let cursorAvisos = ''

  /** Lo llama el cocinero en cada vuelta: READY/FAILED de ≤ 7 días con aviso pendiente y menos de 5 intentos, 10 por vuelta en orden de id. */
  async function barrerAvisos(): Promise<number> {
    const ahora = d.ahora()
    const pendientes = await d.prisma.exportRun.findMany({
      where: {
        id: { gt: cursorAvisos },
        status: { in: ['READY', 'FAILED'] },
        avisoIntentos: { lt: MAX_AVISOS },
        finishedAt: { gte: new Date(+ahora - 7 * DIA_MS) },
        OR: [{ correoAt: null }, { status: 'READY', campanitaAt: null }],
      },
      orderBy: { id: 'asc' },
      take: CANDIDATOS_POR_RECLAMO,
    })
    // Se mueve ANTES de avisar: si un aviso lanza, la siguiente vuelta no se atora en el mismo lote.
    cursorAvisos = pendientes.length < CANDIDATOS_POR_RECLAMO ? '' : pendientes[pendientes.length - 1].id
    for (const r of pendientes) await conNegocio(r.venueId, () => avisar(r)) // candado demo: el correo sabe de qué negocio es
    return pendientes.length
  }

  /**
   * Limpieza diaria (Codex r2 R3): todo pedido VENCIDO (READY, FAILED o EXPIRED aún con ruta; con o sin dueño) se borra por
   * CARPETA (`exports/<runId>/`, todos sus intentos, también el parcial de un intento que perdió la cerca) y sólo se marca
   * limpiado (EXPIRED, filePath null) si ese borrado salió bien; si falla, la siguiente pasada lo reintenta. Todo pedido nace
   * con `expiresAt` (corte + 7 días): la carpeta se borra a los 7 días + la cadencia de esta limpieza (uno que se cierra
   * `VENCIO_SIN_ARMARSE`, una pasada más).
   *
   * Codex r5 B1 (decisión del founder «a»): la subida de un intento viejo no se cancela y puede terminar DESPUÉS de que la
   * carpeta se dio por limpia, sin ninguna fila que la apunte. Esta limpieza ya NO la persigue (se quitó el rebarrido de
   * 48 h de r3 C1 y r4: si fallaba en su ventana, el objeto quedaba para siempre). La borra la regla de ciclo de vida del
   * bucket (`Delete` a los 8 días de nacer bajo `private/<env>/exports/`, `scripts/exportes-regla-de-borrado.ts`).
   *
   * Codex r4 (rediseño): AL FINAL de la pasada, todo QUEUED/RUNNING a 1 h o menos de vencer pasa a FAILED
   * `VENCIO_SIN_ARMARSE` (el reclamo ya no lo toma) y el barrido de avisos le manda su «no pudimos» como a cualquier fallo.
   * Va al final para que su carpeta se borre en la SIGUIENTE pasada (un día después, con `expiresAt` ya vencido), cuando un
   * intento que acaba de perder la cerca ya terminó lo poco que le quedaba. Un RUNNING con el lease VIGENTE no se toca: hay un
   * intento vivo trabajando, y lo que haga lo cierra él (READY o FAILED, que esta limpieza borra después de `expiresAt`); si
   * muere, su lease vence y la siguiente pasada lo marca. Lo más simple que no pisa a un intento vivo.
   */
  async function expirarVencidos(): Promise<number> {
    const ahora = d.ahora()
    let total = 0
    for (;;) {
      const lote = await d.prisma.exportRun.findMany({
        where: { expiresAt: { lt: ahora }, OR: [{ status: { in: ['READY', 'FAILED'] } }, { status: 'EXPIRED', filePath: { not: null } }] },
        take: LOTE_DE_LIMPIEZA,
      })
      let avance = 0
      for (const r of lote) {
        try {
          await d.borrarCarpeta(carpetaDe(r.id))
        } catch {
          logger.warn('[exportes] no se pudo borrar la carpeta de un pedido vencido; se reintenta', { runId: r.id })
          continue
        }
        const { count } = await d.prisma.exportRun.updateMany({
          where: { id: r.id, status: r.status },
          data: { status: 'EXPIRED', filePath: null },
        })
        avance += count
      }
      total += avance
      if (lote.length < LOTE_DE_LIMPIEZA || avance === 0) break
    }

    // Codex r4: los que ya no se pueden armar a tiempo. CAS por intento (status y attempts leídos; RUNNING sólo con el lease
    // vencido, igual que el reclamo): si un intento renovó su lease entre la lectura y el UPDATE, no se le pisa.
    const vigenteHasta = new Date(+ahora + MARGEN_DE_VENCIMIENTO_MS)
    for (;;) {
      const lote = await d.prisma.exportRun.findMany({
        where: { expiresAt: { lte: vigenteHasta }, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', leaseExpiresAt: { lt: ahora } }] },
        take: LOTE_DE_LIMPIEZA,
      })
      let avance = 0
      for (const r of lote) {
        const { count } = await d.prisma.exportRun.updateMany({
          where: { id: r.id, status: r.status, attempts: r.attempts, ...(r.status === 'RUNNING' ? { leaseExpiresAt: { lt: ahora } } : {}) },
          data: { status: 'FAILED', failureCode: 'VENCIO_SIN_ARMARSE', finishedAt: ahora, leaseExpiresAt: null, esperandoCobros: false },
        })
        avance += count
      }
      total += avance
      if (lote.length < LOTE_DE_LIMPIEZA || avance === 0) return total
    }
  }

  return { pedir, reclamarSiguiente, procesar, barrerAvisos, expirarVencidos }
}

export const exportRunService = crearExportRunService()
