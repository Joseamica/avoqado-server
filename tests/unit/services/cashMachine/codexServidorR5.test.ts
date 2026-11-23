/**
 * Máquina de efectivo 1a · ronda 5 de Codex sobre el código del SERVIDOR (`docs/audit/2026-11-17-maquina-de-efectivo/
 * codex-codigo-servidor-r5.md`). UNA prueba por cada caso que Codex reprodujo (H1–H6), con su escenario exacto. H7 va en las
 * devoluciones (`destinoDelReembolso.refund.test.ts`, `issue-refund.test.ts`) y H8 en el detalle del turno.
 *
 * H5 y H6 los reemplazó el recorte R1 (21-nov): `codexServidorR6.test.ts`.
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

import { registrarVentaDeLaMaquinaSchema, subirDudaDeLaMaquinaSchema } from '@/schemas/mobile/cashMachine.schema'
import {
  consultarDudaDeLaMaquina,
  listarDudasDeLaMaquina,
  resolverDudaDeLaMaquina,
  subirDudaDeLaMaquina,
  type DudaDeLaMaquina,
  type ResolucionDelGerente,
} from '@/services/cashMachine/dudasDeLaMaquina'
import { registrarVentaDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
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
const UN_NEGOCIO = 'cjld2cjxh0000qzrmn831i7rn'
const dudaDeLaBandeja = async () => (await listarDudasDeLaMaquina(VENUE, { kind: 'ESPERANDO' })).data[0]

describe('H1 · la bandeja enseña la evidencia física MÁS ALTA del folio, con la versión que el gerente confirma', () => {
  it('🔴 la PC reporta $0; después $50 y pasa $1 de venta a propina (conflicto): la bandeja entrega $50 con la versión 2, nunca «$0, versión 2»', async () => {
    await subir({ lastSeen: { credit: 0 } })
    await expect(subir({ saleCents: 18650, tipCents: 100, lastSeen: { credit: 5000 } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CONFLICT',
    })
    expect(await dudaDeLaBandeja()).toMatchObject({ lastSeen: { credit: 5000 }, version: 2 })
  })

  it('con lo que vio entrar en números (creditCents): el mayor manda y un reenvío tardío con menos no lo tapa (sí sube la versión)', async () => {
    await subir({ creditCents: 0, lastSeen: 'Entró $0.00' })
    await subir({ creditCents: 5000, lastSeen: 'Entró $50.00' })
    await subir({ creditCents: 0, lastSeen: 'Entró $0.00 (llegó tarde)' })
    expect(await dudaDeLaBandeja()).toMatchObject({ creditCents: 5000, lastSeen: 'Entró $50.00', version: 3 })
  })

  it('🔴 un cierre de la PC en conflicto por el reparto también es evidencia: la duda abierta enseña lo que entró según ese cierre', async () => {
    await subir({ lastSeen: { credit: 0 } })
    await expect(vender(cierre({ saleCents: 18650, tipCents: 100 }))).rejects.toMatchObject({ statusCode: 409 })
    expect(await dudaDeLaBandeja()).toMatchObject({ creditCents: 20000, version: 2, status: 'ABIERTO' })
  })
})

describe('H2 · un folio congelado NO es una duda: la duda válida que llega después abre su ESPERANDO', () => {
  it('🔴 un PAGADO imposible congela el folio; la duda válida con $50 vistos queda ABIERTA con incidentId, y el gerente la consulta y la resuelve', async () => {
    await expect(vender(cierre({ creditCents: 10000, changeDispensedCents: 0 }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    const r = await subir({ lastSeen: { credit: 5000 } })
    expect(r).toMatchObject({ status: 'ABIERTO', ack: 'RECIBIDO', incidentId: expect.any(String) })
    const espera = a.base.incidencias.find(i => i.kind === 'ESPERANDO')
    expect(espera).toMatchObject({ id: (r as { incidentId: string }).incidentId, status: 'ABIERTO', deviceId: 'terminal-pc' })
    // Sigue UN solo folio: el congelado por el primer mensaje (no se vuelve a congelar).
    expect(a.base.folios).toHaveLength(1)
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'ABIERTO', incidentId: espera!.id })
    const version = a.base.folios[0].version
    expect(await resolver({ version })).toMatchObject({ status: 200, body: { ack: 'TERMINADO', resolvedBy: 'GERENTE' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })
})

describe('H3 · el primer mensaje congela el carrito aunque el reparto no quepa en centavos enteros', () => {
  const deAna = { ...CARRITO, customerId: 'ana', stampRewardId: 'premio-ana' }

  it('🔴 Ana y su premio con medio centavo de más en la venta: se congela SU carrito; el reenvío corregido con otro carrito es conflicto, nunca su venta', async () => {
    const r1 = await vender(cierre({ saleCents: 18750.5 }), deAna)
    expect(r1).toMatchObject({
      status: 202,
      body: {
        ack: 'TERMINADO',
        motivo: 'REPARTO_DESCUADRADO',
        creditCents: 20000,
        changeDispensedCents: 1250,
        owedCents: 0,
        saleCents: null,
      },
    })
    expect(a.base.folios).toEqual([expect.objectContaining({ pedido: deAna, saleCents: 18750.5, dueCents: 18750 })])
    await expect(vender(cierre(), { ...CARRITO, customerId: 'otra' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
    expect(lector).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('lo FÍSICO con fracción (lo que entró) es imposible, pero también congela: el reenvío corregido sale del carrito de Ana', async () => {
    await expect(vender(cierre({ creditCents: 20000.5 }), deAna)).rejects.toMatchObject({ statusCode: 422 })
    expect(a.base.folios).toEqual([expect.objectContaining({ pedido: deAna })])
    expect(await vender(cierre(), { ...CARRITO, customerId: 'otra' })).toMatchObject({ status: 202, body: { motivo: 'PREMIO_PENDIENTE' } })
    expect(lector).toHaveBeenLastCalledWith(deAna, PC.userId)
  })
})

describe('H4 · un comprobante con folio y dinero legibles nunca es un 400 sin evidencia', () => {
  it('🔴 la hora «conocida» sin fecha pasa la ruta y cuenta como hora desconocida: el dinero queda, por conciliar', async () => {
    // Lo que llega por JSON: «conocida» y sin la llave de la fecha.
    const cuerpo = JSON.parse(JSON.stringify({ referenceCC: REF, cierre: { ...cierre(), occurredAt: undefined }, pedido: CARRITO }))
    expect(cuerpo.cierre).toMatchObject({ occurredAtKnown: true })
    expect('occurredAt' in cuerpo.cierre).toBe(false)
    expect(registrarVentaDeLaMaquinaSchema.safeParse({ params: { venueId: UN_NEGOCIO }, body: cuerpo }).success).toBe(true)
    const r = await registrarVentaDeLaMaquina(VENUE, PC, cuerpo as never, lector)
    expect(r).toMatchObject({ body: { ack: 'TERMINADO' } })
    expect(a.base.cierres).toEqual([expect.objectContaining({ occurredAtKnown: false, occurredAt: null, creditCents: 20000 })])
    expect(a.base.observaciones).toHaveLength(1)
  })

  it('🔴 la duda con $50 vistos y medio centavo en la venta pasa la ruta, queda ABIERTA y el gerente la resuelve (sin venta)', async () => {
    const cuerpo = duda({ saleCents: 18750.5, lastSeen: { credit: 5000 } })
    expect(subirDudaDeLaMaquinaSchema.safeParse({ params: { venueId: UN_NEGOCIO }, body: cuerpo }).success).toBe(true)
    expect(await subirDudaDeLaMaquina(VENUE, PC, cuerpo, lector)).toMatchObject({ status: 'ABIERTO', incidentId: expect.any(String) })
    const d = await dudaDeLaBandeja()
    expect(d).toMatchObject({ saleCents: 18750.5, lastSeen: { credit: 5000 } })
    const r = await resolver({ version: d.version as number })
    expect(r).toMatchObject({
      status: 202,
      body: { ack: 'TERMINADO', motivo: 'REPARTO_DESCUADRADO', resolvedBy: 'GERENTE', saleCents: null },
    })
    expect(await consultarDudaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 'RESUELTO' })
  })

  it('la duda sin hora de inicio, sin reparto y con 20 KB de lo que vio la PC: pasa la ruta y se guarda (lo que vio, cortado a 16 KB)', async () => {
    const cuerpo = { referenceCC: REF, dueCents: 18750, pedido: CARRITO, lastSeen: 'x'.repeat(20_000) }
    expect(subirDudaDeLaMaquinaSchema.safeParse({ params: { venueId: UN_NEGOCIO }, body: cuerpo }).success).toBe(true)
    expect(await subirDudaDeLaMaquina(VENUE, PC, cuerpo, lector)).toMatchObject({ status: 'ABIERTO' })
    const d = await dudaDeLaBandeja()
    expect(d).toMatchObject({ startedAt: null, saleCents: null, tipCents: null })
    expect((d.lastSeen as string).length).toBe(16_384)
  })

  it('lo que sí sigue siendo un 400: sin folio, o un adeudo que no es número (no hay dinero legible que guardar)', () => {
    expect(subirDudaDeLaMaquinaSchema.safeParse({ params: { venueId: UN_NEGOCIO }, body: { dueCents: 18750 } }).success).toBe(false)
    expect(
      registrarVentaDeLaMaquinaSchema.safeParse({
        params: { venueId: UN_NEGOCIO },
        body: { referenceCC: REF, cierre: { ...cierre(), creditCents: 'veinte' } },
      }).success,
    ).toBe(false)
  })
})
