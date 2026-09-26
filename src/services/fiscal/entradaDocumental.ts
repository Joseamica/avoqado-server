// src/services/fiscal/entradaDocumental.ts
// Plan 3 (IVA por producto), Tarea 4: la entrada documental — la FOTO CONGELADA del intento de
// facturar. Se captura UNA VEZ, en la transacción de reserva, y todo lo que sigue (el payload al PAC,
// la comparación de reenvíos, la auditoría de un intento incierto) sólo la LEE — nunca vuelve a
// resolver la orden viva ni el producto después del commit (ver `global-constraints.md`).
import { createHash } from 'crypto'
import type { IvaTratamiento } from './ivaTratamiento'
import type { LoadedOrderBundle, IssueReceptor } from './cfdi.service'
import { assembleSaleInput } from './assembleSaleInput'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import type { CreateInvoiceParams } from './providers/fiscal-provider.interface'

export interface EntradaDocumentalV1 {
  version: 1
  orderId: string
  fiscalEmisorId: string
  /** ID de la fila Cfdi que esta entrada sustituye, o `null` si es una emisión normal. */
  replacesCfdiId: string | null
  /** Foto congelada: lo que el contrato de precio DECÍA al capturar, no lo que diga después. */
  contratoDePrecio: string | null
  /** Foto congelada: lo que el estado de pago DECÍA al capturar, no lo que diga después. */
  paymentStatus: string | null
  clasificacion: 'TODO_16' | 'MIXTA'
  paidCents: number
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  /**
   * Un renglón por `OrderItem` REAL, con su tratamiento resuelto — esto es lo que SELLA la entrada
   * (`OrderItemSelloIva`). Los conceptos de extras no tienen `orderItemId` y no van aquí; venta sin
   * renglones (importe libre) ⇒ `[]`.
   */
  renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
  /**
   * Los parámetros YA RESUELTOS que se le mandarán al PAC (claves SAT, receptor, forma y método de
   * pago, conceptos con sus impuestos). Nada se vuelve a resolver después de capturar. Sin
   * `externalId`: ese campo lo pone `paramsDesdeEntrada` con la llave de la versión que se envía.
   */
  params: Omit<CreateInvoiceParams, 'externalId'>
}

/**
 * Arma la entrada documental de UNA orden, a partir del bundle ya cargado. Falla CERRADO —nunca
 * asume `TODO_16` ni inventa dinero— si el bundle no trae `clasificacion` o `paidCents` resueltos:
 * eso significaría sellar una factura fiscal a ciegas, sobre datos a medio construir (p.ej. un
 * bundle armado a mano por una prueba de otra tarea, sin pasar por `loadOrderForCfdiFromDb`).
 */
export function capturarEntrada(
  bundle: LoadedOrderBundle,
  receptor: IssueReceptor,
  orderId: string,
  opts: { replacesCfdiId?: string } = {},
): EntradaDocumentalV1 {
  const clasificacion = bundle.order.clasificacion
  if (clasificacion !== 'TODO_16' && clasificacion !== 'MIXTA') {
    throw new Error(
      `capturarEntrada: el bundle de la orden ${orderId} no trae "clasificacion" resuelta; no se sella una entrada fiscal a ciegas.`,
    )
  }
  if (typeof bundle.paidCents !== 'number') {
    throw new Error(
      `capturarEntrada: el bundle de la orden ${orderId} no trae "paidCents" resuelto; no se sella una entrada fiscal a ciegas.`,
    )
  }

  // El orderId hace determinista la foto; cada envío sobreescribe AMBAS identidades
  // (idempotencyKey y externalId) con la llave versionada del intento.
  const params = buildCreateInvoiceParams(
    assembleSaleInput(bundle.order, {
      receptor,
      paymentMethod: bundle.paymentMethod,
      tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
      metodoPago: bundle.metodoPago,
      serie: bundle.emisor.serie ?? undefined,
      idempotencyKey: orderId,
    }),
  )

  const renglones = (bundle.order.renglonesOrigen ?? []).map(r => ({ orderItemId: r.orderItemId, tratamiento: r.tratamiento }))

  const entrada: EntradaDocumentalV1 = {
    version: 1,
    orderId,
    fiscalEmisorId: bundle.emisor.id,
    replacesCfdiId: opts.replacesCfdiId ?? null,
    contratoDePrecio: bundle.order.contratoDePrecio ?? null,
    paymentStatus: bundle.order.paymentStatus ?? null,
    clasificacion,
    paidCents: bundle.paidCents,
    montos: { subtotalCents: bundle.subtotalCents, taxCents: bundle.taxCents, totalCents: bundle.totalCents },
    renglones,
    params,
  }
  // Copia profunda: mutar el bundle (o el receptor) DESPUÉS de capturar nunca puede alcanzar la
  // entrada ya sellada — es la garantía de "foto congelada".
  return structuredClone(entrada)
}

/** Ordena las llaves de un valor JSON recursivamente (arrays se recorren en su mismo orden). */
function conLlavesOrdenadas(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(conLlavesOrdenadas)
  if (valor !== null && typeof valor === 'object') {
    const ordenado: Record<string, unknown> = {}
    for (const clave of Object.keys(valor as Record<string, unknown>).sort()) {
      ordenado[clave] = conLlavesOrdenadas((valor as Record<string, unknown>)[clave])
    }
    return ordenado
  }
  return valor
}

/** sha256 hex del JSON canónico de la entrada (llaves ordenadas recursivamente). */
export function huellaDeEntrada(e: EntradaDocumentalV1): string {
  return createHash('sha256')
    .update(JSON.stringify(conLlavesOrdenadas(e)))
    .digest('hex')
}

/**
 * Los `CreateInvoiceParams` completos para ESTE intento: la entrada capturada + el `externalId` de
 * la versión que se envía (`<idempotencyKey>#<attempts>`). Copia profunda: nada de lo que devuelve
 * comparte referencias con la entrada guardada.
 */
export function paramsDesdeEntrada(e: EntradaDocumentalV1, idempotencyKey: string): CreateInvoiceParams {
  return { ...structuredClone(e.params), externalId: idempotencyKey }
}

/** `true` si `v` es un objeto plano (no `null`, no arreglo) — para validar la forma mínima de `leerEntrada`. */
function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Valida la forma MÍNIMA de una entrada documental leída de la base (columna JSON) y la devuelve
 * tipada, o `null` si no es una `EntradaDocumentalV1` válida — filas viejas (`version` ausente o
 * distinta de 1, forma incompleta) leen `null` en vez de reventar.
 */
export function leerEntrada(json: unknown): EntradaDocumentalV1 | null {
  if (!esObjeto(json)) return null
  if (json.version !== 1) return null
  if (typeof json.orderId !== 'string') return null
  if (typeof json.fiscalEmisorId !== 'string') return null
  if (json.replacesCfdiId !== null && typeof json.replacesCfdiId !== 'string') return null
  if (json.contratoDePrecio !== null && typeof json.contratoDePrecio !== 'string') return null
  if (json.paymentStatus !== null && typeof json.paymentStatus !== 'string') return null
  if (json.clasificacion !== 'TODO_16' && json.clasificacion !== 'MIXTA') return null
  if (typeof json.paidCents !== 'number') return null
  if (!esObjeto(json.montos)) return null
  const { subtotalCents, taxCents, totalCents } = json.montos
  if (typeof subtotalCents !== 'number' || typeof taxCents !== 'number' || typeof totalCents !== 'number') return null
  if (!Array.isArray(json.renglones)) return null
  for (const r of json.renglones) {
    if (!esObjeto(r) || typeof r.orderItemId !== 'string' || typeof r.tratamiento !== 'string') return null
  }
  if (!esObjeto(json.params)) return null

  return json as unknown as EntradaDocumentalV1
}
