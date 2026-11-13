/**
 * D1 (pizarrón hz:c2bad9c3:D1, 13-nov): el MISMO reembolso de la TPV llega dos veces casi a la vez (la cola reenvía mientras
 * el primero sigue en el servidor). El segundo buscaba la llave ANTES del candado, no la veía, esperaba el candado y, cuando
 * el primero ya había guardado, veía saldo reembolsable 0 y contestaba 400 «excede el monto reembolsable». La TPV lo marca
 * FAILED permanente y bloquea el cierre de turno, aunque el reembolso SÍ quedó registrado.
 *
 * Base real y cruce FORZADO (Codex r1 #3): un tercero sostiene el candado de la orden hasta que los dos envíos ya buscaron la
 * llave (sin encontrarla) y están formados detrás. Sin esa barrera el segundo podía llegar tarde y salir por el paso 1.5,
 * y la prueba pasaba aunque el arreglo no existiera.
 */
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { abrirTurno, limpiarVenue, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'
import { crearNegocioDePrueba, limpiarNegocioDePrueba, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

let venueId = ''
let staffId = ''

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('reembolso-repetido'))
  await abrirTurno(venueId, staffId)
})

afterAll(async () => {
  if (!venueId) return // Sin negocio no se borra NADA: un filtro con `venueId` indefinido vaciaría tablas enteras.
  await prisma.venueTransaction.deleteMany({ where: { venueId } }).catch(() => undefined)
  await limpiarVenue(venueId)
  await limpiarNegocioDePrueba(venueId)
  await prisma.$disconnect()
})

const reembolsoTotal = (originalPaymentId: string, llave: string, referencia = 'REF-D1') =>
  recordRefund(
    venueId,
    {
      venueId,
      originalPaymentId,
      amount: 10000,
      reason: 'CUSTOMER_REQUEST',
      authorizationNumber: 'AUT-D1',
      referenceNumber: referencia,
      isPartialRefund: false,
      currency: 'MXN',
      idempotencyKey: llave,
    } as never,
    staffId,
  )

/**
 * Cuántas sesiones esperan DETRÁS del tercero, directa o indirectamente (Codex r2 #1): la segunda puede esperar a la
 * primera en la cola del renglón, y las esperas de otras pruebas en la misma base no cuentan.
 */
const detenidasDetrasDe = async (pidTercero: number) => {
  const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
    WITH RECURSIVE cadena(pid) AS (
      SELECT ${pidTercero}::int
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN cadena c ON c.pid = ANY(pg_blocking_pids(a.pid))
    )
    SELECT (count(*) - 1)::int AS n FROM cadena`
  return n
}

/**
 * Sostiene el candado de la orden del cobro, lanza los envíos y sólo suelta cuando los dos están formados detrás: para
 * entonces los dos ya hicieron su primera búsqueda de la llave (antes del candado) y no encontraron nada.
 */
async function conLosDosFormados<T>(orderId: string, envios: () => Array<Promise<T>>) {
  let soltar!: () => void
  const suelta = new Promise<void>(r => (soltar = r))
  let tomado!: (pid: number) => void
  const yaTomado = new Promise<number>(r => (tomado = r))
  const tercero = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
      tomado(await pidDe(tx))
      await suelta
    },
    { timeout: 30_000, maxWait: 10_000 },
  )
  try {
    // Codex r2 #2: si el tercero falla antes de sostener el candado, su error sale aquí en vez de colgar la prueba.
    const pidTercero = await Promise.race([
      yaTomado,
      tercero.then(() => {
        throw new Error('El tercero terminó sin sostener el candado de la orden')
      }),
    ])
    const resultados = Promise.allSettled(envios())
    for (let i = 0; (await detenidasDetrasDe(pidTercero)) < 2; i++) {
      if (i > 400) throw new Error('Los dos envíos no llegaron a formarse detrás del candado')
      await new Promise(r => setTimeout(r, 25))
    }
    return resultados
  } finally {
    soltar()
    await tercero.catch(() => undefined)
  }
}

const motivo = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? String((r.reason as Error)?.message) : '')

const reembolsosDe = (pagoId: string) =>
  prisma.payment.findMany({
    where: { venueId, type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: pagoId } },
    select: { id: true },
  })

describe('D1 · el mismo reembolso de la TPV repetido a la vez', () => {
  it('los dos envíos simultáneos devuelven el MISMO reembolso; ninguno sale 400 y sólo queda una fila', async () => {
    const { pago, order } = await sembrarCobro({ venueId, staffId, saleCents: 10000 })
    const llave = `llave-${cuid()}`

    const [a, b] = await conLosDosFormados(order.id, () => [reembolsoTotal(pago.id, llave), reembolsoTotal(pago.id, llave)])

    expect([a.status, b.status, motivo(a), motivo(b)]).toEqual(['fulfilled', 'fulfilled', '', ''])
    const idA = (a as PromiseFulfilledResult<{ id: string }>).value.id
    const idB = (b as PromiseFulfilledResult<{ id: string }>).value.id
    expect(idB).toBe(idA)
    expect((await reembolsosDe(pago.id)).map(f => f.id)).toEqual([idA])
  })

  it('dos reembolsos DISTINTOS a la vez sobre el mismo cobro: uno se guarda y el otro se sigue rechazando por saldo', async () => {
    const { pago, order } = await sembrarCobro({ venueId, staffId, saleCents: 10000 })

    const resultados = await conLosDosFormados(order.id, () => [
      reembolsoTotal(pago.id, `llave-${cuid()}`, 'REF-UNO'),
      reembolsoTotal(pago.id, `llave-${cuid()}`, 'REF-DOS'),
    ])

    expect(resultados.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(resultados.map(motivo).filter(Boolean)).toEqual([expect.stringMatching(/exceeds remaining refundable/)])
    expect(await reembolsosDe(pago.id)).toHaveLength(1)
  })
})
