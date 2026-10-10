/**
 * Cuadre de la mañana del conector Shopify (spec D5; plan v2 B8). A las 06:14:45 (CDMX) pide una vuelta a cada sucursal
 * ACTIVE: sólo levanta `needsReconcile` (§10.9). Una vuelta que ya va a la mitad sigue; al cerrarla ve el pedido y empieza
 * otra. La corre el worker de 30 s con el lease de cada sucursal; al cerrar, si quedó algo «Por revisar», avisa por la
 * campanita y por correo, una vez al día.
 */
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

export async function pedirCuadreDeLaManana(): Promise<number> {
  // updateMany idempotente (sólo la bandera, sin `increment`): se puede reintentar sin efectos dobles (cron-jobs.md).
  const r = await retry(() => prisma.shopifyLocationLink.updateMany({ where: { status: 'ACTIVE' }, data: { needsReconcile: true } }), {
    retries: 2,
    initialDelay: 1500,
    shouldRetry: shouldRetryDbConnectionError,
    context: 'shopify-reconcile.pedir',
  })
  logger.info(`[SHOPIFY] cuadre de la mañana pedido para ${r.count} sucursal(es)`)
  return r.count
}

export const shopifyReconcileJob = scheduleJob(
  'shopify-reconcile',
  DATABASE_JOB_SCHEDULES.shopifyReconcile,
  () =>
    pedirCuadreDeLaManana()
      .then(() => undefined)
      .catch(err => {
        logger.error(`[SHOPIFY] cuadre de la mañana: ${err?.message}`)
      }),
  null,
  false,
  'America/Mexico_City',
)
