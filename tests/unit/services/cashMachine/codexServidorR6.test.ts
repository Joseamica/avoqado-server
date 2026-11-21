/**
 * Máquina de efectivo 1a · recorte del founder («a», 21-nov) y ronda 6 de Codex sobre el código del SERVIDOR
 * (`docs/audit/2026-11-17-maquina-de-efectivo/codex-codigo-servidor-r6.md`). UNA prueba por caso, con su escenario exacto:
 *  · R1: no se cambia de PC con cobros a medias; un RECIBIDO atascado sale en la bandeja a los 10 min y el gerente lo termina.
 *    r6 #3 (fecha sin hora) y #5 (relevo con 500 folios / carrera) desaparecen: ver `ventaDeLaMaquina.test.ts` y el R1 de aquí.
 *  · r6 #1, #2, #4, #6, #7, #8 y #9 (los que pierden dinero, cobran doble o registran otro importe).
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
import { registrarVentaDeLaMaquinaSchema } from '@/schemas/mobile/cashMachine.schema'
import { emparejarAparato } from '@/services/cashMachine/emparejamiento'
import {
  consultarDudaDeLaMaquina,
  listarDudasDeLaMaquina,
  resolverDudaDeLaMaquina,
  subirDudaDeLaMaquina,
  type DudaDeLaMaquina,
  type ResolucionDelGerente,
} from '@/services/cashMachine/dudasDeLaMaquina'
import { RECIBIDO_ATASCADO_MS, registrarVentaDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
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
const vender = (c = cierre(), pedido: unknown = CARRITO, autor = PC) =>
  registrarVentaDeLaMaquina(VENUE, autor, { referenceCC: REF, cierre: c, pedido }, lector)
const subir = (over: Partial<DudaDeLaMaquina> = {}, autor = PC) => subirDudaDeLaMaquina(VENUE, autor, duda(over), lector)
const resolver = (r: ResolucionDelGerente) => resolverDudaDeLaMaquina(VENUE, GERENTE, REF, r, lector)
const sinBase = () => Object.assign(new Error("Can't reach database server"), { code: 'P1001' })
const UN_NEGOCIO = 'cjld2cjxh0000qzrmn831i7rn'
const porTerminar = () => a.base.incidencias.find(i => i.kind === 'POR_TERMINAR')
/** El RECIBIDO lleva más de 10 min sin terminar. */
const envejecer = () => {
  porTerminar()!.createdAt = new Date(Date.now() - RECIBIDO_ATASCADO_MS - 1000)
}
const bandeja = async (kind?: string) => (await listarDudasDeLaMaquina(VENUE, { kind })).data

describe('R1 · cambiar de PC sólo sin cobros a medias', () => {
  it('🔴 con un desenlace RECIBIDO, otra PC no se empareja (409 con el folio) y la PC de siempre sigue siendo la habilitada', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    expect(await vender()).toMatchObject({ status: 202, body: { ack: 'RECIBIDO' } })
    await expect(emparejarAparato(VENUE, { userId: GERENTE, deviceUid: 'pc-uid-2' }, '192.168.1.50')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_FOLIOS_PENDING',
      details: { count: 1, folios: [{ referenceCC: REF, kind: 'POR_TERMINAR' }] },
    })
    expect(a.base.vinculos.filter(v => v.active).map(v => v.id)).toEqual(['b1'])
    // La PC termina la venta con su reenvío; ya no hay nada a medias y el relevo pasa.
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect(porTerminar()).toBeUndefined()
    await expect(emparejarAparato(VENUE, { userId: GERENTE, deviceUid: 'pc-uid-2' }, '192.168.1.50')).resolves.toMatchObject({
      replaced: [{ deviceId: 'terminal-pc' }],
    })
  })

  it('🔴 r6 #5: un RECIBIDO atascado sale como POR_TERMINAR a los 10 min aunque su PC siga activa, y el gerente lo termina con UN pago', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    await vender()
    // Recién recibido: lo termina la PC sola; todavía no es del gerente.
    expect(await bandeja('POR_TERMINAR')).toEqual([])
    envejecer()
    const [p] = await bandeja('POR_TERMINAR')
    expect(p).toMatchObject({ status: 'ABIERTO', outcome: 'PAGADO', creditCents: 20000, dueCents: 18750, version: 1 })
    expect(a.base.vinculos[0]).toMatchObject({ id: 'b1', active: true })
    expect(await resolver({ version: p.version as number })).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(porTerminar()).toMatchObject({ status: 'RESUELTO', resolvedByStaffId: GERENTE })
    // El reenvío de la PC contesta lo mismo: nunca un segundo pago.
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('el desenlace que termina en el acto no deja nada en la bandeja ni frena el relevo', async () => {
    expect(await vender()).toMatchObject({ status: 200 })
    expect(a.base.incidencias).toEqual([])
  })
})

describe('r6 #1 · lo MÁS que entró en el folio manda, también lo de antes de la duda', () => {
  it('🔴 un cierre de $100 (422) y luego una duda de $0: la bandeja enseña $100 y el gerente no puede cerrar en $0', async () => {
    await expect(vender(cierre({ creditCents: 10000, changeDispensedCents: 0 }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    expect(await subir({ creditCents: 0, lastSeen: { credit: 0 } })).toMatchObject({ status: 'ABIERTO' })
    const [d] = await bandeja('ESPERANDO')
    expect(d).toMatchObject({ creditCents: 10000, version: 2 })
    await expect(
      resolver({
        outcome: 'CANCELADO',
        creditCents: 0,
        changeDispensedCents: 0,
        cancelMode: '1',
        evidence: 'Transacción Cancelada',
        version: d.version as number,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_CREDIT_BELOW_SEEN', details: { creditCents: 10000 } })
    expect(a.base.cierres).toEqual([])
    expect(a.base.folios[0].decision).toBeNull()
    const r = await resolver({
      outcome: 'CANCELADO',
      creditCents: 10000,
      changeDispensedCents: 10000,
      cancelMode: '1',
      evidence: 'Transacción Cancelada, devolvió $100',
      version: d.version as number,
    })
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO', outcome: 'CANCELADO', creditCents: 10000 } })
  })

  it('🔴 un reenvío tardío con menos no tapa al mayor: ni lo que entró ni lo último que vio la PC', async () => {
    await subir({ creditCents: 5000, lastSeen: 'Entró $50.00' })
    await subir({ creditCents: 0, lastSeen: 'Entró $0.00 (llegó tarde)' })
    expect((await bandeja('ESPERANDO'))[0]).toMatchObject({ creditCents: 5000, lastSeen: 'Entró $50.00', version: 2 })
  })
})

describe('r6 #2 · el gerente nunca termina con una versión vencida', () => {
  it('🔴 abre el POR_TERMINAR en versión 1; entra evidencia mientras se lee el carrito: 409 y ningún cierre; con la nueva, un solo cierre', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    await vender()
    envejecer()
    const [p] = await bandeja('POR_TERMINAR')
    expect(p.version).toBe(1)
    const real = lector.getMockImplementation()!
    lector.mockImplementationOnce(async (crudo, vendedor) => {
      // La PC reenvía con la hora distinta (evidencia nueva, versión 2) y su venta vuelve a fallar: el folio sigue RECIBIDO.
      prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
      expect(await vender(cierre({ occurredAt: '2026-11-20T18:01:00.000Z' }))).toMatchObject({ body: { ack: 'RECIBIDO' } })
      return real(crudo, vendedor)
    })
    await expect(resolver({ version: 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CHANGED',
      details: { version: 2 },
    })
    expect(a.base.cierres).toEqual([])
    expect(porTerminar()).toMatchObject({ status: 'ABIERTO' })
    expect(await resolver({ version: 2 })).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect(a.base.cierres).toHaveLength(1)
  })
})

describe('r6 #4 · lo de OTRA PC no cambia la duda de la dueña', () => {
  it('🔴 B recibe 409 OTRA_PC con su duda y su cierre de $50; la bandeja sigue en $0 y en la versión 1', async () => {
    await subir({ creditCents: 0, lastSeen: { credit: 0 } })
    await expect(subir({ creditCents: 5000, lastSeen: { credit: 5000 } }, PC_B)).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ motivo: 'OTRA_PC' }),
    })
    await expect(
      vender(cierre({ creditCents: 5000, changeDispensedCents: 0, outcome: 'CANCELADO', cancelMode: '1' }), CARRITO, PC_B),
    ).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ motivo: 'OTRA_PC' }) })
    expect((await bandeja('ESPERANDO'))[0]).toMatchObject({ creditCents: 0, lastSeen: { credit: 0 }, version: 1, deviceId: 'terminal-pc' })
    // Su evidencia no se pierde: va a su conflicto.
    expect(a.base.incidencias.find(i => i.kind === 'CONFLICTO')).toMatchObject({ status: 'ABIERTO' })
  })
})

describe('r6 #6 · lo que el POST contesta ABIERTO, el GET lo encuentra', () => {
  it('🔴 desenlace RECIBIDO, llega una duda atrasada y la venta vuelve a fallar: ABIERTO con incidentId, y el GET lo mismo (nunca 404)', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    await vender()
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    const r = await subir()
    expect(r).toMatchObject({ status: 'ABIERTO', ack: 'RECIBIDO', incidentId: porTerminar()!.id })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'ABIERTO', incidentId: porTerminar()!.id })
    // Y cuando termina, el GET dice RESUELTO.
    expect(await vender()).toMatchObject({ status: 200 })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'RESUELTO', ack: 'TERMINADO' })
  })
})

describe('r6 #7 · un choque de llave única que NO es del folio es permanente', () => {
  it('🔴 la reserva ya tiene su venta: el índice rechaza la orden → 202 TERMINADO VENTA_RECHAZADA con el dinero; el reenvío contesta lo mismo', async () => {
    const choqueDeLaReserva = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`reservationId`)', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'Order_reservation_alive_key' },
      })
    prismaMock.order.create.mockRejectedValueOnce(choqueDeLaReserva()).mockRejectedValueOnce(choqueDeLaReserva())
    const r = await vender()
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'VENTA_RECHAZADA', creditCents: 20000, owedCents: 0 } })
    expect(a.base.cierres).toEqual([expect.objectContaining({ motivoSinRegistro: 'VENTA_RECHAZADA', creditCents: 20000, paymentId: null })])
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['NO_SE_PUDO_REGISTRAR'])
    await expect(vender()).resolves.toEqual(r)
  })
})

describe('r6 #8 · cualquier desenlace pasa la ruta y queda como IMPOSIBLE con su dinero', () => {
  it.each([
    ['un texto largo', 'Pago con incidencia: '.repeat(400)],
    ['un número', 42],
    ['nada', undefined],
  ])('🔴 %s: la ruta lo acepta, 422 con incidencia y el desenlace TAL CUAL', async (_n, outcome) => {
    const cuerpo = { referenceCC: REF, cierre: { ...cierre(), outcome }, pedido: CARRITO }
    expect(registrarVentaDeLaMaquinaSchema.safeParse({ params: { venueId: UN_NEGOCIO }, body: cuerpo }).success).toBe(true)
    await expect(registrarVentaDeLaMaquina(VENUE, PC, cuerpo as never, lector)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      details: { incidentId: expect.any(String) },
    })
    expect(a.base.observaciones[0].payload).toMatchObject({ outcome: outcome ?? null, creditCents: 20000 })
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['IMPOSIBLE'])
  })
})

describe('r6 #9 · la huella se calcula sobre el mensaje COMPLETO y el crédito crudo', () => {
  it('🔴 dos lastSeen con el mismo comienzo largo y distinto final son DOS observaciones (y se guardan completos)', async () => {
    const largo = 'x'.repeat(20_000)
    await subir({ lastSeen: `${largo}A` })
    await subir({ lastSeen: `${largo}B` })
    expect(a.base.observaciones).toHaveLength(2)
    expect(a.base.folios[0].version).toBe(2)
    expect((a.base.observaciones[1].payload.lastSeen as string).length).toBe(20_001)
    // La bandeja lo enseña cortado a 16 KB.
    expect(((await bandeja('ESPERANDO'))[0].lastSeen as string).length).toBe(16_384)
  })

  it('🔴 dos créditos con fracción distinta (5000.25 y 5000.5) son DOS observaciones', async () => {
    await subir({ creditCents: 5000.25 })
    await subir({ creditCents: 5000.5 })
    expect(a.base.observaciones.map(o => o.payload.creditCents)).toEqual([5000.25, 5000.5])
    expect(a.base.folios[0].version).toBe(2)
  })
})
