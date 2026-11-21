/**
 * D24 (21-nov-2026, nace de la ronda 1 de Codex de D19, hallazgos #1-#3): lo que guarda una FOTO del dinero —la póliza contable y la
 * conciliación bancaria— no puede tomarla mientras la comisión del cobro todavía se está calculando. Un reembolso con tarjeta NACE
 * con comisión 0 y neto = −bruto; su comisión revertida llega después (costo negativo + proyecciones, R13-5). Antes:
 *  · la póliza de la devolución de $40 se guardaba con $40 a banco y SIN el renglón de $1 de comisión, y su llave `refund:<id>:v1`
 *    impedía rehacerla;
 *  · la conciliación comparaba el neto provisional (−$40) y guardaba «sin conciliar» un depósito que con −$39 cuadra.
 * Ahora lo pendiente se SALTA, se CUENTA en la respuesta y se toma en la siguiente corrida (pólizas) o al volver a abrir el estado de
 * cuenta (conciliación). Lo que no está pendiente sale exactamente igual que antes.
 *
 * Cobro real de la TPV (`recordFastPayment`) por la afiliación SECUNDARIA al 2.5 % + $0.50: $100 ⇒ comisión $3, neto $97. Una
 * devolución de $40 ⇒ comisión revertida $1 (2.5 % × 40, sin fijo), neto −$39.
 */
import { randomUUID } from 'crypto'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { asegurarCostoSincrono } from '@/services/payments/deferredTransactionCost.service'
import * as costoDeTransaccion from '@/services/payments/transactionCost.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { claimPaymentEffects, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { getMappings, seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { getStatementDetail, processBankStatement } from '@/services/dashboard/bankReconciliation.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
// El estado de cuenta se sube a Firebase Storage: aquí no sale de la máquina.
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async (_b: Buffer, ruta: string) => `https://storage.example.test/${ruta}`),
}))

jest.setTimeout(120000)

let f: Fixture
let M2: { id: string; externalMerchantId: string }
let organizationId: string
let rfc: string
let cuenta: (movimiento: string) => string

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('d24')
  M2 = await f.afiliacionSecundaria()
  await f.conTarifas({
    primary: { creditRate: 0.08, internationalRate: 0.045, fixed: 0.5 },
    secundaria: { merchantAccountId: M2.id, tasas: { creditRate: 0.025, fixed: 0.5 } },
  })
  organizationId = (await exigir(prisma.venue.findUnique({ where: { id: f.venueId }, select: { organizationId: true } }))).organizationId
  // RFC único por corrida: el folio de las pólizas es consecutivo POR contribuyente.
  rfc = `DVC${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
  await prisma.venue.update({ where: { id: f.venueId }, data: { rfc } })
  await seedBaseChart(f.venueId, { staffId: f.staffId })
  await seedDefaultMappings(f.venueId, { staffId: f.staffId })
  const mapeos = await getMappings(f.venueId)
  const porMovimiento = new Map(mapeos.mappings.filter(m => m.account).map(m => [m.movementType, m.account!.id]))
  cuenta = movimiento => {
    const id = porMovimiento.get(movimiento)
    if (!id) throw new Error(`sin cuenta para ${movimiento}`)
    return id
  }
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.bankStatement.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await prisma.journalEntry.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
  await prisma.accountMapping.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
  await prisma.ledgerAccount.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
  await f.destruir()
})

const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
const efectoDelOriginal = (paymentId: string) => exigir(prisma.paymentEffect.findFirst({ where: { paymentId, kind: 'TRANSACTION_COST' } }))
const poliza = (llave: string) =>
  prisma.journalEntry.findFirst({ where: { organizationId, rfc, idempotencyKey: llave }, include: { lines: true } })
/** Centavos de un renglón de la póliza en la cuenta del movimiento (debe o haber). */
const renglon = (lineas: Array<{ ledgerAccountId: string; debitCents: number; creditCents: number }>, movimiento: string) =>
  lineas.find(l => l.ledgerAccountId === cuenta(movimiento)) ?? null
const suma = (lineas: Array<{ debitCents: number; creditCents: number }>, k: 'debitCents' | 'creditCents') =>
  lineas.reduce((s, l) => s + l[k], 0)

/** Un cobro REST de $100 CONVERGIDO: costo $3.00 (2.5 % + $0.50) y obligación DONE. */
const originalConvergido = async () => {
  const p = await recordFastPayment(
    f.venueId,
    {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
      merchantAccountId: M2.id,
    },
    f.staffId,
  )
  expect(p.status).toBe('COMPLETED')
  expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
  expect(await efectoDelOriginal(p.id)).toMatchObject({ status: 'DONE' })
  expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  return p
}
const reembolsoTpv = async (p: { id: string; orderId: string | null }, amount: number) =>
  (
    await recordRefund(
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
  ).id
const reembolsoDashboard = async (p: { id: string }, amount: number) =>
  (
    await issueRefund({
      venueId: f.venueId,
      paymentId: p.id,
      amount,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId: f.staffId,
    })
  ).refundId

/** El worker REAL de efectos: reclama y corre lo vencido de ESTE negocio (mismo patrón que la suite `costoReal`, D15). */
const correrEfectos = async () => {
  const ahora = new Date()
  await prisma.paymentEffect.updateMany({
    where: { venueId: f.venueId, status: 'PENDING', nextAttemptAt: { lte: ahora } },
    data: { nextAttemptAt: new Date(0) },
  })
  const claims = (await claimPaymentEffects({ now: ahora })).filter(c => c.venueId === f.venueId)
  const r: boolean[] = []
  for (const c of claims) r.push(await runClaimedPaymentEffect(c))
  return r
}

/**
 * Cobro de $100 convergido + devolución de $40 cuyo costo síncrono FALLA (transitorio): la devolución queda con comisión 0 y neto
 * −$40, la obligación del cobro reabierta (PENDING) y su marca en `costPending: true` — la ventana del defecto, sostenida.
 */
const devolucionConComisionPendiente = async (
  reembolsar: (p: { id: string; orderId: string | null }, amount: number) => Promise<string>,
) => {
  const original = await originalConvergido()
  const corte = jest.spyOn(costoDeTransaccion, 'createRefundTransactionCost').mockImplementationOnce(async () => {
    throw new Error('fallo transitorio del costo negativo')
  })
  const refundId = await reembolsar(original, 4000)
  // El dashboard intenta el costo en segundo plano: se espera a que ese intento (el que falla) haya pasado.
  expect(await f.esperar(async () => corte.mock.calls.length > 0, 4000)).toBe(true)
  corte.mockRestore()
  expect(await prisma.transactionCost.findUnique({ where: { paymentId: refundId } })).toBeNull()
  expect((await pago(original.id)).processorData).toMatchObject({ costPending: true })
  expect(await efectoDelOriginal(original.id)).toMatchObject({ status: 'PENDING' })
  const reembolso = await pago(refundId)
  expect(Number(reembolso.feeAmount)).toBe(0)
  expect(Number(reembolso.netAmount)).toBe(-40)
  return { original, refundId }
}

describe.each([
  ['DASHBOARD (issueRefund)', reembolsoDashboard],
  ['TPV (recordRefund)', reembolsoTpv],
] as const)('D24 · pólizas · devolución de $40 por %s con la comisión por calcular', (_canal, reembolsar) => {
  it('se SALTA y se cuenta (no se guarda con comisión 0); la venta original —cuya comisión ya es la final— sí se postea; al converger, la siguiente corrida la genera con $39 a banco y $1 de comisión', async () => {
    const { original, refundId } = await devolucionConComisionPendiente(reembolsar)

    const r1 = await generatePoliciesForVenue(f.venueId)
    expect(r1).toMatchObject({ pendientesDeCosto: 1, costoSinCalcular: 0, posted: 1 })
    expect(await poliza(`refund:${refundId}:v1`)).toBeNull()
    // La venta: su comisión ($3) ya es la definitiva aunque la marca del cobro se reactivó por la devolución.
    const venta = await exigir(poliza(`pay:${original.id}:v1`))
    expect(renglon(venta.lines, 'BANK_RECEIPT')).toMatchObject({ debitCents: 9700, creditCents: 0 })
    expect(renglon(venta.lines, 'PROCESSOR_FEE')).toMatchObject({ debitCents: 300, creditCents: 0 })

    // Re-generar mientras sigue pendiente: se vuelve a saltar, nada nuevo.
    expect(await generatePoliciesForVenue(f.venueId)).toMatchObject({ pendientesDeCosto: 1, posted: 0, alreadyPosted: 1 })
    expect(await poliza(`refund:${refundId}:v1`)).toBeNull()

    // El worker cumple la obligación: costo negativo, proyecciones −$1 / −$39 y la marca en false.
    expect(await correrEfectos()).toContain(true)
    expect((await pago(original.id)).processorData).toMatchObject({ costPending: false })
    expect(Number((await pago(refundId)).feeAmount)).toBe(-1)
    expect(Number((await pago(refundId)).netAmount)).toBe(-39)

    const r3 = await generatePoliciesForVenue(f.venueId)
    expect(r3).toMatchObject({ pendientesDeCosto: 0, costoSinCalcular: 0, posted: 1, alreadyPosted: 1 })
    const devolucion = await exigir(poliza(`refund:${refundId}:v1`))
    expect(renglon(devolucion.lines, 'BANK_RECEIPT')).toMatchObject({ debitCents: 0, creditCents: 3900 })
    expect(renglon(devolucion.lines, 'PROCESSOR_FEE')).toMatchObject({ debitCents: 0, creditCents: 100 })
    expect(suma(devolucion.lines, 'debitCents')).toBe(4000)
    expect(suma(devolucion.lines, 'creditCents')).toBe(4000)
  })
})

describe('D24 · pólizas · VENTA con la comisión por calcular (todavía sin costo)', () => {
  it('se salta y se cuenta; con la obligación en DEAD_LETTER se cuenta también como «sin calcular»; al calcularse, se postea con su comisión real', async () => {
    // La tarifa no se puede acreditar al cobrar: el costo queda PENDIENTE con motivo, sin costo ni comisión (fee 0, neto 100).
    const sinTarifa = jest
      .spyOn(costoDeTransaccion, 'createTransactionCost')
      .mockRejectedValue(new Error('COST_PENDING_AFFILIATION_PRICING_UNRESOLVED: prueba D24'))
    const p = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
        merchantAccountId: M2.id,
      },
      f.staffId,
    )
    expect(await asegurarCostoSincrono(p.id)).toBe('PENDIENTE')
    expect(await prisma.transactionCost.findUnique({ where: { paymentId: p.id } })).toBeNull()
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(p.id)).feeAmount)).toBe(0)

    expect(await generatePoliciesForVenue(f.venueId)).toMatchObject({ pendientesDeCosto: 1, costoSinCalcular: 0, posted: 0 })
    expect(await poliza(`pay:${p.id}:v1`)).toBeNull()

    // El trabajo de la comisión se murió (agotó sus intentos): tampoco se guarda en 0, y se dice aparte.
    await prisma.paymentEffect.updateMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' }, data: { status: 'DEAD_LETTER' } })
    expect(await generatePoliciesForVenue(f.venueId)).toMatchObject({ pendientesDeCosto: 1, costoSinCalcular: 1, posted: 0 })
    expect(await poliza(`pay:${p.id}:v1`)).toBeNull()

    // Alguien lo resuelve: la tarifa vuelve y el costo converge.
    sinTarifa.mockRestore()
    await prisma.paymentEffect.updateMany({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' }, data: { status: 'PENDING' } })
    expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)

    expect(await generatePoliciesForVenue(f.venueId)).toMatchObject({ pendientesDeCosto: 0, costoSinCalcular: 0, posted: 1 })
    const venta = await exigir(poliza(`pay:${p.id}:v1`))
    expect(renglon(venta.lines, 'BANK_RECEIPT')).toMatchObject({ debitCents: 9700 })
    expect(renglon(venta.lines, 'PROCESSOR_FEE')).toMatchObject({ debitCents: 300 })
  })
})

describe('D24 · conciliación bancaria con una devolución cuya comisión está por calcular', () => {
  const hoy = () => formatInTimeZone(new Date(), 'America/Mexico_City', 'yyyy-MM-dd')
  /** Depósito real del día: $97 de la venta − $39 de la devolución = $58. Y un depósito en efectivo que nada explica ($500). */
  const estadoDeCuenta = () => ({
    buffer: Buffer.from(`fecha,descripcion,abono\n${hoy()},DEPOSITO TERMINAL,58.00\n${hoy()},DEPOSITO EN VENTANILLA,500.00\n`),
    originalname: 'estado.csv',
    mimetype: 'text/csv',
  })
  /** Quien abre con `accounting:reconcile` (lo decide el controlador): la decisión se GUARDA. */
  const conPermiso = () => ({ abiertoPor: f.staffId, puedeGuardar: true })
  const lineas = async (statementId: string) =>
    prisma.bankStatementLine.findMany({ where: { bankStatementId: statementId }, orderBy: { rowIndex: 'asc' } })

  it('el día pendiente no se compara: sus líneas quedan «por decidir» (no «sin conciliar») y se deciden solas al volver a abrir el estado de cuenta ya con la comisión', async () => {
    const { refundId } = await devolucionConComisionPendiente(reembolsoDashboard)

    const subida = await processBankStatement(f.venueId, f.staffId, estadoDeCuenta())
    expect(subida).toMatchObject({ lineCount: 2, matchedCount: 0, pendientesDeCosto: 1, costoSinCalcular: 0, lineasPorDecidir: 2 })
    // Guardadas como «por decidir»: sin calificación (una línea decidida siempre la lleva, 0 si no cuadró).
    for (const l of await lineas(subida.statementId)) {
      expect(l).toMatchObject({ matchStatus: 'UNMATCHED', matchScore: null, matchedKey: null })
    }

    // Abrirlo mientras sigue pendiente: siguen por decidir, y la respuesta lo dice por línea.
    const abierto = await getStatementDetail(f.venueId, subida.statementId, conPermiso())
    expect(abierto.matchedCount).toBe(0)
    expect(abierto.lines.map(l => l.costoPendiente)).toEqual([true, true])
    expect(abierto).toMatchObject({ pendientesDeCosto: 1, costoSinCalcular: 0 })

    // La comisión converge.
    expect(await correrEfectos()).toContain(true)
    expect(Number((await pago(refundId)).netAmount)).toBe(-39)

    // Opción C (FLAUTAS_C, 21-nov): quien sólo puede VER lo ve decidido al vuelo, pero no se escribe NADA.
    const lector = await getStatementDetail(f.venueId, subida.statementId, { abiertoPor: f.staffId, puedeGuardar: false })
    expect(lector.matchedCount).toBe(1)
    expect(lector.lines.map(l => [l.matchStatus, l.matchedKey, l.costoPendiente, Number(l.matchScore)])).toEqual([
      ['MATCHED', hoy(), false, 1],
      ['UNMATCHED', null, false, 0],
    ])
    for (const l of await lineas(subida.statementId)) {
      expect(l).toMatchObject({ matchStatus: 'UNMATCHED', matchScore: null, matchedKey: null })
    }
    expect(await prisma.bankStatement.findUnique({ where: { id: subida.statementId }, select: { matchedCount: true } })).toEqual({
      matchedCount: 0,
    })
    expect(
      await prisma.activityLog.count({
        where: { venueId: f.venueId, entityId: subida.statementId, action: 'RECON_PENDING_LINES_DECIDED' },
      }),
    ).toBe(0)

    // Codex r1 #3: dos aperturas A LA VEZ de quien sí puede conciliar — las dos enseñan lo decidido y se guarda una sola vez.
    const [decidido, alMismoTiempo] = await Promise.all([
      getStatementDetail(f.venueId, subida.statementId, conPermiso()),
      getStatementDetail(f.venueId, subida.statementId, conPermiso()),
    ])
    for (const vista of [decidido, alMismoTiempo]) {
      expect(vista.matchedCount).toBe(1)
      expect(vista.lines.map(l => [l.matchStatus, l.matchedKey, l.costoPendiente])).toEqual([
        ['MATCHED', hoy(), false],
        ['UNMATCHED', null, false],
      ])
      expect(vista.lines.map(l => Number(l.matchScore))).toEqual([1, 0])
      expect(vista).not.toHaveProperty('pendientesDeCosto')
    }
    expect(await prisma.bankStatement.findUnique({ where: { id: subida.statementId }, select: { matchedCount: true } })).toEqual({
      matchedCount: 1,
    })
    // La guarda quien puede conciliar (es la misma sugerencia automática de la subida).
    const bitacora = await prisma.activityLog.findMany({
      where: { venueId: f.venueId, entityId: subida.statementId, action: 'RECON_PENDING_LINES_DECIDED' },
      select: { staffId: true, data: true },
      take: 5,
    })
    expect(bitacora).toEqual([{ staffId: f.staffId, data: { decididas: 2, conciliadas: 1, automatico: true } }])

    // Abrirlo otra vez no cambia nada ni vuelve a registrar.
    const otraVez = await getStatementDetail(f.venueId, subida.statementId, conPermiso())
    expect(otraVez.matchedCount).toBe(1)
    expect(
      await prisma.activityLog.count({
        where: { venueId: f.venueId, entityId: subida.statementId, action: 'RECON_PENDING_LINES_DECIDED' },
      }),
    ).toBe(1)
  })

  it('pasada exhaustiva #2: el abono de $97 NO se pega al día vecino ya firme mientras el día más cercano espera su comisión; con la comisión, se decide con su día', async () => {
    const diaLocal = (atras: number) => formatInTimeZone(new Date(Date.now() - atras * 86_400_000), 'America/Mexico_City', 'yyyy-MM-dd')
    const alMediodia = (ymd: string) => new Date(`${ymd}T18:00:00Z`) // mediodía en la Ciudad de México
    // Antier: un cobro de $100 ya convergido ($97 firmes).
    const antier = await originalConvergido()
    await prisma.payment.update({ where: { id: antier.id }, data: { createdAt: alMediodia(diaLocal(2)) } })
    // Ayer: otro cobro de $100 cuya comisión todavía no se puede calcular ($100 provisional).
    const sinTarifa = jest
      .spyOn(costoDeTransaccion, 'createTransactionCost')
      .mockRejectedValue(new Error('COST_PENDING_AFFILIATION_PRICING_UNRESOLVED: prueba D24 #2'))
    const ayer = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
        merchantAccountId: M2.id,
      },
      f.staffId,
    )
    expect(await asegurarCostoSincrono(ayer.id)).toBe('PENDIENTE')
    await prisma.payment.update({ where: { id: ayer.id }, data: { createdAt: alMediodia(diaLocal(1)) } })

    // Hoy llega al banco un abono de $97: es el de AYER (T+1), no el de antier.
    const subida = await processBankStatement(f.venueId, f.staffId, {
      buffer: Buffer.from(`fecha,descripcion,abono\n${hoy()},DEPOSITO TERMINAL,97.00\n`),
      originalname: 'estado.csv',
      mimetype: 'text/csv',
    })
    expect(subida).toMatchObject({ lineCount: 1, matchedCount: 0, pendientesDeCosto: 1, lineasPorDecidir: 1 })
    const [linea] = await lineas(subida.statementId)
    expect(linea).toMatchObject({ matchStatus: 'UNMATCHED', matchScore: null, matchedKey: null })

    // La comisión de ayer se calcula ($3): al abrir con permiso, el abono se concilia con AYER.
    sinTarifa.mockRestore()
    expect(await asegurarCostoSincrono(ayer.id)).toBe('CUMPLIDA')
    expect(Number((await pago(ayer.id)).netAmount)).toBe(97)
    const decidido = await getStatementDetail(f.venueId, subida.statementId, conPermiso())
    expect(decidido.matchedCount).toBe(1)
    expect(decidido.lines.map(l => [l.matchStatus, l.matchedKey, l.costoPendiente])).toEqual([['MATCHED', diaLocal(1), false]])
  })

  it('sin comisión pendiente, todo igual que antes: el depósito de $58 cuadra al subirlo y nada queda por decidir', async () => {
    await devolucionConComisionPendiente(reembolsoDashboard)
    expect(await correrEfectos()).toContain(true)

    const subida = await processBankStatement(f.venueId, f.staffId, estadoDeCuenta())
    expect(subida).toMatchObject({ lineCount: 2, matchedCount: 1, pendientesDeCosto: 0, costoSinCalcular: 0, lineasPorDecidir: 0 })
    const [deposito, efectivo] = await lineas(subida.statementId)
    expect(deposito).toMatchObject({ matchStatus: 'MATCHED', matchedKey: hoy() })
    expect(Number(deposito.matchScore)).toBe(1)
    expect(efectivo).toMatchObject({ matchStatus: 'UNMATCHED', matchedKey: null })
    expect(Number(efectivo.matchScore)).toBe(0)
  })
})
