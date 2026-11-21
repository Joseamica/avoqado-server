// jobs/ventas-cobrar-abandonadas.job.ts

import { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../utils/serializableRetry'
import logger from '../config/logger'
import { conNegocio } from '../services/demo/candadoDemo'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { utcTs } from '../utils/sqlDates'
import { ORDER_LOCK_WAIT_BUDGET } from '../services/shared/paymentShiftClaim'

/**
 * 🔴 hz:e82938e1:D36 — decisión del founder «A con ENSAYO» (20-nov-2026). «Cobrar» de la TPV crea la venta en el SERVIDOR al ir a
 * cobrar; si la cajera se arrepentía antes de cobrar, la venta quedaba PENDING con productos para siempre (106 en 90 días). La TPV
 * nueva la retira sola (`retirar-sin-cobro`); esta limpieza se ocupa de las que dejaron las TPV viejas y de las que ya existen.
 *
 * Qué anula (NUNCA borra: los renglones y la bitácora quedan como rastro), y sólo si TODO se cumple, otra vez bajo el candado:
 *  - venta de Cobrar: `source = TPV`, `type = TAKEOUT`, sin mesa, sin pedido en línea, sin llave de cambio ni de «Pagar después»;
 *  - `PENDING` / `PENDING`, con productos;
 *  - SIN cliente (ni `customerId` ni `OrderCustomer`) y sin `payLater = true`: un «Pagar después» de la TPV siempre lleva cliente
 *    (`CheckoutViewModel.createPayLaterOrder` lo exige), así que una con cliente puede ser una cuenta abierta A PROPÓSITO;
 *  - ningún `Payment` de ningún estado, ninguna asignación de pago, ninguna `TerminalPaymentRequest` (salvo la lápida de admisión
 *    `FAILED` + `REJECTED_…`, que prueba que ese cobro nunca se creó, igual que `abandoned-orders-cleanup`);
 *  - creada Y tocada por última vez hace más de 24 h.
 *
 * La anulación es la de siempre (`cancelOrderInTransaction`: retira la comanda de la pantalla de cocina, suelta vales, devuelve
 * canjes y usos, y el cupón deja de estar apartado). La bitácora `ORDER_CANCELLED` (camino `LIMPIEZA_VENTA_COBRAR_ABANDONADA`, sin
 * persona) va DENTRO de la transacción. Un cobro que llegue después sobre la anulada la reabre con rastro (`reabrirSiRecibeDinero`).
 *
 * 🔴 ENSAYO por omisión (`LIMPIEZA_VENTAS_COBRAR`): no escribe NADA, sólo deja una línea por negocio en el log
 * («[LIMPIEZA COBRAR · ENSAYO] anularía N …», con `venueName`). Pasar a `ACTIVO` es un cambio de configuración en producción que se
 * hace sólo con el «sí» del founder. `APAGADO` no lee ni escribe.
 */

export type ModoDeLaLimpieza = 'ENSAYO' | 'ACTIVO' | 'APAGADO'
export const CAMINO_LIMPIEZA_COBRAR = 'LIMPIEZA_VENTA_COBRAR_ABANDONADA'
export const MOTIVO_LIMPIEZA_COBRAR = 'Venta de Cobrar abandonada antes de cobrar, sin cliente ni cobro (limpieza tras 24 h)'
export const VARIABLE_DEL_MODO = 'LIMPIEZA_VENTAS_COBRAR'

/** Por omisión, y ante cualquier valor que no sea exactamente ACTIVO o APAGADO, ENSAYO: nunca anula sin que alguien lo pida. */
export function modoDeLaLimpiezaDeCobrar(valor: string | undefined = process.env[VARIABLE_DEL_MODO]): ModoDeLaLimpieza {
  const v = (valor ?? '').trim().toUpperCase()
  return v === 'ACTIVO' || v === 'APAGADO' ? v : 'ENSAYO'
}

const PLAZO_HORAS = 24
/** Por vuelta: cada hora alcanza el resto en las siguientes. */
const LOTE = 100

/** Lo que no cambia al anular: se vuelve a comprobar DENTRO de la transacción, ya con la venta tomada. */
const reglaFija = (umbral: Date): Prisma.Sql => Prisma.sql`
  o.source = 'TPV' AND o.type = 'TAKEOUT' AND o."tableId" IS NULL
  AND o."customerId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "OrderCustomer" oc WHERE oc."orderId" = o.id)
  AND o."payLater" IS DISTINCT FROM true
  AND (o."externalId" IS NULL OR (o."externalId" NOT LIKE 'exchange:%' AND o."externalId" NOT LIKE 'pay-later:%'))
  AND NOT EXISTS (SELECT 1 FROM "OnlineOrder" oo WHERE oo."orderId" = o.id)
  AND EXISTS (SELECT 1 FROM "OrderItem" i WHERE i."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "PaymentAllocation" pa WHERE pa."orderId" = o.id)
  AND NOT EXISTS (
    SELECT 1 FROM "TerminalPaymentRequest" r
    WHERE r."venueId" = o."venueId" AND r."orderId" = o.id
      AND NOT (r.status = 'FAILED' AND r."failureCode" IS NOT NULL AND left(r."failureCode", 9) = 'REJECTED_')
  )
  AND o."createdAt" < ${utcTs(umbral)}`

/** La regla completa al elegir: además, pendiente y sin tocar en 24 h (al anular cambian, por eso no van en la relectura). */
const abandonadaDeCobrar = (umbral: Date): Prisma.Sql => Prisma.sql`
  ${reglaFija(umbral)}
  AND o.status = 'PENDING' AND o."paymentStatus" = 'PENDING'
  AND o."updatedAt" < ${utcTs(umbral)}`

export interface Candidata {
  id: string
  venueId: string
  orderNumber: string
  /** La versión al elegirla: si cambió (renglones, descuentos…) bajo el candado, la venta se queda. */
  version: number
}

interface ResumenPorNegocio {
  venueId: string
  cuantas: number
  masVieja: Date
  masNueva: Date
  folioMasViejo: string
  folioMasNuevo: string
  total: string | null
}

export type DesenlaceDeAnular = 'anulada' | 'seQueda'

export interface ResultadoDeLaVuelta {
  modo: ModoDeLaLimpieza
  anularia: number
  anuladas: number
  seQuedan: number
  fallaron: number
}

/** Lo que cambió bajo el candado: la anulación entera se revierte y la venta se queda como estaba. */
class SeQueda extends Error {}

/**
 * Anula UNA candidata con la anulación de siempre. La relectura y la bitácora van en `dentroDeLaTx`: corren con la venta ya tomada
 * y antes del commit; si algo ya no se cumple, todo se revierte.
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
          async (dentro: TxConReintento) => {
            const sigue = await dentro.$queryRaw<Array<{ id: string }>>`
              SELECT o.id FROM "Order" o
              WHERE o.id = ${c.id} AND o."venueId" = ${c.venueId} AND o.version = ${c.version} AND ${reglaFija(umbral)}`
            if (sigue.length === 0) throw new SeQueda()
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
          // Bajo el candado: con dinero no se anula, una ya anulada no se vuelve a escribir, y una mesa nunca.
          { contarPagosRegistrados: true, rechazarYaCancelada: true, rechazarCuentaDeMesa: true },
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
  await publishCancelledOrder(c.venueId, result, undefined, MOTIVO_LIMPIEZA_COBRAR, undefined, { bitacoraEnLaTx: true })
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

  constructor(opciones: OpcionesDeLaLimpieza = {}) {
    this.modoFijo = opciones.modo
    this.anular = opciones.anular ?? anularVentaDeCobrarAbandonada
    this.espera = opciones.esperaDeReintentoMs ?? 1500
    this.job = scheduleJob('ventas-cobrar-abandonadas', this.CRON_PATTERN, this.vuelta.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (!this.job) return
    this.job.start()
    logger.info(`🧹 Limpieza de ventas de Cobrar abandonadas: cada hora, modo ${this.modo()} (${VARIABLE_DEL_MODO})`)
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
    const r: ResultadoDeLaVuelta = { modo, anularia: 0, anuladas: 0, seQuedan: 0, fallaron: 0 }
    if (modo === 'APAGADO') return r
    const umbral = new Date(Date.now() - PLAZO_HORAS * 60 * 60 * 1000)
    try {
      if (modo === 'ENSAYO') {
        await this.ensayo(umbral, r)
        return r
      }
      const candidatas = await retry(
        () =>
          prisma.$queryRaw<Candidata[]>`
            SELECT o.id, o."venueId", o."orderNumber", o.version
            FROM "Order" o
            WHERE ${abandonadaDeCobrar(umbral)}
            ORDER BY o."createdAt" ASC, o.id ASC
            LIMIT ${LOTE}`,
        { retries: 2, initialDelay: this.espera, shouldRetry: shouldRetryDbConnectionError, context: 'ventas-cobrar-abandonadas.elegir' },
      )
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
    }
    return r
  }

  /** ENSAYO: sólo lee (un agregado por negocio, acotado) y lo dice en el log. No abre transacciones ni escribe nada. */
  private async ensayo(umbral: Date, r: ResultadoDeLaVuelta): Promise<void> {
    const porNegocio = await retry(
      () =>
        prisma.$queryRaw<ResumenPorNegocio[]>`
          SELECT o."venueId", count(*)::int AS cuantas,
                 min(o."createdAt") AS "masVieja", max(o."createdAt") AS "masNueva",
                 (array_agg(o."orderNumber" ORDER BY o."createdAt" ASC, o.id ASC))[1] AS "folioMasViejo",
                 (array_agg(o."orderNumber" ORDER BY o."createdAt" DESC, o.id DESC))[1] AS "folioMasNuevo",
                 sum(o.total)::text AS total
          FROM "Order" o
          WHERE ${abandonadaDeCobrar(umbral)}
          GROUP BY o."venueId"
          ORDER BY o."venueId"
          LIMIT 500`,
      { retries: 2, initialDelay: this.espera, shouldRetry: shouldRetryDbConnectionError, context: 'ventas-cobrar-abandonadas.ensayo' },
    )
    for (const n of porNegocio) {
      r.anularia += n.cuantas
      conNegocio(n.venueId, () =>
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
    logger.info(`🧪 [LIMPIEZA COBRAR · ENSAYO] en total anularía ${r.anularia} en ${porNegocio.length} negocio(s); no se escribió nada`, {
      modo: 'ENSAYO',
      anularia: r.anularia,
      negocios: porNegocio.length,
    })
  }
}

export const ventasCobrarAbandonadasJob = new VentasCobrarAbandonadasJob()
