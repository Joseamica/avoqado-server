/**
 * Máquina de efectivo 1a · ronda 5 de Codex sobre el código del SERVIDOR (`docs/audit/2026-11-17-maquina-de-efectivo/
 * codex-codigo-servidor-r5.md`). UNA prueba por cada caso que Codex reprodujo (H1–H6), con su escenario exacto. H7 va en las
 * devoluciones (`destinoDelReembolso.refund.test.ts`, `issue-refund.test.ts`) y H8 en el detalle del turno.
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

import { createHash } from 'crypto'
import { registrarVentaDeLaMaquinaSchema, subirDudaDeLaMaquinaSchema } from '@/schemas/mobile/cashMachine.schema'
import { logAction } from '@/services/dashboard/activity-log.service'
import { emparejarAparato } from '@/services/cashMachine/emparejamiento'
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
const vender = (c = cierre(), pedido: unknown = CARRITO, autor = PC, bindingId?: string) =>
  registrarVentaDeLaMaquina(VENUE, autor, { referenceCC: REF, cierre: c, pedido, bindingId }, lector)
const subir = (over: Partial<DudaDeLaMaquina> = {}) => subirDudaDeLaMaquina(VENUE, PC, duda(over), lector)
const resolver = (over: Partial<ResolucionDelGerente> = {}) => resolverDudaDeLaMaquina(VENUE, GERENTE, REF, resolucion(over), lector)
const sinBase = () => Object.assign(new Error("Can't reach database server"), { code: 'P1001' })
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

describe('H6 · sin hora, un cierre sólo vale si el intento es del emparejamiento de la credencial y nunca lo revocaron', () => {
  /** b1 (la credencial de PC) la revocaron a las 18:00; la misma PC se volvió a emparejar a las 19:00 (b3, activo). */
  beforeEach(() => {
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T18:00:00.000Z')
    a.base.vinculos.push({
      id: 'b3',
      venueId: VENUE,
      deviceId: 'terminal-pc',
      machineIp: '192.168.1.50',
      credentialHash: createHash('sha256').update('credencial-nueva').digest('hex'),
      active: true,
      revokedAt: null,
      createdAt: new Date('2026-11-20T19:00:00.000Z'),
    })
  })
  const sinHora = () => cierre({ occurredAtKnown: false, occurredAt: null })

  it('🔴 credencial de b1 (revocada) con el intento fijo en b3 (activo) y SIN hora: 202 PC_REVOCADA con TRAS_REVOCAR, nunca venta', async () => {
    const r = await vender(sinHora(), CARRITO, PC, 'b3')
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'PC_REVOCADA', creditCents: 20000 } })
    expect(a.base.incidencias.map(i => i.kind).sort()).toEqual(['NO_SE_PUDO_REGISTRAR', 'TRAS_REVOCAR'])
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('la credencial de b3 con su propio intento (b3, nunca revocado) sin hora sí es venta', async () => {
    const r = await vender(sinHora(), CARRITO, { ...PC, credencial: 'credencial-nueva' }, 'b3')
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
  })

  it('la credencial de b3 con el intento fijo en b1 (revocado) sin hora: tampoco', async () => {
    const r = await vender(sinHora(), CARRITO, { ...PC, credencial: 'credencial-nueva' }, 'b1')
    expect(r).toMatchObject({ status: 202, body: { motivo: 'PC_REVOCADA' } })
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

describe('H5 · un RECIBIDO cuya PC relevaron lo termina el gerente desde lo congelado', () => {
  it('🔴 PAGADO válido que queda RECIBIDO y relevan la PC: la nueva recibe 409 OTRA_PC; el gerente lo ve y lo termina con UN pago', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    expect(await vender()).toMatchObject({ status: 202, body: { ack: 'RECIBIDO' } })
    // La PC B toma la máquina: revoca b1 y, en la misma transacción, deja el folio RECIBIDO de b1 en la bandeja.
    const { credential } = await emparejarAparato(VENUE, { userId: GERENTE, deviceUid: 'pc-uid-2' }, '192.168.1.50')
    await expect(vender(cierre(), CARRITO, { ...PC_B, credencial: credential })).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ motivo: 'OTRA_PC' }),
    })
    const bandeja = (await listarDudasDeLaMaquina(VENUE, { kind: 'POR_TERMINAR' })).data
    expect(bandeja).toEqual([
      expect.objectContaining({ kind: 'POR_TERMINAR', status: 'ABIERTO', outcome: 'PAGADO', creditCents: 20000, dueCents: 18750 }),
    ])
    expect(await consultarVentaDeLaMaquina(VENUE, REF)).toMatchObject({ status: 202, body: { ack: 'RECIBIDO' } })
    // Con la versión de la bandeja y SIN importes: sale de lo congelado.
    const r = await resolverDudaDeLaMaquina(VENUE, GERENTE, REF, { version: bandeja[0].version as number }, lector)
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO', resolvedBy: 'MAQUINA', paymentId: 'payment-1' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(a.base.incidencias.find(i => i.kind === 'POR_TERMINAR')).toMatchObject({
      status: 'RESUELTO',
      resolvedByStaffId: GERENTE,
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_FOLIO_FINISHED', staffId: GERENTE }))
    // Repetir (el gerente o la PC vieja) contesta lo mismo: nunca un segundo pago.
    expect(await resolverDudaDeLaMaquina(VENUE, GERENTE, REF, { version: 1 }, lector)).toMatchObject({ status: 200 })
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('con la versión vieja no termina (llegó evidencia nueva); y no se «da por revisado»', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    await vender()
    await emparejarAparato(VENUE, { userId: GERENTE, deviceUid: 'pc-uid-2' }, '192.168.1.50')
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    await vender(cierre({ occurredAt: '2026-11-20T18:01:00.000Z' })) // la hora distinta se anota (versión 2) y vuelve a quedar RECIBIDO
    const [p] = (await listarDudasDeLaMaquina(VENUE, { kind: 'POR_TERMINAR' })).data
    await expect(revisarIncidenciaDeLaMaquina(VENUE, GERENTE, p.id as string, 'ya', 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_NEEDS_RESOLUTION',
    })
    await expect(resolverDudaDeLaMaquina(VENUE, GERENTE, REF, { version: 1 }, lector)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CHANGED',
    })
  })

  it('un folio de una PC YA revocada que queda RECIBIDO aparece desde su primera escritura (sin esperar otro relevo)', async () => {
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T19:00:00.000Z') // cobró a las 18:00, antes de que la revocaran
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    expect(await vender()).toMatchObject({ status: 202, body: { ack: 'RECIBIDO' } })
    const [p] = (await listarDudasDeLaMaquina(VENUE, { kind: 'POR_TERMINAR' })).data
    expect(p).toMatchObject({ status: 'ABIERTO', outcome: 'PAGADO' })
    expect(await resolverDudaDeLaMaquina(VENUE, GERENTE, REF, { version: p.version as number }, lector)).toMatchObject({ status: 200 })
  })

  it('el de una PC revocada que termina en el acto no deja nada en la bandeja ni aviso (sólo su marca TRAS_REVOCAR)', async () => {
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T19:00:00.000Z')
    expect(await vender()).toMatchObject({ status: 200 })
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['TRAS_REVOCAR'])
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_FOLIO_TO_FINISH' }))
  })

  it('si lo termina el reenvío de la PC vieja, el pendiente sale de la bandeja (el cierre es el registro)', async () => {
    prismaMock.shift.findFirst.mockRejectedValueOnce(sinBase())
    await vender()
    await emparejarAparato(VENUE, { userId: GERENTE, deviceUid: 'pc-uid-2' }, '192.168.1.50')
    expect((await listarDudasDeLaMaquina(VENUE, { kind: 'POR_TERMINAR' })).total).toBe(1)
    expect(await vender()).toMatchObject({ status: 200, body: { ack: 'TERMINADO' } })
    expect((await listarDudasDeLaMaquina(VENUE, { kind: 'POR_TERMINAR' })).total).toBe(0)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('una duda SIN desenlace sigue pidiendo lo que vio el gerente: sólo la versión es 400', async () => {
    await subir()
    await expect(resolverDudaDeLaMaquina(VENUE, GERENTE, REF, { version: 1 }, lector)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_MACHINE_DOUBT_RESOLUTION_INCOMPLETE',
    })
  })
})
