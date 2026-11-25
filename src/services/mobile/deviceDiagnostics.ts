/**
 * El POS de Windows dice cómo dibuja su computadora (hz:a5fa2439:D1).
 *
 * La app agrega UNA cabecera opcional, `x-device-diagnostics`, al sondeo que ya hace cada 15–20 s
 * (`GET /mobile/venues/:venueId/display-mode-request`). Aquí se lee y se guarda en `Terminal.deviceDiagnostics` de la ficha
 * exacta que resolvió el sondeo, DESPUÉS de responder: el sondeo nunca espera ni falla por esto. Es un dato de vista;
 * nada del sistema actúa con él. No se lee ninguna hora de la PC: `receivedAt` es la del servidor.
 */
import { Prisma } from '@prisma/client'
import type { Request } from 'express'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

export type DrawingMode = 'AUTO' | 'FAST'
export interface DeviceDiagnostics {
  proc: string
  rev: number
  api: string
  paintMs: number
  performance: 'FLUID' | 'LIGHT' | 'INSUFFICIENT'
  drawingMode: DrawingMode
  forced: boolean
  failed: boolean
  manual: boolean
  light?: boolean
  cpu?: string
  cores?: number
  ramGb?: number
  screen?: string
}
export type StoredDeviceDiagnostics = DeviceDiagnostics & { receivedAt: string }

const HEADER = 'x-device-diagnostics'
const MAX_RAW = 512
const APIS = ['DIRECT3D', 'OPENGL', 'SOFTWARE_FAST', 'SOFTWARE_COMPAT'] as const
const PERFORMANCES = ['FLUID', 'LIGHT', 'INSUFFICIENT'] as const
const MODES = ['AUTO', 'FAST'] as const
const PROC = /^[0-9a-f]{8}$/
const DIGITS = /^\d{1,10}$/
const DECIMAL = /^\d{1,4}(?:\.\d{1,3})?$/
const CPU = /^[^\x00-\x1f\x7f]{1,80}$/ // eslint-disable-line no-control-regex
const SCREEN = /^\d{3,5}x\d{3,5}$/
const ISO = /^\d{4}-\d{2}-\d{2}T/

type Raw = Record<string, unknown>

const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined)
const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
const oneOf = <T extends string>(v: unknown, list: readonly T[]) => ((list as readonly unknown[]).includes(v) ? (v as T) : undefined)
const matching = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined)

/** Una sola regla para la cabecera y para lo guardado: obligatorio malo ⇒ nada; opcional malo ⇒ sólo se cae ése. */
function validate(c: Raw): DeviceDiagnostics | undefined {
  const proc = matching(c.proc, PROC)
  const rev = int(c.rev, 1, 1_000_000_000)
  const api = oneOf(c.api, APIS)
  const paintMs = int(c.paintMs, 0, 120_000)
  const performance = oneOf(c.performance, PERFORMANCES)
  const drawingMode = oneOf(c.drawingMode, MODES)
  if (proc === undefined || rev === undefined || api === undefined || paintMs === undefined) return undefined
  if (performance === undefined || drawingMode === undefined) return undefined

  const d: DeviceDiagnostics = {
    proc,
    rev,
    api,
    paintMs,
    performance,
    drawingMode,
    forced: bool(c.forced) ?? false,
    failed: bool(c.failed) ?? false,
    manual: bool(c.manual) ?? false,
  }
  const light = bool(c.light)
  const cpu = matching(c.cpu, CPU)
  const cores = int(c.cores, 1, 512)
  const ramGb = num(c.ramGb, 0, 4096)
  const screen = matching(c.screen, SCREEN)
  if (light !== undefined) d.light = light
  if (cpu !== undefined) d.cpu = cpu
  if (cores !== undefined) d.cores = cores
  if (ramGb !== undefined) d.ramGb = ramGb
  if (screen !== undefined) d.screen = screen
  return d
}

const digits = (s: string | undefined) => (s !== undefined && DIGITS.test(s) ? Number(s) : undefined)
const decimal = (s: string | undefined) => (s !== undefined && DECIMAL.test(s) ? Number(s) : undefined)
const flag = (s: string | undefined) => (s === '1' ? true : s === '0' ? false : undefined)

/** La cabecera: pares `clave=valor` separados por `;`, partidos en el PRIMER `=`. Nunca lanza. */
export function parseDeviceDiagnostics(raw: unknown): DeviceDiagnostics | undefined {
  try {
    if (typeof raw !== 'string' || raw.length > MAX_RAW) return undefined
    // Una clave repetida queda `undefined`: inválida (obligatoria ⇒ se cae el reporte; opcional ⇒ sólo ella).
    const pairs = new Map<string, string | undefined>()
    for (const segment of raw.split(';')) {
      if (!segment) continue
      const i = segment.indexOf('=')
      const key = i < 0 ? segment : segment.slice(0, i)
      pairs.set(key, pairs.has(key) ? undefined : i < 0 ? '' : segment.slice(i + 1))
    }
    if (pairs.get('v') !== '1') return undefined
    return validate({
      proc: pairs.get('proc'),
      rev: digits(pairs.get('rev')),
      api: pairs.get('api'),
      paintMs: digits(pairs.get('paint')),
      performance: pairs.get('perf'),
      drawingMode: pairs.get('set'),
      forced: flag(pairs.get('forced')),
      failed: flag(pairs.get('fail')),
      manual: flag(pairs.get('hand')),
      light: flag(pairs.get('light')),
      cpu: pairs.get('cpu'),
      cores: digits(pairs.get('cores')),
      ramGb: decimal(pairs.get('ram')),
      screen: pairs.get('screen'),
    })
  } catch {
    return undefined
  }
}

/** Exige UNA sola ocurrencia de la cabecera. Nunca lanza. */
export function readDeviceDiagnostics(req: Request): DeviceDiagnostics | undefined {
  try {
    const values = req.headersDistinct?.[HEADER]
    return values?.length === 1 ? parseDeviceDiagnostics(values[0]) : undefined
  } catch {
    return undefined
  }
}

/** Lo guardado en la columna, validado campo por campo (la marca interna `prevProc` no sale). Nunca lanza. */
export function parseStoredDeviceDiagnostics(raw: unknown): StoredDeviceDiagnostics | undefined {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const receivedAt = matching((raw as Raw).receivedAt, ISO)
    const d = validate(raw as Raw)
    if (!d || receivedAt === undefined || Number.isNaN(Date.parse(receivedAt))) return undefined
    return { ...d, receivedAt }
  } catch {
    return undefined
  }
}

/**
 * Una sentencia condicionada (lo guardado nunca retrocede dentro de una misma apertura). Escribe sólo si la columna está
 * vacía o es basura, si lo guardado es de otra apertura (`proc` distinto, y el que llega no es la apertura que ese
 * reemplazó: `prevProc`), o si es de la misma con una `rev` menor. Lo guardado se lee sin convertir a ciegas: un JSON
 * viejo o raro cuenta como reemplazable y nunca hace fallar la sentencia. Devuelve si escribió.
 */
export async function guardarDiagnostico(terminalId: string, d: DeviceDiagnostics, now: Date): Promise<boolean> {
  const nuevo = JSON.stringify({ ...d, receivedAt: now.toISOString() })
  const viejo = Prisma.sql`t."deviceDiagnostics"`
  const procViejo = Prisma.sql`(CASE WHEN jsonb_typeof(${viejo} -> 'proc') = 'string' THEN ${viejo} ->> 'proc' END)`
  const prevViejo = Prisma.sql`(CASE WHEN jsonb_typeof(${viejo} -> 'prevProc') = 'string' THEN ${viejo} ->> 'prevProc' END)`
  const revViejo = Prisma.sql`(CASE WHEN jsonb_typeof(${viejo} -> 'rev') = 'number' AND (${viejo} ->> 'rev') ~ '^[0-9]{1,18}$' THEN (${viejo} ->> 'rev')::bigint END)`

  // En lote, no interactiva: la conexión no se queda apartada entre turnos de JS. Si la fila está tomada, se falla rápido: el
  // siguiente sondeo lo reintenta.
  const [, escritas] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL lock_timeout = '2s'`,
    prisma.$executeRaw(Prisma.sql`
      UPDATE "Terminal" AS t
      SET "deviceDiagnostics" = ${nuevo}::jsonb || jsonb_strip_nulls(jsonb_build_object(
        'prevProc', CASE WHEN ${procViejo} = ${d.proc} THEN ${prevViejo} ELSE ${procViejo} END))
      WHERE t.id = ${terminalId}
        AND t.type = 'POS_ANDROID'
        AND (
          ${procViejo} IS NULL
          OR (${procViejo} <> ${d.proc} AND ${prevViejo} IS DISTINCT FROM ${d.proc})
          OR (${procViejo} = ${d.proc} AND (${revViejo} IS NULL OR ${revViejo} < ${d.rev}))
        )`),
  ])
  return escritas > 0
}

// Fila tomada (55P03, llega dentro de un P2010), transacción que no arrancó a tiempo (P2028) o pool lleno (P2024).
const ESPERAS = new Set(['55P03', 'P2028', 'P2024'])

/** ¿El guardado falló sólo porque la base estaba ocupada? Es lo normal bajo carga: el siguiente sondeo lo reintenta. */
export function esEsperaDeLaBase(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown } } | null | undefined
  return [e?.code, e?.meta?.code].some(c => typeof c === 'string' && ESPERAS.has(c))
}

// A lo más un guardado en curso por aparato: si ya hay uno, el sondeo no lanza otro (nunca se encolan).
const enCurso = new Set<string>()

// Cada PC sondea cada 15–20 s: un error que se repite avisa a lo más una vez cada 10 min por aparato. Se borra al guardar bien y
// nunca pasa de 1 000 aparatos (si se fuera a pasar, se vacía: a lo más se repite un aviso).
const AVISO_CADA_MS = 10 * 60_000
const TOPE_DE_AVISOS = 1_000
const ultimoAviso = new Map<string, number>()

function avisarFallo(terminalId: string, error: unknown, ahoraMs: number): void {
  if (esEsperaDeLaBase(error)) {
    logger.debug('[dibujo-del-pos] la base estaba ocupada; el siguiente sondeo guarda el reporte de dibujo', {
      terminalId,
      error: mensaje(error),
    })
    return
  }
  const antes = ultimoAviso.get(terminalId)
  if (antes !== undefined && ahoraMs - antes < AVISO_CADA_MS) return
  if (antes === undefined && ultimoAviso.size >= TOPE_DE_AVISOS) ultimoAviso.clear()
  ultimoAviso.set(terminalId, ahoraMs)
  logger.warn('[dibujo-del-pos] no se guardó el reporte de dibujo', { terminalId, error: mensaje(error) })
}

/**
 * Lo que llama el sondeo DESPUÉS de responder: valida la sesión, lee la cabecera y guarda sin que nadie lo espere.
 * Nunca lanza ni rechaza.
 */
export function reportarDiagnosticoTrasElSondeo(req: Request, terminalId: string, now: Date = new Date()): void {
  try {
    // Una sesión de impersonación es de sólo lectura: la misma señal con que la separa impersonationGuard.
    if (req.authContext?.isImpersonating || req.authContext?.impersonation) return
    const d = readDeviceDiagnostics(req)
    if (!d || enCurso.has(terminalId)) return
    enCurso.add(terminalId)
    void guardarDiagnostico(terminalId, d, now)
      .then(
        () => ultimoAviso.delete(terminalId),
        error => avisarFallo(terminalId, error, now.getTime()),
      )
      .finally(() => enCurso.delete(terminalId))
  } catch (error) {
    logger.warn('[dibujo-del-pos] no se pudo leer el reporte de dibujo', { terminalId, error: mensaje(error) })
  }
}

const mensaje = (error: unknown) => (error instanceof Error ? error.message : String(error))
