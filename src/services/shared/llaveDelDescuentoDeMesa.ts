import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'

/**
 * Encargo 7133e3 (hz:0555ee15:D2): llave por envío del DESCUENTO MANUAL de una cuenta de MESAS (POS de ANDROID y WINDOWS).
 *
 * El POS crea la llave al tocar «Aplicar» y la repite en todo lo que nace de ese toque: el reintento del transporte, el reenvío
 * con el PIN del gerente y, si la red falló, el intent `APPLY_DISCOUNT` de la cola. Si la respuesta se perdió pero la fila SÍ se
 * creó, el siguiente envío con la misma llave contesta la fila que ya existe y no crea otra (la trampa D21 de la TPV, que aquí no se
 * repite). Un descuento del catálogo no la necesita: el servicio ya rechaza el mismo `discountId` dos veces en la cuenta.
 *
 * La constancia vive en `IdempotencyRequest` (tabla genérica que ya existe: sin migración), escrita en la MISMA transacción que la
 * fila y buscada CON el candado de la cuenta tomado: dos envíos simultáneos se ordenan y el segundo ve la del primero (el índice
 * único es el respaldo). Sobrevive a que alguien quite la rebaja después. Mismo patrón que la TPV (SERVIDOR #508, D21), con su
 * propio `endpoint` y `actorStaffId` para que las dos llaves nunca se crucen; quien suba el replay puede ser otra sesión del mismo
 * aparato, por eso la persona no entra en la llave.
 */

/**
 * Un año (Codex r1 #3 y r2 #3): la cola sin red de una mesa puede subir días o semanas después, y una constancia vencida volvería a
 * aplicar el descuento que sí aterrizó. Una cuenta de mesa abierta no vive un año; mientras la constancia exista, la misma llave nunca
 * crea otra fila.
 */
export const VIGENCIA_DE_LA_LLAVE_MS = 365 * 24 * 60 * 60 * 1000
const ACTOR = 'pos-mesas'
const endpointDeLaLlave = (orderId: string) => `POST /mobile/orders/${orderId}/discounts/manual`
const hashDeLaFirma = (firma: string) => createHash('sha256').update(firma).digest('hex')

export interface DescuentoManualDeMesa {
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  /** % (0 < v ≤ 100) o pesos (> 0), como lo tecleó la caja. */
  value: number
  /** «Descuento manual» si la caja no le puso nombre. */
  name: string
  /** La llave del envío (uuid del POS). */
  llave: string
}

/** Qué descuento era: la misma llave con otro descuento (o con otro motivo) es otro envío y se rechaza. */
export function firmaDelManual(m: DescuentoManualDeMesa, motivo: { reason?: string | null; reasonComment?: string | null }): string {
  return JSON.stringify(['manual', m.type, m.value, m.name, motivo.reason ?? null, motivo.reasonComment ?? null])
}

async function organizacionDelNegocio(tx: Prisma.TransactionClient, venueId: string): Promise<string | null> {
  return (await tx.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } }))?.organizationId ?? null
}

export interface EnvioYaHecho {
  orderDiscountId: string
  name: string
  amount: number
}

/**
 * El envío que ya se hizo con esta llave en esta cuenta, o null. Una constancia vencida se borra y el envío se atiende como nuevo.
 * Misma llave con otra firma ⇒ 409 (nunca se aplica otro descuento con la llave de uno anterior).
 */
export async function envioYaHechoEnTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  llave: string,
  firma: string,
): Promise<EnvioYaHecho | null> {
  const organizationId = await organizacionDelNegocio(tx, venueId)
  if (!organizationId) return null
  const previa = await tx.idempotencyRequest.findUnique({
    where: {
      organizationId_actorStaffId_endpoint_idempotencyKey: {
        organizationId,
        actorStaffId: ACTOR,
        endpoint: endpointDeLaLlave(orderId),
        idempotencyKey: llave,
      },
    },
  })
  if (!previa) return null
  if (previa.expiresAt.getTime() <= Date.now()) {
    await tx.idempotencyRequest.delete({ where: { id: previa.id } })
    return null
  }
  if (previa.requestHash !== hashDeLaFirma(firma)) {
    throw new ConflictError('Esa llave ya se usó para otro descuento de esta cuenta.', 'DISCOUNT_KEY_REUSED')
  }
  const r = (previa.responseBody ?? {}) as { orderDiscountId?: string; name?: string; amount?: number }
  return { orderDiscountId: String(r.orderDiscountId ?? ''), name: String(r.name ?? ''), amount: Number(r.amount ?? 0) }
}

/** Deja la constancia del envío en la MISMA transacción que creó la fila. */
export async function anotarEnvioEnTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  llave: string,
  firma: string,
  hecho: EnvioYaHecho,
): Promise<void> {
  const organizationId = await organizacionDelNegocio(tx, venueId)
  if (!organizationId) return
  await tx.idempotencyRequest.create({
    data: {
      organizationId,
      actorStaffId: ACTOR,
      endpoint: endpointDeLaLlave(orderId),
      idempotencyKey: llave,
      requestHash: hashDeLaFirma(firma),
      responseStatus: 200,
      responseBody: { orderDiscountId: hecho.orderDiscountId, name: hecho.name, amount: hecho.amount },
      expiresAt: new Date(Date.now() + VIGENCIA_DE_LA_LLAVE_MS),
    },
  })
}
