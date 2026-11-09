/**
 * Un envío del celular aplicado FUERA de su ruta (App de campo, bloque 1, Tarea 7): la gracia de 24 h y «Aplicar» del
 * panel. No hay un escritor nuevo: cada tipo se valida con el MISMO esquema zod de su ruta y se aplica con el MISMO
 * servicio, así que lo que queda en la base es lo mismo que por la ruta normal. Los permisos NO se revisan aquí: la gracia
 * los revisa antes (`permisosDelEnvio`) y en «Aplicar» los autoriza el supervisor.
 *
 * Desenlaces: APLICADO (el status y el body que mandaría la ruta), RECHAZADO (definitivo: no deja efecto) o se LANZA
 * (reintentable: VENTA_EN_PROCESO, CUSTODIA_EN_PROCESO, CHECADA_EN_PROCESO, 429 y 5xx).
 */
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
import prisma from '@/utils/prismaClient'

export type TipoDeEnvio = (typeof TIPOS_DE_ENVIO)[number]

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

const REINTENTABLES = new Set(['VENTA_EN_PROCESO', 'CUSTODIA_EN_PROCESO', 'CHECADA_EN_PROCESO'])

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

export async function aplicarEnvio(
  ctx: { venueId: string; orgId: string; staffId: string; celularId: string },
  tipo: TipoDeEnvio,
  cuerpo: unknown,
): Promise<ResultadoDelEnvio> {
  const { venueId, orgId, staffId, celularId } = ctx
  try {
    switch (tipo) {
      case 'VENTA': {
        const b = validar<any>(ventaDeCampoBodySchema, cuerpo)
        if (!b) return cuerpoInvalido()
        const r = await registrarVentaDeCampo({ venueId, orgId, staffId, celularId }, b)
        return aplicado(r.repetida ? 200 : 201, r)
      }
      case 'ENTRADA': {
        const b = validar<any>(entradaDeCampoBodySchema, cuerpo)
        if (!b) return cuerpoInvalido()
        const r = await registrarEntradaDeCampo({ venueId, staffId }, b)
        return aplicado(r.repetida ? 200 : 201, r)
      }
      case 'SALIDA': {
        const b = validar<any>(salidaDeCampoBodySchema, cuerpo)
        if (!b) return cuerpoInvalido()
        return aplicado(200, await registrarSalidaDeCampo({ venueId, staffId }, b))
      }
      case 'CUSTODIA_ACEPTAR':
      case 'CUSTODIA_RECHAZAR': {
        const aceptar = tipo === 'CUSTODIA_ACEPTAR'
        const b = validar<any>((aceptar ? aceptarCustodiaSchema : rechazarCustodiaSchema).shape.body, cuerpo)
        if (!b) return cuerpoInvalido()
        const { role } = await resolveUserRoleForVenue({ userId: staffId, targetVenueId: venueId })
        if (!role) return rechazado('PERSONA_SIN_ASIGNACION', 'La persona ya no está asignada a esta sucursal.')
        const q = { venueId, staffId, role }
        return desenlaceDeCustodia(aceptar ? await aceptarCustodiaDeCampo(q, b) : await rechazarCustodiaDeCampo(q, b))
      }
      case 'EVIDENCIA': {
        const conLlave = validar<{ ventaLlave: string; paymentId?: unknown }>(evidenciaDeCampoLlaveSchema, cuerpo)
        if (!conLlave) return cuerpoInvalido()
        const { ventaLlave, paymentId: _ignorado, ...resto } = conLlave
        // El resto se valida con el esquema de la ruta ANTES de buscar la venta (el id de prueba sólo llena el campo).
        const proofBody = createProofOfSaleSchema.shape.body
        if (!validar(proofBody, { ...resto, paymentId: cuid() })) return cuerpoInvalido()

        const ficha = await prisma.ventaDeCampo.findUnique({ where: { venueId_llave: { venueId, llave: ventaLlave } } })
        if (!ficha || ficha.estado !== 'COMPLETA' || !ficha.paymentId || ficha.staffId !== staffId || ficha.celularId !== celularId) {
          return rechazado('VENTA_PENDIENTE', 'La venta de esta evidencia todavía no está completa.')
        }
        const b = validar<any>(proofBody, { ...resto, paymentId: ficha.paymentId })!
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
