/**
 * La tasa de inyección: el número con el que Uber decide si te deja seguir integrado.
 *
 * 🔴 POR QUÉ ES LO MÁS IMPORTANTE QUE MEDIR: Uber lo define como "No. of Accepted Orders /
 * Total Submitted Orders" y exige **99.9%**. Por debajo de **99%** las integraciones "can be
 * subject to revoked API access and/or removal or disabling of restaurant stores".
 *
 * O sea: no es un indicador de calidad, es el interruptor de apagado. Y hasta hoy era
 * INVISIBLE — se podía estar cayendo semanas sin que nadie lo supiera hasta recibir el
 * correo de Uber. Cada cosa que produce un rechazo (menú viejo, producto agotado que se
 * sigue vendiendo, la tienda sin pausar cuando la cocina se ahoga, un pedido que revienta al
 * ingerir) se paga aquí, y aquí es donde se ve venir.
 *
 * Con 1000 pedidos al mes, el margen entre el 100% y la revocación son DIEZ pedidos.
 */
import { DeliveryOrderEventStatus, type DeliveryProvider } from '@prisma/client'

import prisma from '@/utils/prismaClient'

import { adapterFor, hasAdapter } from './adapterRegistry'

/** El umbral de Uber. Por debajo: revocación posible. */
export const UMBRAL_REVOCACION = 99
/** El objetivo declarado de Uber. Entre éste y el de revocación es zona de alarma. */
export const UMBRAL_OBJETIVO = 99.9

export interface TasaInyeccion {
  /** Pedidos que Uber nos mandó en la ventana. */
  recibidos: number
  /** De ésos, los que terminaron en una venta aceptada. */
  aceptados: number
  /** Porcentaje, o `null` si no hubo pedidos (una tasa sin datos es ruido, no información). */
  porcentaje: number | null
  estado: 'SIN_DATOS' | 'OK' | 'ALERTA' | 'CRITICO'
  /** Los pedidos que NO entraron, con su motivo — para saber QUÉ arreglar, no sólo que va mal. */
  fallidos: Array<{ externalOrderId: string | null; motivo: string; cuando: Date }>
}

/**
 * @param dias Ventana a medir. Uber revisa a diario, así que 7 días es lo que deja ver una
 *   tendencia sin que un mal día la domine.
 */
export async function calcularTasaInyeccion(params: {
  venueId?: string
  provider: DeliveryProvider
  dias?: number
}): Promise<TasaInyeccion> {
  // Un proveedor sin adaptador no tiene tasa que medir (Deliverect hoy): devolver 0%
  // sería una alarma falsa sobre algo que ni siquiera pasa por este camino.
  if (!hasAdapter(params.provider)) return { recibidos: 0, aceptados: 0, porcentaje: null, estado: 'SIN_DATOS', fallidos: [] }

  const desde = new Date(Date.now() - (params.dias ?? 7) * 24 * 3600_000)
  const base = {
    provider: params.provider,
    receivedAt: { gte: desde },
    // Sólo cuentan los avisos de PEDIDO: un cambio de estado de tienda no es un pedido que
    // se pudo aceptar o no, y meterlo diluiría la tasa hasta volverla mentira.
    //
    // 🔴 Los nombres los da el ADAPTADOR, no se escriben aquí. El guardrail de
    // `adapterRegistry.test.ts` lo prohíbe —y me atrapó escribiendo `'orders.notification'`
    // en este mismo archivo—: el núcleo comparando contra la cadena de un proveedor ya causó
    // tres bugs en este módulo.
    eventType: { in: adapterFor(params.provider).orderEventTypes() },
    ...(params.venueId ? { venueId: params.venueId } : {}),
  }

  const [recibidos, aceptados, fallidosRaw] = await Promise.all([
    prisma.deliveryOrderEvent.count({ where: base }),
    // Aceptado = llegó a ser una venta. `orderId` es la prueba: sin él no hubo pedido que
    // la cocina pudiera preparar, dijera lo que dijera el status.
    prisma.deliveryOrderEvent.count({ where: { ...base, status: DeliveryOrderEventStatus.PROCESSED, orderId: { not: null } } }),
    prisma.deliveryOrderEvent.findMany({
      where: {
        ...base,
        OR: [{ status: DeliveryOrderEventStatus.FAILED }, { orderId: null, status: { not: DeliveryOrderEventStatus.RECEIVED } }],
      },
      select: { externalOrderId: true, error: true, receivedAt: true },
      orderBy: { receivedAt: 'desc' },
      take: 20,
    }),
  ])

  // Sin pedidos no hay tasa. Reportar "0%" cuando no llegó nada dispararía una alarma falsa
  // en cada negocio que aún no vende por Uber — y las alarmas falsas enseñan a ignorarlas.
  if (recibidos === 0) {
    return { recibidos: 0, aceptados: 0, porcentaje: null, estado: 'SIN_DATOS', fallidos: [] }
  }

  const porcentaje = (aceptados / recibidos) * 100
  return {
    recibidos,
    aceptados,
    porcentaje: Math.round(porcentaje * 100) / 100,
    estado: porcentaje < UMBRAL_REVOCACION ? 'CRITICO' : porcentaje < UMBRAL_OBJETIVO ? 'ALERTA' : 'OK',
    fallidos: fallidosRaw.map(f => ({
      externalOrderId: f.externalOrderId,
      motivo: f.error ?? 'sin motivo registrado',
      cuando: f.receivedAt,
    })),
  }
}
