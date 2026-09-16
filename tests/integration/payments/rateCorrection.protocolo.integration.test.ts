/**
 * Codex R12-4 (pasada exhaustiva, checkpoint 1 del webhook): la corrección administrativa de tarifas (`rateCorrection`) NO
 * toca los cobros del PROTOCOLO de costo — snapshot de tarifa presente (incluido `null`) u obligación TRANSACTION_COST —.
 * Recalcular sin clasificar el snapshot, o crear/borrar `TransactionCost` sin la obligación, convertía una corrección
 * genérica en «acreditación» del cargo (un SIN_TARIFA con CREATE_COST al 8 % quedaba «convergido» a $80) o dejaba un
 * efecto DONE sin costo tras la reversa. Preview y apply coinciden; la exclusión se REVALIDA bajo el mutex del Payment
 * antes de escribir; la reversa de un lote ya aplicado también excluye; y todo excluido se explica.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { asegurarCostoSincrono } from '@/services/payments/deferredTransactionCost.service'
import { previewRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionPreview'
import { applyRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionApply'
import { reverseRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionReverse'
import * as moduloDelProtocolo from '@/services/shared/cobroDelProtocolo'
import { MOTIVO_EXCLUSION_DEL_PROTOCOLO } from '@/services/shared/cobroDelProtocolo'
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
  f = await crearFixture('tarifas')
  await f.conTarifas({ primary: { creditRate: 0.025, fixed: 0.5 } })
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.rateCorrectionEntry.deleteMany({ where: { batch: { venueId: f.venueId } } })
  await prisma.rateCorrectionBatch.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
const costoDe = (paymentId: string) => prisma.transactionCost.findUnique({ where: { paymentId } })
const efectoDe = (paymentId: string) => prisma.paymentEffect.findFirst({ where: { paymentId, kind: 'TRANSACTION_COST' } })
const pd = async (id: string) => (await pago(id)).processorData as Record<string, unknown>
const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === action).map(([p]) => p)
const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
/** Al 8 % de crédito: un cobro de $100 «corregido» pasa de $3.00 (2.5 % + $0.50) a $8.50. */
const tarifasNuevas = {
  debitRate: 0.02,
  creditRate: 0.08,
  amexRate: 0.035,
  internationalRate: 0.045,
  includesTax: true,
  taxRate: 0.16,
  fixedFeePerTransaction: 0.5,
}
const args = (missingCostMode: 'FIX_PAYMENT_ONLY' | 'CREATE_COST') => ({
  venueId: f.venueId,
  accountType: 'PRIMARY' as const,
  newVenueRates: tarifasNuevas,
  missingCostMode,
})
/** Restablece la estructura PRIMARY al 2.5 % (apply la actualiza «en vivo»). */
const restablecerTarifas = () =>
  prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'PRIMARY' }, data: { creditRate: 0.025 } })

/** Un cobro REST de $100 del protocolo, con su snapshot VALIDO y su obligación. */
const cobroDelProtocolo = async () => {
  const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
  expect(p.status).toBe('COMPLETED')
  expect(await pd(p.id)).toHaveProperty('pricing')
  return p
}
/** Convergido: costo real y obligación DONE. */
const convergido = async () => {
  const p = await cobroDelProtocolo()
  // Si no converge, el motivo durable (`lastError` de la obligación) viaja en el diff: un PENDIENTE sin motivo no se puede diagnosticar.
  const desenlace = await asegurarCostoSincrono(p.id)
  expect({ desenlace, lastError: (await efectoDe(p.id))?.lastError ?? null }).toMatchObject({ desenlace: 'CUMPLIDA' })
  expect(await efectoDe(p.id)).toMatchObject({ status: 'DONE' })
  expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  return p
}
/** El mismo cobro con el snapshot en OTRO estado (sin costo, obligación PENDING): la exclusión es por PRESENCIA del snapshot. */
const conSnapshot = async (pricing: unknown) => {
  const p = await cobroDelProtocolo()
  await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ pricing })}::jsonb WHERE "id" = ${p.id}`
  await prisma.transactionCost.deleteMany({ where: { paymentId: p.id } })
  return p
}
/** Un cobro ANTERIOR al protocolo: sin snapshot y sin obligación (lo que la corrección genérica SÍ puede tocar). */
const legacy = async () => {
  const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
  await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' - 'costPending' - 'pricingSlot' WHERE "id" = ${p.id}`
  await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
  await prisma.transactionCost.deleteMany({ where: { paymentId: p.id } })
  return p
}
const intacto = async (p: { id: string }, antes: { fee: number; pricing: unknown; costo: unknown; efecto: unknown }) => {
  expect(Number((await pago(p.id)).feeAmount)).toBe(antes.fee)
  expect((await pd(p.id)).pricing).toEqual(antes.pricing)
  expect(await costoDe(p.id)).toEqual(antes.costo)
  if (antes.efecto) expect(await efectoDe(p.id)).toMatchObject({ status: (antes.efecto as { status: string }).status })
  else expect(await efectoDe(p.id)).toBeNull()
}
const foto = async (p: { id: string }) => ({
  fee: Number((await pago(p.id)).feeAmount),
  pricing: (await pd(p.id)).pricing,
  costo: await costoDe(p.id),
  efecto: await efectoDe(p.id),
})

describe('Codex R12 (pasada exhaustiva) · R12-4: la corrección de tarifas excluye los cobros del protocolo — preview, apply (los dos modos), reverse y la carrera con el worker', () => {
  afterEach(restablecerTarifas)

  describe.each(['FIX_PAYMENT_ONLY', 'CREATE_COST'] as const)('apply en modo %s', modo => {
    it(`apply en modo ${modo}: VALIDO+DONE, SIN_TARIFA, CAPTURA_FALLIDA, INVALIDO y \`pricing: null\` quedan INTACTOS (ni fee, ni costo, ni obligación); el legacy sí se corrige; preview y apply coinciden y explican lo excluido`, async () => {
      const valido = await convergido()
      const sinTarifa = await conSnapshot({
        merchantAccountId: f.merchantId,
        slot: 'PRIMARY',
        venue: null,
        provider: null,
        frozenAt: new Date().toISOString(),
      })
      const capturaFallida = await conSnapshot({
        merchantAccountId: f.merchantId,
        slot: null,
        venue: null,
        provider: null,
        capturaFallida: { total: 'BASE_CAIDA' },
      })
      const invalido = await conSnapshot({ merchantAccountId: f.merchantId, slot: 'PRIMARY', venue: 'no-es-un-objeto' })
      const nulo = await conSnapshot(null)
      const viejo = await legacy()
      const protocolo = [valido, sinTarifa, capturaFallida, invalido, nulo]
      const fotos = await Promise.all(protocolo.map(foto))

      const preview = await previewRateCorrection(args(modo))
      expect(preview.inScopeCount).toBe(1)
      expect(preview.excludedProtocolCount).toBe(5)
      expect(preview.excludedProtocolPaymentIds.sort()).toEqual(protocolo.map(p => p.id).sort())
      expect(preview.excludedProtocolReason).toBe(MOTIVO_EXCLUSION_DEL_PROTOCOLO)
      expect(preview.missingCostCount).toBe(1)

      const lote = await applyRateCorrection(args(modo), { staffId: f.staffId })
      expect(lote.status).toBe('APPLIED')
      expect(lote.paymentCount).toBe(1)
      expect(lote.excludedProtocolCount).toBe(5)
      expect(lote.excludedProtocolPaymentIds.sort()).toEqual(protocolo.map(p => p.id).sort())
      for (const [i, p] of protocolo.entries()) await intacto(p, fotos[i])
      // El legacy SÍ: 8 % + $0.50 sobre $100.
      expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
      expect(await costoDe(viejo.id)).toEqual(modo === 'CREATE_COST' ? expect.objectContaining({ paymentId: viejo.id }) : null)
      expect(await prisma.rateCorrectionEntry.count({ where: { batchId: lote.id } })).toBe(1)
      expect(bitacora('RATE_CORRECTION_APPLIED')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            paymentCount: 1,
            excludedProtocolCount: 5,
            excludedProtocolPaymentIds: expect.arrayContaining(protocolo.map(p => p.id)),
          }),
        }),
      ])
    })
  })

  it('el criterio es UNO u OTRO: un cobro con snapshot pero SIN obligación (el efecto ya no existe) y otro con obligación pero SIN snapshot siguen siendo del protocolo — excluidos e intactos; sólo el que no tiene ninguna de las dos se corrige', async () => {
    // Snapshot VALIDO conservado, obligación borrada: la evidencia del snapshot basta por sí sola.
    const soloSnapshot = await convergido()
    await prisma.paymentEffect.deleteMany({ where: { paymentId: soloSnapshot.id, kind: 'TRANSACTION_COST' } })
    expect(await efectoDe(soloSnapshot.id)).toBeNull()
    // Obligación conservada (en cualquier estado — aquí ya DONE por el cálculo síncrono), snapshot y costo borrados: la
    // obligación basta por sí sola.
    const soloObligacion = await cobroDelProtocolo()
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' WHERE "id" = ${soloObligacion.id}`
    await prisma.transactionCost.deleteMany({ where: { paymentId: soloObligacion.id } })
    expect((await pd(soloObligacion.id)).pricing).toBeUndefined()
    expect(await efectoDe(soloObligacion.id)).toMatchObject({ status: 'DONE' })
    const viejo = await legacy()
    const fotoSnapshot = await foto(soloSnapshot)
    const fotoObligacion = await foto(soloObligacion)

    const preview = await previewRateCorrection(args('CREATE_COST'))
    expect(preview.inScopeCount).toBe(1)
    expect(preview.excludedProtocolPaymentIds.sort()).toEqual([soloSnapshot.id, soloObligacion.id].sort())

    const lote = await applyRateCorrection(args('CREATE_COST'), { staffId: f.staffId })
    expect(lote.paymentCount).toBe(1)
    expect(lote.excludedProtocolPaymentIds.sort()).toEqual([soloSnapshot.id, soloObligacion.id].sort())
    await intacto(soloSnapshot, fotoSnapshot)
    await intacto(soloObligacion, fotoObligacion)
    expect(await costoDe(soloObligacion.id)).toBeNull()
    expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
  })

  it('Codex R14-2 · el REEMBOLSO de un cobro del protocolo también queda EXCLUIDO (por su original) de preview y apply, e intacto (fee −3, costo negativo); el reembolso de un cobro legacy sí entra al alcance', async () => {
    const original = await convergido()
    const reembolsar = (p: { id: string; orderId: string | null }) =>
      recordRefund(
        f.venueId,
        {
          venueId: f.venueId,
          originalPaymentId: p.id,
          originalOrderId: p.orderId,
          amount: 10000,
          reason: 'CUSTOMER_REQUEST',
          authorizationNumber: `RF-${randomUUID().slice(0, 6)}`,
          referenceNumber: randomUUID(),
          isPartialRefund: false,
          currency: 'MXN',
          processor: 'angelpay',
          idempotencyKey: randomUUID(),
        } as Parameters<typeof recordRefund>[1],
        f.staffId,
      )
    const reembolso = await reembolsar(original)
    expect(await f.esperar(async () => (await costoDe(reembolso.id)) !== null, 4000)).toBe(true)
    expect(Number((await pago(reembolso.id)).feeAmount)).toBe(-3)
    // El reembolso NO lleva snapshot ni obligación propios: pertenece por su original.
    expect(await pd(reembolso.id)).not.toHaveProperty('pricing')
    expect(await efectoDe(reembolso.id)).toBeNull()
    const viejo = await legacy()
    const reembolsoDelViejo = await reembolsar(viejo)
    const fotoOriginal = await foto(original)
    const fotoReembolso = await foto(reembolso)

    const preview = await previewRateCorrection(args('CREATE_COST'))
    expect(preview.excludedProtocolPaymentIds.sort()).toEqual([original.id, reembolso.id].sort())
    expect(preview.inScopeCount).toBe(2)

    const lote = await applyRateCorrection(args('CREATE_COST'), { staffId: f.staffId })
    expect(lote.excludedProtocolPaymentIds.sort()).toEqual([original.id, reembolso.id].sort())
    expect(lote.paymentCount).toBe(2)
    await intacto(original, fotoOriginal)
    await intacto(reembolso, fotoReembolso)
    expect(Number((await pago(reembolso.id)).feeAmount)).toBe(-3)
    // Los dos legacy (cobro y su reembolso) sí se corrigieron.
    expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
    expect(await costoDe(reembolsoDelViejo.id)).not.toBeNull()
  })

  it('reverse DESPUÉS de converger: un cobro que entró al protocolo tras aplicarse el lote se salta (su costo y su obligación DONE no se tocan) y se explica; el legacy sí se revierte', async () => {
    const viejo = await legacy()
    const otroViejo = await legacy()
    const lote = await applyRateCorrection(args('CREATE_COST'), { staffId: f.staffId })
    expect(lote.paymentCount).toBe(2)
    expect(await costoDe(viejo.id)).not.toBeNull()
    // Después del lote, `viejo` entra al protocolo (una acreditación posterior lo dejó con snapshot y obligación DONE).
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ pricing: { merchantAccountId: f.merchantId, slot: 'PRIMARY' }, costPending: false })}::jsonb WHERE "id" = ${viejo.id}`
    await prisma.paymentEffect.create({
      data: {
        venueId: f.venueId,
        paymentId: viejo.id,
        orderId: viejo.orderId,
        kind: 'TRANSACTION_COST',
        dedupeKey: `r12-4-${viejo.id}`,
        payload: {},
        status: 'DONE',
        completedAt: new Date(),
      },
    })
    const fotoViejo = await foto(viejo)

    const reversa = await reverseRateCorrection(lote.id, { staffId: f.staffId })
    expect(reversa.status).toBe('REVERSED')
    expect(reversa.excludedProtocolPaymentIds).toEqual([viejo.id])
    await intacto(viejo, fotoViejo)
    expect(await costoDe(viejo.id)).not.toBeNull()
    expect(await efectoDe(viejo.id)).toMatchObject({ status: 'DONE' })
    // El que sigue siendo legacy se revierte completo: fee de vuelta a $3.00 y su costo creado por el lote, borrado.
    expect(Number((await pago(otroViejo.id)).feeAmount)).toBe(3)
    expect(await costoDe(otroViejo.id)).toBeNull()
    expect(bitacora('RATE_CORRECTION_REVERSED')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ excludedProtocolPaymentIds: [viejo.id] }) }),
    ])
  })

  const obligacionPara = (p: { id: string; orderId: string | null }, sufijo: string) =>
    prisma.paymentEffect.create({
      data: {
        venueId: f.venueId,
        paymentId: p.id,
        orderId: p.orderId,
        kind: 'TRANSACTION_COST',
        dedupeKey: `r12-4-carrera-${sufijo}-${p.id}`,
        payload: {},
        status: 'PENDING',
      },
    })
  const carreraExcluye = async (
    viejo: Awaited<ReturnType<typeof legacy>>,
    otroViejo: Awaited<ReturnType<typeof legacy>>,
    fotoViejo: Awaited<ReturnType<typeof foto>>,
  ) => {
    const lote = await applyRateCorrection(args('CREATE_COST'), { staffId: f.staffId })
    expect(lote.paymentCount).toBe(1)
    expect(lote.excludedProtocolPaymentIds).toEqual([viejo.id])
    await intacto(viejo, { ...fotoViejo, efecto: { status: 'PENDING' } })
    expect(await costoDe(viejo.id)).toBeNull()
    expect(Number((await pago(otroViejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
    expect(await prisma.rateCorrectionEntry.count({ where: { batchId: lote.id, paymentId: viejo.id } })).toBe(0)
    return lote
  }

  it('CARRERA con el worker (entre la lectura del apply y la partición previa): el cobro que entra al protocolo se excluye ANTES del mutex, no se corrige y se reporta', async () => {
    const viejo = await legacy()
    const otroViejo = await legacy()
    // La segunda lectura de Payments del apply (la primera es la del preview): tras leerla, `viejo` recibe su obligación.
    const original = prisma.payment.findMany.bind(prisma.payment)
    let lecturas = 0
    jest.spyOn(prisma.payment, 'findMany').mockImplementation((async (a: unknown) => {
      const r = await original(a as never)
      if (++lecturas === 2) await obligacionPara(viejo, 'lectura')
      return r
    }) as never)
    const fotoViejo = await foto(viejo)
    const lote = await carreraExcluye(viejo, otroViejo, fotoViejo)
    expect(lote.excludedProtocolCount).toBe(1)
  })

  it('CARRERA con el worker (entre la partición previa y el mutex): el cobro que entra al protocolo justo antes de bloquear se excluye BAJO el mutex (la revalidación), no se corrige y se reporta', async () => {
    const viejo = await legacy()
    const otroViejo = await legacy()
    // La partición previa ya dijo «legacy»; justo antes de tomar el mutex (la última lectura sin candado ya pasó), `viejo`
    // recibe su obligación por OTRA conexión. Sólo la revalidación bajo el mutex puede verlo.
    const bloquear = moduloDelProtocolo.bloquearPayments
    jest.spyOn(moduloDelProtocolo, 'bloquearPayments').mockImplementationOnce(async (db, ids, marcador) => {
      await obligacionPara(viejo, 'mutex')
      return bloquear(db, ids, marcador)
    })
    const fotoViejo = await foto(viejo)
    const lote = await carreraExcluye(viejo, otroViejo, fotoViejo)
    expect(lote.excludedProtocolCount).toBe(1)
    expect(bitacora('RATE_CORRECTION_APPLIED')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ excludedProtocolPaymentIds: [viejo.id], paymentCount: 1 }) }),
    ])
  })
})

describe('Codex R15-2 · la corrección de tarifas PROTEGE el par ORIGINAL → reembolso durante la clasificación y la escritura: los originales de los reembolsos del lote (dentro y fuera del lote) se bloquean PRIMERO y SIN ESPERAR (NOWAIT); un original ocupado aparta a sus reembolsos —y a sí mismo si está en el lote— en vez de esperar; después el lote en `id ASC`; bajo los candados se releen tipo, venue y puntero y, si cambiaron, se sueltan TODOS los candados del intento y se reinicia (≤3; después 409 que declara que la tarifa vigente ya cambió)', () => {
  const ctx = () => ({ staffId: f.staffId })
  const reembolsar = (p: { id: string; orderId: string | null }, amount = 10000, isPartialRefund = false) =>
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
  /** Deja el cobro FUERA del alcance por fecha (`dateFrom` = hace 30 min): un original fuera del lote. */
  const retrodatar = (id: string) => prisma.payment.update({ where: { id }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } })
  const desdeHaceMedaHora = () => ({ ...args('CREATE_COST'), dateFrom: new Date(Date.now() - 30 * 60_000) })
  const barrera = () => {
    let liberar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (liberar = r))
    const pausada = new Promise<void>(r => (pausado = r))
    const pausadaEn = (ms: number) =>
      Promise.race([
        pausada.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return { liberar, pausado, liberada, pausadaEn }
  }
  /** OTRA transacción sostiene el mutex del Payment (como la unidad de costo) hasta que la prueba lo suelta — MONTAJE registrado al lanzarlo. */
  const sostenerMutex = (Act: ReturnType<typeof actores>, id: string) => {
    const b = barrera()
    const ajena = Act.montaje(
      `mutex ajeno sobre ${id}`,
      prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${id} FOR NO KEY UPDATE`
          b.pausado()
          await b.liberada
        },
        { timeout: 30_000 },
      ),
    )
    return { b, ajena }
  }
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
  /** Pausa el apply en la fase del LOTE (`bloquearPayments`): `antes` = entre la fase de originales y la del lote; `despues` = con el lote ya tomado. */
  const pausarEnElLote = (b: ReturnType<typeof barrera>, cuando: 'antes' | 'despues', llamada = 1) => {
    const real = moduloDelProtocolo.bloquearPayments
    let n = 0
    jest.spyOn(moduloDelProtocolo, 'bloquearPayments').mockImplementation(async (db, ids, marcador) => {
      if (++n !== llamada) return real(db, ids, marcador)
      if (cuando === 'antes') {
        b.pausado()
        await b.liberada
        return real(db, ids, marcador)
      }
      const r = await real(db, ids, marcador)
      b.pausado()
      await b.liberada
      return r
    })
    return () => n
  }
  afterEach(async () => {
    jest.restoreAllMocks()
    await restablecerTarifas()
  })

  it('ORIGINAL FUERA DEL LOTE, OCUPADO · el original (legacy, fuera del alcance por fecha) está tomado por otra transacción —como la unidad de costo que lo estuviera acreditando—: apply NO espera (termina con ese candado todavía puesto), aparta el reembolso como OCUPADO sin bloquearlo (su fila sigue LIBRE mientras el lote corrige el otro legacy, que sí está tomado), y el reembolso queda intacto; la bitácora explica lo apartado', async () => {
    // (El reembolso de un original del PROTOCOLO se aparta ANTES de los candados, en la partición previa — R14-2; aquí el original es
    // legacy: el reembolso es corrigible y su pertenencia depende de un original que alguien está tomando.)
    const original = await legacy()
    const reembolso = await reembolsar(original)
    await retrodatar(original.id)
    const viejo = await legacy()
    const fotoReembolso = await foto(reembolso)
    const Act = actores()
    const { b: mutex, ajena } = sostenerMutex(Act, original.id)
    const lote = barrera()
    pausarEnElLote(lote, 'despues')
    let apply!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof applyRateCorrection>>>>
    let fallo: Fallo = null
    try {
      expect(await mutex.pausadaEn(10_000)).toBe(true)
      apply = Act.lanzar('apply', applyRateCorrection(desdeHaceMedaHora(), ctx()))
      // Llegó a la fase del lote SIN esperar al original ocupado (acotado: si esperara, la pausa nunca llega y cae por aserción).
      expect(await lote.pausadaEn(5000)).toBe(true)
      expect(await sondaSinEsperar(reembolso.id)).toBe('LIBRE')
      expect(await sondaSinEsperar(viejo.id)).toBe('TOMADA')
      await Act.liberar({ lote: () => lote.liberar() })
      // Termina con el mutex del original todavía puesto: la corrección no espera al original.
      expect(await Act.carrera(apply, 5000)).toMatchObject({ estado: 'ASENTADA', ok: true })
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ lote: () => lote.liberar(), mutex: () => mutex.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      await ajena.resultado()
      const resultado = await apply.resultado()
      expect(resultado).toMatchObject({
        status: 'APPLIED',
        paymentCount: 1,
        excludedProtocolPaymentIds: [],
        excludedBusyPaymentIds: [reembolso.id],
        excludedBusyCount: 1,
      })
      expect(typeof resultado.excludedBusyReason).toBe('string')
      await intacto(reembolso, fotoReembolso)
      expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
      expect(await prisma.rateCorrectionEntry.count({ where: { batchId: resultado.id, paymentId: reembolso.id } })).toBe(0)
      expect(bitacora('RATE_CORRECTION_APPLIED')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ excludedBusyPaymentIds: [reembolso.id], paymentCount: 1 }) }),
      ])
    })
  })

  /** El escenario de Codex: un original HISTÓRICO de $100 con su costo de $3 pero sin snapshot ni obligación (legacy con costo). */
  const legacyConCosto = async () => {
    const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
    expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' - 'costPending' - 'pricingSlot' WHERE "id" = ${p.id}`
    await prisma.paymentEffect.deleteMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })
    expect(await costoDe(p.id)).not.toBeNull()
    expect(await efectoDe(p.id)).toBeNull()
    return p
  }

  it('CARRERA con un reembolso REAL · el original histórico P ($100, costo $3, sin snapshot ni obligación) está fuera del lote y su reembolso parcial R1 dentro; apply se pausa DESPUÉS de clasificar (R1 legacy) y ANTES de escribir; un segundo reembolso real R2 sobre P —el que incorpora a P al protocolo con su obligación— ESPERA el candado de P (la corrección lo tiene desde la fase de originales) y sólo entra cuando el lote commiteó: R1 se corrige con la clasificación que hizo, y P entra al protocolo DESPUÉS', async () => {
    const original = await legacyConCosto()
    const r1 = await reembolsar(original, 4000, true)
    // R1 es HISTÓRICO: hoy un reembolso deja obligación en su original (R12-15); la de entonces no existe — se retira, y P sigue legacy.
    await prisma.paymentEffect.deleteMany({ where: { paymentId: original.id, kind: 'TRANSACTION_COST' } })
    expect(await efectoDe(original.id)).toBeNull()
    expect(await pd(r1.id)).not.toHaveProperty('pricing')
    await retrodatar(original.id)
    const Act = actores()
    const b = barrera()
    // La revalidación BAJO los candados es la llamada a `cobrosDelProtocolo` con el cliente de la TRANSACCIÓN (las particiones
    // previas del preview y del apply van con el cliente global): se pausa con el resultado ya calculado, justo antes de escribir.
    const real = moduloDelProtocolo.cobrosDelProtocolo
    let bajoLosCandados = 0
    jest.spyOn(moduloDelProtocolo, 'cobrosDelProtocolo').mockImplementation(async (db, ids) => {
      const r = await real(db, ids)
      if (db !== (prisma as unknown) && ++bajoLosCandados === 1) {
        b.pausado()
        await b.liberada
      }
      return r
    })
    let apply!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof applyRateCorrection>>>>
    let r2!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof reembolsar>>>>
    let fallo: Fallo = null
    try {
      apply = Act.lanzar('apply', applyRateCorrection(desdeHaceMedaHora(), ctx()))
      expect(await b.pausadaEn(5000)).toBe(true)
      r2 = Act.lanzar('reembolso real R2 sobre P', reembolsar(original, 3000, true))
      // El reembolso real toma P con `FOR UPDATE`: mientras la corrección clasifica y escribe, ESPERA (no se asienta en 2 s).
      expect(await Act.carrera(r2, 2000)).toEqual({ estado: 'BLOQUEADA' })
      expect(await efectoDe(original.id)).toBeNull()
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ apply: () => b.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const resultado = await apply.resultado()
      const segundo = await r2.resultado()
      expect(resultado).toMatchObject({ status: 'APPLIED', paymentCount: 1, excludedProtocolPaymentIds: [], excludedBusyPaymentIds: [] })
      expect(await prisma.rateCorrectionEntry.count({ where: { batchId: resultado.id, paymentId: r1.id } })).toBe(1)
      // R2 entró DESPUÉS del lote: P ya pertenece al protocolo (obligación de costo negativo), y ese ingreso no pudo cruzarse con la
      // clasificación de R1 (la partición previa del apply había dicho «legacy» con P intacto).
      expect(segundo.status).toBe('COMPLETED')
      expect(await efectoDe(original.id)).not.toBeNull()
      expect(bajoLosCandados).toBe(1)
    })
  })

  it('ORIGINAL LEGACY FUERA DEL LOTE · el reembolso (corrigible) está en el lote y su original legacy no: mientras apply clasifica y escribe, el original está BLOQUEADO por el lote (una sonda NOWAIT lo encuentra tomado) — nadie puede acreditarlo entre la clasificación y la escritura —; al terminar, el reembolso queda corregido (su original sigue siendo legacy)', async () => {
    const viejo = await legacy()
    const reembolso = await reembolsar(viejo)
    await retrodatar(viejo.id)
    const Act = actores()
    const lote = barrera()
    pausarEnElLote(lote, 'despues')
    let apply!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof applyRateCorrection>>>>
    let fallo: Fallo = null
    try {
      apply = Act.lanzar('apply', applyRateCorrection(desdeHaceMedaHora(), ctx()))
      expect(await lote.pausadaEn(5000)).toBe(true)
      // El original NO está en el lote y aun así está tomado (fase de originales); el reembolso también (fase del lote).
      expect(await sondaSinEsperar(viejo.id)).toBe('TOMADA')
      expect(await sondaSinEsperar(reembolso.id)).toBe('TOMADA')
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ lote: () => lote.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const resultado = await apply.resultado()
      expect(resultado).toMatchObject({ status: 'APPLIED', paymentCount: 1, excludedProtocolPaymentIds: [], excludedBusyPaymentIds: [] })
      expect(await prisma.rateCorrectionEntry.count({ where: { batchId: resultado.id, paymentId: reembolso.id } })).toBe(1)
      expect(await costoDe(reembolso.id)).not.toBeNull()
      // Al soltarse la transacción, el original queda libre.
      expect(await sondaSinEsperar(viejo.id)).toBe('LIBRE')
    })
  })

  it('ORDEN INVERSO DE IDS DENTRO DEL LOTE · original y reembolso legacy en el lote con el id del reembolso MENOR que el del original: el original se bloquea en la fase de originales, ANTES del lote — pausado entre las dos fases, el original está tomado y el reembolso sigue libre —; después ambos se corrigen', async () => {
    const viejo = await legacy()
    const reembolso = await reembolsar(viejo)
    // Un id menor que cualquier cuid (`c…`): la fase del lote (id ASC) lo tomaría ANTES que a su original — el orden inverso al de la
    // unidad de costo. Las FK hacia Payment son ON UPDATE CASCADE; el puntero (`processorData.originalPaymentId`) vive en el reembolso.
    const idMenor = `0-${randomUUID()}`
    await prisma.$executeRaw`UPDATE "Payment" SET "id" = ${idMenor} WHERE "id" = ${reembolso.id}`
    expect(idMenor < viejo.id).toBe(true)
    const Act = actores()
    const lote = barrera()
    const llamadas = pausarEnElLote(lote, 'antes')
    let apply!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof applyRateCorrection>>>>
    let fallo: Fallo = null
    try {
      apply = Act.lanzar('apply', applyRateCorrection(args('CREATE_COST'), ctx()))
      expect(await lote.pausadaEn(5000)).toBe(true)
      expect(await sondaSinEsperar(viejo.id)).toBe('TOMADA')
      expect(await sondaSinEsperar(idMenor)).toBe('LIBRE')
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ lote: () => lote.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const resultado = await apply.resultado()
      expect(llamadas()).toBe(1)
      expect(resultado).toMatchObject({ status: 'APPLIED', paymentCount: 2, excludedProtocolPaymentIds: [], excludedBusyPaymentIds: [] })
      expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
      expect(await prisma.rateCorrectionEntry.count({ where: { batchId: resultado.id, paymentId: idMenor } })).toBe(1)
    })
  })

  it('RELECTURA · el puntero del reembolso cambia de original (O1 → O2, los dos legacy y fuera del lote) mientras apply ya tomó el candado de O1: la relectura bajo los candados lo detecta, se sueltan TODOS los candados del intento y se reinicia — en el segundo intento O2 está tomado y O1 libre, y el reembolso se corrige con su puntero nuevo', async () => {
    const o1 = await legacy()
    const o2 = await legacy()
    const reembolso = await reembolsar(o1)
    await retrodatar(o1.id)
    await retrodatar(o2.id)
    const Act = actores()
    const lote = barrera()
    const real = moduloDelProtocolo.bloquearPayments
    let llamadas = 0
    jest.spyOn(moduloDelProtocolo, 'bloquearPayments').mockImplementation(async (db, ids, marcador) => {
      llamadas++
      if (llamadas === 1) {
        // Primer intento: O1 ya está tomado; ANTES de la fase del lote, por OTRA conexión, el reembolso cambia de original.
        await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ originalPaymentId: o2.id })}::jsonb WHERE "id" = ${reembolso.id}`
        return real(db, ids, marcador)
      }
      const r = await real(db, ids, marcador)
      if (llamadas === 2) {
        lote.pausado()
        await lote.liberada
      }
      return r
    })
    let apply!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof applyRateCorrection>>>>
    let fallo: Fallo = null
    try {
      apply = Act.lanzar('apply', applyRateCorrection(desdeHaceMedaHora(), ctx()))
      // Si no hubiera relectura no habría segundo intento: la pausa nunca llegaría y la prueba cae por ASERCIÓN.
      expect(await lote.pausadaEn(5000)).toBe(true)
      expect(await sondaSinEsperar(o2.id)).toBe('TOMADA')
      expect(await sondaSinEsperar(o1.id)).toBe('LIBRE')
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ lote: () => lote.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const resultado = await apply.resultado()
      expect(llamadas).toBe(2)
      expect(resultado).toMatchObject({ status: 'APPLIED', paymentCount: 1, excludedProtocolPaymentIds: [], excludedBusyPaymentIds: [] })
      expect(await prisma.rateCorrectionEntry.count({ where: { batchId: resultado.id, paymentId: reembolso.id } })).toBe(1)
    })
  })

  it('RELECTURA · si el puntero cambia en CADA intento, al tercero apply responde 409 (`RATE_CORRECTION_LOCK_UNSTABLE`) sin tocar ningún cobro histórico ni escribir entradas, deja el lote FAILED, y el mensaje declara que la tarifa VIGENTE ya quedó actualizada (el 409 no es «no se escribió nada»)', async () => {
    const o1 = await legacy()
    const o2 = await legacy()
    const reembolso = await reembolsar(o1)
    await retrodatar(o1.id)
    await retrodatar(o2.id)
    const fotoReembolso = await foto(reembolso)
    const real = moduloDelProtocolo.bloquearPayments
    let llamadas = 0
    jest.spyOn(moduloDelProtocolo, 'bloquearPayments').mockImplementation(async (db, ids, marcador) => {
      llamadas++
      const nuevo = llamadas % 2 === 1 ? o2.id : o1.id
      await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ originalPaymentId: nuevo })}::jsonb WHERE "id" = ${reembolso.id}`
      return real(db, ids, marcador)
    })
    await expect(applyRateCorrection(desdeHaceMedaHora(), ctx())).rejects.toMatchObject({
      statusCode: 409,
      code: 'RATE_CORRECTION_LOCK_UNSTABLE',
      message: expect.stringMatching(/tarifa.*vigente.*ya/i),
      details: expect.objectContaining({ liveRatesUpdated: true }),
    })
    expect(llamadas).toBe(3)
    await intacto(reembolso, fotoReembolso)
    const lote = await exigir(prisma.rateCorrectionBatch.findFirst({ where: { venueId: f.venueId }, orderBy: { createdAt: 'desc' } }))
    expect(lote).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/vuelve a intentarlo/i) })
    expect(await prisma.rateCorrectionEntry.count({ where: { batchId: lote.id } })).toBe(0)
    // La estructura vigente SÍ cambió (paso previo a la transacción): un cobro nuevo ya cobraría al 8 %.
    const vigente = await exigir(
      prisma.venuePricingStructure.findFirst({ where: { venueId: f.venueId, accountType: 'PRIMARY', active: true } }),
    )
    expect(Number(vigente.creditRate)).toBeCloseTo(0.08, 6)
    // Los candados se soltaron: todo libre.
    for (const id of [o1.id, o2.id, reembolso.id]) expect(await sondaSinEsperar(id)).toBe('LIBRE')
  })

  it('VARIOS REEMBOLSOS DEL MISMO ORIGINAL · dos reembolsos parciales ($40 y $60) de un original legacy fuera del lote: con el original OCUPADO los dos se apartan como ocupados e intactos (el original se pide una vez: ninguno espera); con el original libre los dos se corrigen, y el legacy se corrige en ambos casos', async () => {
    const original = await legacy()
    const r1 = await reembolsar(original, 4000, true)
    const r2 = await reembolsar(original, 6000, true)
    await retrodatar(original.id)
    const viejo = await legacy()
    const fotos = [await foto(r1), await foto(r2)]
    const Act = actores()
    const { b: mutex, ajena } = sostenerMutex(Act, original.id)
    let apply!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof applyRateCorrection>>>>
    let fallo: Fallo = null
    try {
      expect(await mutex.pausadaEn(10_000)).toBe(true)
      apply = Act.lanzar('apply con el original ocupado', applyRateCorrection(desdeHaceMedaHora(), ctx()))
      expect(await Act.carrera(apply, 5000)).toMatchObject({ estado: 'ASENTADA', ok: true })
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ mutex: () => mutex.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      await ajena.resultado()
      const ocupado = await apply.resultado()
      expect(ocupado.excludedBusyPaymentIds.sort()).toEqual([r1.id, r2.id].sort())
      expect(ocupado).toMatchObject({ paymentCount: 1, excludedProtocolPaymentIds: [] })
      await intacto(r1, fotos[0])
      await intacto(r2, fotos[1])
      expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
    })
    // Con el original libre: los dos reembolsos (legacy) se corrigen — su original quedó bloqueado durante la corrección.
    const otroViejo = await legacy()
    const libre = await applyRateCorrection(desdeHaceMedaHora(), ctx())
    expect(libre).toMatchObject({ excludedBusyPaymentIds: [], excludedProtocolPaymentIds: [] })
    expect(await prisma.rateCorrectionEntry.count({ where: { batchId: libre.id, paymentId: { in: [r1.id, r2.id] } } })).toBe(2)
    expect(Number((await pago(otroViejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
  })

  it('REVERSE · un original OCUPADO (en el lote) aparta de la reversa a sí mismo y a su reembolso (quedan como el lote los dejó, explicado y sin esperar); el resto se revierte y el lote queda REVERSED', async () => {
    const viejo = await legacy()
    const reembolso = await reembolsar(viejo)
    const otro = await legacy()
    const lote = await applyRateCorrection(args('CREATE_COST'), ctx())
    expect(lote.paymentCount).toBe(3)
    expect(Number((await pago(otro.id)).feeAmount)).toBeCloseTo(8.5, 6)
    const Act = actores()
    const { b: mutex, ajena } = sostenerMutex(Act, viejo.id)
    let reverse!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof reverseRateCorrection>>>>
    let fallo: Fallo = null
    try {
      expect(await mutex.pausadaEn(10_000)).toBe(true)
      reverse = Act.lanzar('reverse con el original ocupado', reverseRateCorrection(lote.id, ctx()))
      expect(await Act.carrera(reverse, 5000)).toMatchObject({ estado: 'ASENTADA', ok: true })
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ mutex: () => mutex.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      await ajena.resultado()
      const resultado = await reverse.resultado()
      expect(resultado.status).toBe('REVERSED')
      expect(resultado.excludedBusyPaymentIds.sort()).toEqual([viejo.id, reembolso.id].sort())
      expect(resultado).toMatchObject({ excludedProtocolPaymentIds: [], excludedBusyCount: 2 })
      // El original y su reembolso quedaron como el lote los dejó; el otro legacy volvió a $3 y perdió el costo creado.
      expect(Number((await pago(viejo.id)).feeAmount)).toBeCloseTo(8.5, 6)
      expect(await costoDe(viejo.id)).not.toBeNull()
      expect(Number((await pago(otro.id)).feeAmount)).toBe(3)
      expect(await costoDe(otro.id)).toBeNull()
      expect(bitacora('RATE_CORRECTION_REVERSED')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ excludedBusyPaymentIds: expect.arrayContaining([viejo.id, reembolso.id]), paymentCount: 1 }),
        }),
      ])
    })
  })
})
