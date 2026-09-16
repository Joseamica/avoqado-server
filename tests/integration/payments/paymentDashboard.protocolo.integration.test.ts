/**
 * Codex R12-5 (pasada exhaustiva, checkpoint 1 del webhook): editar y borrar un Payment desde el dashboard NO puede destruir la
 * verdad financiera del protocolo de costo. Un cobro con tarifa congelada u obligación TRANSACTION_COST conserva importe
 * bancario, propina, estado, método, identidad del cargo, venta, snapshot, costo, obligación y vínculo: reembolso, anulación y
 * corrección económica van por sus flujos financieros. Los no-op siguen pasando; la decisión se toma bajo el mutex del
 * Payment (el mismo que la convergencia). Un cobro anterior al protocolo (sin snapshot ni obligación) se edita como siempre.
 *
 * Codex R14-2: el REEMBOLSO de un cobro del protocolo pertenece al protocolo por su ORIGINAL — su obligación de costo vive en el
 * original y su costo negativo es una copia a prorrata del costo original. Editar su importe o borrarlo deja una devolución
 * bancaria sin contrapartida financiera. PUT económico y DELETE sobre el REFUND ⇒ 409; la decisión se toma bajo los mutex del
 * original y del reembolso, en ese orden (el de la unidad de costo: original → reembolsos).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { asegurarCostoSincrono } from '@/services/payments/deferredTransactionCost.service'
import { updatePayment, deletePayment } from '@/services/dashboard/payment.dashboard.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import * as costoDeTransaccion from '@/services/payments/transactionCost.service'
import { claimPaymentEffects, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import * as moduloDelProtocolo from '@/services/shared/cobroDelProtocolo'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores, type Fallo } from './actores'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn(async () => undefined) }))

let f: Fixture
beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('edicion')
  await f.conTarifas({ primary: { creditRate: 0.025, fixed: 0.5 } })
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const CODIGO = 'PAYMENT_PROTECTED_BY_COST_PROTOCOL'
const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
const foto = async (id: string) => {
  const p = await pago(id)
  return {
    amount: Number(p.amount),
    tip: Number(p.tipAmount),
    status: p.status,
    method: p.method,
    cardBrand: p.cardBrand,
    auth: p.authorizationNumber,
    ref: p.referenceNumber,
    orderId: p.orderId,
    pricing: (p.processorData as Record<string, unknown>).pricing,
    costPending: (p.processorData as Record<string, unknown>).costPending,
    vinculo: p.terminalPaymentRequestId,
    costo: await prisma.transactionCost.findUnique({ where: { paymentId: id } }),
    efecto: await prisma.paymentEffect.findFirst({
      where: { paymentId: id, kind: 'TRANSACTION_COST' },
      select: { status: true, lastError: true },
    }),
    venta: await prisma.venueTransaction.findFirst({ where: { paymentId: id }, select: { id: true, grossAmount: true } }),
  }
}
async function vincular(requestId: string, attemptId = randomUUID()) {
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId, attemptId },
    { socketId: 's', terminalId: f.serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return attemptId
}
/**
 * Codex R13-6: un cobro con costo PENDIENTE REAL — nace del WEBHOOK (método provisional ⇒ la unidad de costo no corre hasta que
 * el REST acredite): obligación PENDING, marca `costPending: true` y SIN costo. Se AFIRMA ese estado antes de probar la protección
 * (el REST de la terminal calcula el costo SÍNCRONO: «pendiente» por REST ya era DONE).
 */
const cobroConCostoPendiente = async () => {
  const solicitud = await f.solicitud({ processedByStaffId: f.staffId })
  const attemptId = await vincular(solicitud.requestId)
  const result = await processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId),
    eventId: f.nuevoEventId(),
    merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })
  expect(result.action).toBe('CONFIRMED')
  const p = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: attemptId } }))
  expect(await foto(p.id)).toMatchObject({
    status: 'COMPLETED',
    costPending: true,
    costo: null,
    efecto: { status: 'PENDING' },
    vinculo: solicitud.requestId,
  })
  return p
}
/** Un cobro REST de $100 CONVERGIDO (snapshot VALIDO, costo síncrono, obligación DONE, ligado a su solicitud). */
const cobroConvergido = async () => {
  const solicitud = await f.solicitud()
  const p = await recordFastPayment(
    f.venueId,
    f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId, tarjeta }),
    f.staffId,
  )
  expect(p.status).toBe('COMPLETED')
  expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
  const estado = await foto(p.id)
  expect(estado).toMatchObject({ costPending: false, efecto: { status: 'DONE' }, vinculo: solicitud.requestId })
  expect(estado.costo).not.toBeNull()
  return p
}
const legacy = async () => {
  const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
  await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' - 'costPending' - 'pricingSlot' WHERE "id" = ${p.id}`
  await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
  await prisma.transactionCost.deleteMany({ where: { paymentId: p.id } })
  return p
}
/** Un cobro ANTERIOR al protocolo pero CON costo (costeado en el registro): un reembolso posterior lo mete al protocolo (ENCOLADA). */
const legacyConCosto = async () => {
  const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
  expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
  await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' - 'costPending' - 'pricingSlot' WHERE "id" = ${p.id}`
  await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
  expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(1)
  expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })).toBe(0)
  return p
}
const reembolsoReal = (p: { id: string; orderId: string | null }, amount = 10000) =>
  recordRefund(
    f.venueId,
    {
      venueId: f.venueId,
      originalPaymentId: p.id,
      originalOrderId: p.orderId,
      amount,
      reason: 'CUSTOMER_REQUEST',
      authorizationNumber: `RF-${randomUUID().slice(0, 6)}`,
      referenceNumber: randomUUID(),
      isPartialRefund: amount !== 10000,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: randomUUID(),
    } as Parameters<typeof recordRefund>[1],
    f.staffId,
  )
const barrera = () => {
  let soltar!: () => void
  let pausado!: () => void
  const liberada = new Promise<void>(r => (soltar = r))
  const enPausa = new Promise<void>(r => (pausado = r))
  const pausadaEn = (ms: number) =>
    Promise.race([
      enPausa.then(() => true),
      new Promise<boolean>(r => {
        const t = setTimeout(() => r(false), ms)
        t.unref?.()
      }),
    ])
  return { soltar, pausado, liberada, pausadaEn }
}
const rechazo = async (promesa: Promise<unknown>, campos?: string[]) => {
  const detalles = campos ? { details: expect.objectContaining({ fields: expect.arrayContaining(campos) }) } : {}
  await expect(promesa).rejects.toMatchObject({ statusCode: 409, code: CODIGO, ...detalles })
}

describe('Codex R12 (pasada exhaustiva) · R12-5: editar/borrar un cobro del protocolo desde el dashboard', () => {
  describe.each([
    ['con costo PENDIENTE', cobroConCostoPendiente],
    ['ya CONVERGIDO (DONE)', cobroConvergido],
  ])('cobro %s', (nombre, crear) => {
    it.each([
      ['importe', { amount: 120 }, ['amount']],
      ['propina', { tipAmount: 15 }, ['tipAmount']],
      ['estado COMPLETED → FAILED', { status: 'FAILED' as const }, ['status']],
      ['método', { method: 'DEBIT_CARD' as const }, ['method']],
      ['marca', { cardBrand: 'AMERICAN_EXPRESS' as const }, ['cardBrand']],
      ['autorización', { authorizationNumber: 'AUTH-OTRA' }, ['authorizationNumber']],
      ['referencia', { referenceNumber: 'REF-OTRA' }, ['referenceNumber']],
      ['PAN y modo de entrada', { maskedPan: '****9999', entryMode: 'MANUAL' as const }, ['maskedPan', 'entryMode']],
    ])(
      `cobro ${nombre} · PUT %s ⇒ 409 con código y NADA cambia (importe bancario, venta, snapshot, costo, obligación y vínculo)`,
      async (_c, cambio, campos) => {
        const p = await crear()
        const antes = await foto(p.id)
        await rechazo(updatePayment(f.venueId, p.id, cambio as never), campos)
        expect(await foto(p.id)).toEqual(antes)
      },
    )

    it(`cobro ${nombre} · DELETE ⇒ 409 con código; el Payment, su venta, su costo, su obligación y el vínculo con la solicitud siguen ahí`, async () => {
      const p = await crear()
      const antes = await foto(p.id)
      await expect(deletePayment(f.venueId, p.id)).rejects.toMatchObject({ statusCode: 409, code: CODIGO })
      expect(await foto(p.id)).toEqual(antes)
      expect(await prisma.terminalPaymentRequest.findFirst({ where: { paymentId: p.id } })).not.toBeNull()
    })

    it(`cobro ${nombre} · un NO-OP legítimo (los mismos valores, COMPLETED → COMPLETED) pasa y no cambia nada`, async () => {
      const p = await crear()
      const antes = await foto(p.id)
      // Un no-op NO rechaza: se afirma con `.resolves` (un 409 aquí tiene que caer como aserción, no como error suelto).
      await expect(
        updatePayment(f.venueId, p.id, {
          amount: Number(p.amount),
          tipAmount: Number(p.tipAmount),
          status: 'COMPLETED',
          method: p.method,
          cardBrand: p.cardBrand ?? undefined,
          authorizationNumber: p.authorizationNumber ?? undefined,
          referenceNumber: p.referenceNumber ?? undefined,
        }),
      ).resolves.toMatchObject({ id: p.id })
      expect(await foto(p.id)).toEqual(antes)
    })
  })

  it('CARRERA con la convergencia: con la fila del Payment tomada por la unidad de costo, el PUT espera el mutex y después decide (409) — nunca escribe por debajo', async () => {
    const p = await cobroConCostoPendiente()
    // Codex R13-6: la transacción que sostiene la fila es un MONTAJE del conjunto de actores; la primera espera y la primera
    // aserción van DENTRO del bloque cuyo `finally` suelta la barrera, y `cerrar` corre siempre (también si el montaje falla).
    const A = actores()
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pid = 0
    const candado = A.montaje(
      'transacción que sostiene la fila del Payment',
      prisma.$transaction(
        async tx => {
          const [{ pid: mio }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${p.id} FOR NO KEY UPDATE`
          pid = mio
          await suelto
        },
        { timeout: 20_000 },
      ),
    )
    let edicion!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof updatePayment>>>>
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    let fallo: Fallo = null
    try {
      if (!(await f.esperar(async () => pid > 0))) throw new Error('la fila del Payment nunca se tomó')
      const lineaBase = await f.pidsQueEsperan('proteccion')
      edicion = A.lanzar('PUT', updatePayment(f.venueId, p.id, { amount: 120 }))
      enEspera = await f.esperarBloqueados('proteccion', 1, 5000, lineaBase)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'fila del Payment': () => soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      // Primero el desenlace de CADA actor (el candado terminó; el PUT fue rechazado con 409 y `amount` — su desenlace ESPERADO) y sólo
      // después la propiedad bajo prueba: el PUT esperó el mutex bloqueado por ese pid. Afirmar la espera antes de examinar el rechazo
      // esperado convertiría una espera ausente en INCONCLUSO (rechazo sin examinar) en vez de en la caída que es.
      await expect(candado.resultado()).resolves.toBeUndefined()
      await rechazo(edicion.resultado(), ['amount'])
      expect(enEspera).toHaveLength(1)
      expect(enEspera[0].bloqueadoPor).toContain(pid)
      expect(Number((await pago(p.id)).amount)).toBe(100)
    })
  })

  describe('Codex R13-2 · el PUT clasifica, valida y ESCRIBE dentro de la MISMA transacción que posee el mutex — un reembolso real que mete el cobro al protocolo nunca se cruza con el UPDATE de una edición ya clasificada como legacy', () => {
    afterEach(() => jest.restoreAllMocks())

    it('PUT detenido DESPUÉS de clasificar como legacy (con el mutex tomado): el reembolso real ESPERA el mutex (bloqueado por el pid del PUT); al reanudar, el PUT commitea $120 y sólo entonces el reembolso entra al protocolo sobre $120 — el importe con el que el cobro ENTRÓ al protocolo es el que conserva', async () => {
      const p = await legacyConCosto()
      const A = actores()
      const b = barrera()
      let pidDelPut = 0
      const real = moduloDelProtocolo.cobrosDelProtocolo
      // La clasificación corre de verdad; después el PUT se detiene (con el mutex tomado, si la escritura vive en la misma transacción).
      jest.spyOn(moduloDelProtocolo, 'cobrosDelProtocolo').mockImplementationOnce(async (db, ids) => {
        const r = await real(db, ids)
        const [{ pid }] = await (db as typeof prisma).$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        pidDelPut = pid
        b.pausado()
        await b.liberada
        return r
      })
      const put = A.lanzar('PUT', updatePayment(f.venueId, p.id, { amount: 120 }))
      let refund!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof recordRefund>>>>
      const obs = { pausado: false, bloqueado: false, amountAlEntrar: -1 }
      let fallo: Fallo = null
      try {
        obs.pausado = await b.pausadaEn(5000)
        refund = A.lanzar('reembolso real', reembolsoReal(p))
        // El reembolso toma la fila del original (`FOR UPDATE`): tiene que quedar bloqueado por el PUT, que sigue con el mutex.
        obs.bloqueado = await f.esperar(async () => {
          const filas = await prisma.$queryRaw<{ pid: number; bloqueadoPor: number[] }[]>`
            SELECT pid, pg_blocking_pids(pid) AS "bloqueadoPor" FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM "Payment"%FOR UPDATE%'`
          return filas.some(fila => fila.bloqueadoPor.includes(pidDelPut))
        }, 5000)
      } catch (error) {
        fallo = { error }
      } finally {
        await A.liberar({ 'sonda del PUT': () => b.soltar() })
      }
      await A.cerrar(fallo)
      await A.afirmar(async () => {
        expect(obs.pausado).toBe(true)
        expect(obs.bloqueado).toBe(true)
        await expect(put.resultado()).resolves.toMatchObject({ amount: expect.anything() })
        const desenlaceDelReembolso = await refund.resultado()
        expect(desenlaceDelReembolso).toMatchObject({ id: expect.any(String) })
        // Serializado: el PUT escribió $120 ANTES de que el reembolso entrara; el cobro entró al protocolo con $120 y lo conserva.
        const despues = await foto(p.id)
        expect(despues.amount).toBe(120)
        // Codex R13-5: al ENCOLAR la obligación (cobro anterior al protocolo con costo) la marca se reactiva.
        expect(despues.efecto).toMatchObject({ status: 'PENDING' })
        expect(despues.costPending).toBe(true)
        expect(despues.costo).not.toBeNull()
        expect(
          await prisma.payment.count({ where: { type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: p.id } } }),
        ).toBe(1)
      })
    })

    it('SONDA: si el PUT escribiera FUERA de la transacción que posee el mutex, un reembolso real entraría al protocolo entre la clasificación y el UPDATE — el importe con el que el cobro entró al protocolo tiene que ser el que conserva (un UPDATE cruzado lo cambiaría)', async () => {
      const p = await legacyConCosto()
      const A = actores()
      const b = barrera()
      const realUpdate = prisma.payment.update.bind(prisma.payment)
      // La sonda sólo detiene la escritura del PUT sobre ESTE cobro hecha con el cliente GLOBAL (fuera de toda transacción);
      // cualquier otra escritura pasa intacta. En el código correcto nunca se dispara: el PUT escribe con su `tx`.
      const sonda = jest.spyOn(prisma.payment, 'update').mockImplementation((async (args: Parameters<typeof realUpdate>[0]) => {
        const where = (args as { where?: { id?: string } }).where
        const data = (args as { data?: { amount?: unknown } }).data
        if (where?.id === p.id && data?.amount !== undefined) {
          b.pausado()
          await b.liberada
        }
        return realUpdate(args)
      }) as never)
      const put = A.lanzar('PUT', updatePayment(f.venueId, p.id, { amount: 120 }))
      const obs = { desenlaceDelPut: null as unknown, amountAlEntrar: -1 }
      let refund!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof recordRefund>>>>
      let fallo: Fallo = null
      try {
        // O el PUT terminó (escribió bajo el mutex, en su transacción) o quedó detenido en la sonda (escritura fuera de ella).
        obs.desenlaceDelPut = await Promise.race([
          A.carrera(put, 3000),
          b.pausadaEn(3000).then(pausado => (pausado ? 'EN_LA_SONDA' : null)),
        ])
        // El reembolso real entra al protocolo AHORA (con el PUT terminado, o con el PUT detenido fuera del mutex).
        refund = A.lanzar('reembolso real', reembolsoReal(p))
        await refund.resultado()
        obs.amountAlEntrar = Number((await pago(p.id)).amount)
      } catch (error) {
        fallo = { error }
      } finally {
        await A.liberar({ 'sonda del UPDATE': () => b.soltar() })
        sonda.mockRestore()
      }
      await A.cerrar(fallo)
      await A.afirmar(async () => {
        expect(obs.desenlaceDelPut).not.toBeNull()
        await put.resultado()
        const despues = await foto(p.id)
        // El invariante: ninguna edición cruza una entrada al protocolo ya confirmada.
        expect(despues.amount).toBe(obs.amountAlEntrar)
        expect(despues.efecto).toMatchObject({ status: 'PENDING' })
        expect(despues.costPending).toBe(true)
        expect(
          await prisma.payment.count({ where: { type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: p.id } } }),
        ).toBe(1)
      })
    })
  })

  it('un cobro ANTERIOR al protocolo (sin snapshot ni obligación) se sigue editando y borrando como antes', async () => {
    const p = await legacy()
    const editado = await updatePayment(f.venueId, p.id, { tipAmount: 7, cardBrand: 'MASTERCARD' })
    expect(Number(editado.tipAmount)).toBe(7)
    expect(editado.cardBrand).toBe('MASTERCARD')
    await deletePayment(f.venueId, p.id)
    expect(await prisma.payment.findUnique({ where: { id: p.id } })).toBeNull()
  })
})

describe('Codex R14-2 · el REEMBOLSO de un cobro del protocolo también está protegido: PUT económico y DELETE sobre el REFUND ⇒ 409; el reembolso, su costo, su venta y el historial del original quedan intactos', () => {
  afterEach(() => jest.restoreAllMocks())
  const reembolsoDashboard = (p: { id: string }, amount = 10000) =>
    issueRefund({ venueId: f.venueId, paymentId: p.id, amount, tipRefundCents: 0, reason: 'CUSTOMER_REQUEST' as never, staffId: f.staffId })
  const idDelReembolso = (r: unknown) => (r as { id?: string }).id ?? (r as { refundId: string }).refundId
  /** El worker REAL de efectos: reclama y corre lo que haya vencido (cierra la obligación reabierta del original). */
  const correrEfectos = async () => {
    const claims = await claimPaymentEffects({ now: new Date() })
    for (const c of claims) await runClaimedPaymentEffect(c)
  }
  /** Foto del reembolso, del original y del historial del original (eventos, solicitud, cuántos reembolsos apuntan a él). */
  const fotoDelPar = async (refundId: string, originalId: string) => {
    const r = await pago(refundId)
    const vt = await prisma.venueTransaction.findUnique({ where: { paymentId: refundId } })
    return {
      reembolso: {
        ...(await foto(refundId)),
        type: r.type,
        originalPaymentId: (r.processorData as Record<string, unknown>).originalPaymentId,
        fee: Number(r.feeAmount),
        net: Number(r.netAmount),
        ventaFee: vt ? Number(vt.feeAmount) : null,
        ventaNet: vt ? Number(vt.netAmount) : null,
      },
      original: await foto(originalId),
      historial: {
        eventos: await prisma.providerEventLog.count({ where: { paymentId: originalId } }),
        solicitud: await prisma.terminalPaymentRequest.findFirst({ where: { paymentId: originalId }, select: { id: true, status: true } }),
        reembolsos: await prisma.payment.count({
          where: { type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: originalId } },
        }),
      },
    }
  }
  type Reembolsar = (p: { id: string; orderId: string | null }) => Promise<unknown>
  /**
   * Obligación del original PENDING: la creación síncrona del costo negativo FALLA (transitorio) ⇒ el reembolso queda SIN costo
   * (fee 0 / neto −100) y el original con la obligación reabierta (`REFUND_COST`) — el estado que el worker retomará después.
   */
  const conObligacionPendiente = async (reembolsar: Reembolsar) => {
    const original = await cobroConvergido()
    const corte = jest.spyOn(costoDeTransaccion, 'createRefundTransactionCost').mockImplementationOnce(async () => {
      throw new Error('fallo transitorio del costo negativo')
    })
    const refundId = idDelReembolso(await reembolsar(original))
    corte.mockRestore()
    const par = await fotoDelPar(refundId, original.id)
    expect(par.reembolso).toMatchObject({ type: 'REFUND', originalPaymentId: original.id, costo: null, fee: 0, net: -100 })
    expect(par.original).toMatchObject({ efecto: { status: 'PENDING', lastError: 'REFUND_COST' }, costPending: true })
    return { original, refundId }
  }
  /** Obligación del original DONE: el costo negativo existe, el reembolso está proyectado (fee −3 / neto −97) y el worker cerró la obligación. */
  const conObligacionCumplida = async (reembolsar: Reembolsar) => {
    const original = await cobroConvergido()
    const refundId = idDelReembolso(await reembolsar(original))
    // El dashboard costea en segundo plano (fire-and-forget): se espera a que aterrice antes de cerrar la obligación.
    expect(await f.esperar(async () => (await prisma.transactionCost.findUnique({ where: { paymentId: refundId } })) !== null, 4000)).toBe(
      true,
    )
    await correrEfectos()
    const par = await fotoDelPar(refundId, original.id)
    expect(par.reembolso).toMatchObject({ type: 'REFUND', originalPaymentId: original.id, fee: -3, net: -97, ventaFee: -3, ventaNet: -97 })
    expect(par.reembolso.costo).not.toBeNull()
    expect(par.original).toMatchObject({ efecto: { status: 'DONE' }, costPending: false })
    return { original, refundId }
  }

  describe.each([
    ['TPV (recordRefund)', (p: { id: string; orderId: string | null }) => reembolsoReal(p)],
    ['dashboard (issueRefund)', (p: { id: string; orderId: string | null }) => reembolsoDashboard(p)],
  ] as const)('reembolso por %s', (canal, reembolsar) => {
    describe.each([
      ['PENDING', conObligacionPendiente],
      ['DONE', conObligacionCumplida],
    ])('obligación del original %s', (obligacion, crear) => {
      it.each([
        ['importe', { amount: -120 }, ['amount']],
        ['importe (a positivo)', { amount: 100 }, ['amount']],
        ['propina', { tipAmount: 5 }, ['tipAmount']],
        ['estado COMPLETED → FAILED', { status: 'FAILED' as const }, ['status']],
        ['método', { method: 'DEBIT_CARD' as const }, ['method']],
        ['marca', { cardBrand: 'AMERICAN_EXPRESS' as const }, ['cardBrand']],
        ['autorización', { authorizationNumber: 'AUTH-OTRA' }, ['authorizationNumber']],
        ['referencia', { referenceNumber: 'REF-OTRA' }, ['referenceNumber']],
      ])(
        `${canal} · obligación ${obligacion} · PUT %s sobre el REFUND ⇒ 409 con código, campos y el original nombrado; nada cambia en el reembolso, en el original ni en su historial`,
        async (_c, cambio, campos) => {
          const { original, refundId } = await crear(reembolsar)
          const antes = await fotoDelPar(refundId, original.id)
          await expect(updatePayment(f.venueId, refundId, cambio as never)).rejects.toMatchObject({
            statusCode: 409,
            code: CODIGO,
            details: expect.objectContaining({ fields: expect.arrayContaining(campos), originalPaymentId: original.id }),
          })
          expect(await fotoDelPar(refundId, original.id)).toEqual(antes)
        },
      )

      it(`${canal} · obligación ${obligacion} · DELETE sobre el REFUND ⇒ 409 con código y el original nombrado; el reembolso, su costo, su venta y el historial del original siguen ahí`, async () => {
        const { original, refundId } = await crear(reembolsar)
        const antes = await fotoDelPar(refundId, original.id)
        await expect(deletePayment(f.venueId, refundId)).rejects.toMatchObject({
          statusCode: 409,
          code: CODIGO,
          details: expect.objectContaining({ fields: ['delete'], originalPaymentId: original.id }),
        })
        expect(await fotoDelPar(refundId, original.id)).toEqual(antes)
        expect(await prisma.payment.findUnique({ where: { id: refundId } })).not.toBeNull()
      })

      it(`${canal} · obligación ${obligacion} · un NO-OP legítimo sobre el REFUND (los mismos valores) pasa y no cambia nada`, async () => {
        const { original, refundId } = await crear(reembolsar)
        const antes = await fotoDelPar(refundId, original.id)
        const r = await pago(refundId)
        await expect(
          updatePayment(f.venueId, refundId, {
            amount: Number(r.amount),
            tipAmount: Number(r.tipAmount),
            status: r.status as 'COMPLETED',
            method: r.method,
            referenceNumber: r.referenceNumber ?? undefined,
          }),
        ).resolves.toMatchObject({ id: refundId })
        expect(await fotoDelPar(refundId, original.id)).toEqual(antes)
      })
    })
  })

  it('CONTROL: el reembolso de un cobro LEGACY sin costo (el original NO entra al protocolo al reembolsarse) se sigue editando y borrando como antes', async () => {
    const original = await legacy()
    const refund = await reembolsoReal(original)
    // El original sigue fuera del protocolo (sin snapshot, sin obligación): su reembolso tampoco pertenece.
    expect(await foto(original.id)).toMatchObject({ pricing: undefined, efecto: null, costo: null })
    const editado = await updatePayment(f.venueId, refund.id, { referenceNumber: 'REF-CORREGIDA' })
    expect(editado.referenceNumber).toBe('REF-CORREGIDA')
    await deletePayment(f.venueId, refund.id)
    expect(await prisma.payment.findUnique({ where: { id: refund.id } })).toBeNull()
  })

  it('CARRERA con la unidad del ORIGINAL: con la fila del original tomada por la unidad de costo, el PUT sobre el REFUND espera ESE mutex (bloqueado por su pid) — y mientras espera NO tiene tomada la fila del reembolso (orden original → reembolso, el de la unidad) — y después decide (409)', async () => {
    const { original, refundId } = await conObligacionCumplida(p => reembolsoReal(p))
    const A = actores()
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pid = 0
    const candado = A.montaje(
      'transacción que sostiene la fila del ORIGINAL',
      prisma.$transaction(
        async tx => {
          const [{ pid: mio }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${original.id} FOR NO KEY UPDATE`
          pid = mio
          await suelto
        },
        { timeout: 20_000 },
      ),
    )
    let edicion!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof updatePayment>>>>
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    const obs = { reembolsoLibre: null as boolean | null }
    let fallo: Fallo = null
    try {
      if (!(await f.esperar(async () => pid > 0))) throw new Error('la fila del original nunca se tomó')
      const lineaBase = await f.pidsQueEsperan('proteccion')
      edicion = A.lanzar('PUT sobre el REFUND', updatePayment(f.venueId, refundId, { amount: -120 }))
      enEspera = await f.esperarBloqueados('proteccion', 1, 5000, lineaBase)
      // Con el PUT esperando el original, la fila del REFUND tiene que estar LIBRE: si el PUT la hubiera tomado antes (reembolso →
      // original), este NOWAIT reventaría con 55P03 — y ése es el orden que se cruza con la unidad (original → reembolsos).
      obs.reembolsoLibre = await prisma
        .$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${refundId} FOR NO KEY UPDATE NOWAIT`
          return true
        })
        .catch(error => {
          if (/55P03|could not obtain lock/i.test(String((error as Error).message))) return false
          throw error
        })
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'fila del original': () => soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(candado.resultado()).resolves.toBeUndefined()
      await rechazo(edicion.resultado(), ['amount'])
      expect(enEspera).toHaveLength(1)
      expect(enEspera[0].bloqueadoPor).toContain(pid)
      expect(obs.reembolsoLibre).toBe(true)
      expect(Number((await pago(refundId)).amount)).toBe(-100)
    })
  })
  it('RELECTURA bajo el candado: si el puntero al original CAMBIA mientras el PUT espera el original viejo, el PUT suelta ese candado (savepoint), vuelve a leer y protege contra el par ACTUAL — con el original viejo LIBRE y el nuevo TOMADO', async () => {
    const { original, refundId } = await conObligacionCumplida(p => reembolsoReal(p))
    const otro = await legacy()
    const A = actores()
    const b = barrera()
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pid = 0
    const candado = A.montaje(
      'transacción que sostiene la fila del ORIGINAL viejo',
      prisma.$transaction(
        async tx => {
          const [{ pid: mio }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${original.id} FOR NO KEY UPDATE`
          pid = mio
          await suelto
        },
        { timeout: 20_000 },
      ),
    )
    // La clasificación corre de verdad y después el PUT se detiene con sus candados tomados: ahí se sondea QUÉ filas sostiene.
    const real = moduloDelProtocolo.cobrosDelProtocolo
    jest.spyOn(moduloDelProtocolo, 'cobrosDelProtocolo').mockImplementationOnce(async (db, ids) => {
      const r = await real(db, ids)
      b.pausado()
      await b.liberada
      return r
    })
    const libre = (id: string) =>
      prisma
        .$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${id} FOR NO KEY UPDATE NOWAIT`
          return true
        })
        .catch(error => {
          if (/55P03|could not obtain lock/i.test(String((error as Error).message))) return false
          throw error
        })
    let edicion!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof updatePayment>>>>
    const obs = {
      pausado: false,
      enEspera: 0,
      reapuntado: null as boolean | null,
      viejoLibre: null as boolean | null,
      nuevoLibre: null as boolean | null,
      reembolsoLibre: null as boolean | null,
    }
    let fallo: Fallo = null
    try {
      if (!(await f.esperar(async () => pid > 0))) throw new Error('la fila del original nunca se tomó')
      const lineaBase = await f.pidsQueEsperan('proteccion')
      edicion = A.lanzar('PUT sobre el REFUND', updatePayment(f.venueId, refundId, { referenceNumber: 'REF-REAPUNTADA' }))
      obs.enEspera = (await f.esperarBloqueados('proteccion', 1, 5000, lineaBase)).length
      // Con el PUT esperando el original viejo, el reembolso cambia de original — su fila tiene que estar LIBRE (el PUT aún no la
      // toma). Con `lock_timeout` acotado: si el PUT ya la tuviera (orden reembolso → original), este UPDATE no se queda colgado
      // sino que lo DICE (`reapuntado: false`), y la prueba cae por aserción.
      obs.reapuntado = await prisma
        .$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`
          await tx.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ originalPaymentId: otro.id })}::jsonb WHERE "id" = ${refundId}`
          return true
        })
        .catch(error => {
          if (/55P03|lock timeout/i.test(String((error as Error).message))) return false
          throw error
        })
      soltar()
      obs.pausado = await b.pausadaEn(5000)
      obs.viejoLibre = await libre(original.id)
      obs.nuevoLibre = await libre(otro.id)
      obs.reembolsoLibre = await libre(refundId)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'fila del original viejo': () => soltar(), 'sonda del PUT': () => b.soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      // Primero el desenlace de CADA actor (el candado terminó; el PUT decidió contra el par ACTUAL: `otro` es legacy ⇒ el reembolso ya
      // no pertenece al protocolo y se EDITA), después la propiedad bajo prueba. Al revés, un mutante que deja al PUT en 409 convertiría
      // la caída en INCONCLUSO (rechazo sin examinar) en vez de en la aserción que es.
      await expect(candado.resultado()).resolves.toBeUndefined()
      await expect(edicion.resultado()).resolves.toMatchObject({ id: refundId, referenceNumber: 'REF-REAPUNTADA' })
      expect(obs.enEspera).toBe(1)
      expect(obs.reapuntado).toBe(true)
      expect(obs.pausado).toBe(true)
      // El par actual es (otro, reembolso): el original viejo quedó LIBRE (el savepoint soltó su candado) y el nuevo y el reembolso TOMADOS.
      expect(obs).toMatchObject({ viejoLibre: true, nuevoLibre: false, reembolsoLibre: false })
    })
  })
})
