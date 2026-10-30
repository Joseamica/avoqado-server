jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 1 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn().mockResolvedValue(undefined) }))

/**
 * 🔴 DINERO. Sellos a mano (23-oct-2026): el negocio migra el cartón de papel de un cliente o corrige un error escribiendo
 * el TOTAL que tiene. Un sello de más es producto regalado; un ajuste aplicado dos veces (doble clic, reintento del panel)
 * es una cartilla regalada. Por eso el ajuste es un asiento del libro con autor y motivo, y sólo se aplica si la tarjeta,
 * su número y su versión siguen siendo los que vio quien lo pidió.
 */
import { adjustStamps, AdjustStampsInput } from '../../../../src/services/wallet/stampLedger.service'
import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'
import { sendFirstStampEmailIfDue } from '@/services/wallet/firstStampEmail.service'

const CONFIG = {
  venueId: 'v1',
  active: true,
  stampsEnabled: true,
  stampsRequired: 10,
  maxStampsPerDay: 1,
  stampRewardType: 'FREE_PRODUCT',
  stampRewardValue: null,
  stampRewardProductId: null,
  stampRewardLabel: 'Un café gratis',
}

type Abierta = { id: string; cycle: number; stampsEarned: number; stampsRequired: number } | null

/** Lo que hay en la base del cliente: su abierta más vieja, otra abierta (D2), la última cartilla y la versión de la abierta. */
function estado(e: { abierta: Abierta; otraAbierta?: { id: string } | null; ultima?: { cycle: number } | null; version?: number }) {
  prismaMock.stampCard.findFirst.mockImplementation((async (args: any) => {
    const w = args?.where ?? {}
    if (w.completedAt === null && w.id?.not) return e.otraAbierta ?? null
    if (w.completedAt === null) return e.abierta
    return e.ultima ?? (e.abierta ? { cycle: e.abierta.cycle } : null)
  }) as never)
  prismaMock.stampEvent.count.mockResolvedValue((e.version ?? e.abierta?.stampsEarned ?? 0) as never)
}

function pedir(over: Partial<AdjustStampsInput> = {}): AdjustStampsInput {
  return {
    stampsEarned: 7,
    expectedStampCardId: 'sc1',
    expectedStampsEarned: 2,
    expectedVersion: 2,
    expectedStampsRequired: 10,
    reason: 'Cartón de papel',
    staffVenueId: 'sv1',
    actorStaffId: 's1',
    ...over,
  }
}

describe('adjustStamps', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Sin colas «Once» ni implementaciones sobrantes de otra prueba.
    for (const m of [
      prismaMock.$transaction,
      prismaMock.$executeRaw,
      prismaMock.stampCard.findFirst,
      prismaMock.stampEvent.count,
      prismaMock.stampReward.findUnique,
      prismaMock.stampReward.create,
      prismaMock.stampReward.update,
    ])
      m.mockReset()
    prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as never)
    prismaMock.$executeRaw.mockResolvedValue(0 as never)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(CONFIG as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1' } as any)
    prismaMock.stampCard.create.mockResolvedValue({ id: 'sc-nueva', cycle: 1, stampsEarned: 0, stampsRequired: 10 } as any)
    prismaMock.stampCard.update.mockResolvedValue({} as any)
    prismaMock.stampEvent.create.mockResolvedValue({ id: 'se1' } as any)
    prismaMock.stampReward.findUnique.mockResolvedValue(null)
    prismaMock.stampReward.create.mockResolvedValue({ id: 'rw1' } as any)
    // Por defecto: la tarjeta 1 con 2 de 10 y dos asientos.
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 2, stampsRequired: 10 } })
  })

  it('sube de 2 a 7: asiento ADJUST +5 con motivo y autor, contador 7, no completa', async () => {
    // El motivo se guarda recortado.
    const r = await adjustStamps('v1', 'c1', pedir({ reason: '  Cartón de papel ' }))

    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ADJUST',
        quantity: 5,
        reason: 'Cartón de papel',
        createdById: 'sv1',
        orderId: null,
        venueId: 'v1',
        stampCardId: 'sc1',
      }),
    })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc1' }, data: { stampsEarned: 7 } })
    expect(r).toEqual({ stampCardId: 'sc1', from: 2, to: 7, delta: 5, completed: false, stampsRequired: 10 })
    expect(prismaMock.stampReward.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
  })

  it('baja de 5 a 2 (corrección): asiento −3', async () => {
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 5, stampsRequired: 10 } })

    const r = await adjustStamps('v1', 'c1', pedir({ stampsEarned: 2, expectedStampsEarned: 5, expectedVersion: 5 }))

    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'ADJUST', quantity: -3 }) })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc1' }, data: { stampsEarned: 2 } })
    expect(r).toMatchObject({ from: 5, to: 2, delta: -3, completed: false })
  })

  it('a 0 está permitido; abajo de 0 lo rechaza el esquema', async () => {
    const r = await adjustStamps('v1', 'c1', pedir({ stampsEarned: 0 }))

    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ quantity: -2 }) })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc1' }, data: { stampsEarned: 0 } })
    expect(r).toMatchObject({ to: 0, delta: -2, completed: false })
  })

  it('🔴 llegar a la meta completa la tarjeta: premio PENDING y tarjeta nueva en 0', async () => {
    const r = await adjustStamps('v1', 'c1', pedir({ stampsEarned: 10 }))

    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc1' }, data: { stampsEarned: 10 } })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc1' }, data: { completedAt: expect.any(Date) } })
    expect(prismaMock.stampReward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stampCardId: 'sc1',
          customerId: 'c1',
          venueId: 'v1',
          status: 'PENDING',
          rewardLabel: 'Un café gratis',
        }),
      }),
    )
    expect(prismaMock.stampCard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: 'v1', customerId: 'c1', cycle: 2, stampsRequired: 10, stampsEarned: 0 }),
    })
    expect(r).toMatchObject({ stampCardId: 'sc1', from: 2, to: 10, delta: 8, completed: true, rewardId: 'rw1' })
  })

  it('🔴 con un premio CANCELLED de esa tarjeta lo reactiva en vez de crear otro (D1)', async () => {
    prismaMock.stampReward.findUnique.mockResolvedValue({ id: 'rw-viejo', status: 'CANCELLED' } as any)
    prismaMock.stampReward.update.mockResolvedValue({ id: 'rw-viejo' } as any)

    const r = await adjustStamps('v1', 'c1', pedir({ stampsEarned: 10 }))

    expect(prismaMock.stampReward.create).not.toHaveBeenCalled()
    expect(prismaMock.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rw-viejo' }, data: expect.objectContaining({ status: 'PENDING', redeemedAt: null }) }),
    )
    expect(r).toMatchObject({ completed: true, rewardId: 'rw-viejo' })
  })

  it('🔴 si ya hay otra abierta, no crea una tercera (D2)', async () => {
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 2, stampsRequired: 10 }, otraAbierta: { id: 'sc2' }, ultima: { cycle: 2 } })

    const r = await adjustStamps('v1', 'c1', pedir({ stampsEarned: 10 }))

    expect(r).toMatchObject({ completed: true, rewardId: 'rw1' })
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
  })

  it('sin tarjeta y se esperaba null: la crea y ajusta', async () => {
    estado({ abierta: null, ultima: null })

    const r = await adjustStamps(
      'v1',
      'c1',
      pedir({ stampsEarned: 3, expectedStampCardId: null, expectedStampsEarned: 0, expectedVersion: 0 }),
    )

    // Igual que `grantStamp`: ciclo = último + 1, la meta de la config de hoy, 0 sellos.
    expect(prismaMock.stampCard.create).toHaveBeenCalledWith({
      data: { venueId: 'v1', customerId: 'c1', cycle: 1, stampsRequired: 10, stampsEarned: 0 },
    })
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ stampCardId: 'sc-nueva', quantity: 3 }) })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc-nueva' }, data: { stampsEarned: 3 } })
    // Sin tarjeta no hay asientos que contar.
    expect(prismaMock.stampEvent.count).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stampCardId: 'sc-nueva', from: 0, to: 3, delta: 3, completed: false })
  })

  it('🔴 sin tarjeta pero se esperaba un id ⇒ STAMPS_CHANGED', async () => {
    estado({ abierta: null, ultima: null })

    await expect(adjustStamps('v1', 'c1', pedir())).rejects.toMatchObject({
      statusCode: 409,
      code: 'STAMPS_CHANGED',
      details: { stampCardId: null, stampsEarned: 0, stampsRequired: 10, version: 0, rewardLabel: 'Un café gratis' },
    })
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it.each<[string, Parameters<typeof estado>[0], Partial<AdjustStampsInput>, Record<string, unknown>]>([
    [
      'otra tarjeta',
      { abierta: { id: 'sc2', cycle: 2, stampsEarned: 2, stampsRequired: 10 }, version: 2 },
      {},
      { stampCardId: 'sc2', stampsEarned: 2, stampsRequired: 10, version: 2, rewardLabel: 'Un café gratis' },
    ],
    [
      'otro número',
      { abierta: { id: 'sc1', cycle: 1, stampsEarned: 3, stampsRequired: 10 }, version: 2 },
      {},
      { stampCardId: 'sc1', stampsEarned: 3, stampsRequired: 10, version: 2, rewardLabel: 'Un café gratis' },
    ],
    [
      'otra versión',
      { abierta: { id: 'sc1', cycle: 1, stampsEarned: 2, stampsRequired: 10 }, version: 3 },
      {},
      { stampCardId: 'sc1', stampsEarned: 2, stampsRequired: 10, version: 3, rewardLabel: 'Un café gratis' },
    ],
    [
      'hay tarjeta y se esperaba ninguna',
      { abierta: { id: 'sc1', cycle: 1, stampsEarned: 0, stampsRequired: 10 }, version: 0 },
      { expectedStampCardId: null, expectedStampsEarned: 0, expectedVersion: 0 },
      { stampCardId: 'sc1', stampsEarned: 0, stampsRequired: 10, version: 0, rewardLabel: 'Un café gratis' },
    ],
  ])('🔴 CAS: %s ⇒ STAMPS_CHANGED, no se escribe nada', async (_n, base, over, actuales) => {
    estado(base)

    await expect(adjustStamps('v1', 'c1', pedir(over))).rejects.toMatchObject({
      statusCode: 409,
      code: 'STAMPS_CHANGED',
      details: actuales,
    })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
    expect(notifyCustomerPassUpdated).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  // F1 (pasada de la familia): la META es parte de lo que vio el gerente. Sin cartilla, «null/0/0» coincide aunque otro
  // administrador cambie la meta: con 10→5 un total de 5 regalaría un premio que nadie anunció; con 10→20 un «completa» ya
  // no completaría. Se compara ANTES de abrir la cartilla y antes de validar el total.
  it.each<[string, number, number]>([
    ['10→5 con total 5 (premio no anunciado)', 5, 5],
    ['10→20 con total 10 (el premio anunciado no llega)', 20, 10],
  ])('🔴 F1 sin cartilla y la meta cambió %s ⇒ STAMPS_CHANGED, sin cartilla, sin ADJUST y sin premio', async (_n, metaNueva, total) => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG, stampsRequired: metaNueva } as any)
    estado({ abierta: null, ultima: null })

    await expect(
      adjustStamps(
        'v1',
        'c1',
        pedir({ stampsEarned: total, expectedStampCardId: null, expectedStampsEarned: 0, expectedVersion: 0, expectedStampsRequired: 10 }),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'STAMPS_CHANGED',
      details: { stampCardId: null, stampsEarned: 0, stampsRequired: metaNueva, version: 0, rewardLabel: 'Un café gratis' },
    })
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
    expect(prismaMock.stampReward.create).not.toHaveBeenCalled()
  })

  it('🔴 F1 con cartilla: una meta distinta de la de la cartilla ⇒ STAMPS_CHANGED, sin escrituras', async () => {
    // La cartilla es de 10 (congelada); quien pide vio 8.
    await expect(adjustStamps('v1', 'c1', pedir({ expectedStampsRequired: 8 }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'STAMPS_CHANGED',
      details: { stampCardId: 'sc1', stampsEarned: 2, stampsRequired: 10, version: 2, rewardLabel: 'Un café gratis' },
    })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
    expect(prismaMock.stampReward.create).not.toHaveBeenCalled()
  })

  // Codex r2 #1: comparar id y número no basta. El ajuste 9 → 10 completa la tarjeta 1; una devolución de una venta vieja
  // le quita un sello y la REABRE en 9 (D3, es la llena con premio por cobrar). La abierta más vieja vuelve a ser la 1 con 9:
  // el reintento del panel cumpliría id y número y volvería a regalar el premio. Sólo la versión lo distingue.
  it('🔴 Codex r2 #1: completa, una devolución reabre la MISMA tarjeta al mismo número, y el reintento rebota', async () => {
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 9, stampsRequired: 10 }, version: 9 })
    const peticion = pedir({ stampsEarned: 10, expectedStampsEarned: 9, expectedVersion: 9 })

    expect(await adjustStamps('v1', 'c1', peticion)).toMatchObject({ completed: true })

    // Después de la devolución: la misma tarjeta, el mismo número, y dos asientos más (el ADJUST y la REVERSAL).
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 9, stampsRequired: 10 }, version: 9 + 2 })

    await expect(adjustStamps('v1', 'c1', peticion)).rejects.toMatchObject({
      code: 'STAMPS_CHANGED',
      details: { stampCardId: 'sc1', stampsEarned: 9, version: 11 },
    })
    expect(prismaMock.stampEvent.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.stampReward.create).toHaveBeenCalledTimes(1)
  })

  it('igual al actual ⇒ NO_CHANGE', async () => {
    await expect(adjustStamps('v1', 'c1', pedir({ stampsEarned: 2 }))).rejects.toMatchObject({ statusCode: 400, code: 'NO_CHANGE' })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it('🔴 la meta es la de la TARJETA: 8 se acepta con tarjeta de 10 y config de 7, y 8 ⇒ ABOVE_GOAL con tarjeta de 7 y config de 10', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG, stampsRequired: 7 } as any)
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 2, stampsRequired: 10 } })

    expect(await adjustStamps('v1', 'c1', pedir({ stampsEarned: 8 }))).toMatchObject({ to: 8, completed: false, stampsRequired: 10 })
    expect(prismaMock.stampReward.create).not.toHaveBeenCalled()

    jest.clearAllMocks()
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG, stampsRequired: 10 } as any)
    estado({ abierta: { id: 'sc1', cycle: 1, stampsEarned: 2, stampsRequired: 7 } })

    await expect(adjustStamps('v1', 'c1', pedir({ stampsEarned: 8, expectedStampsRequired: 7 }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'ABOVE_GOAL',
    })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    ['5 espacios', '     '],
    ['501 caracteres', 'x'.repeat(501)],
  ])('motivo de %s ⇒ INVALID_REASON', async (_n, reason) => {
    await expect(adjustStamps('v1', 'c1', pedir({ reason }))).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REASON' })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['sin config', null],
    ['programa inactivo', { ...CONFIG, active: false }],
    ['sellos apagados', { ...CONFIG, stampsEnabled: false }],
  ])('programa apagado (%s) ⇒ STAMPS_DISABLED, sin escrituras', async (_n, config) => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(config as any)

    await expect(adjustStamps('v1', 'c1', pedir())).rejects.toMatchObject({ statusCode: 409, code: 'STAMPS_DISABLED' })
    // F3: la config se lee DENTRO de la transacción, así que el rechazo sale de ahí sin tocar la cartilla.
    expect(prismaMock.stampCard.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
  })

  it('cliente de otro venue ⇒ NotFound', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null)

    await expect(adjustStamps('v1', 'c1', pedir())).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', venueId: 'v1' } }))
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 el candado del cliente es la PRIMERA sentencia, y la config se lee DESPUÉS de él (F3)', async () => {
    const orden: string[] = []
    // F3: si la config se leyera antes del candado, un apagado o un cambio de meta mientras el ajuste espera al cliente
    // no se vería. Leída dentro, después del candado, una sola lectura compara y abre la cartilla.
    prismaMock.loyaltyConfig.findUnique.mockImplementation((async () => {
      orden.push('config')
      return CONFIG
    }) as never)
    prismaMock.$transaction.mockImplementation((async (cb: any) => {
      orden.push('BEGIN')
      return cb(prismaMock)
    }) as never)
    prismaMock.$executeRaw.mockImplementation((async () => {
      orden.push('candado')
      return 0
    }) as never)
    prismaMock.stampCard.findFirst.mockImplementation((async () => {
      orden.push('cartilla')
      return { id: 'sc1', cycle: 1, stampsEarned: 2, stampsRequired: 10 }
    }) as never)
    prismaMock.stampEvent.count.mockImplementation((async () => {
      orden.push('versión')
      return 2
    }) as never)
    prismaMock.stampEvent.create.mockImplementation((async () => {
      orden.push('asiento')
      return { id: 'se1' }
    }) as never)

    await adjustStamps('v1', 'c1', pedir())

    expect(orden).toEqual(['BEGIN', 'candado', 'config', 'cartilla', 'versión', 'asiento'])
    expect(prismaMock.loyaltyConfig.findUnique).toHaveBeenCalledTimes(1)
    // El MISMO candado (negocio, cliente) que `grantStamp` y la reversa; no hay venta, así que no hay segundo candado.
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1)
    const [plantilla, ...valores] = prismaMock.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(plantilla.join('?')).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?))')
    expect(valores).toEqual(['v1', 'c1'])
    // La abierta MÁS VIEJA, la misma que llena `grantStamp` (D2), y la versión se cuenta sobre ella.
    expect((prismaMock.stampCard.findFirst as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: { venueId: 'v1', customerId: 'c1', completedAt: null },
      orderBy: { cycle: 'asc' },
    })
    expect(prismaMock.stampEvent.count).toHaveBeenCalledWith({ where: { stampCardId: 'sc1' } })
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 15_000 })
  })

  it('avisa al Wallet y NO manda el correo de primer sello', async () => {
    await adjustStamps('v1', 'c1', pedir())

    expect(notifyCustomerPassUpdated).toHaveBeenCalledWith('v1', 'c1')
    // Un ajuste es una migración del cartón, no una visita.
    expect(sendFirstStampEmailIfDue).not.toHaveBeenCalled()
  })

  it('🔴 ActivityLog STAMPS_ADJUSTED con staffId = actorStaffId', async () => {
    await adjustStamps('v1', 'c1', pedir())

    expect(logAction).toHaveBeenCalledWith({
      staffId: 's1',
      venueId: 'v1',
      action: 'STAMPS_ADJUSTED',
      entity: 'Customer',
      entityId: 'c1',
      data: { stampCardId: 'sc1', from: 2, to: 7, delta: 5, reason: 'Cartón de papel', completed: false, rewardId: undefined },
    })
  })

  it('sin staffVenueId (dueño sin fila en StaffVenue) el asiento va con createdById null', async () => {
    await adjustStamps('v1', 'c1', pedir({ staffVenueId: undefined }))

    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdById: null }) })
    // Su autoría queda en la bitácora.
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: 's1' }))
  })
})
