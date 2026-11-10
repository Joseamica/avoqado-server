/**
 * Un envío del celular aplicado FUERA de su ruta (App de campo, bloque 1, Tarea 7): la gracia de 24 h y «Aplicar» del
 * panel. No hay un escritor nuevo: cada tipo se valida con el MISMO esquema zod de su ruta y se aplica con el MISMO
 * servicio, así que lo que queda en la base es lo mismo que por la ruta normal. Los permisos NO se revisan aquí: la gracia
 * los revisa antes (`permisosDelEnvio`) y en «Aplicar» los autoriza el supervisor.
 *
 * Desenlaces: APLICADO (el status y el body que mandaría la ruta), RECHAZADO (definitivo: no deja efecto) o se LANZA
 * (reintentable: VENTA_EN_PROCESO, CUSTODIA_EN_PROCESO, CHECADA_EN_PROCESO, 429 y 5xx).
 */
import type { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import cuid from 'cuid'
import { ZodTypeAny } from 'zod'
import AppError, { ConflictError } from '@/errors/AppError'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { createProofOfSaleSchema } from '@/schemas/tpv.schema'
import {
  aceptarCustodiaSchema,
  entradaDeCampoBodySchema,
  evidenciaDeCampoLlaveSchema,
  rechazarCustodiaSchema,
  salidaDeCampoBodySchema,
  TIPOS_DE_ENVIO,
  ventaDeCampoBodySchema,
} from '@/schemas/tpv/campo.schema'
import { registrarEntradaDeCampo, registrarSalidaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'
import { aceptarCustodiaDeCampo, FilaDeCustodia, rechazarCustodiaDeCampo } from '@/services/tpv/campo/custodiaDeCampo.service'
import { registrarVentaDeCampo } from '@/services/tpv/campo/ventaDeCampo.service'
import { createOrUpdateProofOfSale, TerminalCapture } from '@/services/tpv/sale-verification.service'
import { AppliedCaptureSeqs, CaptureDestination, isNewerCapture } from '@/services/playtelecom/linkingNumber.rules'
import prisma from '@/utils/prismaClient'

export type TipoDeEnvio = (typeof TIPOS_DE_ENVIO)[number]
/** Quien lee: el cliente de siempre, o la transacción del candado del celular (I8: la consulta va dentro de la decisión). */
type Lector = Prisma.TransactionClient

export type Rechazo = { code: string; message: string; detalle?: unknown }
export type ResultadoDelEnvio = { tipo: 'APLICADO'; status: number; body: unknown } | { tipo: 'RECHAZADO'; rechazo: Rechazo }

/** La huella de una pieza: la misma que calcula el celular para su latido. */
export const huellaDelEnvio = (tipo: TipoDeEnvio, venueId: string, cuerpoJson: string): string =>
  createHash('sha256').update(`${tipo}\n${venueId}\n${cuerpoJson}`).digest('hex')

/** Los permisos de la ruta normal de cada tipo. La checada sólo pide el `StaffVenue` activo (`requireVenueMembership`). */
const PERMISOS: Record<TipoDeEnvio, string[]> = {
  VENTA: ['serialized-inventory:sell', 'payments:create'],
  ENTRADA: [],
  SALIDA: [],
  CUSTODIA_ACEPTAR: ['tpv-sim-custody:accept'],
  CUSTODIA_RECHAZAR: ['tpv-sim-custody:reject'],
  EVIDENCIA: ['payments:create'],
}
export const permisosDelEnvio = (tipo: TipoDeEnvio): string[] => PERMISOS[tipo]

// VERIFICATION_MOVED: la venta cambió de tienda mientras se guardaba la evidencia («vuelve a intentarlo»).
const REINTENTABLES = new Set(['VENTA_EN_PROCESO', 'CUSTODIA_EN_PROCESO', 'CHECADA_EN_PROCESO', 'VERIFICATION_MOVED'])

const rechazado = (code: string, message: string, detalle?: unknown): ResultadoDelEnvio => ({
  tipo: 'RECHAZADO',
  rechazo: { code, message, ...(detalle !== undefined && { detalle }) },
})
const aplicado = (status: number, body: unknown): ResultadoDelEnvio => ({ tipo: 'APLICADO', status, body })
const cuerpoInvalido = () => rechazado('CUERPO_INVALIDO', 'Lo que mandó el celular no es válido para esta acción.')

/** Un 4xx definitivo es un rechazo; lo reintentable (y lo que no es un AppError) se lanza tal cual. */
function comoRechazo(error: unknown): ResultadoDelEnvio {
  if (
    error instanceof AppError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 429 &&
    !REINTENTABLES.has(error.code ?? '')
  ) {
    return rechazado(error.code ?? 'RECHAZADO', error.message, error.details)
  }
  throw error
}

/** La misma traducción que `terminalCaptureFrom` del controlador de la TPV (la terminal nueva manda `captureSeq`). */
function capturaDe(b: {
  captureSeq?: number
  captureDeviceId?: string
  idempotencyKey?: string
  capturedAt?: string
}): TerminalCapture | undefined {
  if (b.captureSeq === undefined || !b.captureDeviceId || !b.idempotencyKey || !b.capturedAt) return undefined
  return { seq: b.captureSeq, deviceId: b.captureDeviceId, idempotencyKey: b.idempotencyKey, capturedAt: new Date(b.capturedAt) }
}

/** La custodia contesta `{ status, body }` como su ruta; un CUSTODIA_EN_PROCESO se lanza (reintentable). */
function desenlaceDeCustodia(r: { status: number; body: any }): ResultadoDelEnvio {
  if (r.body?.code === 'CUSTODIA_EN_PROCESO') {
    throw new ConflictError(r.body.message, r.body.code, r.body.summary ? { summary: r.body.summary, results: r.body.results } : undefined)
  }
  if (r.status >= 400) return rechazado(r.body?.code ?? 'RECHAZADO', r.body?.message ?? 'No se pudo aplicar la custodia.')
  if (r.body?.summary?.failed > 0) {
    const fallidas = (r.body.results as FilaDeCustodia[]).filter(f => f.status === 'error')
    return rechazado('CUSTODIA_INCOMPLETA', 'Algunas SIMs no se pudieron aceptar.', { summary: r.body.summary, fallidas })
  }
  return aplicado(r.status, r.body)
}

const validar = <T>(schema: ZodTypeAny, cuerpo: unknown): T | null => {
  const r = schema.safeParse(cuerpo)
  return r.success ? (r.data as T) : null
}

/** El esquema de la ruta normal de cada tipo (la evidencia va aparte: nombra su venta con `ventaLlave`). */
const ESQUEMAS: Record<Exclude<TipoDeEnvio, 'EVIDENCIA'>, ZodTypeAny> = {
  VENTA: ventaDeCampoBodySchema,
  ENTRADA: entradaDeCampoBodySchema,
  SALIDA: salidaDeCampoBodySchema,
  CUSTODIA_ACEPTAR: aceptarCustodiaSchema.shape.body,
  CUSTODIA_RECHAZAR: rechazarCustodiaSchema.shape.body,
}

/**
 * La evidencia: su llave de venta y el resto validado con el esquema de la ruta (el id de prueba sólo llena `paymentId`).
 * Fuera de su ruta (la gracia y «Aplicar») exige los campos de captura (S9) y `photoLabel` (R3-3): la captura es la llave de
 * idempotencia de la foto, pero sólo en una ranura FIJA, y la única fija es la de la etiqueta (Vinculacion = 0, Portabilidad
 * = 1). `replaceIndex` solo no basta: sobre una verificación vacía la ruta normal la pone en la 0 y la repetición en la 1, y
 * la misma foto queda dos veces. Sin `photoLabel` → CUERPO_INVALIDO. La ruta normal de la TPV no cambia.
 * R4-3: la ranura es UNA y sale de la etiqueta. El escritor compartido (`placePhotos`) prefiere `replaceIndex` cuando esa
 * posición existe, así que un índice que no es el de la etiqueta mandaría la foto a otra ranura que la que lee
 * `efectoYaHecho`: `replaceIndex` sólo se acepta si coincide con la etiqueta (entonces los dos caminos del escritor caen en la
 * misma ranura); si no → CUERPO_INVALIDO.
 */
const RANURA_DE_LA_ETIQUETA = { Vinculacion: 0, Portabilidad: 1 } as const
function evidenciaValida(
  cuerpo: unknown,
): { ventaLlave: string; resto: Record<string, unknown>; b: any; ranura: CaptureDestination } | null {
  const conLlave = validar<{ ventaLlave: string; paymentId?: unknown }>(evidenciaDeCampoLlaveSchema, cuerpo)
  if (!conLlave) return null
  const { ventaLlave, paymentId: _ignorado, ...resto } = conLlave
  const b = validar<any>(createProofOfSaleSchema.shape.body, { ...resto, paymentId: cuid() })
  if (!b || b.photoLabel === undefined || !capturaDe(b)) return null
  const indice = RANURA_DE_LA_ETIQUETA[b.photoLabel as keyof typeof RANURA_DE_LA_ETIQUETA]
  if (b.replaceIndex !== undefined && b.replaceIndex !== indice) return null
  return { ventaLlave, resto, b, ranura: indice === 0 ? 'PHOTO_VINCULACION' : 'PHOTO_PORTABILIDAD' }
}

/** La venta de la evidencia: COMPLETA, de esta persona y de ESTE celular (el nuevo de la persona no la nombra). */
async function fichaDeLaEvidencia(ctx: { venueId: string; staffId: string; celularId: string }, ventaLlave: string, db: Lector = prisma) {
  const ficha = await db.ventaDeCampo.findUnique({ where: { venueId_llave: { venueId: ctx.venueId, llave: ventaLlave } } })
  const suya = ficha?.estado === 'COMPLETA' && !!ficha.paymentId && ficha.staffId === ctx.staffId && ficha.celularId === ctx.celularId
  return suya ? (ficha as typeof ficha & { paymentId: string }) : null
}

/** ¿El cuerpo pasa el esquema de su tipo? Sin tocar la base: la gracia lo revisa antes de retener nada (S7). */
export const cuerpoValido = (tipo: TipoDeEnvio, cuerpo: unknown): boolean =>
  tipo === 'EVIDENCIA' ? evidenciaValida(cuerpo) !== null : validar(ESQUEMAS[tipo], cuerpo) !== null

export async function aplicarEnvio(
  ctx: { venueId: string; orgId: string; staffId: string; celularId: string },
  tipo: TipoDeEnvio,
  cuerpo: unknown,
): Promise<ResultadoDelEnvio> {
  const { venueId, orgId, staffId, celularId } = ctx
  try {
    switch (tipo) {
      case 'VENTA': {
        const b = validar<any>(ESQUEMAS.VENTA, cuerpo)
        if (!b) return cuerpoInvalido()
        const r = await registrarVentaDeCampo({ venueId, orgId, staffId, celularId }, b)
        return aplicado(r.repetida ? 200 : 201, r)
      }
      case 'ENTRADA': {
        const b = validar<any>(ESQUEMAS.ENTRADA, cuerpo)
        if (!b) return cuerpoInvalido()
        const r = await registrarEntradaDeCampo({ venueId, staffId }, b)
        return aplicado(r.repetida ? 200 : 201, r)
      }
      case 'SALIDA': {
        const b = validar<any>(ESQUEMAS.SALIDA, cuerpo)
        if (!b) return cuerpoInvalido()
        return aplicado(200, await registrarSalidaDeCampo({ venueId, staffId }, b))
      }
      case 'CUSTODIA_ACEPTAR':
      case 'CUSTODIA_RECHAZAR': {
        const aceptar = tipo === 'CUSTODIA_ACEPTAR'
        const b = validar<any>(ESQUEMAS[tipo], cuerpo)
        if (!b) return cuerpoInvalido()
        const { role } = await resolveUserRoleForVenue({ userId: staffId, targetVenueId: venueId })
        if (!role) return rechazado('PERSONA_SIN_ASIGNACION', 'La persona ya no está asignada a esta sucursal.')
        const q = { venueId, staffId, role }
        return desenlaceDeCustodia(aceptar ? await aceptarCustodiaDeCampo(q, b) : await rechazarCustodiaDeCampo(q, b))
      }
      case 'EVIDENCIA': {
        // Se valida ANTES de buscar la venta.
        const valida = evidenciaValida(cuerpo)
        if (!valida) return cuerpoInvalido()
        const { ventaLlave, resto } = valida

        const ficha = await fichaDeLaEvidencia(ctx, ventaLlave)
        if (!ficha) return rechazado('VENTA_PENDIENTE', 'La venta de esta evidencia todavía no está completa.')
        const b = validar<any>(createProofOfSaleSchema.shape.body, { ...resto, paymentId: ficha.paymentId })!
        // El mismo acomodo que `createProofOfSale` (sale-verification.tpv.controller.ts).
        const result = await createOrUpdateProofOfSale(
          venueId,
          b.paymentId,
          b.photoUrls,
          staffId,
          b.verificationId,
          b.replaceIndex,
          b.photoLabel,
          { orgId, capture: capturaDe(b), linkingNumber: b.linkingNumber, portedNumber: b.portedNumber },
        )
        return aplicado(200, { success: true, message: 'Proof-of-sale photo uploaded successfully', ...result })
      }
    }
  } catch (error) {
    return comoRechazo(error)
  }
}

// ------------------------------------------------------------------------------------------------------------------------
// ¿El efecto ya ocurrió? (T1)
// ------------------------------------------------------------------------------------------------------------------------

/**
 * `aMedias` (U2): una VENTA con su ficha EN_CURSO. No está hecha, pero tampoco es «nada»: puede tener orden o cobro. La fila
 * nunca vuelve a PENDIENTE ni se descarta; «Aplicar» o el reintento de la gracia la terminan (el servicio la retoma por llave).
 */
export type EfectoDelEnvio = { hecho: true; resultado: unknown } | { hecho: false; aMedias?: true }
const NO_HECHO: EfectoDelEnvio = { hecho: false }
export const estaAMedias = (ya: EfectoDelEnvio | null): boolean => !!ya && !ya.hecho && ya.aMedias === true

/** Las asignaciones que dan a una persona la versión que ve su celular (las dos escriben ASSIGNED_TO_PROMOTER o el traslado). */
const ASIGNACIONES_A_LA_PERSONA = ['ASSIGNED_TO_PROMOTER', 'REASSIGNED_PROMOTER_TO_PROMOTER'] as const
const TOPE_DE_EVENTOS = 1000 // ≤ 50 SIMs por cuerpo; cada una con pocas asignaciones y decisiones de la misma persona

/**
 * UNA verdad por tipo, mirando la base: ¿lo que pide ESTE cuerpo ya quedó hecho? La usan la gracia y «Aplicar» antes de
 * reanudar un APLICANDO y antes de regresar cualquier fila a PENDIENTE: un efecto que ya ocurrió (aun por la ruta normal con
 * la respuesta perdida, o por otro «Aplicar» simultáneo) nunca queda descartable.
 *
 * `limite`: cuándo nació el retenido. La asignación que vio el celular es anterior a esa fecha.
 */
export async function efectoYaHecho(
  tipo: TipoDeEnvio,
  ctx: { venueId: string; orgId: string; staffId: string; celularId: string },
  cuerpo: unknown,
  limite: Date,
  db: Lector = prisma,
): Promise<EfectoDelEnvio> {
  switch (tipo) {
    case 'VENTA': {
      const b = validar<{ llave: string; serialNumber: string }>(ESQUEMAS.VENTA, cuerpo)
      if (!b) return NO_HECHO
      const f = await db.ventaDeCampo.findUnique({ where: { venueId_llave: { venueId: ctx.venueId, llave: b.llave } } })
      if (!f || f.staffId !== ctx.staffId || f.serialNumber !== b.serialNumber) return NO_HECHO
      // EN_CURSO: a medias (U2), ni hecha ni descartable; el servicio la retoma por su llave.
      if (f.estado === 'EN_CURSO') return { hecho: false, aMedias: true }
      return {
        hecho: true,
        resultado: { orderId: f.orderId, paymentId: f.paymentId, saleVerificationId: f.saleVerificationId, recuperado: true },
      }
    }
    case 'ENTRADA':
    case 'SALIDA': {
      const b = validar<{ llave: string; timeEntryId?: string; llaveEntrada?: string }>(ESQUEMAS[tipo], cuerpo)
      if (!b) return NO_HECHO
      const where =
        tipo === 'ENTRADA'
          ? { staffId_llaveEntrada: { staffId: ctx.staffId, llaveEntrada: b.llave } }
          : { staffId_llaveSalida: { staffId: ctx.staffId, llaveSalida: b.llave } }
      const t = await db.timeEntry.findUnique({ where, select: { id: true, venueId: true, llaveEntrada: true } })
      // La misma llave en otra sucursal es otra checada (LLAVE_REUSADA), no ésta.
      if (!t || t.venueId !== ctx.venueId) return NO_HECHO
      // R3-4: la salida es de la entrada que NOMBRA el cuerpo, igual que el escritor (checadaDeCampo.service, «esLaNombrada»):
      // la llave de salida de la entrada A con un cuerpo que nombra la B es LLAVE_REUSADA, no la salida de B.
      const esLaNombrada = tipo === 'ENTRADA' || (b.timeEntryId ? t.id === b.timeEntryId : t.llaveEntrada === b.llaveEntrada)
      return esLaNombrada ? { hecho: true, resultado: { timeEntryId: t.id, recuperado: true } } : NO_HECHO
    }
    case 'CUSTODIA_ACEPTAR':
    case 'CUSTODIA_RECHAZAR':
      return custodiaHecha(tipo, ctx, cuerpo, limite, db)
    case 'EVIDENCIA': {
      const valida = evidenciaValida(cuerpo)
      if (!valida) return NO_HECHO
      const ficha = await fichaDeLaEvidencia(ctx, valida.ventaLlave, db)
      if (!ficha) return NO_HECHO
      const sv = await db.saleVerification.findUnique({
        where: { paymentId: ficha.paymentId },
        select: { id: true, appliedCaptureSeqs: true },
      })
      if (!sv) return NO_HECHO
      const { seq, deviceId } = capturaDe(valida.b)!
      const aplicadas = (sv.appliedCaptureSeqs ?? {}) as AppliedCaptureSeqs
      // R3-3/R4-3: la MISMA ranura que usará el escritor (la de la etiqueta; un replaceIndex distinto no pasa la validación).
      const { ranura } = valida
      // En su ranura: ésta o una más nueva del mismo aparato. En cualquier ranura: ESTA misma captura (la puso la ruta normal
      // con otro acomodo). Una más nueva en la OTRA ranura no dice nada de ésta.
      const exacta = (['PHOTO_VINCULACION', 'PHOTO_PORTABILIDAD'] as const).some(d => aplicadas[d]?.[deviceId] === seq)
      if (!exacta && isNewerCapture(aplicadas, ranura, deviceId, seq)) return NO_HECHO
      return { hecho: true, resultado: { verificationId: sv.id, paymentId: ficha.paymentId, recuperado: true } }
    }
  }
}

/**
 * La custodia por SIM, en su bitácora (`SerializedItemCustodyEvent`, la que escribe el servicio de custodia). La bitácora no
 * guarda la versión, así que el límite inferior es la ASIGNACIÓN a esta persona más reciente antes de que naciera el retenido
 * (la que dio la versión que vio el celular); sin asignación en la bitácora (alta directa a la persona), no hay límite. Cuenta
 * la aceptación (o el rechazo) de ESTA persona desde ahí: la de una entrega anterior no.
 * ponytail: si a la persona se la recolectaron y volvieron a asignar ENTRE su decisión y el retenido, esa decisión ya no
 * cuenta (queda PENDIENTE con ASIGNACION_CAMBIO); para afinarlo habría que guardar la versión en la bitácora.
 */
async function custodiaHecha(
  tipo: 'CUSTODIA_ACEPTAR' | 'CUSTODIA_RECHAZAR',
  ctx: { orgId: string; staffId: string },
  cuerpo: unknown,
  limite: Date,
  db: Lector,
): Promise<EfectoDelEnvio> {
  const b = validar<any>(ESQUEMAS[tipo], cuerpo)
  if (!b) return NO_HECHO
  const series: string[] = (tipo === 'CUSTODIA_ACEPTAR' ? b.sims : [b]).map((s: { serialNumber: string }) => s.serialNumber)
  const base = {
    serialNumber: { in: series, mode: 'insensitive' as const },
    serializedItem: { OR: [{ organizationId: ctx.orgId }, { venue: { organizationId: ctx.orgId } }] },
  }
  const select = { serialNumber: true, createdAt: true }
  const [asignaciones, decisiones] = await Promise.all([
    db.serializedItemCustodyEvent.findMany({
      where: { ...base, eventType: { in: [...ASIGNACIONES_A_LA_PERSONA] }, toStaffId: ctx.staffId, createdAt: { lte: limite } },
      select,
      orderBy: { createdAt: 'desc' },
      take: TOPE_DE_EVENTOS,
    }),
    db.serializedItemCustodyEvent.findMany({
      where: {
        ...base,
        eventType: tipo === 'CUSTODIA_ACEPTAR' ? 'ACCEPTED_BY_PROMOTER' : 'REJECTED_BY_PROMOTER',
        actorStaffId: ctx.staffId,
      },
      select,
      orderBy: { createdAt: 'desc' },
      take: TOPE_DE_EVENTOS,
    }),
  ])
  const clave = (s: string) => s.toLowerCase()
  const desde = new Map<string, Date>()
  for (const a of asignaciones) if (!desde.has(clave(a.serialNumber))) desde.set(clave(a.serialNumber), a.createdAt) // la más reciente

  const eventos: { serialNumber: string; at: string }[] = []
  const faltan: string[] = []
  for (const serie of series) {
    const d0 = desde.get(clave(serie))
    const e = decisiones.find(d => clave(d.serialNumber) === clave(serie) && (!d0 || d.createdAt >= d0))
    if (e) eventos.push({ serialNumber: serie, at: e.createdAt.toISOString() })
    else faltan.push(serie)
  }
  if (eventos.length === 0) return NO_HECHO
  return { hecho: true, resultado: { recuperadoDeLaBitacora: true, eventos, ...(faltan.length > 0 && { faltan }) } }
}
