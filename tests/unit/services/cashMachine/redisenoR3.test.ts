/**
 * Máquina de efectivo 1a · rediseño tras la ronda 3 de Codex sobre el código (`codex-codigo-servidor-r3.md`) y sus ajustes
 * (`codex-r6.md`). UNA prueba por cada caso que Codex reprodujo en r3 (#1, #2, #3, #5, #6, #7, #9, #10, #11; #4 y #12 son de
 * devoluciones y #8 del turno: van en sus archivos) y por cada ajuste de r6 (1–6; 7 devoluciones, 8 turno), con su escenario exacto.
 *
 * Corre el núcleo real contra el doble de Prisma, con las tablas de la máquina en memoria (una transacción que truena se deshace).
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  resolvePaymentShiftReconciliationEnabled: jest.fn().mockResolvedValue(false),
}))

import { Prisma } from '@prisma/client'
import { registrarVenta, subirDuda } from '@/controllers/mobile/cashMachine.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  consultarDudaDeLaMaquina,
  listarDudasDeLaMaquina,
  resolverDudaDeLaMaquina,
  revisarIncidenciaDeLaMaquina,
  subirDudaDeLaMaquina,
  type DudaDeLaMaquina,
  type ResolucionDelGerente,
} from '@/services/cashMachine/dudasDeLaMaquina'
import { consultarVentaDeLaMaquina, registrarVentaDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
import { emparejarAparato } from '@/services/cashMachine/emparejamiento'
import { prismaMock } from '../../../__helpers__/setup'
import { CARRITO, GERENTE, PC, PC_B, REF, VENUE, cierre, lector, prepararArnes, type Arnes } from '../../../__helpers__/arnesDeLaMaquina'

let a: Arnes
beforeEach(() => {
  jest.clearAllMocks()
  a = prepararArnes(prismaMock)
})

const duda = (over: Partial<DudaDeLaMaquina> = {}): DudaDeLaMaquina => ({
  referenceCC: REF,
  dueCents: 18750,
  saleCents: 18750,
  tipCents: 0,
  pedido: CARRITO,
  startedAt: '2026-11-20T17:58:00.000Z',
  lastSeen: { credit: 0 },
  saleShiftId: 'shift-A',
  ...over,
})
const resolucion = (over: Partial<ResolucionDelGerente> = {}): ResolucionDelGerente => ({
  outcome: 'PAGADO',
  creditCents: 20000,
  changeDispensedCents: 1250,
  occurredAt: '2026-11-20T18:00:00.000Z',
  evidence: 'Pago Completado $187.50',
  version: 1,
  ...over,
})
const vender = (c = cierre(), pedido: unknown = CARRITO, autor = PC) =>
  registrarVentaDeLaMaquina(VENUE, autor, { referenceCC: REF, cierre: c, pedido }, lector)
const subir = (over: Partial<DudaDeLaMaquina> = {}, autor = PC) => subirDudaDeLaMaquina(VENUE, autor, duda(over), lector)
const resolver = (over: Partial<ResolucionDelGerente> = {}, gerente = GERENTE) =>
  resolverDudaDeLaMaquina(VENUE, gerente, REF, resolucion(over), lector)
const acciones = () => (logAction as jest.Mock).mock.calls.map(c => c[0].action)

/** Lo que el controlador manda al servicio: el mismo `req` de la PC. */
const req = (body: unknown) =>
  ({
    params: { venueId: VENUE },
    body,
    headers: { 'x-device-id': 'pc-uid-1', 'x-device-platform': 'DESKTOP', 'x-cash-machine-credential': PC.credencial },
    authContext: { userId: PC.userId, venueId: VENUE, role: 'CASHIER' },
  }) as any
const res = () => {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r), set: jest.fn(() => r) }
  return r
}

describe('r3 #1 · un comprobante válido con el carrito ilegible nunca es 400 (D1)', () => {
  it('🔴 la venta: el POST del controlador con carrito vacío guarda la evidencia y contesta 202 TERMINADO con su incidencia', async () => {
    const r = res()
    const next = jest.fn()
    await registrarVenta(req({ referenceCC: REF, cierre: cierre(), pedido: {} }), r, next)
    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(202)
    expect(r.json.mock.calls[0][0]).toMatchObject({
      ack: 'TERMINADO',
      deviceId: 'terminal-pc',
      incident: 'NO_SE_PUDO_REGISTRAR',
      motivo: 'CARRITO_ILEGIBLE',
      creditCents: 20000,
      changeDispensedCents: 1250,
    })
    expect(r.json.mock.calls[0][0].incidentId).toEqual(expect.any(String))
    expect(a.base.observaciones).toHaveLength(1)
    expect(a.base.folios[0]).toMatchObject({ referenceCC: REF, pedido: {}, deviceId: 'terminal-pc' })
    expect(a.base.cierres[0]).toMatchObject({ outcome: 'PAGADO', motivoSinRegistro: 'CARRITO_ILEGIBLE', paymentId: null })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 la duda: el POST del controlador con carrito vacío la guarda ABIERTA (no 400), y el GET sigue diciendo ABIERTO', async () => {
    const r = res()
    const next = jest.fn()
    await subirDuda(req({ ...duda(), pedido: {} }), r, next)
    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(200)
    expect(r.json.mock.calls[0][0]).toMatchObject({ status: 'ABIERTO', ack: 'RECIBIDO', deviceId: 'terminal-pc' })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'ABIERTO', ack: 'RECIBIDO' })
  })
})

describe('r3 #2 · el reenvío no sustituye al cliente ni quita el premio del carrito congelado (D2)', () => {
  it('🔴 la duda congeló a Ana con su premio; el cierre llega con otra clienta y sin premio: la venta sale de lo congelado → 202 PREMIO_PENDIENTE', async () => {
    const deAna = { ...CARRITO, customerId: 'ana', stampRewardId: 'premio-ana' }
    await subir({ pedido: deAna })
    const r = await vender(cierre(), { ...CARRITO, customerId: 'otra' })
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'PREMIO_PENDIENTE' } })
    expect(lector).toHaveBeenLastCalledWith(deAna, PC.userId)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    // La discrepancia queda para revisión, nunca como sustitución.
    expect(a.base.incidencias.find(i => i.kind === 'CONFLICTO')?.payload.eventos[0]).toMatchObject({ motivo: 'DISCREPANCIA' })
  })
})

describe('r3 #3 · el mismo folio nunca cae en el turno vivo equivocado (D2)', () => {
  it('🔴 la duda se subió con A; A terminó 17:00, el comprobante dice 17:05 y el reenvío trae B: POR_CONCILIAR, nunca B', async () => {
    a.turnoA = {
      id: 'shift-A',
      status: 'CLOSED',
      startTime: new Date('2026-11-20T14:00:00.000Z'),
      endTime: new Date('2026-11-20T17:00:00.000Z'),
    }
    await subir({ saleShiftId: 'shift-A' })
    const r = await vender(cierre({ saleShiftId: 'shift-B', occurredAt: '2026-11-20T17:05:00.000Z' }))
    expect(r).toMatchObject({ status: 200, body: { shiftStatus: 'POR_CONCILIAR' } })
    expect(a.base.cierres[0]).toMatchObject({ saleShiftId: 'shift-A', shiftStatus: 'POR_CONCILIAR' })
    expect(prismaMock.payment.create.mock.calls[0][0].data.shiftId ?? null).not.toBe('shift-B')
    expect(a.base.incidencias.find(i => i.kind === 'CONFLICTO')?.payload.eventos[0]).toMatchObject({
      saleShiftId: 'shift-B',
      motivo: 'DISCREPANCIA',
    })
  })
})

describe('r3 #5 · el 202 dice el cambio que la máquina comprobablemente debe (D1)', () => {
  it('🔴 $100 de compra, $150 recibidos, $0 entregados y la venta no se arma: 202 con owedKind CAMBIO y $50, y su cierre lo cuenta UNA vez', async () => {
    a.subtotal.pesos = 100
    const r = await vender(cierre({ dueCents: 10000, saleCents: 10000, creditCents: 15000, changeDispensedCents: 0 }), {
      ...CARRITO,
      couponCode: 'X',
    })
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', owedKind: 'CAMBIO', owedCents: 5000 } })
    // El MCP «con deuda» lee los cierres: el folio sin venta está ahí, con su deuda, una sola vez.
    expect(a.base.cierres.filter(c => c.owedCents > 0)).toHaveLength(1)
  })
})

describe('r3 #6 · rechazo permanente contra reintento', () => {
  it('🔴 la llave del folio ya es de otra cuenta: 202 TERMINADO LLAVE_OCUPADA con su incidencia, nunca el 409 que la PC repetiría siempre', async () => {
    prismaMock.order.findUnique.mockImplementation(async (q: any) =>
      q?.where?.venueId_externalId ? { id: 'otra-cuenta', items: [], promotions: [] } : null,
    )
    const r = await vender()
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'LLAVE_OCUPADA' } })
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['NO_SE_PUDO_REGISTRAR'])
  })

  it('🔴 un interbloqueo agotado en la PRIMERA transacción: 409 CASH_MACHINE_CLOSE_RETRY y nada escrito', async () => {
    const traba = Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } })
    prismaMock.$queryRaw.mockRejectedValue(traba)
    await expect(vender()).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_CLOSE_RETRY' })
    expect(a.base.observaciones).toEqual([])
    expect(a.base.folios).toEqual([])
  })
})

describe('r3 #7 · el acuse trae el aparato dueño: una PC nunca retira el pendiente de otra (D3)', () => {
  it('🔴 A registró el folio; B (con su credencial revocada) manda lo mismo: 409 con el dueño, y el GET de B también dice que es de A', async () => {
    await vender()
    await expect(vender(cierre(), CARRITO, PC_B)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
      details: expect.objectContaining({ motivo: 'OTRA_PC', deviceId: 'terminal-pc', registrado: null }),
    })
    const get = await consultarVentaDeLaMaquina(VENUE, REF)
    expect(get.body).toMatchObject({ ack: 'TERMINADO', deviceId: 'terminal-pc' })
  })
})

describe('r3 #9 · dos carritos en conflicto son dos evidencias (D2, r6-3)', () => {
  it('🔴 folio de $100; llegan dos versiones de $110 con mercancía distinta: la segunda reabre la revisada y sube la versión', async () => {
    a.subtotal.pesos = 100
    await subir({ dueCents: 10000, saleCents: 10000, tipCents: 0 })
    const de110 = (items: unknown) =>
      vender(cierre({ dueCents: 11000, saleCents: 11000, creditCents: 11000, changeDispensedCents: 0 }), { ...CARRITO, items })
    await expect(de110([{ name: 'A', quantity: 1, unitPrice: 11000 }])).rejects.toMatchObject({ statusCode: 409 })
    const conflicto = () => a.base.incidencias.find(i => i.kind === 'CONFLICTO')!
    expect(conflicto().payload.version).toBe(1)
    await revisarIncidenciaDeLaMaquina(VENUE, GERENTE, conflicto().id, 'visto', 1)
    expect(conflicto().status).toBe('RESUELTO')
    await expect(de110([{ name: 'B', quantity: 1, unitPrice: 11000 }])).rejects.toMatchObject({ statusCode: 409 })
    expect(conflicto()).toMatchObject({ status: 'ABIERTO', payload: expect.objectContaining({ version: 2 }) })
  })
})

describe('r3 #10 · la hora nueva y el crédito recién visto no desaparecen (D2)', () => {
  it('🔴 después de un 202 el gerente aporta la hora que faltaba: queda para conciliar, misma respuesta, la venta no se toca', async () => {
    await subir({ pedido: { ...CARRITO, couponCode: 'X' } })
    const primero = await resolver({ occurredAt: null })
    expect(primero).toMatchObject({ status: 202, body: { motivo: 'DESCUENTO' } })
    const version = a.base.folios[0].version
    const segundo = await resolver({ occurredAt: '2026-11-20T18:00:00.000Z', version })
    expect(segundo).toEqual(primero)
    expect(a.base.cierres).toHaveLength(1)
    expect(a.base.observaciones.some(o => o.payload.occurredAt === '2026-11-20T18:00:00.000Z')).toBe(true)
    expect(a.base.incidencias.find(i => i.kind === 'CONFLICTO')).toMatchObject({ status: 'ABIERTO' })
  })

  it('🔴 con la duda abierta la PC vio $0 y luego $50: la segunda observación queda, sube la versión y la bandeja enseña $50', async () => {
    await subir({ lastSeen: { credit: 0 } })
    await subir({ lastSeen: { credit: 5000 } })
    expect(a.base.observaciones).toHaveLength(2)
    const [d] = (await listarDudasDeLaMaquina(VENUE, {})).data
    expect(d).toMatchObject({ kind: 'ESPERANDO', lastSeen: { credit: 5000 }, version: 2 })
  })
})

describe('r3 #11 · la resolución se anuncia una vez, por quien cambió la fila (D4)', () => {
  it('🔴 dos gerentes confirman el mismo comprobante leyendo la misma versión: un ganador y UN aviso de resolución', async () => {
    await subir()
    await resolver({}, 'gerente-1')
    await resolver({}, 'gerente-2')
    const avisos = (logAction as jest.Mock).mock.calls.filter(c => c[0].action === 'CASH_MACHINE_DOUBT_RESOLVED')
    expect(avisos).toHaveLength(1)
    expect(avisos[0][0].staffId).toBe('gerente-1')
    expect(a.base.cierres).toHaveLength(1)
  })
})

describe('r6-1 · RECIBIDO no es TERMINADO: el reenvío reanuda la venta desde lo congelado', () => {
  it('🔴 la venta falla por algo transitorio tras guardar la evidencia: 202 RECIBIDO (no RETRY), el GET dice RECIBIDO y el reenvío termina con UN pago', async () => {
    const original = prismaMock.$transaction.getMockImplementation()!
    let caida = false
    prismaMock.$transaction.mockImplementation(async (cb: any, o: any) => {
      // La transacción de la VENTA (la que abre con el presupuesto del candado de la cuenta) se cae una vez: el proceso «muere».
      if (o?.timeout && !caida) {
        caida = true
        throw Object.assign(new Error('Transaction already closed'), { code: 'P2028' })
      }
      return original(cb, o)
    })
    const r1 = await vender()
    expect(r1).toEqual({ status: 202, body: { ack: 'RECIBIDO', referenceCC: REF, deviceId: 'terminal-pc', outcome: 'PAGADO' } })
    expect(a.base.folios[0].decision).toMatchObject({ resolvedBy: 'MAQUINA', cierre: { outcome: 'PAGADO' } })
    expect(a.base.cierres).toEqual([])
    expect(await consultarVentaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 202, body: { ack: 'RECIBIDO' } })
    const r2 = await vender()
    expect(r2).toMatchObject({ status: 200, body: { ack: 'TERMINADO', deviceId: 'terminal-pc', paymentId: 'payment-1' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(a.base.observaciones).toHaveLength(1)
  })
})

describe('r6-2 · una duda nunca se vuelve desenlace por un carrito roto', () => {
  it('🔴 la PC vio $50 de $100 y perdió el aviso, con el carrito roto: la duda sigue ABIERTA (bloquea) y el gerente entra por la misma escritura', async () => {
    a.subtotal.pesos = 100
    await subir({ dueCents: 10000, saleCents: 10000, pedido: { roto: true }, lastSeen: { credit: 5000 } })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'ABIERTO' })
    expect(a.base.cierres).toEqual([])
    const r = await resolver({ creditCents: 10000, changeDispensedCents: 0, version: a.base.folios[0].version })
    // Primero se guardó su declaración, después se leyó el carrito: el dinero queda sin venta y la duda se cierra.
    expect(a.base.observaciones.some(o => o.payload.origen === 'GERENTE')).toBe(true)
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'CARRITO_ILEGIBLE', resolvedBy: 'GERENTE' } })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'RESUELTO', motivo: 'CARRITO_ILEGIBLE' })
  })

  it('un CANCELADO válido del gerente no necesita carrito', async () => {
    await subir({ pedido: undefined })
    const r = await resolver({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000, cancelMode: '1' })
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO', outcome: 'CANCELADO', owedCents: 0 } })
  })
})

describe('r6-3 · la huella completa, contra TODO el historial', () => {
  it('🔴 GUARDADO y luego CANCELADO con las mismas cifras: el segundo es conflicto (409), nunca la misma operación', async () => {
    const guardado = cierre({ outcome: 'GUARDADO', creditCents: 5000, changeDispensedCents: 0, cancelMode: '2' })
    expect(await vender(guardado, undefined)).toMatchObject({ status: 200, body: { owedKind: 'GUARDADO', owedCents: 5000 } })
    const cancelado = cierre({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 0, cancelMode: '1' })
    await expect(vender(cancelado, undefined)).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_CLOSE_CONFLICT' })
    expect(a.base.cierres).toHaveLength(1)
  })

  it('🔴 A–B–A son DOS observaciones, y 52 distintas son 52 (sin tope que pierda la penúltima)', async () => {
    await subir({ lastSeen: 'A' })
    await subir({ lastSeen: 'B' })
    await subir({ lastSeen: 'A' })
    expect(a.base.observaciones).toHaveLength(2)
    expect(a.base.folios[0].version).toBe(2)
    for (let i = 0; i < 50; i++) await subir({ lastSeen: `vista-${i}` })
    expect(a.base.observaciones).toHaveLength(52)
    expect(a.base.folios[0].version).toBe(52)
  })
})

describe('r6-4 · el gerente resuelve con la versión que vio', () => {
  it('🔴 abrió la duda en $0; entra una observación de $50; confirma el formulario viejo: 409 CASH_MACHINE_DOUBT_CHANGED y nada escrito', async () => {
    await subir({ lastSeen: { credit: 0 } })
    const vista = a.base.folios[0].version
    await subir({ lastSeen: { credit: 5000 } })
    await expect(
      resolver({ outcome: 'CANCELADO', creditCents: 0, changeDispensedCents: 0, cancelMode: '1', version: vista }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CHANGED',
      details: { version: vista + 1 },
    })
    expect(a.base.cierres).toEqual([])
    expect(a.base.observaciones.some(o => o.payload.origen === 'GERENTE')).toBe(false)
    expect(acciones()).not.toContain('CASH_MACHINE_DOUBT_RESOLVED')
    // Con la versión actual, sí.
    expect(await resolver({ version: vista + 1 })).toMatchObject({ status: 200, body: { resolvedBy: 'GERENTE' } })
  })
})

describe('r6-5 · una sola PC activa por negocio', () => {
  it('🔴 emparejar otra PC (otra IP) revoca la anterior en la misma transacción, bajo el MISMO candado del negocio', async () => {
    const r = await emparejarAparato(VENUE, { userId: GERENTE, deviceUid: 'pc-uid-2' }, '192.168.1.99')
    expect(a.base.vinculos.filter(v => v.active)).toEqual([expect.objectContaining({ id: r.bindingId, deviceId: 'terminal-pc-B' })])
    expect(r.replaced).toEqual([{ deviceId: 'terminal-pc', machineIp: '192.168.1.50' }])
    const candados = prismaMock.$queryRaw.mock.calls
      .map((c: any[]) => JSON.stringify(c[0]))
      .filter((s: string) => s.includes('cash-machine-binding'))
    expect(new Set(candados).size).toBe(1)
  })
})

describe('regresión: un PAGADO normal sigue igual', () => {
  it('18750 centavos → Payment.amount 187.50, con el acuse TERMINADO y su dueño', async () => {
    const r = await vender()
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO', deviceId: 'terminal-pc', owedKind: null, owedCents: 0 } })
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({
      amount: 187.5,
      cashMachineRef: REF,
      fundsFlow: 'EXTERNAL_RECORDED',
    })
    expect(new Prisma.Decimal(prismaMock.payment.create.mock.calls[0][0].data.amount).toFixed(2)).toBe('187.50')
  })
})
