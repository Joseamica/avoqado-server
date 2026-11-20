/**
 * Máquina de efectivo QuickPay Mini · fase 1a (R4-2, R5#1, R5#4): antes del `paycash` la PC cotiza el carrito con red. El total sale de
 * la MISMA lógica que crea la cuenta en línea (`cotizarVentaDeMostrador`), sin escribir nada. La máquina sólo cobra múltiplos de $0.50.
 *
 * El `quoteId` sirve para EMPEZAR un cobro durante 10 minutos (la PC lo usa con `expiresAt`); subir la venta nunca depende de él: si el
 * precio bajó entre tanto, la venta lo registra como excedente (`ventaDeLaMaquina.ts`). Va firmado con HMAC-SHA256 (sucursal, huella del
 * carrito, total y vencimiento) con una subllave derivada de `ACCESS_TOKEN_SECRET` (separación de llaves, como `unsubscribeToken.ts`):
 * no se guarda nada y no sirve como token de sesión.
 */
import crypto from 'crypto'

import AppError from '../../errors/AppError'
import { ACCESS_TOKEN_SECRET } from '../../config/env'
import { operationHash } from '../../utils/operationHash'
import { cotizarVentaDeMostrador, type CreateOrderInput } from '../mobile/order.mobile.service'
import { pedidoConDescuento } from './ventaDeLaMaquina'

export const VIGENCIA_DE_LA_COTIZACION_MS = 10 * 60_000

/**
 * Por qué la máquina no cobra este carrito (la PC lo explica y ofrece tarjeta antes del `paycash`):
 *  · `DESCUENTO`: cualquier descuento —de renglón, de cuenta, cortesía, cupón, promoción o del cliente— (decisión a del founder,
 *    Codex r1 #9 #10; reemplaza a `PROMOCION` y `CUPON`, que la PC nunca llegó a leer);
 *  · `PREMIO_PENDIENTE`: un premio de sellos (R5#4; su texto es otro);
 *  · `SIN_IMPORTE`: la cuenta es de $0 (Codex r1 #12);
 *  · `CENTAVOS`: no es múltiplo de $0.50;
 *  · `PRODUCTO_NO_DISPONIBLE`: un producto o extra que ya no está.
 */
export type MotivoSinMaquina = 'CENTAVOS' | 'PRODUCTO_NO_DISPONIBLE' | 'PREMIO_PENDIENTE' | 'DESCUENTO' | 'SIN_IMPORTE'

export interface CotizacionDeLaMaquina {
  /** Sólo si se puede cobrar en la máquina. */
  quoteId: string | null
  expiresAt: string | null
  /** Centavos (la frontera de la máquina). `null` si el carrito no se pudo cotizar. Total = venta + propina = el `Due`. */
  totalCents: number | null
  saleCents: number | null
  tipCents: number | null
  /** Todos los descuentos (de renglón, cortesías y de cuenta): venta = Σ renglones − descuentos. */
  discountCents: number | null
  renglones: Array<{
    productId: string | null
    name: string
    quantity: number
    unitCents: number
    totalCents: number
    discountCents: number
  }>
  cobrableEnMaquina: boolean
  motivo?: MotivoSinMaquina
}

const aCentavos = (pesos: number) => Math.round(pesos * 100)

const sinCotizar = (motivo: MotivoSinMaquina): CotizacionDeLaMaquina => ({
  quoteId: null,
  expiresAt: null,
  totalCents: null,
  saleCents: null,
  tipCents: null,
  discountCents: null,
  renglones: [],
  cobrableEnMaquina: false,
  motivo,
})

/** Un producto o un extra que ya no está en el catálogo (los 400 de `buildOrderItemsData`). */
const esProductoNoDisponible = (error: unknown) =>
  error instanceof AppError && (error.code === 'PRODUCT_NOT_FOUND' || error.code === 'MODIFIER_NOT_FOUND')

const llave = () => crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update('avoqado-cash-machine-quote-v1').digest()
const firma = (cuerpo: string) => crypto.createHmac('sha256', llave()).update(cuerpo).digest('base64url')

interface CuerpoDeLaCotizacion {
  v: 1
  ve: string
  /** Huella del carrito tal cual llegó (`operationHash`). */
  h: string
  t: number
  e: number
}

function firmarCotizacion(c: CuerpoDeLaCotizacion): string {
  const cuerpo = Buffer.from(JSON.stringify(c)).toString('base64url')
  return `${cuerpo}.${firma(cuerpo)}`
}

/** La cotización si es auténtica, de esta sucursal y sigue vigente; si no, `null`. */
export function leerCotizacion(
  quoteId: string,
  venueId: string,
  ahoraMs = Date.now(),
): { cartHash: string; totalCents: number; expiresAtMs: number } | null {
  const [cuerpo, dada, sobra] = quoteId.split('.')
  if (!cuerpo || !dada || sobra !== undefined) return null
  const a = Buffer.from(dada)
  const b = Buffer.from(firma(cuerpo))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const c = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf-8')) as CuerpoDeLaCotizacion
    if (c.v !== 1 || c.ve !== venueId || !(ahoraMs <= c.e)) return null
    return { cartHash: c.h, totalCents: c.t, expiresAtMs: c.e }
  } catch {
    return null
  }
}

/**
 * `POST /mobile/venues/:venueId/cash-machine/quote`. `input` es el pedido ya leído como `POST /orders`; `carrito`, el cuerpo tal cual
 * (su huella va en el `quoteId`); `premioPendiente`, si el carrito trae un premio de sellos (R5#4). Un carrito con descuento no se
 * cotiza: la fase 1a no lo cobra en la máquina (decisión a), y tampoco lo registra si llega (`ventaDeLaMaquina`). Los demás rechazos de
 * la creación en línea (precio cambiado) suben tal cual, como en `POST /orders`.
 */
export async function cotizarParaLaMaquina(
  venueId: string,
  input: CreateOrderInput,
  opciones: { premioPendiente: boolean; carrito: unknown },
): Promise<CotizacionDeLaMaquina> {
  if (opciones.premioPendiente) return sinCotizar('PREMIO_PENDIENTE')
  if (pedidoConDescuento(input)) return sinCotizar('DESCUENTO')

  let venta: Awaited<ReturnType<typeof cotizarVentaDeMostrador>>
  try {
    venta = await cotizarVentaDeMostrador(venueId, input)
  } catch (error) {
    if (esProductoNoDisponible(error)) return sinCotizar('PRODUCTO_NO_DISPONIBLE')
    throw error
  }

  const tipCents = aCentavos(venta.propina)
  const saleCents = aCentavos(venta.total - venta.propina)
  const totalCents = saleCents + tipCents
  // El descuento que el servidor pone solo (nada en el carrito lo pidió) tampoco: lo que se cotiza es lo que se registra.
  const motivo: MotivoSinMaquina | undefined =
    aCentavos(venta.descuento) > 0 ? 'DESCUENTO' : totalCents <= 0 ? 'SIN_IMPORTE' : totalCents % 50 !== 0 ? 'CENTAVOS' : undefined
  const expiresAtMs = Date.now() + VIGENCIA_DE_LA_COTIZACION_MS
  return {
    quoteId: motivo ? null : firmarCotizacion({ v: 1, ve: venueId, h: operationHash(opciones.carrito), t: totalCents, e: expiresAtMs }),
    expiresAt: motivo ? null : new Date(expiresAtMs).toISOString(),
    totalCents,
    saleCents,
    tipCents,
    discountCents: aCentavos(venta.descuento),
    renglones: venta.renglones.map(r => ({
      productId: r.productId,
      name: r.name,
      quantity: r.quantity,
      unitCents: aCentavos(r.unitPrice),
      totalCents: aCentavos(r.total),
      discountCents: aCentavos(r.discount),
    })),
    cobrableEnMaquina: !motivo,
    ...(motivo ? { motivo } : {}),
  }
}
