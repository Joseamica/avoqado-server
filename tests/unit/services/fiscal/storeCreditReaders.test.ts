/**
 * La pasada de lectores del saldo a favor (spec 2026-10-30-saldo-a-favor §5.3, tarea S8b). Inventario y decisiones:
 * docs/audit/2026-10-30-saldo-a-favor/lectores-de-systemkind.md (workspace).
 *
 * Dos reglas:
 * - lo gastado de un sobre de saldo a favor es VENTA NORMAL (su devolución ya restó la venta original), nunca «saldo de tarjeta
 *   vendida»; se clasifica POR CANJE (un cobro puede canjear una tarjeta vendida y un sobre de saldo a la vez) y la devolución de ese
 *   cobro, por sus REDEEM_REVERSAL;
 * - la devolución a saldo (medio STORE_CREDIT) es una devolución de la venta, no física: ni «saldo de tarjeta vendida», ni dinero que
 *   sale, ni algo que la cajera pueda «devolver con» otro medio.
 *
 * Los lectores síncronos (el acumulador del ISR) cargan la clasificación del lote ANTES de recorrer (Codex plan r3, hallazgo 4); los que
 * agregan en SQL usan la subconsulta. Las cifras de SQL contra Postgres real: tests/integration/storeCredit/lectoresDeSaldo.
 */
import { Prisma } from '@prisma/client'

jest.mock('@/services/fiscal/librosDeOrdenes', () => ({
  ...jest.requireActual('@/services/fiscal/librosDeOrdenes'),
  recorrerLibros: jest.fn(),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { recorrerLibros } from '@/services/fiscal/librosDeOrdenes'
import { tarjetasDeRegaloEnFoto } from '@/services/fiscal/tarjetasDeRegaloEnElIsr'
import { LIMITES_DEL_REPORTE, estadoDeResultadosEnFoto } from '@/services/dashboard/accounting.dashboard.service'
import { computeGiftCardFigures } from '@/services/dashboard/sales-summary.dashboard.service'
import { listPendingAccountingReview } from '@/services/giftCards/giftCardReports.service'
import { WHERE_DEVOLUCION_A_SALDO_A_FAVOR, WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE } from '@/services/giftCards/giftCardMarks'
import { esPendienteDeRevisionContable } from '@/services/fiscal/autoPosting.service'
import { resolveTenderForCharge, updateTenderType } from '@/services/dashboard/tenderType.dashboard.service'
import { sePuedeEscogerComoDevolver } from '@/services/tpv/terminalRefundTarget'
import { montoSaldoAFavorSql, saldoAFavorPorFila, sqlNoEsDelMedioSaldoAFavor } from '@/services/storeCredit/saldoAFavorEnLectores'

const mRecorrer = recorrerLibros as jest.Mock
const T = new Date('2026-10-15T18:00:00.000Z')
const D = (v: string | number) => new Prisma.Decimal(v)

beforeEach(() => {
  jest.clearAllMocks()
})

// ── La herramienta ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('saldoAFavorPorFila y montoSaldoAFavorSql', () => {
  it('🔴 UNA consulta por lote: el cobro por sus REDEEM, la devolución por sus REDEEM_REVERSAL, con EL predicado del sobre', async () => {
    const db = {
      $queryRaw: jest.fn(async () => [
        { id: 'p1', cents: 20000 },
        { id: 'r1', cents: 4000 },
      ]),
    }
    const m = await saldoAFavorPorFila(db as never, [
      { id: 'p1', type: 'REGULAR' },
      { id: 'p0', type: null },
      { id: 'r1', type: 'REFUND' },
    ])
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
    expect(m).toEqual(
      new Map([
        ['p1', 20000],
        ['r1', 4000],
      ]),
    )
    const q = (db.$queryRaw.mock.calls[0] as unknown[])[0] as Prisma.Sql
    expect(q.sql).toMatch(/a\.type = 'REDEEM' AND a\."paymentId" = ANY/)
    expect(q.sql).toMatch(/a\.type = 'REDEEM_REVERSAL' AND a\."refundPaymentId" = ANY/)
    // EL predicado: el sobre nació de una devolución (ACTIVATE con refundPaymentId), no «tiene cliente».
    expect(q.sql).toContain(`saldo_a_favor_act.type = 'ACTIVATE' AND saldo_a_favor_act."refundPaymentId" IS NOT NULL`)
    // Los cobros sin tipo (legado) son cobros; la devolución va aparte.
    expect(q.values).toEqual([['p1', 'p0'], ['r1']])
  })

  it('sin filas no consulta', async () => {
    const db = { $queryRaw: jest.fn() }
    expect(await saldoAFavorPorFila(db, [])).toEqual(new Map())
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('las subconsultas de SQL: la suma por canje con EL predicado y el medio de la devolución a saldo; alias cerrado', () => {
    const monto = montoSaldoAFavorSql('p')
    expect(monto.sql).toContain(`sf_a.type = 'REDEEM' AND sf_a."paymentId" = "p".id`)
    expect(monto.sql).toContain(`sf_a.type = 'REDEEM_REVERSAL' AND sf_a."refundPaymentId" = "p".id`)
    expect(monto.sql).toContain('saldo_a_favor_act."refundPaymentId" IS NOT NULL')
    expect(monto.values).toEqual([])
    expect(sqlNoEsDelMedioSaldoAFavor('p').sql).toBe(
      `NOT EXISTS (SELECT 1 FROM "VenueTenderType" sc_t WHERE sc_t."venueId" = "p"."venueId" AND sc_t.id = "p"."tenderTypeId" AND sc_t."systemKind" = 'STORE_CREDIT')`,
    )
    expect(() => montoSaldoAFavorSql('p; DROP')).toThrow(/Alias SQL inválido/)
    expect(() => sqlNoEsDelMedioSaldoAFavor('p"')).toThrow(/Alias SQL inválido/)
  })
})

// ── ISR (tarjetasDeRegaloEnElIsr) ──────────────────────────────────────────────────────────────────────────────────────

type Mov = { id: string; type: 'REGULAR' | 'REFUND'; amountCents: number; tipCents?: number; netCents: number }

/** La foto del ISR de UNA cuenta de mercancía pagada con el medio de tarjetas; `saldo` = lo que dirían sus REDEEM/REDEEM_REVERSAL. */
function fotoDelIsr(movs: Mov[], saldo: Record<string, number>, demoraMs = 0) {
  const consultas: string[] = []
  const tx = {
    giftCard: { findFirst: jest.fn(async () => (consultas.push('hayTarjetas'), { id: 'gc' })) },
    fiscalEmisor: { findFirst: jest.fn(async () => (consultas.push('emisor'), null)) },
    payment: {
      findMany: jest.fn(async () => (consultas.push('cobrosConSaldo'), movs.map(m => ({ id: m.id, type: m.type })))),
    },
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      if (q.sql.includes('"GiftCardActivity"')) {
        consultas.push('saldoAFavor')
        if (demoraMs > 0) await new Promise(r => setTimeout(r, demoraMs))
        return Object.entries(saldo).map(([id, cents]) => ({ id, cents }))
      }
      consultas.push('ordenes')
      return [{ orderId: 'o1', deTarjetas: false }]
    }),
  }
  mRecorrer.mockImplementation(async (_tx: unknown, _p: unknown, alMovimiento: (m: unknown, parte: unknown) => void) => {
    for (const m of movs) {
      alMovimiento(
        {
          id: m.id,
          orderId: 'o1',
          createdAt: T,
          type: m.type,
          amountCents: m.amountCents,
          tipCents: m.tipCents ?? 0,
          method: 'OTHER',
          incluirEnContabilidad: undefined,
          tenderSystemKind: 'GIFT_CARD',
        },
        { netCents: m.netCents, aproximada: false },
      )
    }
    return { consultas: 1, filas: movs.length }
  })
  const correr = () =>
    tarjetasDeRegaloEnFoto(
      tx as unknown as Prisma.TransactionClient,
      { id: 'v1', timezone: 'America/Mexico_City' },
      { from: '2026-10-01', to: '2026-10-31' },
      LIMITES_DEL_REPORTE,
    )
  return { tx, consultas, correr }
}

// $500 con IVA incluido = 43,103 centavos sin IVA; $100 = 8,621; $200 = 17,241.
const COBRO_MIXTO: Mov = { id: 'p1', type: 'REGULAR', amountCents: 50000, netCents: 43103 }

describe('ISR · tarjetas de regalo en el estimado (tarjetasDeRegaloEnFoto)', () => {
  it('🔴 un cobro que mezcla $300 de tarjeta regalada y $200 de saldo a favor: el ISR cuenta $200 como venta normal y $300 como hoy', async () => {
    const { correr } = fotoDelIsr([COBRO_MIXTO], { p1: 20000 })
    // Sólo los $300 de la tarjeta vendida van al aviso (300/1.16 = 258.62); los $200 de saldo a favor ya están en la base como venta.
    expect(await correr()).toEqual({ cargasCents: 0, pagadoConSaldoSinIvaCents: 25862 })
  })

  it('🔴 devolver $100 de esa compra (parcial): la devolución se reparte igual, por sus REDEEM_REVERSAL', async () => {
    // El reverso regresó los $100 a la tarjeta vendida (la libreta revierte en el orden de los canjes): la devolución resta entera del
    // «pagado con saldo». Con la proporción del cobro (60 %) habría restado 5,173 y no 8,621.
    const devolucion: Mov = { id: 'r1', type: 'REFUND', amountCents: -10000, netCents: -8621 }
    const aLaTarjeta = await fotoDelIsr([COBRO_MIXTO, devolucion], { p1: 20000 }).correr()
    expect(aLaTarjeta.pagadoConSaldoSinIvaCents).toBe(25862 - 8621)
    // Si el reverso hubiera regresado $40 al sobre de saldo a favor, sólo $60 restan del aviso.
    const repartida = await fotoDelIsr([COBRO_MIXTO, devolucion], { p1: 20000, r1: 4000 }).correr()
    expect(repartida.pagadoConSaldoSinIvaCents).toBe(25862 - (8621 - Math.round(8621 * 0.4)))
  })

  it('🔴 devolver una compra pagada sólo con saldo a favor: la devolución no sale como «saldo de tarjeta vendida» ni en el aviso al contador', async () => {
    // La compra fue el mes pasado: en este periodo sólo está su devolución, que regresó entera al sobre de saldo a favor. Antes salía
    // «sí resta $172.41 de devoluciones de lo pagado con saldo de tarjetas».
    const r = await fotoDelIsr([{ id: 'r2', type: 'REFUND', amountCents: -20000, netCents: -17241 }], { r2: 20000 }).correr()
    // Los dos importes en 0: el ISR no arma `avisoTarjetasDeRegalo` (isr.service.ts `avisoDeTarjetas`, prueba «sin tarjetas … SIN aviso»).
    expect(r).toEqual({ cargasCents: 0, pagadoConSaldoSinIvaCents: 0 })
  })

  it('🔴 una venta mixta 50/50 y su devolución completa en el mismo periodo dan 0 (redondeo simétrico: sin aviso de un centavo)', async () => {
    // $200 = $100 de saldo a favor + $100 de tarjeta vendida; sin IVA 17,241 (impar), así que la mitad es 8,620.5. Redondear con signo
    // dejaba la venta en 8,620 y su devolución en −8,621: «sí resta $0.01 de devoluciones…» sin que nada hubiera pasado.
    const r = await fotoDelIsr(
      [
        { id: 'p5', type: 'REGULAR', amountCents: 20000, netCents: 17241 },
        { id: 'r5', type: 'REFUND', amountCents: -20000, netCents: -17241 },
      ],
      { p5: 10000, r5: 10000 },
    ).correr()
    expect(r).toEqual({ cargasCents: 0, pagadoConSaldoSinIvaCents: 0 })
  })

  it('con propina, la parte de saldo a favor se mide sobre lo canjeado (venta + propina)', async () => {
    // $500 + $50 de propina canjeados: $220 del sobre de saldo a favor = 40 % ⇒ queda el 60 % de la venta sin IVA.
    const r = await fotoDelIsr([{ ...COBRO_MIXTO, tipCents: 5000 }], { p1: 22000 }).correr()
    expect(r.pagadoConSaldoSinIvaCents).toBe(25862)
  })

  it('🔴 el ISR completo con la clasificación cargada antes da las mismas cifras que con el mapa vacío más el reparto (clasificación demorada: no hay promesas sin esperar)', async () => {
    const movs: Mov[] = [COBRO_MIXTO, { id: 'r1', type: 'REFUND', amountCents: -10000, netCents: -8621 }]
    const demorada = await fotoDelIsr(movs, { p1: 20000, r1: 4000 }, 25).correr()
    const sinSaldo = await fotoDelIsr(movs, {}).correr()
    // El reparto, a mano: cada movimiento pierde su parte de saldo a favor.
    const reparto = Math.round(43103 * (20000 / 50000)) + Math.round(-8621 * (4000 / 10000))
    expect(sinSaldo.pagadoConSaldoSinIvaCents).toBe(43103 - 8621) // el mapa vacío = como antes de S8b
    expect(demorada.pagadoConSaldoSinIvaCents).toBe(sinSaldo.pagadoConSaldoSinIvaCents - reparto)
    expect(demorada.cargasCents).toBe(sinSaldo.cargasCents)
  })

  it('🔴 el número de consultas del ISR no crece con el número de movimientos (10 y 100)', async () => {
    const movimientos = (n: number): Mov[] =>
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: 'REGULAR' as const, amountCents: 10000, netCents: 8621 }))
    const saldoDe = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 5000]))
    const diez = fotoDelIsr(movimientos(10), saldoDe(10))
    const r10 = await diez.correr()
    const cien = fotoDelIsr(movimientos(100), saldoDe(100))
    const r100 = await cien.correr()
    expect(diez.consultas).toEqual(['hayTarjetas', 'emisor', 'ordenes', 'cobrosConSaldo', 'saldoAFavor'])
    expect(cien.consultas).toEqual(diez.consultas)
    expect(r10.pagadoConSaldoSinIvaCents).toBe(10 * (8621 - Math.round(8621 / 2)))
    expect(r100.pagadoConSaldoSinIvaCents).toBe(100 * (8621 - Math.round(8621 / 2)))
  })
})

// ── Estado de resultados: lo que el ISR resta por devoluciones a saldo (para su aviso) ───────────────────────────────────

describe('estado de resultados · el gancho de devoluciones a saldo a favor (aviso del ISR)', () => {
  const T0 = new Date('2026-10-15T18:00:00.000Z')
  const parte = (netCents: number) => ({ netCents, taxCents: 0, taxByRate: {}, porTratamiento: {}, aproximada: false })
  const devolucion = (id: string, systemKind: string | null, originalMethod: string, createdAt = T0) => ({
    id,
    orderId: 'o1',
    createdAt,
    type: 'REFUND',
    amountCents: -20000,
    tipCents: 0,
    method: 'OTHER',
    incluirEnContabilidad: undefined,
    ...(systemKind ? { tenderSystemKind: systemKind } : {}),
    processorData: { originalMethod },
  })

  it('🔴 avisa la parte sin IVA de cada devolución a saldo a favor del periodo y en el alcance fiscal, con la MISMA regla única; nada más', async () => {
    const tx = {
      fiscalEmisor: { findFirst: jest.fn(async () => ({ includeCashInAccounting: false })) },
      $queryRaw: jest.fn(async () => [{ orderId: 'o1' }]),
    }
    mRecorrer.mockImplementation(async (_tx: unknown, _p: unknown, alMovimiento: (m: unknown, parte: unknown) => void) => {
      alMovimiento(devolucion('a-saldo-tarjeta', 'STORE_CREDIT', 'CREDIT_CARD'), parte(-17241)) // ✓ en el alcance
      alMovimiento(devolucion('a-saldo-efectivo', 'STORE_CREDIT', 'CASH'), parte(-8621)) // el efectivo está fuera de los libros
      alMovimiento(devolucion('al-saldo-de-regalo', 'GIFT_CARD', 'OTHER'), parte(-4310)) // no es saldo a favor
      alMovimiento(devolucion('de-otro-mes', 'STORE_CREDIT', 'CREDIT_CARD', new Date('2026-09-15T18:00:00.000Z')), parte(-999))
      return { consultas: 1, filas: 4 }
    })
    const alDevolverASaldo = jest.fn()
    const r = await estadoDeResultadosEnFoto(
      tx as unknown as Prisma.TransactionClient,
      { id: 'v1', name: 'IQ', timezone: 'America/Mexico_City' },
      { from: '2026-10-01', to: '2026-10-31' },
      LIMITES_DEL_REPORTE,
      alDevolverASaldo,
    )
    expect(alDevolverASaldo.mock.calls).toEqual([[17241]])
    // La base fiscal sí la restó (S3): el aviso dice exactamente lo que la base restó.
    expect(r.fiscalRevenue.ingresosSinIvaCents).toBe(-17241 - 4310)
  })
})

// ── Resumen de ventas (computeGiftCardFigures) ─────────────────────────────────────────────────────────────────────────

describe('resumen de ventas · computeGiftCardFigures', () => {
  const INICIO = new Date('2026-10-01T06:00:00.000Z')
  const FIN = new Date('2026-11-01T05:59:59.999Z')
  const responder = (saldo: Record<string, unknown>) =>
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ amount: '1000', count: 2 }])
      .mockResolvedValueOnce([{ amount: '0' }])
      .mockResolvedValueOnce([saldo])
  /** La SQL de una llamada a `$queryRaw` (plantilla etiquetada), con sus fragmentos anidados. */
  const sqlDe = (call: unknown[]) => {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]]
    return Prisma.sql(strings, ...values).sql
  }

  it('🔴 «pagado con saldo» sólo cuenta tarjetas vendidas; las dos patas del saldo a favor salen aparte, para la barra de ventas', async () => {
    responder({
      amount: '300.00',
      count: 1,
      tips: '0',
      reversals: '100.00',
      storeCreditNet: '0.00',
      storeCreditCount: 2,
    })
    const f = await computeGiftCardFigures('v1', INICIO, FIN)
    expect(f).toMatchObject({
      balancePaid: 300,
      balanceCount: 1,
      balanceTips: 0,
      balanceReversals: 100,
      storeCreditNet: 0,
      storeCreditCount: 2,
    })
    const sql = sqlDe(prismaMock.$queryRaw.mock.calls[2])
    // La parte de cada canje que salió de un sobre de saldo a favor se resta, por EL predicado; el medio STORE_CREDIT entra a la consulta.
    expect(sql).toContain('saldo_a_favor_act."refundPaymentId" IS NOT NULL')
    expect(sql).toMatch(/t\."systemKind" IN \('GIFT_CARD', 'STORE_CREDIT'\)/)
  })

  describe('consultas', () => {
    afterEach(() => {
      // Lo que esta prueba sembró en el cliente global no se queda para las siguientes.
      prismaMock.$queryRaw.mockReset()
      prismaMock.payment.findMany.mockReset().mockResolvedValue([])
      prismaMock.giftCardActivity.findMany.mockReset().mockResolvedValue([])
    })

    /** Todas las llamadas a todo el cliente (cada modelo y cada `$queryRaw`): una lectura por fila se notaría aquí. */
    const consultasHechas = () => {
      let n = 0
      for (const v of Object.values(prismaMock as Record<string, unknown>)) {
        if (jest.isMockFunction(v)) n += v.mock.calls.length
        else if (v && typeof v === 'object')
          for (const f of Object.values(v as Record<string, unknown>)) if (jest.isMockFunction(f)) n += f.mock.calls.length
      }
      return n
    }

    /**
     * Una base falsa con N cobros con saldo: toda lectura por fila ve N filas (la lista de cobros, sus canjes, la clasificación por
     * fila), así que un N+1 haría N consultas más. Los tres agregados contestan una sola fila, como Postgres.
     */
    const sembrar = (n: number) => {
      const cobros = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: 'REGULAR', amount: D(100), tipAmount: D(0) }))
      prismaMock.payment.findMany.mockResolvedValue(cobros)
      prismaMock.giftCardActivity.findMany.mockResolvedValue(cobros.map(c => ({ paymentId: c.id, giftCardId: 'g', amount: D(50) })))
      prismaMock.$queryRaw.mockImplementation(async (...call: unknown[]) => {
        const sql = sqlDe(call)
        if (sql.includes('"storeCreditNet"'))
          return [{ amount: String(50 * n), count: n, tips: '0', reversals: '0', storeCreditNet: String(50 * n), storeCreditCount: 0 }]
        if (sql.includes('FROM "OrderItem" oi')) return [{ amount: '0', count: 0 }]
        if (sql.includes('SUM(ABS(p.amount))')) return [{ amount: '0' }]
        return cobros.map(c => ({ id: c.id, cents: 5000 }))
      })
    }

    it('🔴 el número de consultas del resumen de ventas no crece con el número de movimientos (10 y 100), contado en todo el cliente', async () => {
      sembrar(10)
      await computeGiftCardFigures('v1', INICIO, FIN)
      const con10 = consultasHechas()
      jest.clearAllMocks()
      sembrar(100)
      const f = await computeGiftCardFigures('v1', INICIO, FIN)
      expect(consultasHechas()).toBe(con10)
      expect(con10).toBe(3)
      expect(f).toMatchObject({ balancePaid: 5000, storeCreditNet: 5000 })
    })
  })
})

// ── Lista del contador y autoposteo: la misma regla ────────────────────────────────────────────────────────────────────

describe('pendientes de revisión contable · la devolución a saldo a favor', () => {
  const devolucionASaldo = {
    id: 'r-saldo',
    createdAt: new Date('2026-10-12T18:00:00.000Z'),
    amount: D('-200'),
    tipAmount: D('0'),
    method: 'OTHER',
    type: 'REFUND',
    tenderLabel: 'Saldo a favor',
    tenderType: { systemKind: 'STORE_CREDIT' },
    order: { id: 'o1', orderNumber: 'ORD-1' },
  }

  it('🔴 la devolución a saldo está en la lista del contador con la MISMA regla que el autoposteo, como reverso de saldo y en sus totales', async () => {
    // La marca de la lista la incluye, y el autoposteo la salta (S3): las dos dicen lo mismo.
    expect(WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE.OR).toContainEqual(WHERE_DEVOLUCION_A_SALDO_A_FAVOR)
    expect(WHERE_DEVOLUCION_A_SALDO_A_FAVOR).toEqual({ type: 'REFUND', tenderType: { is: { systemKind: 'STORE_CREDIT' } } })
    expect(esPendienteDeRevisionContable(devolucionASaldo as never)).toBe(true)

    prismaMock.payment.count.mockResolvedValue(1)
    prismaMock.payment.findMany.mockResolvedValue([devolucionASaldo])
    prismaMock.payment.groupBy
      .mockResolvedValueOnce([{ type: 'REFUND', _sum: { amount: D('-200'), tipAmount: D('0') }, _count: { _all: 1 } }])
      .mockResolvedValueOnce([])
    const r = await listPendingAccountingReview('v1', { from: '2026-10-01', to: '2026-10-14' })
    // No es la cancelación de una venta de TARJETAS: es dinero que regresó a un saldo (la misma póliza que el reverso de un canje).
    expect(r.items.map(x => [x.paymentId, x.kind])).toEqual([['r-saldo', 'REVERSO_DE_SALDO']])
    expect(r.totals.REVERSO_DE_SALDO).toEqual({ count: 1, amount: -200, tipAmount: 0 })
    expect(r.totals.CANCELACION_DE_VENTA).toEqual({ count: 0, amount: 0, tipAmount: 0 })
    // Los totales «con saldo» también la traen.
    expect(JSON.stringify(prismaMock.payment.groupBy.mock.calls[0][0].where)).toContain('STORE_CREDIT')
    expect(r.notice).toMatch(/saldo a favor/)
  })
})

// ── El medio de sistema «Saldo a favor» ────────────────────────────────────────────────────────────────────────────────

describe('el medio «Saldo a favor» no se edita, no cobra y no deja escoger con qué devolver', () => {
  it('🔴 editar el medio «Saldo a favor» se rechaza con su propio código y texto (no el de «Tarjeta de regalo»)', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce({ id: 't-sc', venueId: 'v1', systemKind: 'STORE_CREDIT', isSystem: true })
    const error = await updateTenderType('v1', 't-sc', 1, { name: 'Otro nombre' } as never).catch(e => e)
    expect(error).toMatchObject({ code: 'STORE_CREDIT_TENDER_NOT_ALLOWED', statusCode: 400 })
    expect(error.message).toMatch(/«Saldo a favor»/)
    expect(error.message).not.toMatch(/Tarjeta de regalo/)
  })

  it('🔴 cobrar con el medio «Saldo a favor» se rechaza con su propio código y texto', async () => {
    const tx = {
      venueTenderType: {
        findFirst: jest.fn(async () => ({
          id: 't-sc',
          baseMethod: 'OTHER',
          active: true,
          revision: 1,
          name: 'Saldo a favor',
          systemKind: 'STORE_CREDIT',
        })),
      },
    }
    const error = await resolveTenderForCharge('v1', 't-sc', 1, tx as never).catch(e => e)
    expect(error).toMatchObject({ code: 'STORE_CREDIT_TENDER_NOT_ALLOWED', statusCode: 400 })
    expect(error.message).toMatch(/saldo a favor/i)
    expect(error.message).not.toMatch(/tarjeta de regalo/i)
  })

  it('🔴 sePuedeEscogerComoDevolver: el medio de saldo a favor nunca deja escoger efectivo ni transferencia', () => {
    const filaASaldo = {
      method: 'OTHER',
      source: 'POS',
      externalSource: null,
      tenderSatFormaPago: '17',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderCountsAsCash: false,
      tenderTypeId: 't-sc',
      tenderSystemKind: 'STORE_CREDIT',
    }
    expect(sePuedeEscogerComoDevolver(filaASaldo as never)).toBe(false)
    // Control: la misma fila con un vale del negocio (tender propio) sí deja escoger.
    expect(sePuedeEscogerComoDevolver({ ...filaASaldo, tenderSystemKind: null, tenderSatFormaPago: '99' } as never)).toBe(true)
  })
})
