// jobs/ventas-cobrar-abandonadas.job.ts

import { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../utils/serializableRetry'
import logger from '../config/logger'
import { conNegocio } from '../services/demo/candadoDemo'
import { getContext, runWithContext } from '../observability/executionContext'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { utcTs } from '../utils/sqlDates'
import { ORDER_LOCK_WAIT_BUDGET } from '../services/shared/paymentShiftClaim'

/**
 * 🔴 hz:e82938e1:D36 — decisión del founder «A con ENSAYO» (20-nov-2026). «Cobrar» de la TPV crea la venta en el SERVIDOR al ir a
 * cobrar; si la cajera se arrepentía antes de cobrar, la venta quedaba PENDING con productos para siempre (106 en 90 días). La TPV
 * nueva la retira sola (`retirar-sin-cobro`); esta limpieza se ocupa de las que dejaron las TPV viejas y de las que ya existen.
 *
 * Qué anula (NUNCA borra: los renglones y la bitácora quedan como rastro), y sólo si TODO se cumple, otra vez bajo el candado y
 * ANTES de escribir nada:
 *  - venta de Cobrar: `source = TPV`, `type = TAKEOUT`, sin mesa, sin reserva, sin pedido en línea, y con la llave de Cobrar: el
 *    UUID que `CheckoutViewModel` manda a `createOrderWithItems` desde la TPV 2.8.2 (en campo, 2.10 o más). Sin llave o con otra
 *    es de otro flujo y se queda: la cuenta que nace al SEPARAR una cuenta (sin llave), cripto (sin llave), una reserva, `local_…`
 *    (la libreta legacy de «Órdenes»), `giftcard:`, `exchange:`, `pay-later:` (Codex r3 #2 y r4 #1; la pasada por los 29 creadores
 *    de ventas está en el anexo de la promesa);
 *  - `PENDING` / `PENDING`, con productos;
 *  - SIN cliente (ni `customerId` ni `OrderCustomer`) y sin `payLater = true`: un «Pagar después» de la TPV siempre lleva cliente
 *    (`CheckoutViewModel.createPayLaterOrder` lo exige), así que una con cliente puede ser una cuenta abierta A PROPÓSITO;
 *  - ningún `Payment` de ningún estado, ninguna asignación de pago y NINGUNA `TerminalPaymentRequest`, ni siquiera una rechazada
 *    (el POS intentó cobrarla: igual que el retiro de la TPV, se queda; Codex r3 #4);
 *  - SIN NINGÚN DESCUENTO y sin REFERIDO: que anularla no devuelva nada que un cobro tardío deje a medias o cuente dos veces
 *    (auditorías de Codex del 21-nov antes de ACTIVO; tras dos rondas con la misma familia, la pasada completa de abajo).
 *  - creada Y tocada por última vez hace más de 24 h, y con la misma versión que al elegirla.
 *
 * 🔴 Lo que una anulación devuelve, y por qué la limpieza no se cruza con ninguno (pasada completa, 21-nov). Si después llega el cobro
 * tardío, la venta se reabre (`reabrirSiRecibeDinero`) y NADIE vuelve a contar lo que la anulación devolvió:
 *   | efecto de anular (`cancelOrderInTransaction` + `publishCancelledOrder`) | cómo queda fuera                               |
 *   | comandas retiradas de la pantalla de cocina                            | a propósito: la cocina descarta > 12 h          |
 *   | uso de un descuento con tope (`usoContado`, D24)                       | sin ningún descuento                            |
 *   | canje de puntos o premio de sellos (se devuelve y se BORRA la fila)    | sin ningún descuento (si no, deuda que no hubo) |
 *   | apartado del cupón (cuenta sólo ventas vivas)                          | sin ningún descuento                            |
 *   | referidos a VOID (`onOrderCancelled`, después del commit)              | sin referido bajo el candado + `sinReferidos`   |
 *   | vales V7 que se sueltan                                                | nacen CONFIRMED y sin la llave de Cobrar        |
 *   | sobres de tarjetas de regalo desactivados                              | su venta lleva la llave `giftcard:`             |
 *   | mesa que se libera · folio de la tienda (sello y cortesía)             | sin mesa · sin pedido en línea                  |
 *   | pases de Wallet de clientas con premio                                 | sólo nacen de un canje: sin ningún descuento    |
 *   Un efecto NUEVO de anular entra a esta tabla antes de activar la limpieza en otro lado.
 *
 * La anulación es la de siempre (`cancelOrderInTransaction`: retira la comanda de la pantalla de cocina, suelta vales, devuelve
 * canjes y usos). La bitácora `ORDER_CANCELLED` (camino `LIMPIEZA_VENTA_COBRAR_ABANDONADA`, sin persona) va DENTRO de la
 * transacción. Un cobro que llegue después sobre la anulada (el efectivo que la cola de una TPV vieja manda días después, la tarjeta
 * aprobada que el aparato registra tarde) la reabre con rastro (`reabrirSiRecibeDinero`, prueba de integración). Su comanda no sale,
 * y es a propósito: la cocina descarta los renglones de más de 12 h (`KITCHEN_STALENESS_MS`) y tras 24 h el cliente ya se fue
 * (promesa de D36, Codex r3 #1). Lo que el aparato nunca registra, el SERVIDOR no lo ve, anulada o no: igual que hoy (declarado).
 * La lista legacy de «Órdenes» de las TPV viejas ya no ofrece una venta anulada para cobrarla (`getOrders`, 21-nov). Una TPV vieja que
 * todavía la tenga abierta en pantalla puede cobrarla en vivo (Codex r2 #3): el dinero se registra y la venta se reabre con rastro, lo
 * mismo que pasaría sin la limpieza (la venta seguía abierta), y como no lleva descuentos ni referidos, nada se cuenta dos veces.
 *
 * 🔴 El interruptor es `LIMPIEZA_VENTAS_COBRAR`. Sin valor, en el SERVIDOR real anula (`ACTIVO`): el founder dio su «sí, en prod» el
 * 22-nov («A»: que nazca prendida en el código, sin tocar Render), después de ver el ENSAYO con este código. «Real» = `NODE_ENV=production`
 * Y el servicio de Render `avoqado-server` (`modoDeLaLimpiezaDeCobrar`). Sin valor en cualquier otro servidor (local, Fly, Docker,
 * staging), `ENSAYO`: los servidores locales comparten la base av-db-25 y no deben anular ventas de prueba ajenas.
 * `ENSAYO` no escribe NADA, sólo deja una línea por negocio en el log («[LIMPIEZA COBRAR · ENSAYO] anularía N …», con `venueName`).
 * `APAGADO` no lee ni escribe. En Render, la variable queda como freno de emergencia: `ENSAYO` o `APAGADO` la detienen.
 */

export type ModoDeLaLimpieza = 'ENSAYO' | 'ACTIVO' | 'APAGADO'
export const CAMINO_LIMPIEZA_COBRAR = 'LIMPIEZA_VENTA_COBRAR_ABANDONADA'
export const MOTIVO_LIMPIEZA_COBRAR = 'Venta de Cobrar abandonada antes de cobrar, sin cliente ni cobro (limpieza tras 24 h)'
export const VARIABLE_DEL_MODO = 'LIMPIEZA_VENTAS_COBRAR'

/** El servicio de Render del SERVIDOR real (producción). Render pone su nombre en `RENDER_SERVICE_NAME` (`src/config/env.ts`). */
export const SERVICIO_DE_PRODUCCION = 'avoqado-server'

/**
 * Un valor escrito manda (ACTIVO, ENSAYO o APAGADO, sin importar mayúsculas ni espacios). Sin valor, ACTIVO sólo en el SERVIDOR real
 * (founder, 22-nov): `NODE_ENV=production` Y el servicio de Render `avoqado-server`. Codex d36-activo r1 #1: Fly staging/demo, Docker
 * Compose o un arranque local también dicen «production» y no deben anular, así que el nombre del servicio es la segunda llave. En
 * cualquier otro servidor, ENSAYO. Cualquier otro texto (una errata) es ENSAYO: un error de dedo nunca anula. Si renombran el servicio,
 * vuelve a ENSAYO (falla del lado seguro, visible en la línea de arranque).
 */
export function modoDeLaLimpiezaDeCobrar(
  valor: string | undefined = process.env[VARIABLE_DEL_MODO],
  servidor: { entorno?: string; servicio?: string } = {
    entorno: process.env.NODE_ENV,
    servicio: process.env.RENDER_SERVICE_NAME,
  },
): ModoDeLaLimpieza {
  const v = (valor ?? '').trim().toUpperCase()
  if (v === 'ACTIVO' || v === 'APAGADO' || v === 'ENSAYO') return v
  if (v === '') return servidor.entorno === 'production' && servidor.servicio === SERVICIO_DE_PRODUCCION ? 'ACTIVO' : 'ENSAYO'
  return 'ENSAYO'
}

const PLAZO_HORAS = 24
/** Por vuelta: cada hora sigue donde se quedó la anterior. */
const LOTE = 100
/** ENSAYO: cuántos negocios van al log, uno por línea (los de más ventas); el total siempre es de todos. */
const NEGOCIOS_EN_EL_LOG = 500

/** La llave de Cobrar: `UUID.randomUUID()` de la TPV (`CheckoutViewModel`, desde 2.8.2). Sin llave NO es de Cobrar (Codex r4 #1). */
export const LLAVE_DE_COBRAR = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

/**
 * La regla completa. Se usa al elegir y, otra vez, con la venta tomada y antes de escribir nada (`comprobarBajoElCandado`): una
 * edición entre la elección y el candado (nombre, nota, otro estado) mueve `updatedAt` o `status` y la venta se queda (Codex r3 #3).
 */
const abandonadaDeCobrar = (umbral: Date): Prisma.Sql => Prisma.sql`
  o.source = 'TPV' AND o.type = 'TAKEOUT' AND o."tableId" IS NULL AND o."reservationId" IS NULL
  AND o."externalId" ~* ${LLAVE_DE_COBRAR}
  AND o.status = 'PENDING' AND o."paymentStatus" = 'PENDING'
  AND o."customerId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "OrderCustomer" oc WHERE oc."orderId" = o.id)
  AND o."payLater" IS DISTINCT FROM true
  AND NOT EXISTS (SELECT 1 FROM "OnlineOrder" oo WHERE oo."orderId" = o.id)
  AND EXISTS (SELECT 1 FROM "OrderItem" i WHERE i."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "PaymentAllocation" pa WHERE pa."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "TerminalPaymentRequest" r WHERE r."venueId" = o."venueId" AND r."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "OrderDiscount" d WHERE d."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "Referral" rf WHERE rf."qualifyingOrderId" = o.id)
  AND o."createdAt" < ${utcTs(umbral)}
  AND o."updatedAt" < ${utcTs(umbral)}`

export interface Candidata {
  id: string
  venueId: string
  orderNumber: string
  /** La versión al elegirla: si cambió (renglones, descuentos…) bajo el candado, la venta se queda. */
  version: number
  /** Para avanzar el lote entre vueltas (cursor por `createdAt, id`). */
  createdAt?: Date
}

interface ResumenPorNegocio {
  venueId: string
  venueName: string | null
  cuantas: number
  masVieja: Date
  masNueva: Date
  folioMasViejo: string
  folioMasNuevo: string
  total: string | null
  /** De TODOS los negocios, no sólo de los que caben en el log (Codex r3 #5). */
  ventasEnTotal: number
  negociosEnTotal: number
}

export type DesenlaceDeAnular = 'anulada' | 'seQueda'

export interface ResultadoDeLaVuelta {
  modo: ModoDeLaLimpieza
  /** ENSAYO: cuántas anularía en TODOS los negocios (exacto, aunque el log enseñe sólo los primeros). */
  anularia: number
  /** ENSAYO: el desglose que llegó al log, por negocio. */
  negocios: Array<{ venueId: string; cuantas: number }>
  /** Otra vuelta seguía corriendo: ésta no hizo nada. */
  saltada?: boolean
  anuladas: number
  seQuedan: number
  fallaron: number
}

/** Lo que cambió bajo el candado: la anulación entera se revierte y la venta se queda como estaba. */
class SeQueda extends Error {}

/**
 * Anula UNA candidata con la anulación de siempre. La relectura corre con la venta ya tomada y ANTES de escribir nada
 * (`comprobarBajoElCandado`); la bitácora, dentro de la misma transacción (`dentroDeLaTx`). Si algo ya no se cumple, no se escribe.
 */
export async function anularVentaDeCobrarAbandonada(c: Candidata, umbral: Date): Promise<DesenlaceDeAnular> {
  const { cancelOrderInTransaction, publishCancelledOrder } = await import('@/services/mobile/order.mobile.service')
  let result: Awaited<ReturnType<typeof cancelOrderInTransaction>>
  try {
    result = await withDeadlockRetry(
      tx =>
        cancelOrderInTransaction(
          tx,
          c.venueId,
          c.id,
          undefined,
          undefined,
          // La bitácora, en la misma transacción: si no se escribe, no hay anulación.
          async (dentro: TxConReintento) => {
            await dentro.activityLog.create({
              data: {
                action: 'ORDER_CANCELLED',
                entity: 'Order',
                entityId: c.id,
                staffId: null,
                venueId: c.venueId,
                data: { camino: CAMINO_LIMPIEZA_COBRAR, reason: MOTIVO_LIMPIEZA_COBRAR, orderNumber: c.orderNumber },
              },
            })
          },
          {
            // Bajo el candado: con dinero no se anula, una ya anulada no se vuelve a escribir, y una mesa nunca.
            contarPagosRegistrados: true,
            rechazarYaCancelada: true,
            rechazarCuentaDeMesa: true,
            // Ya tomada y antes de escribir nada: la regla completa y la misma versión, o se queda como está.
            comprobarBajoElCandado: async bajo => {
              const sigue = await bajo.$queryRaw<Array<{ id: string }>>`
                SELECT o.id FROM "Order" o
                WHERE o.id = ${c.id} AND o."venueId" = ${c.venueId} AND o.version = ${c.version} AND ${abandonadaDeCobrar(umbral)}`
              if (sigue.length === 0) throw new SeQueda()
            },
          },
        ),
      { etiqueta: 'anularVentaDeCobrarAbandonada', ...ORDER_LOCK_WAIT_BUDGET },
    )
  } catch (error) {
    // Lo que no se cumplió bajo el candado (cambió, ya la anularon, ya tiene dinero, es de mesa): se queda como está.
    if (error instanceof SeQueda) return 'seQueda'
    const status = (error as { statusCode?: number } | null)?.statusCode
    if (status === 400 || status === 404 || status === 409) return 'seQueda'
    throw error
  }
  // La bitácora ya quedó en la transacción: aquí sólo los avisos de cualquier anulación (sockets, referidos, vales, pases).
  // `sinReferidos`: bajo el candado la venta no tenía referidos; uno capturado en el instante después se queda para el cobro tardío.
  await publishCancelledOrder(c.venueId, result, undefined, MOTIVO_LIMPIEZA_COBRAR, undefined, { bitacoraEnLaTx: true, sinReferidos: true })
  return 'anulada'
}

export interface OpcionesDeLaLimpieza {
  modo?: ModoDeLaLimpieza
  /** Para pruebas: quién anula una candidata (por omisión, [anularVentaDeCobrarAbandonada]). */
  anular?: (c: Candidata, umbral: Date) => Promise<DesenlaceDeAnular>
  /** Para pruebas: la espera del reintento de la lectura de entrada. */
  esperaDeReintentoMs?: number
}

export class VentasCobrarAbandonadasJob {
  private job: CronJob | null = null
  private readonly CRON_PATTERN = '23 * * * *' // cada hora, fuera del minuto :00 (cron-jobs.md)
  private readonly modoFijo?: ModoDeLaLimpieza
  private readonly anular: (c: Candidata, umbral: Date) => Promise<DesenlaceDeAnular>
  private readonly espera: number
  /** Dónde sigue el lote: las que se quedan no tapan a las de atrás (Codex r3). Al llegar al final, vuelve al principio. */
  private cursor: { createdAt: Date; id: string } | null = null
  /** El programador no espera a la vuelta anterior: una vuelta larga no se encima con la siguiente. */
  private enCurso = false

  constructor(opciones: OpcionesDeLaLimpieza = {}) {
    this.modoFijo = opciones.modo
    this.anular = opciones.anular ?? anularVentaDeCobrarAbandonada
    this.espera = opciones.esperaDeReintentoMs ?? 1500
    this.job = scheduleJob('ventas-cobrar-abandonadas', this.CRON_PATTERN, this.vuelta.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (!this.job) return
    this.job.start()
    // De dónde salió el modo, para comprobarlo en el log sin abrir la configuración: la variable escrita o el valor por omisión.
    const escrita = (process.env[VARIABLE_DEL_MODO] ?? '').trim() !== ''
    logger.info(
      `🧹 Limpieza de ventas de Cobrar abandonadas: cada hora, modo ${this.modo()} (${escrita ? `${VARIABLE_DEL_MODO} escrita` : `por omisión en ${process.env.RENDER_SERVICE_NAME ?? 'un servidor sin nombre de Render'}`})`,
    )
  }

  stop(): void {
    this.job?.stop()
  }

  /** Para pruebas y para correrla a mano. */
  async correrAhora(): Promise<ResultadoDeLaVuelta> {
    return this.unaVuelta()
  }

  private modo(): ModoDeLaLimpieza {
    return this.modoFijo ?? modoDeLaLimpiezaDeCobrar()
  }

  /** Lo que corre el programador: su firma es `() => void | Promise<void>`. */
  private async vuelta(): Promise<void> {
    await this.unaVuelta()
  }

  private async unaVuelta(): Promise<ResultadoDeLaVuelta> {
    const modo = this.modo()
    const r: ResultadoDeLaVuelta = { modo, anularia: 0, negocios: [], anuladas: 0, seQuedan: 0, fallaron: 0 }
    if (modo === 'APAGADO') return r
    if (this.enCurso) {
      logger.warn('⏭️ [LIMPIEZA COBRAR] la vuelta anterior sigue corriendo: ésta se salta', { modo })
      return { ...r, saltada: true }
    }
    this.enCurso = true
    const umbral = new Date(Date.now() - PLAZO_HORAS * 60 * 60 * 1000)
    try {
      if (modo === 'ENSAYO') {
        await this.ensayo(umbral, r)
        return r
      }
      const desde = this.cursor
      const candidatas = await retry(
        () =>
          prisma.$queryRaw<Candidata[]>`
            SELECT o.id, o."venueId", o."orderNumber", o.version, o."createdAt"
            FROM "Order" o
            WHERE ${abandonadaDeCobrar(umbral)}
              ${desde ? Prisma.sql`AND (o."createdAt", o.id) > (${utcTs(desde.createdAt)}, ${desde.id})` : Prisma.empty}
            ORDER BY o."createdAt" ASC, o.id ASC
            LIMIT ${LOTE}`,
        { retries: 2, initialDelay: this.espera, shouldRetry: shouldRetryDbConnectionError, context: 'ventas-cobrar-abandonadas.elegir' },
      )
      // Lote lleno: la siguiente vuelta sigue después de la última; si no, ya se llegó al final y vuelve a empezar.
      const ultima = candidatas[candidatas.length - 1]
      this.cursor = candidatas.length === LOTE && ultima?.createdAt ? { createdAt: ultima.createdAt, id: ultima.id } : null
      for (const c of candidatas) {
        try {
          const desenlace = await this.anular(c, umbral)
          if (desenlace === 'anulada') r.anuladas += 1
          else r.seQuedan += 1
        } catch (error) {
          // Una que no se pudo no frena a las demás ni tumba la vuelta.
          r.fallaron += 1
          conNegocio(c.venueId, () =>
            logger.error(`❌ [LIMPIEZA COBRAR] no se pudo anular la venta abandonada ${c.orderNumber}`, { orderId: c.id, error }),
          )
        }
      }
      if (candidatas.length) {
        logger.info(`🧹 [LIMPIEZA COBRAR · ACTIVO] anuló ${r.anuladas}, se quedan ${r.seQuedan}, fallaron ${r.fallaron}`, { ...r })
      }
    } catch (error) {
      r.fallaron += 1
      logger.error('❌ [LIMPIEZA COBRAR] la vuelta falló (la siguiente vuelve a intentar)', { modo, error })
    } finally {
      this.enCurso = false
    }
    return r
  }

  /**
   * ENSAYO: sólo lee (un agregado por negocio) y lo dice en el log. No abre transacciones ni escribe nada. Los totales son de TODOS los
   * negocios (ventanas sobre el agregado, antes del tope); el tope sólo acota cuántas líneas van al log, y si recorta lo dice.
   */
  private async ensayo(umbral: Date, r: ResultadoDeLaVuelta): Promise<void> {
    const porNegocio = await retry(
      () =>
        prisma.$queryRaw<ResumenPorNegocio[]>`
          SELECT o."venueId", min(v.name) AS "venueName", count(*)::int AS cuantas,
                 min(o."createdAt") AS "masVieja", max(o."createdAt") AS "masNueva",
                 (array_agg(o."orderNumber" ORDER BY o."createdAt" ASC, o.id ASC))[1] AS "folioMasViejo",
                 (array_agg(o."orderNumber" ORDER BY o."createdAt" DESC, o.id DESC))[1] AS "folioMasNuevo",
                 sum(o.total)::text AS total,
                 (sum(count(*)) OVER ())::int AS "ventasEnTotal",
                 (count(*) OVER ())::int AS "negociosEnTotal"
          FROM "Order" o
          JOIN "Venue" v ON v.id = o."venueId"
          WHERE ${abandonadaDeCobrar(umbral)}
          GROUP BY o."venueId"
          ORDER BY cuantas DESC, o."venueId"
          LIMIT ${NEGOCIOS_EN_EL_LOG}`,
      { retries: 2, initialDelay: this.espera, shouldRetry: shouldRetryDbConnectionError, context: 'ventas-cobrar-abandonadas.ensayo' },
    )
    for (const n of porNegocio) {
      r.negocios.push({ venueId: n.venueId, cuantas: n.cuantas })
      // El nombre sale de la misma consulta: la línea lo trae aunque la caché de nombres todavía no cargue (Codex r3).
      enElNegocio(n.venueId, n.venueName, () =>
        logger.info(
          `🧪 [LIMPIEZA COBRAR · ENSAYO] anularía ${n.cuantas} venta(s) de Cobrar abandonada(s) (la más vieja ${n.folioMasViejo}, la más nueva ${n.folioMasNuevo})`,
          {
            modo: 'ENSAYO',
            anularia: n.cuantas,
            total: n.total,
            masVieja: { folio: n.folioMasViejo, creada: n.masVieja },
            masNueva: { folio: n.folioMasNuevo, creada: n.masNueva },
          },
        ),
      )
    }
    const ventas = porNegocio[0]?.ventasEnTotal ?? 0
    const negocios = porNegocio[0]?.negociosEnTotal ?? 0
    r.anularia = ventas
    const recorte =
      negocios > porNegocio.length ? ` (en el log van los ${porNegocio.length} con más; faltan ${negocios - porNegocio.length})` : ''
    logger.info(`🧪 [LIMPIEZA COBRAR · ENSAYO] en total anularía ${ventas} en ${negocios} negocio(s)${recorte}; no se escribió nada`, {
      modo: 'ENSAYO',
      anularia: ventas,
      negocios,
      negociosEnElLog: porNegocio.length,
    })
  }
}

/** Como `conNegocio`, pero con el nombre que ya trajo la consulta (la caché de nombres puede no haber cargado todavía). */
function enElNegocio<T>(venueId: string, venueName: string | null, fn: () => T): T {
  if (!venueName) return conNegocio(venueId, fn)
  return conNegocio(venueId, () => runWithContext({ ...getContext()!, venueName }, fn))
}

export const ventasCobrarAbandonadasJob = new VentasCobrarAbandonadasJob()
