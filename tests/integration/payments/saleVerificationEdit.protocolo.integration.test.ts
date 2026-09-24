/**
 * Codex R13-3 (checkpoint 1 del webhook): el editor de VERIFICACIONES DE VENTA (back-office de PlayTelecom, por HTTP y por MCP)
 * escribía `Payment.amount` y `Payment.method` directamente — otro escritor administrativo que eludía el protocolo de costo
 * (invariante 14). Ahora aplica el MISMO criterio compartido que el PUT del dashboard (`cobrosDelProtocolo`, bajo el mutex del
 * Payment): un cobro del protocolo (tarifa congelada u obligación TRANSACTION_COST, en PENDING real o DONE) conserva importe y
 * método —se rechaza con 409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL` y NADA cambia—; revisión, notas, estado de la verificación,
 * tipo de venta y los no-op legítimos siguen pasando; un cobro anterior al protocolo se edita como siempre. El permiso OWNER y
 * el `confirm:true` del MCP no acreditan otro importe bancario. La verdad contra Postgres vive aquí; la ruta HTTP y la tool
 * del MCP se prueban con Prisma doblado en `tests/api-tests/dashboard/saleVerificationEdit.api.test.ts` y
 * `tests/unit/mcp-customer/sale-verification-writes.test.ts`.
 *
 * Codex R16-1: un REFUND pertenece al protocolo POR SU ORIGINAL (`cobrosDelProtocolo`, R14-2), así que la fila que decide su
 * clasificación es la del original — y el editor sólo tomaba la suya. Con el original libre, un segundo reembolso real podía
 * meterlo al protocolo entre la clasificación «legacy» del reembolso y su UPDATE: R1 pasaba de −$40 a +$40 sin movimiento
 * bancario. Ahora el editor toma el par en el orden de la unidad de costo (original → reembolso, `bloquearConSuOriginal`,
 * con relectura del puntero) ANTES de releer, clasificar y escribir, y conserva los dos candados hasta commitear.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { asegurarCostoSincrono } from '@/services/payments/deferredTransactionCost.service'
import * as costoDiferido from '@/services/payments/deferredTransactionCost.service'
import * as moduloDelProtocolo from '@/services/shared/cobroDelProtocolo'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { createSaleVerification } from '@/services/tpv/sale-verification.service'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores, type Fallo } from './actores'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToUser: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let f: Fixture
beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('verificacion')
  await f.conTarifas({ primary: { creditRate: 0.025, fixed: 0.5 } })
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  await prisma.saleVerification.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
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
    pricing: (p.processorData as Record<string, unknown>).pricing,
    costPending: (p.processorData as Record<string, unknown>).costPending,
    costo: await prisma.transactionCost.findUnique({ where: { paymentId: id } }),
    efecto: await prisma.paymentEffect.findFirst({ where: { paymentId: id, kind: 'TRANSACTION_COST' }, select: { status: true } }),
    venta: await prisma.venueTransaction.findFirst({ where: { paymentId: id }, select: { grossAmount: true, netAmount: true } }),
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
/** PENDING REAL: el cobro nace del webhook (método provisional ⇒ la unidad de costo no corre): obligación PENDING, marca true, sin costo. */
const cobroPendienteReal = async () => {
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
  const antes = await foto(p.id)
  expect(antes).toMatchObject({ status: 'COMPLETED', costPending: true, costo: null, efecto: { status: 'PENDING' } })
  return p
}
/** DONE: el cobro REST de la terminal, con su costo síncrono convergido. */
const cobroConvergido = async () => {
  const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
  expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
  expect(await foto(p.id)).toMatchObject({ status: 'COMPLETED', costPending: false, efecto: { status: 'DONE' } })
  expect((await foto(p.id)).costo).not.toBeNull()
  return p
}
const legacy = async () => {
  const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
  await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' - 'costPending' - 'pricingSlot' WHERE "id" = ${p.id}`
  await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
  await prisma.transactionCost.deleteMany({ where: { paymentId: p.id } })
  return p
}
const verificacionDe = (p: { id: string }) =>
  prisma.saleVerification.create({
    data: { venueId: f.venueId, paymentId: p.id, staffId: f.staffId, photos: [], status: 'PENDING', isPortabilidad: false },
  })
const editar = (sv: { id: string }, cambios: Record<string, unknown>) =>
  editOrgSaleVerification(f.fixture, { saleVerificationId: sv.id, editedById: f.staffId, reason: 'corrección de prueba R13-3', ...cambios })
const rechazo = async (promesa: Promise<unknown>, campos: string[]) =>
  expect(promesa).rejects.toMatchObject({
    statusCode: 409,
    code: CODIGO,
    details: expect.objectContaining({ fields: expect.arrayContaining(campos) }),
  })

describe('Codex R13-3 · el editor de verificaciones de venta no cambia el dinero de un cobro del protocolo', () => {
  describe.each([
    ['con costo PENDIENTE real', cobroPendienteReal],
    ['ya CONVERGIDO (DONE)', cobroConvergido],
  ])('cobro %s', (nombre, crear) => {
    it(`cobro ${nombre} · editar el IMPORTE ($100 → $120) ⇒ 409 con código; Payment, snapshot, costo, obligación y venta intactos; la verificación tampoco cambia`, async () => {
      const p = await crear()
      const sv = await verificacionDe(p)
      const antes = await foto(p.id)
      await rechazo(editar(sv, { amount: 120 }), ['amount'])
      expect(await foto(p.id)).toEqual(antes)
      expect(await exigir(prisma.saleVerification.findUnique({ where: { id: sv.id } }))).toMatchObject({
        status: 'PENDING',
        reviewNotes: null,
      })
    })

    it(`cobro ${nombre} · cambiar la FORMA DE PAGO (CARD → CASH) ⇒ 409 con código y nada cambia`, async () => {
      const p = await crear()
      const sv = await verificacionDe(p)
      const antes = await foto(p.id)
      await rechazo(editar(sv, { paymentForm: 'CASH' }), ['method'])
      expect(await foto(p.id)).toEqual(antes)
    })

    it(`cobro ${nombre} · importe y forma a la vez ⇒ 409 nombrando los dos campos; nada cambia`, async () => {
      const p = await crear()
      const sv = await verificacionDe(p)
      const antes = await foto(p.id)
      await rechazo(editar(sv, { amount: 250, paymentForm: 'OTHER' }), ['amount', 'method'])
      expect(await foto(p.id)).toEqual(antes)
    })

    it(`cobro ${nombre} · CONTROL: revisión sin dinero (estado FAILED con notas, tipo de venta) pasa y el Payment no se toca`, async () => {
      const p = await crear()
      const sv = await verificacionDe(p)
      const antes = await foto(p.id)
      const editada = await editar(sv, { status: 'FAILED', reviewNotes: 'Falta la foto de la vinculación', isPortabilidad: true })
      expect(editada).toMatchObject({ status: 'FAILED', isPortabilidad: true, reviewNotes: 'Falta la foto de la vinculación' })
      expect(await foto(p.id)).toEqual(antes)
    })

    it(`cobro ${nombre} · CONTROL: un NO-OP económico (el mismo importe y la misma forma de pago) pasa y nada cambia`, async () => {
      const p = await crear()
      const sv = await verificacionDe(p)
      const antes = await foto(p.id)
      await expect(editar(sv, { amount: Number(p.amount), paymentForm: 'CARD' })).resolves.toMatchObject({ id: sv.id })
      expect(await foto(p.id)).toEqual(antes)
    })
  })

  it('CARRERA con la convergencia: con la fila del Payment tomada por la unidad de costo, el editor ESPERA el mutex (bloqueado por ese pid) y después decide (409) — nunca escribe por debajo', async () => {
    const p = await cobroPendienteReal()
    const sv = await verificacionDe(p)
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
    let edicion!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof editOrgSaleVerification>>>>
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    let fallo: Fallo = null
    try {
      if (!(await f.esperar(async () => pid > 0))) throw new Error('la fila del Payment nunca se tomó')
      const lineaBase = await f.pidsQueEsperan('proteccion')
      edicion = A.lanzar('PATCH de la verificación', editar(sv, { amount: 120 }))
      enEspera = await f.esperarBloqueados('proteccion', 1, 5000, lineaBase)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'fila del Payment': () => soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      // Primero el desenlace de CADA actor (el candado terminó; el PATCH fue rechazado con 409 y `amount` — su desenlace ESPERADO),
      // y sólo después la propiedad bajo prueba: el editor esperó el mutex bloqueado por ese pid. Si la espera se afirmara antes de
      // examinar el rechazo esperado, una espera ausente saldría como INCONCLUSO (rechazo sin examinar) en vez de como la caída que es.
      await expect(candado.resultado()).resolves.toBeUndefined()
      await rechazo(edicion.resultado(), ['amount'])
      expect(enEspera).toHaveLength(1)
      expect(enEspera[0].bloqueadoPor).toContain(pid)
      expect((await foto(p.id)).amount).toBe(100)
    })
  })

  it('un cobro ANTERIOR al protocolo (sin snapshot ni obligación) se sigue corrigiendo como siempre: importe y forma de pago cambian, con bitácora', async () => {
    const p = await legacy()
    const sv = await verificacionDe(p)
    const editada = await editar(sv, { amount: 120, paymentForm: 'CASH' })
    expect(editada.payment).toMatchObject({ method: 'CASH' })
    expect(Number(editada.payment.amount)).toBe(120)
    expect(await foto(p.id)).toMatchObject({ amount: 120, method: 'CASH' })
    expect(await prisma.activityLog.count({ where: { entityId: sv.id, action: 'SALE_VERIFICATION_EDIT' } })).toBe(1)
  })
})

describe('Codex R16-1 · el editor de verificaciones sobre un REEMBOLSO protege también a su ORIGINAL (orden original → reembolso) antes de releer, clasificar y escribir', () => {
  afterEach(() => jest.restoreAllMocks())
  const costoDe = (paymentId: string) => prisma.transactionCost.findUnique({ where: { paymentId } })
  const efectoDe = (paymentId: string) => prisma.paymentEffect.findFirst({ where: { paymentId, kind: 'TRANSACTION_COST' } })
  /** El original HISTÓRICO de Codex: $100 con su costo de $3 pero sin snapshot ni obligación (legacy con costo). */
  const legacyConCosto = async () => {
    const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
    expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' - 'costPending' - 'pricingSlot' WHERE "id" = ${p.id}`
    await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
    expect(await costoDe(p.id)).not.toBeNull()
    expect(await efectoDe(p.id)).toBeNull()
    return p
  }
  const reembolsoReal = (p: { id: string; orderId: string | null }, amount: number, isPartialRefund: boolean) =>
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
        isPartialRefund,
        currency: 'MXN',
        processor: 'angelpay',
        idempotencyKey: randomUUID(),
      } as Parameters<typeof recordRefund>[1],
      f.staffId,
    )
  /** Sonda: ¿la fila está tomada AHORA? (NOWAIT en transacción propia con savepoint; nunca espera, nunca deja candado.) */
  const sondaSinEsperar = (id: string): Promise<'LIBRE' | 'TOMADA'> =>
    prisma.$transaction(async tx => {
      await tx.$executeRaw`SAVEPOINT sonda`
      try {
        await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${id} FOR NO KEY UPDATE NOWAIT`
        await tx.$executeRaw`RELEASE SAVEPOINT sonda`
        return 'LIBRE' as const
      } catch (error) {
        if (!/55P03|could not obtain lock/i.test(error instanceof Error ? error.message : String(error))) throw error
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT sonda`
        return 'TOMADA' as const
      }
    })
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
  /**
   * El escenario de Codex R16-1: original histórico P ($100, costo $3, sin snapshot ni obligación), su reembolso parcial HISTÓRICO
   * R1 (−$40) y la verificación de venta de R1, creada por el servicio real (valida id y venue; no excluye un REFUND).
   */
  const escenario = async () => {
    const P = await legacyConCosto()
    const R1 = await reembolsoReal(P, 4000, true)
    // R1 es HISTÓRICO: hoy un reembolso deja obligación en su original (R12-15); la de entonces no existe — se retira, y P sigue legacy.
    await prisma.paymentEffect.deleteMany({ where: { paymentId: P.id, kind: 'TRANSACTION_COST' } })
    expect(await efectoDe(P.id)).toBeNull()
    expect((await pago(R1.id)).processorData).not.toHaveProperty('pricing')
    expect(Number((await pago(R1.id)).amount)).toBe(-40)
    const sv = await createSaleVerification(f.venueId, { paymentId: R1.id, staffId: f.staffId, photos: [], scannedProducts: [] })
    expect(sv).toMatchObject({ paymentId: R1.id, status: 'PENDING' })
    return { P, R1, sv }
  }
  /** Sesiones detenidas en el `FOR UPDATE` del original que toma un reembolso real, y por quién están bloqueadas. */
  const reembolsosEsperandoElOriginal = () =>
    prisma.$queryRaw<{ pid: number; bloqueadoPor: number[] }[]>`
      SELECT pid, pg_blocking_pids(pid) AS "bloqueadoPor" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM "Payment"%FOR UPDATE%'`

  it('ORIGINAL PRIMERO · un segundo reembolso real R2 (−$30) sostiene P (obligación asegurada, sin commit): el editor de R1 (amount: 40) ESPERA el candado de P (bloqueado por el pid de R2) y mientras espera deja R1 LIBRE; al commitear R2 —P ya del protocolo—, el editor relee, clasifica a R1 por su original y responde 409: importe (−$40), método, costo, venta, verificación y bitácora intactos', async () => {
    const { P, R1, sv } = await escenario()
    const antesR1 = await foto(R1.id)
    const antesSv = await exigir(prisma.saleVerification.findUnique({ where: { id: sv.id } }))
    const A = actores()
    const b = barrera()
    let pidDeR2 = 0
    const real = costoDiferido.asegurarObligacionDeCostoNegativo
    // R2 corre de verdad hasta asegurar la obligación de P (con P tomado por su `FOR UPDATE`) y se detiene ANTES de commitear:
    // la intercalación se demuestra observando el commit de esa obligación, sin exigir su trabajo posterior.
    jest.spyOn(costoDiferido, 'asegurarObligacionDeCostoNegativo').mockImplementationOnce(async (tx, originalId, refundId) => {
      const r = await real(tx, originalId, refundId)
      const [{ pid }] = await (tx as typeof prisma).$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      pidDeR2 = pid
      b.pausado()
      await b.liberada
      return r
    })
    const r2 = A.lanzar('reembolso real R2 sobre P', reembolsoReal(P, 3000, true))
    let edicion!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof editOrgSaleVerification>>>>
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    const obs = { pausado: false, r1: null as 'LIBRE' | 'TOMADA' | null, pConObligacionAntesDelCommit: null as boolean | null }
    let fallo: Fallo = null
    try {
      obs.pausado = await b.pausadaEn(5000)
      const lineaBase = await f.pidsQueEsperan('proteccion')
      edicion = A.lanzar('edición de la verificación de R1', editar(sv, { amount: 40 }))
      // El editor toma PRIMERO el original (orden original → reembolso, el de la unidad de costo): espera P, bloqueado por R2…
      // (ventanas cortas: la transacción pausada de R2 tiene el presupuesto de Prisma, y una espera ausente debe caer por ASERCIÓN,
      // no por vencer ese presupuesto).
      enEspera = await f.esperarBloqueados('proteccion', 1, 2000, lineaBase)
      // …y mientras espera, la fila de R1 sigue LIBRE (si la hubiera tomado antes, este NOWAIT reventaría con 55P03).
      obs.r1 = await sondaSinEsperar(R1.id)
      // La obligación que R2 aseguró sobre P todavía no está commiteada: desde fuera, P sigue siendo legacy.
      obs.pConObligacionAntesDelCommit = (await efectoDe(P.id)) !== null
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'reembolso R2 (commit)': () => b.soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.pausado).toBe(true)
      expect(pidDeR2).toBeGreaterThan(0)
      expect(await r2.resultado()).toMatchObject({ status: 'COMPLETED' })
      // El editor esperó a R2 y, con P ya del protocolo, protegió a R1 (409 nombrando `amount`): nunca escribió por debajo.
      await rechazo(edicion.resultado(), ['amount'])
      expect(enEspera).toHaveLength(1)
      expect(enEspera[0].bloqueadoPor).toContain(pidDeR2)
      expect(obs.r1).toBe('LIBRE')
      expect(obs.pConObligacionAntesDelCommit).toBe(false)
      // R1 intacto (importe −$40, método, costo, venta); P entró al protocolo por R2; la verificación y la bitácora, sin tocar.
      expect(await foto(R1.id)).toEqual(antesR1)
      expect((await foto(R1.id)).amount).toBe(-40)
      expect(await efectoDe(P.id)).not.toBeNull()
      expect(await exigir(prisma.saleVerification.findUnique({ where: { id: sv.id } }))).toEqual(antesSv)
      expect(await prisma.activityLog.count({ where: { entityId: sv.id, action: 'SALE_VERIFICATION_EDIT' } })).toBe(0)
    })
  })

  it('EDITOR PRIMERO · el editor de R1 (amount: 40) se detiene tras clasificar (legacy) con los candados tomados: sostiene P Y R1 (los dos TOMADOS para una sonda NOWAIT); el reembolso real R2 sobre P ESPERA al pid del editor; al reanudar, el editor escribe +$40 con la clasificación que hizo y sólo entonces R2 entra y mete a P al protocolo — serializado, nunca cruzado', async () => {
    const { P, R1, sv } = await escenario()
    const A = actores()
    const b = barrera()
    let pidDelEditor = 0
    const real = moduloDelProtocolo.cobrosDelProtocolo
    // La clasificación corre de verdad; después el editor se detiene con los candados tomados (relectura, clasificación y UPDATE
    // viven en la misma transacción).
    jest.spyOn(moduloDelProtocolo, 'cobrosDelProtocolo').mockImplementationOnce(async (db, ids) => {
      const r = await real(db, ids)
      const [{ pid }] = await (db as typeof prisma).$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      pidDelEditor = pid
      b.pausado()
      await b.liberada
      return r
    })
    const edicion = A.lanzar('edición de la verificación de R1', editar(sv, { amount: 40 }))
    let r2!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof reembolsoReal>>>>
    const obs = { pausado: false, p: null as 'LIBRE' | 'TOMADA' | null, r1: null as 'LIBRE' | 'TOMADA' | null, r2Bloqueado: false }
    let fallo: Fallo = null
    try {
      obs.pausado = await b.pausadaEn(5000)
      // Con la clasificación hecha y antes de escribir, el editor sostiene el PAR: P (el original) y R1 (el reembolso).
      obs.p = await sondaSinEsperar(P.id)
      obs.r1 = await sondaSinEsperar(R1.id)
      r2 = A.lanzar('reembolso real R2 sobre P', reembolsoReal(P, 3000, true))
      // R2 toma P con `FOR UPDATE`: tiene que quedar bloqueado por el editor (el poseedor correcto), no por nadie más.
      // (ventana corta: la transacción pausada del editor tiene el presupuesto de Prisma; una espera ausente cae por ASERCIÓN).
      obs.r2Bloqueado = await f.esperar(
        async () => (await reembolsosEsperandoElOriginal()).some(fila => fila.bloqueadoPor.includes(pidDelEditor)),
        2000,
      )
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'editor (clasificación hecha)': () => b.soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.pausado).toBe(true)
      expect(pidDelEditor).toBeGreaterThan(0)
      const editada = await edicion.resultado()
      expect(await r2.resultado()).toMatchObject({ status: 'COMPLETED' })
      expect(obs).toMatchObject({ p: 'TOMADA', r1: 'TOMADA', r2Bloqueado: true })
      // Serializado: el editor escribió +$40 ANTES de que R2 entrara (su clasificación «legacy» era cierta con P tomado), y P
      // entró al protocolo DESPUÉS, por R2.
      expect(Number(editada.payment.amount)).toBe(40)
      expect((await foto(R1.id)).amount).toBe(40)
      expect(await efectoDe(P.id)).not.toBeNull()
      expect(await prisma.activityLog.count({ where: { entityId: sv.id, action: 'SALE_VERIFICATION_EDIT' } })).toBe(1)
    })
  })
})

/**
 * Excepción de EFECTIVO MANUAL (2026-09-21, tras la auditoría de Codex gpt-6-astra del 20-sep): desde el deploy del 18-sep TODO
 * cobro registrado por la terminal lleva la llave `pricing` —en efectivo sin afiliación vale `null`— y `cobrosDelProtocolo`
 * clasifica «llave presente» como protegido. Un SIM de $0 en efectivo de PlayTelecom quedaba así bajo el protocolo de costo sin
 * tener tarifa, evidencia bancaria ni obligación que proteger (162 cobros en dos días; Daniel Samperio: 2 × 409 el 18-sep; PT
 * corrige 41-58 verificaciones al mes, 77 de 119 de FORMA de pago). La pertenencia GLOBAL no cambia (el PUT y el DELETE del
 * dashboard siguen protegiendo ese cobro): sólo el editor de verificaciones deja pasar el cobro CASH sin afiliación, con
 * snapshot exactamente nulo, sin costo, sin obligación TRANSACTION_COST en ningún estado y sin reembolsos que lo apunten.
 * Un `pricing: null` CON afiliación es una captura INVÁLIDA (R10-1) y sigue protegido. La forma sólo se mueve entre EFECTIVO y OTRO
 * (77 de las 119 correcciones de PT son CASH → OTHER): pasar a TARJETA afirmaría dinero bancario que Avoqado no ve, y se rechaza.
 * Al cambiar la forma de pago se estampa
 * `fundsFlow` coherente (CASH → CASH_DRAWER; lo demás → EXTERNAL_RECORDED): la caja y el saldo disponible leen `fundsFlow`
 * por encima de `method` (`tenderSemantics`), y dejarlo en CASH_DRAWER con método OTHER era la incoherencia que señaló Codex.
 */
describe('Excepción de efectivo manual · un cobro CASH sin afiliación (pricing null) se corrige desde la verificación, y sólo desde ahí', () => {
  /** El cobro exacto de PlayTelecom: CASH desde la terminal, sin afiliación ⇒ `pricing: null` con la llave PRESENTE, sin slot ni costo. */
  const efectivoSinAfiliacion = async (amount = 10000) => {
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true, amount }), method: 'CASH' },
      f.staffId,
    )
    const fila = await pago(p.id)
    const pd = fila.processorData as Record<string, unknown>
    expect(fila).toMatchObject({ method: 'CASH', merchantAccountId: null, terminalPaymentRequestId: null })
    expect(Object.prototype.hasOwnProperty.call(pd, 'pricing')).toBe(true)
    expect(pd.pricing).toBeNull()
    expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })).toBe(0)
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    return p
  }
  const bitacoras = (sv: { id: string }) => prisma.activityLog.count({ where: { entityId: sv.id, action: 'SALE_VERIFICATION_EDIT' } })

  it('CASH sin afiliación · cambiar la FORMA DE PAGO (CASH → OTRO) pasa: método OTHER, fundsFlow EXTERNAL_RECORDED y bitácora', async () => {
    const p = await efectivoSinAfiliacion()
    const sv = await verificacionDe(p)
    const editada = await editar(sv, { paymentForm: 'OTHER' })
    expect(editada.payment).toMatchObject({ method: 'OTHER' })
    expect(await pago(p.id)).toMatchObject({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', merchantAccountId: null })
    expect(Number((await pago(p.id)).amount)).toBe(100)
    expect(await bitacoras(sv)).toBe(1)
    const bitacora = await exigir(prisma.activityLog.findFirst({ where: { entityId: sv.id, action: 'SALE_VERIFICATION_EDIT' } }))
    expect(bitacora.data).toMatchObject({ viaExcepcionEfectivoManual: true, after: { method: 'OTHER' } })
  })

  it('CASH sin afiliación · cambiar el IMPORTE ($100 → $120) pasa y el método (y su fundsFlow) no se tocan', async () => {
    const p = await efectivoSinAfiliacion()
    const antes = await pago(p.id)
    const sv = await verificacionDe(p)
    const editada = await editar(sv, { amount: 120 })
    expect(Number(editada.payment.amount)).toBe(120)
    const despues = await pago(p.id)
    expect(despues).toMatchObject({ method: 'CASH', fundsFlow: antes.fundsFlow })
    expect(Number(despues.amount)).toBe(120)
    expect(await bitacoras(sv)).toBe(1)
  })

  it('CASH sin afiliación · volver a EFECTIVO (OTRO → CASH) estampa fundsFlow CASH_DRAWER', async () => {
    const p = await efectivoSinAfiliacion()
    const sv = await verificacionDe(p)
    await editar(sv, { paymentForm: 'OTHER' })
    expect(await pago(p.id)).toMatchObject({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED' })
    // El cobro ya no es CASH: la excepción lo vuelve a examinar y lo deja pasar SÓLO porque sigue sin afiliación, sin costo y sin
    // reembolsos (la forma corregida no lo mete al protocolo). Regresar a efectivo lo devuelve al cajón.
    await editar(sv, { paymentForm: 'CASH' })
    expect(await pago(p.id)).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    expect(await bitacoras(sv)).toBe(2)
  })

  it('CONTROL · pasar a TARJETA (CASH → CARD) ⇒ 409: la excepción sólo mueve la forma entre efectivo y otro', async () => {
    const p = await efectivoSinAfiliacion()
    const sv = await verificacionDe(p)
    const antes = await foto(p.id)
    await rechazo(editar(sv, { paymentForm: 'CARD' }), ['method'])
    expect(await foto(p.id)).toEqual(antes)
    expect(await bitacoras(sv)).toBe(0)
  })

  it('CONTROL · el mismo cobro con un REEMBOLSO que lo apunta (cualquier estado) ⇒ 409 y nada cambia', async () => {
    const p = await efectivoSinAfiliacion()
    await issueRefund({ venueId: f.venueId, paymentId: p.id, amount: 2000, reason: 'OTHER', staffId: f.staffId })
    const sv = await verificacionDe(p)
    const antes = await foto(p.id)
    await rechazo(editar(sv, { amount: 120 }), ['amount'])
    await rechazo(editar(sv, { paymentForm: 'OTHER' }), ['method'])
    expect(await foto(p.id)).toEqual(antes)
    expect(await bitacoras(sv)).toBe(0)
  })

  it('CONTROL · pricing null CON afiliación (captura INVÁLIDA, R10-1) ⇒ 409: la excepción es sólo para el efectivo sin afiliación', async () => {
    const p = await recordFastPayment(f.venueId, { ...f.registroDeLaTerminal({ attemptId: randomUUID() }), method: 'CASH' }, f.staffId)
    // Sólo la afiliación distingue este cobro del elegible: snapshot nulo, sin slot, sin costo ni obligación — como el de PT.
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = jsonb_set(jsonb_set("processorData", '{pricing}', 'null'::jsonb), '{pricingSlot}', 'null'::jsonb) WHERE "id" = ${p.id}`
    await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
    await prisma.transactionCost.deleteMany({ where: { paymentId: p.id } })
    const fila = await pago(p.id)
    expect(fila.merchantAccountId).not.toBeNull()
    expect((fila.processorData as Record<string, unknown>).pricing).toBeNull()
    const sv = await verificacionDe(p)
    const antes = await foto(p.id)
    await rechazo(editar(sv, { amount: 120 }), ['amount'])
    expect(await foto(p.id)).toEqual(antes)
  })

  it('CONTROL · con una obligación TRANSACTION_COST (aunque esté FAILED) ⇒ 409', async () => {
    const p = await efectivoSinAfiliacion()
    await prisma.paymentEffect.create({
      data: { venueId: f.venueId, paymentId: p.id, kind: 'TRANSACTION_COST', dedupeKey: `tc:${p.id}`, payload: {}, status: 'FAILED' },
    })
    const sv = await verificacionDe(p)
    const antes = await foto(p.id)
    await rechazo(editar(sv, { paymentForm: 'OTHER' }), ['method'])
    expect(await foto(p.id)).toEqual(antes)
  })

  it('CONTROL · la pertenencia GLOBAL no cambia: el PUT genérico del dashboard sigue rechazando ese mismo cobro con 409', async () => {
    const p = await efectivoSinAfiliacion()
    const antes = await foto(p.id)
    await rechazo(updatePayment(f.venueId, p.id, { amount: 120 }), ['amount'])
    expect(await foto(p.id)).toEqual(antes)
  })

  it('CONTROL · el CONTRATO no cambia para el cobro con tarjeta: un cobro convergido sigue en 409 (regresión de R13-3)', async () => {
    const p = await cobroConvergido()
    const sv = await verificacionDe(p)
    await rechazo(editar(sv, { paymentForm: 'CASH' }), ['method'])
  })
})
