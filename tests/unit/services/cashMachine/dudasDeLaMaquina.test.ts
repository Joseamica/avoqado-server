/**
 * Máquina de efectivo 1a · «Cobros en duda» (R4-4, R5#5, R5#6, R5#7, R5#8 y el rediseño tras la ronda 3 de Codex). La PC perdió el
 * mensaje de cierre: sube la duda (ESPERANDO), que congela el folio, y un GERENTE la resuelve con SU sesión, tecleando lo que ve en la
 * máquina y la `version` que vio. Su declaración entra por la MISMA escritura que el cierre de la PC; la duda queda RESUELTO en la misma
 * transacción que el cierre y, sin la hora del comprobante, hora y turno quedan «por conciliar».
 *
 * Corre el núcleo real contra el doble de Prisma con las tablas de la máquina en memoria (`arnesDeLaMaquina.ts`). Los casos exactos de
 * Codex r3 y r6 están en `redisenoR3.test.ts`.
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
  lastSeen: [{ event: 'updateCredit', credit: '200.00' }],
  saleShiftId: 'shift-A',
  ...over,
})
const resolucion = (over: Partial<ResolucionDelGerente> = {}): ResolucionDelGerente => ({
  outcome: 'PAGADO',
  creditCents: 20000,
  changeDispensedCents: 1250,
  occurredAt: '2026-11-20T18:00:00.000Z',
  evidence: 'El comprobante dice Pago Completado $187.50, crédito $200, cambio $12.50',
  version: 1,
  ...over,
})
const subir = (over: Partial<DudaDeLaMaquina> = {}, autor = PC) => subirDudaDeLaMaquina(VENUE, autor, duda(over), lector)
const resolver = (over: Partial<ResolucionDelGerente> = {}) =>
  resolverDudaDeLaMaquina(VENUE, GERENTE, REF, resolucion({ version: a.base.folios[0]?.version ?? 1, ...over }), lector)
const dudaGuardada = () => a.base.incidencias.find(i => i.kind === 'ESPERANDO')
const acciones = () => (logAction as jest.Mock).mock.calls.map(c => c[0].action)

describe('subirDudaDeLaMaquina (la PC no sabe cómo terminó)', () => {
  it('🔴 la PC emparejada sube la duda: congela el folio, ESPERANDO ABIERTO y la bitácora lo anota', async () => {
    const r = await subir()
    expect(r).toEqual({
      status: 'ABIERTO',
      ack: 'RECIBIDO',
      referenceCC: REF,
      deviceId: 'terminal-pc',
      incidentId: dudaGuardada()!.id,
      version: 1,
    })
    expect(a.base.folios[0]).toMatchObject({
      deviceId: 'terminal-pc',
      bindingId: 'b1',
      pedido: CARRITO,
      saleShiftId: 'shift-A',
      dueCents: 18750,
      decision: null,
    })
    expect(dudaGuardada()).toMatchObject({
      status: 'ABIERTO',
      deviceId: 'terminal-pc',
      payload: expect.objectContaining({ subidoPor: 'staff-cajera' }),
    })
    expect(acciones()).toEqual(['CASH_MACHINE_DOUBT_OPENED'])
  })

  it('repetir la misma duda es idempotente: una fila, la misma respuesta, sin otro renglón en la bitácora', async () => {
    const primera = await subir()
    jest.clearAllMocks()
    await expect(subir()).resolves.toEqual(primera)
    expect(a.base.incidencias).toHaveLength(1)
    expect(a.base.observaciones).toHaveLength(1)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 la misma duda con otro adeudo es 409 con la evidencia guardada (CONFLICTO): los importes los fija la primera', async () => {
    await subir()
    await expect(subir({ dueCents: 20000, saleCents: 20000 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CONFLICT',
      details: expect.objectContaining({ registrada: { dueCents: 18750, saleCents: 18750, tipCents: 0 }, incidentId: expect.any(String) }),
    })
    expect(a.base.folios[0].dueCents).toBe(18750)
  })

  it('🔴 el folio ya tiene su cierre: responde ese acuse (RESUELTO, TERMINADO) y no abre una duda', async () => {
    const venta = await registrarVentaDeLaMaquina(VENUE, PC, { referenceCC: REF, cierre: cierre(), pedido: CARRITO }, lector)
    const r = await subir()
    expect(r).toEqual({ status: 'RESUELTO', ...venta.body })
    expect(dudaGuardada()).toBeUndefined()
  })

  it('🔴 otra caja sin la credencial: 403 y no escribe nada', async () => {
    await expect(subir({}, { ...PC, credencial: null })).rejects.toMatchObject({ statusCode: 403, code: 'CASH_MACHINE_NOT_PAIRED' })
    expect(a.base.folios).toEqual([])
    expect(a.base.observaciones).toEqual([])
  })

  it('🔴 la PC revocada re-envía SU duda: misma respuesta, sin otra fila ni incidencia', async () => {
    const primera = await subir()
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T19:00:00.000Z')
    await expect(subir()).resolves.toEqual(primera)
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['ESPERANDO'])
  })

  it('🔴 Codex r1 #5 (decisión d): la PC revocada entrega una duda NUEVA: se guarda y queda TRAS_REVOCAR', async () => {
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T19:00:00.000Z')
    expect(await subir()).toMatchObject({ status: 'ABIERTO' })
    expect(a.base.incidencias.map(i => i.kind).sort()).toEqual(['ESPERANDO', 'TRAS_REVOCAR'])
  })

  it('🔴 F4: un adeudo que no es venta + propina ya no es 400: la duda se guarda ABIERTA con su evidencia', async () => {
    expect(await subir({ dueCents: 20000 })).toMatchObject({ status: 'ABIERTO' })
    expect(a.base.observaciones).toHaveLength(1)
    expect(a.base.folios[0]).toMatchObject({ dueCents: 20000, saleCents: 18750, tipCents: 0 })
  })

  it('🔴 Codex r1 #12: una duda con adeudo de $187.35 o de $0 es 422 con su incidencia IMPOSIBLE, no una duda', async () => {
    await expect(subir({ dueCents: 18735, saleCents: 18735 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      details: { incidentId: expect.any(String) },
    })
    await expect(subir({ dueCents: 0, saleCents: 0 })).rejects.toMatchObject({ statusCode: 422 })
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['IMPOSIBLE'])
    // F12: el primer mensaje congela el folio aunque sea imposible; el segundo no lo sustituye.
    expect(a.base.folios).toEqual([expect.objectContaining({ dueCents: 18735, saleCents: 18735, decision: null })])
  })
})

describe('consultarDudaDeLaMaquina (la PC pregunta cada 60 s, R5#6)', () => {
  it('abierta → { status: ABIERTO, ack: RECIBIDO, deviceId }; sin duda ni cierre → 404', async () => {
    await expect(consultarDudaDeLaMaquina(VENUE, REF)).rejects.toMatchObject({ statusCode: 404 })
    await subir()
    await expect(consultarDudaDeLaMaquina(VENUE, REF)).resolves.toMatchObject({
      status: 'ABIERTO',
      ack: 'RECIBIDO',
      deviceId: 'terminal-pc',
    })
  })

  it('🔴 ida y vuelta: después de que el gerente resuelve, la consulta trae la MISMA evidencia que la venta', async () => {
    await subir()
    const r = await resolver()
    const consulta = await consultarDudaDeLaMaquina(VENUE, REF)
    expect(consulta).toEqual({ status: 'RESUELTO', ...r.body })
    await expect(consultarVentaDeLaMaquina(VENUE, REF)).resolves.toEqual(r)
  })
})

describe('listarDudasDeLaMaquina (acotada, R4-4)', () => {
  const sembrar = (n: number) => {
    for (let i = 0; i < n; i++) {
      a.base.incidencias.push({
        id: `inc-${String(i).padStart(3, '0')}`,
        venueId: VENUE,
        referenceCC: `AQ${String(i).padStart(12, '0')}`,
        kind: 'IMPOSIBLE',
        status: 'ABIERTO',
        deviceId: 'terminal-pc',
        createdAt: new Date(Date.UTC(2026, 10, 20, 18, 0, 0) - i * 1000),
        payload: { eventos: [{ i }], veces: 1, repetidas: 0, version: 1 },
      })
    }
  }

  it('🔴 un límite hostil se recorta a 100; por omisión 50; orden estable y el total con el MISMO filtro', async () => {
    sembrar(130)
    expect((await listarDudasDeLaMaquina(VENUE, { limit: 5000 })).data).toHaveLength(100)
    const r = await listarDudasDeLaMaquina(VENUE, {})
    expect(r.data).toHaveLength(50)
    expect(r.total).toBe(130)
    expect(r.data[0].id).toBe('inc-000')
  })

  it('hay más: nextCursor; con él, la siguiente página empieza DESPUÉS de la última leída', async () => {
    sembrar(30)
    const p1 = await listarDudasDeLaMaquina(VENUE, { limit: 20 })
    const p2 = await listarDudasDeLaMaquina(VENUE, { limit: 20, cursor: p1.nextCursor! })
    expect(p2.data.map(d => d.id)).toEqual(Array.from({ length: 10 }, (_, i) => `inc-${String(i + 20).padStart(3, '0')}`))
    expect(p2.nextCursor).toBeNull()
  })

  it('un cursor que no es nuestro es 400', async () => {
    await expect(listarDudasDeLaMaquina(VENUE, { cursor: 'inventado' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('🔴 una duda trae lo congelado de su folio (importes, carrito, turno) y la versión con que se resuelve', async () => {
    await subir()
    const [d] = (await listarDudasDeLaMaquina(VENUE, {})).data
    expect(d).toMatchObject({
      kind: 'ESPERANDO',
      dueCents: 18750,
      saleCents: 18750,
      tipCents: 0,
      pedido: CARRITO,
      saleShiftId: 'shift-A',
      version: 1,
    })
  })
})

describe('resolverDudaDeLaMaquina (el gerente, con su sesión)', () => {
  beforeEach(async () => {
    await subir()
    jest.clearAllMocks()
  })

  it('🔴 PAGADO: la venta nace con el carrito CONGELADO, en pesos, resuelta por el GERENTE del token, y la duda queda RESUELTO', async () => {
    const r = await resolver()
    expect(r).toMatchObject({ status: 200, body: { ack: 'TERMINADO', resolvedBy: 'GERENTE', outcome: 'PAGADO', paymentId: 'payment-1' } })
    expect(lector).toHaveBeenCalledWith(CARRITO, 'staff-cajera')
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({ amount: 187.5, processedById: GERENTE, cashMachineRef: REF })
    expect(a.base.cierres[0]).toMatchObject({
      resolvedBy: 'GERENTE',
      resolvedByStaffId: GERENTE,
      evidence: expect.stringContaining('Pago Completado'),
    })
    expect(dudaGuardada()).toMatchObject({ status: 'RESUELTO', resolvedByStaffId: GERENTE })
    expect(acciones()).toContain('CASH_MACHINE_DOUBT_RESOLVED')
  })

  it('🔴 R5#8: sin la hora del comprobante → hora y turno POR CONCILIAR; nunca la hora de inicio ni la de resolución', async () => {
    const r = await resolver({ occurredAt: null })
    expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
    expect(a.base.cierres[0]).toMatchObject({ occurredAt: null, occurredAtKnown: false })
  })

  it('con la hora del comprobante, el cierre guarda ESA hora', async () => {
    await resolver()
    expect(a.base.cierres[0].occurredAt).toEqual(new Date('2026-11-20T18:00:00.000Z'))
  })

  it('CANCELADO con devolución incompleta: cierre sin pago, NO_DEVUELTO, sin leer el carrito', async () => {
    const r = await resolver({ outcome: 'CANCELADO', creditCents: 10000, changeDispensedCents: 8000, cancelMode: '1' })
    expect(r).toMatchObject({ status: 200, body: { outcome: 'CANCELADO', owedKind: 'NO_DEVUELTO', owedCents: 2000, paymentId: null } })
    expect(lector).not.toHaveBeenCalled()
  })

  it('🔴 resolver otra vez con lo mismo devuelve la MISMA evidencia y un solo pago; con otros datos, 409 con su evidencia', async () => {
    const primera = await resolver()
    await expect(resolver()).resolves.toEqual(primera)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    await expect(resolver({ creditCents: 50000, changeDispensedCents: 31250 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
  })

  it('una duda que no existe es 404', async () => {
    await expect(resolverDudaDeLaMaquina(VENUE, GERENTE, 'AQ000000000000', resolucion(), lector)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('🔴 la venta ya no se arma (producto borrado): 202 TERMINADO con el dinero, la duda se cierra y la PC lo ve', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    a.base.folios[0].pedido = { ...CARRITO, items: [{ productId: 'prod-borrado', quantity: 1 }] }
    const r = await resolver()
    expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'VENTA_RECHAZADA', resolvedBy: 'GERENTE' } })
    expect(dudaGuardada()!.status).toBe('RESUELTO')
    await expect(consultarDudaDeLaMaquina(VENUE, REF)).resolves.toMatchObject({ status: 'RESUELTO', motivo: 'VENTA_RECHAZADA' })
  })

  it('🔴 si la PC sube después el cierre real, la duda se cierra sola (MAQUINA) en la misma transacción, sin aviso de gerente', async () => {
    const r = await registrarVentaDeLaMaquina(VENUE, PC, { referenceCC: REF, cierre: cierre(), pedido: CARRITO }, lector)
    expect(r).toMatchObject({ status: 200, body: { resolvedBy: 'MAQUINA' } })
    expect(dudaGuardada()).toMatchObject({ status: 'RESUELTO', resolvedByStaffId: null })
    expect(acciones()).not.toContain('CASH_MACHINE_DOUBT_RESOLVED')
  })

  it('🔴 Codex r1 #10 (decisión a): la duda con cortesía NO se vuelve venta con los permisos del gerente: 202 DESCUENTO', async () => {
    a.base.folios[0].pedido = { ...CARRITO, items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750, isCortesia: true }] }
    expect(await resolver()).toMatchObject({ status: 202, body: { motivo: 'DESCUENTO' } })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 Codex r2 #11: la duda con premio de sellos: el gerente confirma el dinero → 202 PREMIO_PENDIENTE, sin venta', async () => {
    a.base.folios[0].pedido = { ...CARRITO, stampRewardId: 'premio-1' }
    expect(await resolver()).toMatchObject({ status: 202, body: { motivo: 'PREMIO_PENDIENTE' } })
  })

  it('🔴 Codex r2 #10: CANCELADO sin el modo que vio el gerente es 422 y la duda sigue abierta; GUARDADO + «2» se cierra', async () => {
    await expect(resolver({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000 })).rejects.toMatchObject({
      statusCode: 422,
    })
    expect(dudaGuardada()!.status).toBe('ABIERTO')
    const r = await resolver({ outcome: 'GUARDADO', creditCents: 5000, changeDispensedCents: 0, cancelMode: '2' })
    expect(r).toMatchObject({ status: 200, body: { outcome: 'GUARDADO', owedKind: 'GUARDADO', owedCents: 5000 } })
  })
})

describe('Codex r1 #4 y r2 #4: la duda es de la PC que la subió', () => {
  it('🔴 la duda la subió A; B (revocada, con otro aparato) con el mismo folio recibe 409 OTRA_PC con incidencia y la duda de A sigue abierta', async () => {
    await subir()
    await expect(subir({}, PC_B)).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ motivo: 'OTRA_PC', registrada: null }),
    })
    await expect(
      registrarVentaDeLaMaquina(VENUE, PC_B, { referenceCC: REF, cierre: cierre(), pedido: { ...CARRITO, couponCode: 'X' } }, lector),
    ).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ motivo: 'OTRA_PC' }) })
    expect(dudaGuardada()!.status).toBe('ABIERTO')
    expect(a.base.cierres).toEqual([])
  })
})

describe('Codex servidor r2 #1: la PC revocada conserva su revokedAt aunque exista SU duda', () => {
  beforeEach(async () => {
    await subir()
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T18:30:00.000Z')
  })

  it('🔴 cobrado DESPUÉS de la revocación (o sin hora): 202 PC_REVOCADA con TRAS_REVOCAR, sin venta; su duda se cierra', async () => {
    const r = await registrarVentaDeLaMaquina(
      VENUE,
      PC,
      { referenceCC: REF, cierre: cierre({ occurredAt: '2026-11-20T19:00:00.000Z' }), pedido: CARRITO },
      lector,
    )
    expect(r).toMatchObject({ status: 202, body: { motivo: 'PC_REVOCADA' } })
    expect(a.base.incidencias.map(i => i.kind).sort()).toEqual(['ESPERANDO', 'NO_SE_PUDO_REGISTRAR', 'TRAS_REVOCAR'])
    expect(dudaGuardada()!.status).toBe('RESUELTO')
  })

  it('🔴 cobrado ANTES de la revocación: se registra la venta y queda TRAS_REVOCAR; la repetición exacta da lo mismo', async () => {
    const entrada = { referenceCC: REF, cierre: cierre({ occurredAt: '2026-11-20T18:00:00.000Z' }), pedido: CARRITO }
    const r = await registrarVentaDeLaMaquina(VENUE, PC, entrada, lector)
    expect(r.status).toBe(200)
    await expect(registrarVentaDeLaMaquina(VENUE, PC, entrada, lector)).resolves.toEqual(r)
    expect(a.base.incidencias.map(i => i.kind).sort()).toEqual(['ESPERANDO', 'TRAS_REVOCAR'])
  })

  it('el gerente no está revocado: él declara lo que ve en la máquina y la venta se registra', async () => {
    expect(await resolver({ occurredAt: '2026-11-20T19:00:00.000Z' })).toMatchObject({ status: 200, body: { resolvedBy: 'GERENTE' } })
  })
})

describe('Codex r1 #7 y r2 #8: la bandeja trae todas las incidencias y el gerente revisa las que no son duda', () => {
  const imposible = async () => {
    await expect(subir({ dueCents: 18735, saleCents: 18735 })).rejects.toMatchObject({ statusCode: 422 })
    return a.base.incidencias.find(i => i.kind === 'IMPOSIBLE')!
  }

  it('🔴 la lista trae el IMPOSIBLE de un 422 con su tipo, cuántas veces llegó y su evidencia', async () => {
    await imposible()
    await expect(subir({ dueCents: 18735, saleCents: 18735 })).rejects.toMatchObject({ statusCode: 422 })
    const [f] = (await listarDudasDeLaMaquina(VENUE, {})).data
    expect(f).toMatchObject({
      kind: 'IMPOSIBLE',
      veces: 2,
      repetidas: 1,
      version: 1,
      primerEvento: expect.objectContaining({ dueCents: 18735 }),
    })
  })

  it('🔴 revisar: queda RESUELTO con el gerente y su nota, en la bitácora; repetirlo no anota otra vez', async () => {
    const fila = await imposible()
    jest.clearAllMocks()
    const r = await revisarIncidenciaDeLaMaquina(VENUE, GERENTE, fila.id, 'La máquina devolvió todo', 1)
    expect(r).toEqual({ id: fila.id, referenceCC: REF, kind: 'IMPOSIBLE', status: 'RESUELTO', version: 1 })
    expect(fila).toMatchObject({
      status: 'RESUELTO',
      resolvedByStaffId: GERENTE,
      payload: expect.objectContaining({ revision: expect.objectContaining({ nota: 'La máquina devolvió todo' }) }),
    })
    await revisarIncidenciaDeLaMaquina(VENUE, GERENTE, fila.id, 'La máquina devolvió todo', 1)
    expect(acciones()).toEqual(['CASH_MACHINE_INCIDENT_REVIEWED'])
  })

  it('🔴 evidencia nueva mientras revisaba: 409 CASH_MACHINE_INCIDENT_CHANGED; una retransmisión idéntica no la cambia', async () => {
    const fila = await imposible()
    await expect(subir({ dueCents: 18735, saleCents: 18735 })).rejects.toMatchObject({ statusCode: 422 }) // idéntica
    expect(fila.payload.version).toBe(1)
    await expect(subir({ dueCents: 18735, saleCents: 18735, lastSeen: 'otra' })).rejects.toMatchObject({ statusCode: 422 }) // nueva
    await expect(revisarIncidenciaDeLaMaquina(VENUE, GERENTE, fila.id, 'x', 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_INCIDENT_CHANGED',
      details: { version: 2 },
    })
    expect(fila.status).toBe('ABIERTO')
  })

  it('una duda (ESPERANDO) no se revisa: se resuelve (409); otra sucursal o un id inventado: 404', async () => {
    await subir()
    await expect(revisarIncidenciaDeLaMaquina(VENUE, GERENTE, dudaGuardada()!.id, 'x', 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_NEEDS_RESOLUTION',
    })
    await expect(revisarIncidenciaDeLaMaquina('otra-sucursal', GERENTE, dudaGuardada()!.id, 'x', 1)).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(revisarIncidenciaDeLaMaquina(VENUE, GERENTE, 'inventado', 'x', 1)).rejects.toMatchObject({ statusCode: 404 })
  })
})
