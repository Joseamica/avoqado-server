import { Prisma } from '@prisma/client'

import {
  COBRO_SIN_MARCA_DE_TURNO_CERRADO,
  cajaDeLaVentaDe,
  claimShiftForCapturedPayment,
  esVentaDeCajaCerrada,
  laCajaDeLaVenta,
  marcaDeCajaDeLaVenta,
  marcaDeCajaDeLaVentaCerrada,
  recordPendingPaymentShiftReconciliation,
  turnoDeLaOrdenQueNace,
  ventaDeLaColaEnTx,
} from '@/services/shared/paymentShiftClaim'

// 🔴 S3 «Efectivo sin red en el turno correcto»: el POS (ANDROID/iOS) manda la CAJA en que cobró; su turno ligado (1:1) es el turno
// de la venta. Con caja capturada, la caja manda sobre el turno de la orden (Codex plan r3 #1: la cuenta que el replay materializa al
// reconectar nace en el vivo). Una caja cerrada SIN turno ligado no es «no vino nada» (r3 #2): el cobro queda aparte.

const VENUE_ID = 'venue-1'

function makeTx(
  candidate: { id: string; status: string } | null,
  {
    turnoDeLaOrden = null as string | null,
    cajas = [] as Array<{ id: string; venueId: string; status: string; shiftId: string | null }>,
  } = {},
) {
  return {
    shift: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (typeof where?.id !== 'string') return candidate
        return where.venueId === VENUE_ID ? { id: where.id } : null
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    order: { findFirst: jest.fn().mockResolvedValue({ shiftId: turnoDeLaOrden }) },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    orderItem: { findFirst: jest.fn().mockResolvedValue(null) },
    cashDrawerSession: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const caja: any = cajas.find(c => c.id === where.id && c.venueId === where.venueId)
        if (!caja) return null
        // Una caja cerrada de estas pruebas la cerró una PERSONA contando, salvo que diga lo contrario (`sinConteo`).
        const contada = caja.status === 'CLOSED' && !caja.sinConteo
        return {
          id: caja.id,
          status: caja.status,
          shiftId: caja.shiftId,
          actualAmount: contada ? '1000.00' : null,
          closedByStaffId: contada ? 'cajero-1' : null,
        }
      }),
    },
    // El cobro nunca aparta la caja ni el turno con SQL crudo (Codex r3 código #3): si alguien lo llama, la prueba lo dice.
    $queryRaw: jest.fn(),
  }
}

const base = {
  venueId: VENUE_ID,
  amountPesos: new Prisma.Decimal('100.00'),
  tipPesos: new Prisma.Decimal('0.00'),
  incrementTotalOrders: true,
  orderId: 'order-1',
}

describe('laCajaDeLaVenta', () => {
  it('sin caja ⇒ null, sin consultar', async () => {
    const tx = makeTx(null)
    for (const id of [undefined, null, '']) expect(await laCajaDeLaVenta(tx as never, VENUE_ID, id)).toBeNull()
    expect(tx.cashDrawerSession.findFirst).not.toHaveBeenCalled()
  })

  it('caja de otro negocio o inexistente ⇒ null (se ignora, como un turno inventado)', async () => {
    const tx = makeTx(null, { cajas: [{ id: 'caja-ajena', venueId: 'otro-negocio', status: 'CLOSED', shiftId: 't-x' }] })
    expect(await laCajaDeLaVenta(tx as never, VENUE_ID, 'caja-ajena')).toBeNull()
    expect(await laCajaDeLaVenta(tx as never, VENUE_ID, 'no-existe')).toBeNull()
    // Acotada al negocio que cobra: la caja de otro negocio no aparece.
    expect(tx.cashDrawerSession.findFirst).toHaveBeenCalledWith({
      where: { id: 'caja-ajena', venueId: VENUE_ID },
      select: { id: true, status: true, shiftId: true, actualAmount: true, closedByStaffId: true },
    })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('caja de este negocio ⇒ su estado y su turno ligado', async () => {
    const tx = makeTx(null, { cajas: [{ id: 'caja-A', venueId: VENUE_ID, status: 'CLOSED', shiftId: 'turno-A' }] })
    expect(await laCajaDeLaVenta(tx as never, VENUE_ID, 'caja-A')).toEqual({
      id: 'caja-A',
      status: 'CLOSED',
      shiftId: 'turno-A',
      cerradaSinConteo: false,
    })
  })
})

describe('claim con caja capturada', () => {
  it('la caja manda sobre el turno de la orden: cuenta materializada en B + caja de A cerrado ⇒ SALE_SHIFT_CLOSED', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, { turnoDeLaOrden: 'turno-B' })

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A', cajaCapturada: true })

    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'turno-A' })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(tx.order.findFirst).not.toHaveBeenCalled()
  })

  it('sin caja capturada (la cola de la TPV con shiftIdDeLaVenta) la regla de la orden sigue igual: manda el turno de la orden', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, { turnoDeLaOrden: 'turno-B' })

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toEqual({ shiftId: 'turno-B', candidateShiftId: 'turno-B', observedStatus: 'OPEN', pendingReason: null })
  })

  it('caja cerrada SIN turno ligado ⇒ aparte: SALE_DRAWER_CLOSED con la caja, sin buscar ni sumar al vivo', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' })

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, apartePorCajaCerrada: { cajaId: 'caja-vieja' } })

    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'turno-B',
      observedStatus: 'OPEN',
      pendingReason: 'SALE_DRAWER_CLOSED',
      saleDrawerId: 'caja-vieja',
    })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
  })

  it('la conciliación lleva el motivo y la caja de la venta', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' })
    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, apartePorCajaCerrada: { cajaId: 'caja-vieja' } })

    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: 'payment-1',
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'payCashOrder',
      amountPesos: base.amountPesos,
      tipPesos: base.tipPesos,
      reconciliationEnabled: true,
    })

    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      status: 'PENDING',
      reason: 'SALE_DRAWER_CLOSED',
      saleDrawerId: 'caja-vieja',
      totalPesos: '100.00',
    })
  })
})

describe('marca de caja de la venta cerrada', () => {
  it('se escribe y se reconoce', () => {
    expect(marcaDeCajaDeLaVentaCerrada('caja-vieja')).toEqual({ cajaDeLaVentaCerrada: 'caja-vieja' })
    expect(marcaDeCajaDeLaVentaCerrada(undefined)).toBeUndefined()
    expect(esVentaDeCajaCerrada({ cajaDeLaVentaCerrada: 'caja-vieja' })).toBe(true)
    for (const v of [null, undefined, {}, [], 'x', { ventaDeTurnoCerrado: 't' }]) expect(esVentaDeCajaCerrada(v as never)).toBe(false)
  })

  it('el predicado de «cobro sin marca» excluye las DOS marcas (Codex plan r4 #2: el cierre y la lista no lo adoptan)', () => {
    expect(COBRO_SIN_MARCA_DE_TURNO_CERRADO).toEqual({
      AND: [
        { posRawData: { path: ['ventaDeTurnoCerrado'], equals: Prisma.AnyNull } },
        { posRawData: { path: ['cajaDeLaVentaCerrada'], equals: Prisma.AnyNull } },
      ],
    })
  })
})

describe('ventaDeLaColaEnTx — lo que la cola dice de la venta, resuelto una vez', () => {
  const cajas = [
    { id: 'caja-A', venueId: VENUE_ID, status: 'CLOSED', shiftId: 'turno-A' },
    { id: 'caja-B', venueId: VENUE_ID, status: 'OPEN', shiftId: 'turno-B' },
    { id: 'caja-vieja', venueId: VENUE_ID, status: 'CLOSED', shiftId: null },
    { id: 'caja-sin-turno-abierta', venueId: VENUE_ID, status: 'OPEN', shiftId: null },
  ]

  it('sin datos ⇒ nada (como hoy)', async () => {
    const tx = makeTx(null, { cajas })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, {})).toEqual({ expectedShiftId: null, cajaCapturada: false })
  })

  it('caja capturada ABIERTA ⇒ su turno ligado, con cajaCapturada y la caja para releerla (Codex r6 código #2)', async () => {
    const tx = makeTx(null, { cajas })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'caja-B' })).toEqual({
      expectedShiftId: 'turno-B',
      cajaCapturada: true,
      cajaId: 'caja-B',
      cajaLigadaAbierta: 'caja-B',
    })
  })

  // 🔴 Codex r6 (código) #2: la caja ligada se leyó abierta; al releerla tras el CAS ya está cerrada.
  it('caja ligada que alguien cerró CONTANDO a media transacción ⇒ se deshace la suma y queda aparte por su caja', async () => {
    const tx = makeTx(
      { id: 'turno-B', status: 'OPEN' },
      { cajas: [{ id: 'caja-B', venueId: VENUE_ID, status: 'CLOSED', shiftId: 'turno-B' }] },
    )
    const claim = await claimShiftForCapturedPayment(tx as never, {
      ...base,
      expectedShiftId: 'turno-B',
      cajaCapturada: true,
      cajaLigadaAbierta: 'caja-B',
    })
    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_DRAWER_CLOSED', saleDrawerId: 'caja-B' })
    expect(tx.shift.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.shift.updateMany.mock.calls[1][0].data).toMatchObject({
      totalSales: { decrement: base.amountPesos },
      totalOrders: { decrement: 1 },
    })
  })

  it('caja ligada que cerró SOLA el sistema a media transacción ⇒ la venta se queda en su turno', async () => {
    const tx = makeTx(
      { id: 'turno-B', status: 'OPEN' },
      { cajas: [{ id: 'caja-B', venueId: VENUE_ID, status: 'CLOSED', shiftId: 'turno-B', sinConteo: true } as never] },
    )
    const claim = await claimShiftForCapturedPayment(tx as never, {
      ...base,
      expectedShiftId: 'turno-B',
      cajaCapturada: true,
      cajaLigadaAbierta: 'caja-B',
    })
    expect(claim).toMatchObject({ shiftId: 'turno-B', pendingReason: null })
    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
  })

  // 🔴 Codex r7 (código) #1: el turno salió de una caja ya validada y lo borraron desde el panel a media subida.
  it('con caja capturada, un turno que ya no existe aparta la venta (y la orden nace sin turno), nunca va al vivo', async () => {
    const tx = makeTx({ id: 'turno-U', status: 'OPEN' })
    tx.shift.findFirst.mockImplementation(async ({ where }: any) =>
      typeof where?.id !== 'string' ? { id: 'turno-U', status: 'OPEN' } : null,
    )
    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-borrado', cajaCapturada: true })
    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'turno-borrado' })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    const venta = { expectedShiftId: 'turno-borrado', cajaCapturada: true, cajaId: 'caja-A' }
    expect(await turnoDeLaOrdenQueNace(tx as never, VENUE_ID, venta, { id: 'turno-U' })).toBeNull()
    // Sin caja (la terminal manda su turno), un id que no es de este negocio sigue «como si no viniera».
    tx.shift.updateMany.mockClear()
    const sinCaja = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'inventado' })
    expect(sinCaja.shiftId).toBe('turno-U')
  })

  it('la marca de la caja de la venta se lee igual que se escribe, y lo demás no es caja', () => {
    expect(cajaDeLaVentaDe(marcaDeCajaDeLaVenta('caja-A') as never)).toBe('caja-A')
    expect(marcaDeCajaDeLaVenta(undefined)).toBeUndefined()
    for (const raro of [null, undefined, 'caja-A', ['caja-A'], {}, { cajaDeLaVenta: 7 }, { cajaDeLaVenta: '' }]) {
      expect(cajaDeLaVentaDe(raro as never)).toBeNull()
    }
  })

  it('caja capturada CERRADA con su turno ⇒ ese turno y aparte (el claim decide SALE_SHIFT_CLOSED o SALE_DRAWER_CLOSED)', async () => {
    const tx = makeTx(null, { cajas })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'caja-A' })).toEqual({
      expectedShiftId: 'turno-A',
      cajaCapturada: true,
      apartePorCajaCerrada: { cajaId: 'caja-A' },
      cajaId: 'caja-A',
    })
  })

  it('caja cerrada sin turno ligado ⇒ aparte por caja cerrada', async () => {
    const tx = makeTx(null, { cajas })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'caja-vieja' })).toEqual({
      expectedShiftId: null,
      cajaCapturada: true,
      apartePorCajaCerrada: { cajaId: 'caja-vieja' },
      cajaId: 'caja-vieja',
    })
  })

  it('caja que cerró el SISTEMA sola (sin conteo) con su turno ⇒ ese turno, SIN aparte (Codex r5 código #3)', async () => {
    const tx = makeTx(null, {
      cajas: [{ id: 'caja-auto', venueId: VENUE_ID, status: 'CLOSED', shiftId: 'turno-T', sinConteo: true } as never],
    })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'caja-auto' })).toEqual({
      expectedShiftId: 'turno-T',
      cajaCapturada: true,
      cajaId: 'caja-auto',
    })
  })

  it('caja CERRADA aunque conserve su turno ligado ⇒ también aparte (Codex r4 código #1), con su turno para el D4', async () => {
    const tx = makeTx(null, { cajas: [{ id: 'caja-cerrada-ligada', venueId: VENUE_ID, status: 'CLOSED', shiftId: 'turno-T' }] })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'caja-cerrada-ligada' })).toEqual({
      expectedShiftId: 'turno-T',
      cajaCapturada: true,
      apartePorCajaCerrada: { cajaId: 'caja-cerrada-ligada' },
      cajaId: 'caja-cerrada-ligada',
    })
  })

  it('caja ABIERTA sin turno ligado ⇒ como hoy (no hay turno de la venta ni nada que apartar)', async () => {
    const tx = makeTx(null, { cajas })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'caja-sin-turno-abierta' })).toEqual({
      expectedShiftId: null,
      cajaCapturada: true,
      cajaId: 'caja-sin-turno-abierta',
      // Codex r4 código #2: se relee tras el claim; si cambió a media transacción, la venta queda aparte.
      cajaSinTurno: 'caja-sin-turno-abierta',
    })
  })

  it('caja de otro negocio o inexistente ⇒ como si no viniera', async () => {
    const tx = makeTx(null, { cajas })
    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { cashDrawerSessionId: 'no-existe' })).toEqual({
      expectedShiftId: null,
      cajaCapturada: false,
    })
  })

  it('turno de la venta (TPV) y caja a la vez ⇒ manda el turno de la venta; si no coinciden, rastro en el log', async () => {
    const logger = (await import('@/config/logger')).default
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    const tx = makeTx(null, { cajas })

    expect(await ventaDeLaColaEnTx(tx as never, VENUE_ID, { shiftIdDeLaVenta: 'turno-X', cashDrawerSessionId: 'caja-A' })).toEqual({
      expectedShiftId: 'turno-X',
      cajaCapturada: false,
    })
    expect(warn).toHaveBeenCalledWith(
      '[TURNO DE LA VENTA] La caja y el turno de la venta no coinciden',
      expect.objectContaining({ venueId: VENUE_ID, shiftIdDeLaVenta: 'turno-X', cashDrawerSessionId: 'caja-A', turnoDeLaCaja: 'turno-A' }),
    )
    warn.mockRestore()
  })
})

describe('turnoDeLaOrdenQueNace — la cuenta que nace en el replay', () => {
  const vivo = { id: 'turno-B' }

  it('sin datos o con el turno vivo ⇒ el vivo (como hoy)', async () => {
    const tx = makeTx(null)
    expect(await turnoDeLaOrdenQueNace(tx as never, VENUE_ID, { expectedShiftId: null, cajaCapturada: false }, vivo)).toBe(vivo)
    expect(await turnoDeLaOrdenQueNace(tx as never, VENUE_ID, { expectedShiftId: 'turno-B', cajaCapturada: true }, vivo)).toBe(vivo)
  })

  it('turno de la venta cerrado de este negocio ⇒ sin turno; inventado ⇒ el vivo', async () => {
    const tx = makeTx(null)
    expect(await turnoDeLaOrdenQueNace(tx as never, VENUE_ID, { expectedShiftId: 'turno-A', cajaCapturada: true }, vivo)).toBeNull()
    const ajeno = { ...makeTx(null), shift: { findFirst: jest.fn().mockResolvedValue(null) } }
    expect(await turnoDeLaOrdenQueNace(ajeno as never, VENUE_ID, { expectedShiftId: 'inventado', cajaCapturada: false }, vivo)).toBe(vivo)
  })

  it('caja cerrada sin turno ⇒ sin turno, aunque haya vivo', async () => {
    const tx = makeTx(null)
    const venta = { expectedShiftId: null, cajaCapturada: true, apartePorCajaCerrada: { cajaId: 'caja-vieja' } }
    expect(await turnoDeLaOrdenQueNace(tx as never, VENUE_ID, venta, vivo)).toBeNull()
  })
})

describe('laCajaDeLaVenta — sin candados (Codex r3 código #3)', () => {
  it('ligada, cerrada o abierta sin turno ⇒ lectura simple: nunca SQL crudo con FOR SHARE / FOR NO KEY UPDATE', async () => {
    const cajas = [
      { id: 'ligada', venueId: VENUE_ID, status: 'OPEN', shiftId: 'turno-A' },
      { id: 'cerrada', venueId: VENUE_ID, status: 'CLOSED', shiftId: null },
      { id: 'sin-turno', venueId: VENUE_ID, status: 'OPEN', shiftId: null },
    ]
    const tx = makeTx(null, { cajas })
    for (const id of ['ligada', 'cerrada', 'sin-turno']) await laCajaDeLaVenta(tx as never, VENUE_ID, id)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.cashDrawerSession.findFirst).toHaveBeenCalledTimes(3)
  })
})
