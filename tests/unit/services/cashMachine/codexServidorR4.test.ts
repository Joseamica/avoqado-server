/**
 * Máquina de efectivo 1a · ronda 4 de Codex sobre el código del SERVIDOR (`docs/audit/2026-11-17-maquina-de-efectivo/
 * codex-codigo-servidor-r4.md`). UNA prueba por cada caso que Codex reprodujo (F3–F8, F12, F13), con su escenario exacto. F1, F2 y F9
 * no aplican (migraciones aplastadas; nada de la 1a salió de esta rama); F10 va en las devoluciones y F11 en el detalle del turno.
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
import { registrarVenta } from '@/controllers/mobile/cashMachine.mobile.controller'
import {
  consultarDudaDeLaMaquina,
  listarDudasDeLaMaquina,
  resolverDudaDeLaMaquina,
  subirDudaDeLaMaquina,
  type DudaDeLaMaquina,
  type ResolucionDelGerente,
} from '@/services/cashMachine/dudasDeLaMaquina'
import { consultarVentaDeLaMaquina, registrarVentaDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
import { prismaMock } from '../../../__helpers__/setup'
import { CARRITO, GERENTE, PC, REF, VENUE, cierre, lector, prepararArnes, type Arnes } from '../../../__helpers__/arnesDeLaMaquina'

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
const subir = (over: Partial<DudaDeLaMaquina> = {}) => subirDudaDeLaMaquina(VENUE, PC, duda(over), lector)
const resolver = (over: Partial<ResolucionDelGerente> = {}) => resolverDudaDeLaMaquina(VENUE, GERENTE, REF, resolucion(over), lector)
const traba = () => Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } })
const sinBase = () => Object.assign(new Error("Can't reach database server"), { code: 'P1001' })

/** Lo que el controlador manda al servicio: el mismo `req` de la PC (con EL lector real del carrito). */
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

describe('F3 · un carrito congelado que no se puede leer es PERMANENTE: nunca RECIBIDO para siempre', () => {
  it('🔴 el comprobante trae una línea nula: 202 TERMINADO CARRITO_ILEGIBLE con el cierre físico, y el reenvío contesta lo mismo', async () => {
    const cuerpo = { referenceCC: REF, cierre: cierre(), pedido: { ...CARRITO, items: [null] } }
    for (let i = 0; i < 3; i++) {
      const r = res()
      const next = jest.fn()
      await registrarVenta(req(cuerpo), r, next)
      expect(next).not.toHaveBeenCalled()
      expect(r.status).toHaveBeenCalledWith(202)
      expect(r.json.mock.calls[0][0]).toMatchObject({
        ack: 'TERMINADO',
        motivo: 'CARRITO_ILEGIBLE',
        creditCents: 20000,
        changeDispensedCents: 1250,
        owedCents: 0,
      })
    }
    expect(a.base.cierres).toEqual([expect.objectContaining({ outcome: 'PAGADO', motivoSinRegistro: 'CARRITO_ILEGIBLE' })])
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 el reenvío con el carrito corregido NO lo sustituye: el folio ya terminó con lo congelado', async () => {
    await vender(cierre(), { ...CARRITO, items: [null] }).catch(() => undefined)
    const r = res()
    await registrarVenta(req({ referenceCC: REF, cierre: cierre(), pedido: CARRITO }), r, jest.fn())
    expect(r.json.mock.calls[0][0]).toMatchObject({ ack: 'TERMINADO', motivo: 'CARRITO_ILEGIBLE' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('una falla de la BASE al leer el carrito sí es pasajera: RECIBIDO, y el reenvío termina la venta', async () => {
    lector.mockRejectedValueOnce(sinBase())
    expect(await vender()).toMatchObject({ status: 202, body: { ack: 'RECIBIDO', outcome: 'PAGADO' } })
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO', paymentId: 'payment-1' } })
  })

  it('🔴 la venta se cae con algo que no es la base (el carrito congelado rompe al escribir): 202 VENTA_RECHAZADA, nunca RECIBIDO', async () => {
    prismaMock.order.create.mockRejectedValueOnce(
      new Prisma.PrismaClientValidationError('Argument `quantity`: Invalid value provided.', { clientVersion: 'test' }),
    )
    expect(await vender()).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'VENTA_RECHAZADA' } })
    expect(a.base.cierres).toHaveLength(1)
  })
})

describe('F4 · un comprobante legible con el reparto descuadrado nunca se pierde en un 400', () => {
  const descuadrada = { dueCents: 10000, saleCents: 10000, tipCents: 100 }

  it('🔴 la PC vio $50 de $100 (venta $100, propina $1): la duda queda ABIERTA con la evidencia y el gerente la ve', async () => {
    const r = await subir({ ...descuadrada, lastSeen: { credit: 5000 } })
    expect(r).toMatchObject({ status: 'ABIERTO', ack: 'RECIBIDO', deviceId: 'terminal-pc' })
    expect(a.base.observaciones).toHaveLength(1)
    expect(a.base.folios[0]).toMatchObject(descuadrada)
    const [d] = (await listarDudasDeLaMaquina(VENUE, {})).data
    expect(d).toMatchObject({ kind: 'ESPERANDO', status: 'ABIERTO', lastSeen: { credit: 5000 }, ...descuadrada })
  })

  it('🔴 el gerente la resuelve PAGADO: el dinero queda sin venta (REPARTO_DESCUADRADO) y la duda se cierra', async () => {
    await subir({ ...descuadrada, lastSeen: { credit: 5000 } })
    const r = await resolver({ creditCents: 10000, changeDispensedCents: 0, version: a.base.folios[0].version })
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'REPARTO_DESCUADRADO', resolvedBy: 'GERENTE' } })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'RESUELTO' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('o CANCELADO: el cierre físico queda como cualquier cancelación (el reparto no importa sin venta)', async () => {
    await subir({ ...descuadrada, lastSeen: { credit: 5000 } })
    const r = await resolver({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000, cancelMode: '1' })
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO', outcome: 'CANCELADO', owedCents: 0 } })
  })

  it('el cierre de la PC con el reparto descuadrado: 202 TERMINADO REPARTO_DESCUADRADO, nunca 422 ni 400', async () => {
    const r = await vender(cierre({ ...descuadrada, creditCents: 10000, changeDispensedCents: 0 }))
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'REPARTO_DESCUADRADO', owedCents: 0 } })
  })
})

describe('F5 · el gerente sólo firma la versión que vio, y la ve de UNA sola foto', () => {
  it('🔴 la bandeja lee la evidencia y la versión en la MISMA foto (RepeatableRead): nunca «$0, versión 2»', async () => {
    await subir({ lastSeen: { credit: 0 } })
    const foto = structuredClone(a.base)
    await subir({ lastSeen: { credit: 5000 } }) // los $50 entran después de la foto
    const enLaFoto: any = {
      cashMachineIncident: {
        count: jest.fn(async () => foto.incidencias.length),
        findMany: jest.fn(async () => foto.incidencias),
      },
      cashMachineFolio: { findMany: jest.fn(async () => foto.folios) },
    }
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(enLaFoto))
    const [d] = (await listarDudasDeLaMaquina(VENUE, {})).data
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    )
    expect(d).toMatchObject({ lastSeen: { credit: 0 }, version: 1 })
    // Con esa versión, el formulario viejo ya no firma: los $50 llegaron después.
    await expect(
      resolver({ outcome: 'CANCELADO', creditCents: 0, changeDispensedCents: 0, cancelMode: '1', version: d.version as number }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_DOUBT_CHANGED' })
    expect(a.base.cierres).toEqual([])
  })

  it('🔴 una declaración imposible con la versión vieja se rechaza por la versión ANTES de agregar nada', async () => {
    await subir({ lastSeen: { credit: 0 } })
    await subir({ lastSeen: { credit: 5000 } })
    const antes = a.base.observaciones.length
    await expect(resolver({ outcome: 'PAGADO', creditCents: 100, changeDispensedCents: 0, version: 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CHANGED',
    })
    expect(a.base.observaciones).toHaveLength(antes)
    expect(a.base.incidencias.some(i => i.kind === 'IMPOSIBLE')).toBe(false)
    expect(a.base.folios[0].version).toBe(2)
  })
})

describe('F6 · la evidencia física que llega después de resolver vuelve a revisión', () => {
  it('🔴 el gerente cerró CANCELADO en $0; la PC reporta $50 en el mismo folio: queda una revisión ABIERTA y el desenlace no cambia', async () => {
    await subir({ lastSeen: { credit: 0 } })
    expect(await resolver({ outcome: 'CANCELADO', creditCents: 0, changeDispensedCents: 0, cancelMode: '1' })).toMatchObject({
      status: 200,
      body: { outcome: 'CANCELADO' },
    })
    await subir({ lastSeen: { credit: 5000 } })
    const pendientes = (await listarDudasDeLaMaquina(VENUE, { status: 'ABIERTO' })).data
    expect(pendientes).toEqual([
      expect.objectContaining({
        kind: 'CONFLICTO',
        ultimoEvento: null,
        primerEvento: expect.objectContaining({ motivo: 'TRAS_RESOLVER' }),
      }),
    ])
    expect(a.base.cierres).toEqual([expect.objectContaining({ outcome: 'CANCELADO', creditCents: 0 })])
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'RESUELTO', outcome: 'CANCELADO' })
  })

  it('una retransmisión de lo que ya se vio no abre nada', async () => {
    await subir({ lastSeen: { credit: 0 } })
    await resolver({ outcome: 'CANCELADO', creditCents: 0, changeDispensedCents: 0, cancelMode: '1' })
    await subir({ lastSeen: { credit: 0 } })
    expect((await listarDudasDeLaMaquina(VENUE, { status: 'ABIERTO' })).data).toEqual([])
  })
})

describe('F8 · con lo primero ya guardado, cualquier falla contesta RECIBIDO (nunca el RETRY de «no se escribió»)', () => {
  it('🔴 otra petición termina el folio y la relectura de ésta falla: 202 RECIBIDO; el reenvío contesta el TERMINADO guardado', async () => {
    const original = prismaMock.$transaction.getMockImplementation()!
    const lockOriginal = prismaMock.$queryRaw.getMockImplementation()!
    const leerCierre = prismaMock.cashMachineClose.findUnique.getMockImplementation()!
    let ganada = false
    let armada = false
    // Cuando ESTA venta descubre el cierre de la otra (bajo su candado), la base se cae justo para la relectura.
    prismaMock.cashMachineClose.findUnique.mockImplementation(async (q: any) => {
      const fila = await leerCierre(q)
      if (armada && fila) {
        armada = false
        prismaMock.$queryRaw.mockRejectedValue(traba())
      }
      return fila
    })
    prismaMock.$transaction.mockImplementation(async (cb: any, o: any) => {
      if (o?.timeout && !ganada) {
        ganada = true
        armada = true
        // Mientras ésta vende, la OTRA petición ya escribió su cierre.
        a.base.cierres.push({
          ...a.base.folios[0],
          id: 'close-de-la-otra',
          outcome: 'PAGADO',
          resolvedBy: 'MAQUINA',
          resolvedByStaffId: null,
          evidence: null,
          creditCents: 20000,
          changeDispensedCents: 1250,
          appliedCents: 18750,
          excedenteCents: 0,
          owedCents: 0,
          owedKind: null,
          orderId: 'order-otra',
          paymentId: 'payment-otra',
          shiftStatus: 'EN_TURNO',
          occurredAt: new Date('2026-11-20T18:00:00.000Z'),
          occurredAtKnown: true,
          motivoSinRegistro: null,
        })
      }
      return original(cb, o)
    })
    const r1 = await vender()
    expect(r1).toEqual({ status: 202, body: { ack: 'RECIBIDO', referenceCC: REF, deviceId: 'terminal-pc', outcome: 'PAGADO' } })
    expect(armada).toBe(false) // sí llegó a la relectura (no se cayó antes)
    prismaMock.$queryRaw.mockImplementation(lockOriginal)
    prismaMock.$transaction.mockImplementation(original)
    prismaMock.cashMachineClose.findUnique.mockImplementation(leerCierre)
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO', paymentId: 'payment-otra' } })
  })

  it('🔴 la lectura del turno falla DESPUÉS de guardar el comprobante: 202 RECIBIDO (no el error de base); el reenvío termina', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    expect(await vender()).toMatchObject({ status: 202, body: { ack: 'RECIBIDO', outcome: 'PAGADO' } })
    expect(await consultarVentaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 202, body: { ack: 'RECIBIDO' } })
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('RETRY sólo si la PRIMERA escritura no se hizo', async () => {
    prismaMock.$queryRaw.mockRejectedValue(traba())
    await expect(vender()).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_CLOSE_RETRY' })
    expect(a.base.observaciones).toEqual([])
  })
})

describe('F12 · el primer mensaje congela el folio aunque su cierre sea imposible', () => {
  it('🔴 el carrito de Ana con premio y un cierre imposible; corregido y reenviado con otro carrito sin premio: sale de lo congelado → PREMIO_PENDIENTE', async () => {
    const deAna = { ...CARRITO, customerId: 'ana', stampRewardId: 'premio-ana' }
    await expect(vender(cierre({ creditCents: 10000, changeDispensedCents: 0 }), deAna)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    expect(a.base.folios).toEqual([
      expect.objectContaining({ pedido: deAna, deviceId: 'terminal-pc', saleShiftId: 'shift-A', decision: null }),
    ])
    const r = await vender(cierre(), { ...CARRITO, customerId: 'otra' })
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'PREMIO_PENDIENTE' } })
    expect(lector).toHaveBeenLastCalledWith(deAna, PC.userId)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('otros importes después de un primer mensaje imposible son conflicto, nunca sustitución', async () => {
    await expect(vender(cierre({ creditCents: 10000, changeDispensedCents: 0 }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(vender(cierre({ dueCents: 20000, saleCents: 20000, creditCents: 20000, changeDispensedCents: 0 }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
    expect(a.base.folios[0]).toMatchObject({ dueCents: 18750 })
  })
})

describe('F13 · la misma hora con otra zona es la MISMA evidencia', () => {
  it('🔴 la duda se reenvía con 17:58Z como 11:58-06:00: una observación, versión 1, y el gerente resuelve con la versión 1', async () => {
    await subir({ startedAt: '2026-11-20T17:58:00.000Z' })
    await subir({ startedAt: '2026-11-20T11:58:00.000-06:00' })
    expect(a.base.observaciones).toHaveLength(1)
    expect(a.base.folios[0].version).toBe(1)
    expect(await resolver({ version: 1 })).toMatchObject({ status: 200, body: { resolvedBy: 'GERENTE' } })
  })

  it('el cierre con la hora en otra zona es retransmisión, sin discrepancia', async () => {
    await vender(cierre({ occurredAt: '2026-11-20T18:00:00.000Z' }))
    await vender(cierre({ occurredAt: '2026-11-20T12:00:00.000-06:00' }))
    expect(a.base.observaciones).toHaveLength(1)
    expect(a.base.incidencias).toEqual([])
  })
})
