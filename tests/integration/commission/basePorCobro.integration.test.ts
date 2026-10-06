// tests/integration/commission/basePorCobro.integration.test.ts
/**
 * Fase 3 de pago por servicio, Bloque A — la base de comisión de una venta cobrada en varios cobros, contra Postgres REAL
 * y por el camino de la terminal (efecto durable + worker). Números del spec §9-1; caso 24 del §13.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/basePorCobro.integration.test.ts --ci
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { enqueuePaymentCommissionInTx } from '@/services/tpv/paymentEffects.service'
import { createCommissionForPayment, createSplitCommissionForPayment } from '@/services/dashboard/commission/commission-calculation.service'
import { buildSaleLines } from '@/services/fiscal/autoPosting.service'
import { committedAndPendingCommissionProgress, otrosCobros } from '@/services/dashboard/commission/commission-utils'
import {
  asegurarBaseDePrueba,
  barreraDeFila,
  borrarMundoComisiones,
  categoria,
  cobro,
  crearMundoComisiones,
  despues,
  devolver,
  MundoComisiones,
  netoVivo,
  orden,
  planear,
  procesarEfectos,
  snapshotViejo,
} from './_mundoComisiones'

let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
afterEach(async () => {
  // Se suelta ANTES de borrar: una prueba sin mundo propio no vuelve a borrar el de la anterior, ni uno a medio borrar.
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

/** Cobra la orden en estos montos, uno tras otro, y materializa cada comisión como lo hace la terminal. */
async function cobrarEnPartes(orderId: string, montos: number[]): Promise<string[]> {
  const pagos: string[] = []
  for (const monto of montos) {
    const id = await cobro(m, orderId, monto)
    await planear(id)
    await procesarEfectos(m)
    pagos.push(id)
  }
  return pagos
}
const filaDe = (paymentId: string, configId = m.configId) =>
  prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId, configId } })

describe('A1b · cada cobro comisiona su parte de la orden (spec §9-1, Codex r3-14)', () => {
  it('«lo cobrado»: dos cobros de $225 de una venta de lista $500 con $50 de descuento comisionan $22.50 cada uno', async () => {
    m = await crearMundoComisiones('cobrado')
    const orderId = await orden(m, { subtotal: 500, discountAmount: 50 })
    const [p1, p2] = await cobrarEnPartes(orderId, [225, 225])
    expect([(await filaDe(p1)).netCommission.toFixed(2), (await filaDe(p2)).netCommission.toFixed(2)]).toEqual(['22.50', '22.50'])
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('45.00')
  })

  it('🔴 «precio de lista»: la base total es $500, no $550 (cada cobro suma SU parte del descuento)', async () => {
    m = await crearMundoComisiones('lista', { includeDiscount: true })
    const orderId = await orden(m, { subtotal: 500, discountAmount: 50 })
    const [p1, p2] = await cobrarEnPartes(orderId, [225, 225])
    const filas = [await filaDe(p1), await filaDe(p2)]
    expect(filas.map(f => f.baseAmount.toFixed(2))).toEqual(['250.00', '250.00'])
    expect(filas.map(f => f.discountAmount.toFixed(2))).toEqual(['25.00', '25.00'])
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('50.00')
  })

  it('«lo cobrado»: devolver el primer cobro deja $22.50', async () => {
    m = await crearMundoComisiones('devolucion')
    const orderId = await orden(m, { subtotal: 500, discountAmount: 50 })
    const [p1] = await cobrarEnPartes(orderId, [225, 225])
    await devolver(m, p1, 225)
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('22.50')
  })

  it('🔴 por categoría: cada cobro comisiona su mitad y devolver el primero deja la del segundo (caso 24)', async () => {
    m = await crearMundoComisiones('categoria')
    const cat = await categoria(m)
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { filterByCategories: true, categoryIds: [cat] } })
    const orderId = await orden(m, { subtotal: 450, renglones: [{ categoryId: cat, precio: 450 }] })
    const [p1, p2] = await cobrarEnPartes(orderId, [225, 225])
    expect([(await filaDe(p1)).netCommission.toFixed(2), (await filaDe(p2)).netCommission.toFixed(2)]).toEqual(['22.50', '22.50'])
    await devolver(m, p1, 225)
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('22.50')
  })

  it('🔴 el sobrante también se reparte por cobro', async () => {
    m = await crearMundoComisiones('sobrante')
    const [a, b] = [await categoria(m), await categoria(m)]
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { filterByCategories: true, categoryIds: [a], priority: 10 } })
    const general = await prisma.commissionConfig.create({
      data: {
        venueId: m.venueId,
        name: 'General 10 %',
        createdById: m.owner,
        recipient: 'PROCESSOR',
        defaultRate: 0.1,
        includeTax: true,
        categoryIds: [],
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    })
    const orderId = await orden(m, {
      subtotal: 450,
      renglones: [
        { categoryId: a, precio: 300 },
        { categoryId: b, precio: 150 },
      ],
    })
    const pagos = await cobrarEnPartes(orderId, [225, 225])
    for (const p of pagos) {
      expect((await filaDe(p)).baseAmount.toFixed(2)).toBe('150.00')
      expect((await filaDe(p, general.id)).baseAmount.toFixed(2)).toBe('75.00')
    }
  })

  it('un solo cobro sigue comisionando la venta entera (lo de siempre)', async () => {
    m = await crearMundoComisiones('unico', { includeDiscount: true })
    const orderId = await orden(m, { subtotal: 500, discountAmount: 50 })
    const [p] = await cobrarEnPartes(orderId, [450])
    expect((await filaDe(p)).baseAmount.toFixed(2)).toBe('500.00')
  })

  it.each([
    ['primero el de fecha MÁS NUEVA', true],
    ['en el orden de sus fechas', false],
  ])('🔴 dos cobros confirmados %s: las bases suman exacto, ni un centavo de más ni de menos (Codex plan r2)', async (_, alReves) => {
    m = await crearMundoComisiones('carrera', { includeDiscount: true })
    // $0.03 de descuento entre dos cobros de $50: 0.015 se redondea a 0.02. El que completa la orden se lleva lo que falta
    // (0.01): las bases suman 100.03. Ordenando por fecha, el de fecha más nueva confirmado PRIMERO no veía al otro, el otro
    // no lo contaba (fecha posterior), y los dos llevaban 0.02: 100.04.
    const orderId = await orden(m, { subtotal: 100.03, discountAmount: 0.03 })
    const [masVieja, masNueva] = [despues(), despues()]
    /** El commit financiero de un cobro: candado de la orden, la fila y su comisión en cola, en UNA transacción. */
    const confirmar = (createdAt: Date) =>
      prisma.$transaction(
        async tx => {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`)
          const id = await cobro(m, orderId, 50, { createdAt, db: tx })
          await enqueuePaymentCommissionInTx(tx, id)
          return id
        },
        { timeout: 30_000 },
      )

    const barrera = await barreraDeFila('Order', orderId)
    let primero!: Promise<string>
    let segundo!: Promise<string>
    try {
      // El candado de la orden se reparte en orden de llegada: el que espera primero confirma primero.
      primero = confirmar(alReves ? masNueva : masVieja)
      await barrera.esperarA(1)
      segundo = confirmar(alReves ? masVieja : masNueva)
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    await Promise.all([primero, segundo])
    await procesarEfectos(m)

    const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, orderId }, take: 10 })
    const suma = (k: 'baseAmount' | 'discountAmount') => filas.reduce((t, f) => t.add(f[k]), new Prisma.Decimal(0)).toFixed(2)
    expect([filas.length, suma('discountAmount'), suma('baseAmount')]).toEqual([2, '0.03', '100.03'])
    expect(filas.map(f => f.discountAmount.toFixed(2)).sort()).toEqual(['0.01', '0.02'])
  })
})

describe('A1c · «con IVA» es lo que pagó el cliente; «sin IVA» le resta su parte (D5, spec §9-1)', () => {
  it.each([
    ['IVA aparte', 'IVA_APARTE', 100, true, ['58.00', '58.00']],
    ['IVA aparte', 'IVA_APARTE', 100, false, ['50.00', '50.00']],
    ['IVA incluido', 'IVA_INCLUIDO', 116, true, ['58.00', '58.00']],
    ['IVA incluido', 'IVA_INCLUIDO', 116, false, ['50.00', '50.00']],
  ] as const)(
    '🔴 %s (%s), subtotal %d, con IVA=%s: dos cobros de $58 dan bases %j (nunca $132 en total)',
    async (_n, contratoDePrecio, subtotal, includeTax, bases) => {
      m = await crearMundoComisiones('iva', { includeTax })
      const orderId = await orden(m, { subtotal, taxAmount: 16, contratoDePrecio })
      const pagos = await cobrarEnPartes(orderId, [58, 58])
      expect(await Promise.all(pagos.map(async p => (await filaDe(p)).baseAmount.toFixed(2)))).toEqual([...bases])
    },
  )

  it('🔴 por categoría con el IVA incluido, «sin IVA» le separa el IVA al renglón con su tasa', async () => {
    m = await crearMundoComisiones('cat-iva', { includeTax: false })
    const cat = await categoria(m)
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { filterByCategories: true, categoryIds: [cat] } })
    const orderId = await orden(m, {
      subtotal: 116,
      taxAmount: 16,
      contratoDePrecio: 'IVA_INCLUIDO',
      renglones: [{ categoryId: cat, precio: 116, iva: 16 }],
    })
    const [p] = await cobrarEnPartes(orderId, [116])
    expect((await filaDe(p)).baseAmount.toFixed(2)).toBe('100.00')
  })
})

describe('A1d · la columna nace «sin IVA» (D5 enmendada, spec §9-1)', () => {
  it('🔴 el default de la base es false: un esquema que no dice nada comisiona sin IVA', async () => {
    const [col] = await prisma.$queryRaw<Array<{ d: string | null }>>`
      SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'CommissionConfig' AND column_name = 'includeTax'`
    expect(col.d).toBe('false')
  })
})

/** La venta neta (HABER ventas) que la póliza contable asienta para un cobro: `buildSaleLines` con los renglones REALES de su orden. */
async function ventaNetaDeLaPoliza(paymentId: string): Promise<string> {
  const { orderId, ...cobroContable } = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { id: true, amount: true, tipAmount: true, feeAmount: true, method: true, type: true, createdAt: true, orderId: true },
  })
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    select: { quantity: true, unitPrice: true, discountAmount: true, product: { select: { taxRate: true } } },
    take: 100,
  })
  const poliza = buildSaleLines(
    { ...cobroContable, merchantAccount: null, ecommerceMerchant: null, order: { status: 'COMPLETED', orderNumber: null, items } },
    cuenta => cuenta,
  )
  return ((poliza?.lines.find(l => l.ledgerAccountId === 'SALES_REVENUE')?.creditCents ?? 0) / 100).toFixed(2)
}

describe('A1e · «sin IVA» usa el IVA de la póliza contable (D5 enmendada, spec §9-1)', () => {
  it.each([
    ['🔴 paquete de Mindform al 16 %', 'IVA_INCLUIDO', 'IVA_16', 116, true, '116.00'],
    ['🔴 paquete de Mindform al 16 %', 'IVA_INCLUIDO', 'IVA_16', 116, false, '100.00'],
    ['frontera al 8 %', 'IVA_INCLUIDO', 'IVA_8', 108, true, '108.00'],
    ['frontera al 8 %', 'IVA_INCLUIDO', 'IVA_8', 108, false, '100.00'],
    ['tasa 0', 'IVA_INCLUIDO', 'IVA_0', 100, true, '100.00'],
    ['tasa 0', 'IVA_INCLUIDO', 'IVA_0', 100, false, '100.00'],
    ['exento', 'IVA_INCLUIDO', 'EXENTO', 100, true, '100.00'],
    ['exento', 'IVA_INCLUIDO', 'EXENTO', 100, false, '100.00'],
    ['venta anterior al contrato, sin IVA registrado', 'DESCONOCIDO', 'IVA_16', 116, false, '100.00'],
  ] as const)('%s (%s, %s), un cobro de $%s, con IVA=%s: base %s', async (_n, contratoDePrecio, tratamiento, precio, includeTax, base) => {
    m = await crearMundoComisiones('tasa', { includeTax })
    const cat = await categoria(m)
    const orderId = await orden(m, { subtotal: precio, contratoDePrecio, renglones: [{ categoryId: cat, precio, tratamiento }] })
    const [p] = await cobrarEnPartes(orderId, [precio])
    expect((await filaDe(p)).baseAmount.toFixed(2)).toBe(base)
  })

  const ventasDePoliza: Array<[string, Array<{ precio: number; tratamiento?: 'IVA_0' }>, number, number]> = [
    ['un paquete al 16 %', [{ precio: 116 }], 116, 0],
    ['una venta mixta (16 % y 0 %)', [{ precio: 116 }, { precio: 100, tratamiento: 'IVA_0' }], 216, 0],
    ['un cargo por servicio de $11.60', [{ precio: 116 }], 116, 11.6],
  ]
  it.each(ventasDePoliza)(
    '🔴 «Lo cobrado», un solo cobro sin categorías ni propina: la base «sin IVA» es la venta neta de su póliza (%s)',
    async (_n, renglones, subtotal, cargo) => {
      m = await crearMundoComisiones('poliza', { includeTax: false })
      const cat = await categoria(m)
      const orderId = await orden(m, { subtotal, cargo, renglones: renglones.map(r => ({ ...r, categoryId: cat })) })
      const [p] = await cobrarEnPartes(orderId, [subtotal + cargo])
      expect((await filaDe(p)).baseAmount.toFixed(2)).toBe(await ventaNetaDeLaPoliza(p))
    },
  )

  it('🔴 orden mixta (16 % y 0 %) en dos cobros: cada base es la de su póliza y suman exacto $200', async () => {
    m = await crearMundoComisiones('mixta', { includeTax: false })
    const cat = await categoria(m)
    const orderId = await orden(m, {
      subtotal: 216,
      renglones: [
        { categoryId: cat, precio: 116, tratamiento: 'IVA_16' },
        { categoryId: cat, precio: 100, tratamiento: 'IVA_0' },
      ],
    })
    const [p1, p2] = await cobrarEnPartes(orderId, [100, 116])
    const bases = [(await filaDe(p1)).baseAmount.toFixed(2), (await filaDe(p2)).baseAmount.toFixed(2)]
    expect(bases).toEqual(['92.59', '107.41'])
    expect(bases).toEqual([await ventaNetaDeLaPoliza(p1), await ventaNetaDeLaPoliza(p2)])
  })

  it('un renglón sin producto («Otro importe») cuenta al 16 %: $116 + $100 al 0 % comisionan $200 sin IVA', async () => {
    m = await crearMundoComisiones('sin-producto', { includeTax: false })
    const cat = await categoria(m)
    const orderId = await orden(m, {
      subtotal: 216,
      renglones: [
        { categoryId: cat, precio: 116, sinProducto: true },
        { categoryId: cat, precio: 100, tratamiento: 'IVA_0' },
      ],
    })
    const [p] = await cobrarEnPartes(orderId, [216])
    expect((await filaDe(p)).baseAmount.toFixed(2)).toBe('200.00')
  })

  it('IVA cobrado aparte: $100 al 16 % + $16 aparte comisionan $100, igual que su póliza', async () => {
    m = await crearMundoComisiones('aparte', { includeTax: false })
    const cat = await categoria(m)
    const orderId = await orden(m, {
      subtotal: 100,
      taxAmount: 16,
      contratoDePrecio: 'IVA_APARTE',
      renglones: [{ categoryId: cat, precio: 100, iva: 16 }],
    })
    const [p] = await cobrarEnPartes(orderId, [116])
    expect([(await filaDe(p)).baseAmount.toFixed(2), await ventaNetaDeLaPoliza(p)]).toEqual(['100.00', '100.00'])
  })

  it('🔴 «precio de lista» sin IVA sale de los renglones, no de la cabecera: $116 al 16 % con $58 de descuento + $100 al 0 % = $200', async () => {
    m = await crearMundoComisiones('lista', { includeTax: false, includeDiscount: true })
    const cat = await categoria(m)
    const orderId = await orden(m, {
      subtotal: 216,
      discountAmount: 58,
      renglones: [
        { categoryId: cat, precio: 116, descuento: 58 },
        { categoryId: cat, precio: 100, tratamiento: 'IVA_0' },
      ],
    })
    const [p] = await cobrarEnPartes(orderId, [158])
    expect((await filaDe(p)).baseAmount.toFixed(2)).toBe('200.00')
  })

  it.each([
    [true, '216.00'],
    [false, '200.00'],
  ] as const)(
    '🔴 Codex r3-3: con la cortesía del POS, «precio de lista» con IVA=%s comisiona la misma mercancía: base %s',
    async (includeTax, base) => {
      // $116 al 16 % regalado entero + $100 exentos: el POS móvil deja la cabecera en subtotal $100 y descuento $0.
      m = await crearMundoComisiones('cortesia', { includeTax, includeDiscount: true })
      const cat = await categoria(m)
      const orderId = await orden(m, {
        subtotal: 100,
        renglones: [
          { categoryId: cat, precio: 116, descuento: 116 },
          { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
        ],
      })
      const [p] = await cobrarEnPartes(orderId, [100])
      expect((await filaDe(p)).baseAmount.toFixed(2)).toBe(base)
    },
  )

  it.each([false, true])(
    '🔴 Codex r3-2: el esquema general comisiona el cargo por servicio sin su IVA (precio de lista=%s): $116 + $11.60 ⇒ $110',
    async includeDiscount => {
      m = await crearMundoComisiones('cargo', { includeTax: false, includeDiscount })
      const cat = await categoria(m)
      const orderId = await orden(m, { subtotal: 116, cargo: 11.6, renglones: [{ categoryId: cat, precio: 116 }] })
      const [p] = await cobrarEnPartes(orderId, [127.6])
      expect((await filaDe(p)).baseAmount.toFixed(2)).toBe('110.00')
    },
  )

  it.each([false, true])(
    '🔴 Codex r3-2: la comisión dividida también conserva el cargo (precio de lista=%s): $55 y $55',
    async includeDiscount => {
      m = await crearMundoComisiones('cargo-dividida', { includeTax: false, includeDiscount })
      const cat = await categoria(m)
      const orderId = await orden(m, { subtotal: 116, cargo: 11.6, renglones: [{ categoryId: cat, precio: 116 }] })
      const p = await cobro(m, orderId, 127.6)
      await createSplitCommissionForPayment(p, [m.ana, m.bea])
      const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: p }, take: 10 })
      expect(filas.map(f => f.baseAmount.toFixed(2))).toEqual(['55.00', '55.00'])
    },
  )

  it.each([
    [0.5, true, '58.00'],
    [0.5, false, '50.00'],
    [2, true, '232.00'],
    [2, false, '200.00'],
  ] as const)(
    '🔴 Codex r4-1: venta por peso en «precio de lista», $116/kg × %s kg con IVA=%s: base %s',
    async (kilos, includeTax, base) => {
      m = await crearMundoComisiones('peso', { includeTax, includeDiscount: true })
      const cat = await categoria(m)
      const importe = 116 * kilos
      const orderId = await orden(m, { subtotal: importe, renglones: [{ categoryId: cat, precio: 116, kilos }] })
      const [p] = await cobrarEnPartes(orderId, [importe])
      expect((await filaDe(p)).baseAmount.toFixed(2)).toBe(base)
    },
  )

  it.each([
    [0.5, '25.00'],
    [2, '100.00'],
  ] as const)('🔴 Codex r4-1: la dividida en «precio de lista» sin IVA, $116/kg × %s kg: %s por persona', async (kilos, cadaUno) => {
    m = await crearMundoComisiones('peso-dividida', { includeTax: false, includeDiscount: true })
    const cat = await categoria(m)
    const importe = 116 * kilos
    const orderId = await orden(m, { subtotal: importe, renglones: [{ categoryId: cat, precio: 116, kilos }] })
    const p = await cobro(m, orderId, importe)
    await createSplitCommissionForPayment(p, [m.ana, m.bea])
    const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: p }, take: 10 })
    expect(filas.map(f => f.baseAmount.toFixed(2))).toEqual([cadaUno, cadaUno])
  })

  it.each([
    [true, '108.00'],
    [false, '100.00'],
  ] as const)(
    '🔴 Codex r3-3: la dividida en «precio de lista» con la cortesía del POS también sale de los renglones (con IVA=%s): %s por persona',
    async (includeTax, cadaUno) => {
      // La misma cortesía: $116 al 16 % regalado entero + $100 exentos, cabecera en subtotal $100. Desde la cabecera serían $50 c/u.
      m = await crearMundoComisiones('cortesia-dividida', { includeTax, includeDiscount: true })
      const cat = await categoria(m)
      const orderId = await orden(m, {
        subtotal: 100,
        renglones: [
          { categoryId: cat, precio: 116, descuento: 116 },
          { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
        ],
      })
      const p = await cobro(m, orderId, 100)
      await createSplitCommissionForPayment(p, [m.ana, m.bea])
      const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: p }, take: 10 })
      expect(filas.map(f => f.baseAmount.toFixed(2))).toEqual([cadaUno, cadaUno])
    },
  )

  it('🔴 comisión dividida: el paquete de $116 al 16 % se reparte sobre $100 sin IVA ($50 y $50)', async () => {
    m = await crearMundoComisiones('dividida', { includeTax: false })
    const cat = await categoria(m)
    const orderId = await orden(m, { subtotal: 116, renglones: [{ categoryId: cat, precio: 116 }] })
    const p = await cobro(m, orderId, 116)
    await createSplitCommissionForPayment(p, [m.ana, m.bea])
    const filas = await prisma.commissionCalculation.findMany({
      where: { venueId: m.venueId, paymentId: p },
      orderBy: { staffId: 'asc' },
      take: 10,
    })
    expect(filas.map(f => [f.baseAmount.toFixed(2), f.taxAmount.toFixed(2), f.netCommission.toFixed(2)])).toEqual([
      ['50.00', '8.00', '5.00'],
      ['50.00', '8.00', '5.00'],
    ])
  })
})

describe('A6 F2 · un importe congelado vale lo mismo en cola que materializado (Codex bloque A r1 [P2])', () => {
  /**
   * Orden exenta por categoría, esquema al 5 % con propina. Primer cobro `venta` + $0.20 de propina, que se queda en cola o se
   * materializa; después el segundo, de $0.10, que completa la orden. Devuelve los dos cobros ya materializados.
   *
   * Los $2.10 de Codex NO reproducen contra Postgres: Prisma guarda el JSON con 16 cifras y 2.3000000000000003 llega como 2.3.
   * Con $32.20 sí: 32.2 + 0.2 = 32.400000000000006 se guarda como 32.40000000000001 (lo que ya documentaba A3:
   * «-0.009999999999999998»).
   */
  async function dosCobros(venta: number, primeroMaterializado: boolean, conSnapshotViejo = false) {
    m = await crearMundoComisiones(`f2-${primeroMaterializado ? 'fila' : 'cola'}`, {
      defaultRate: 0.05,
      includeTips: true,
      includeTax: false,
    })
    const cat = await categoria(m)
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { filterByCategories: true, categoryIds: [cat] } })
    const total = new Prisma.Decimal(venta).plus('0.10').toNumber()
    const orderId = await orden(m, { subtotal: total, renglones: [{ categoryId: cat, precio: total, tratamiento: 'EXENTO' }] })
    const p1 = await cobro(m, orderId, venta, { propina: 0.2 })
    await planear(p1)
    const snapshot = (await prisma.paymentEffect.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: p1, kind: 'COMMISSION' } }))
      .payload as Record<string, unknown>
    if (conSnapshotViejo) await snapshotViejo(m, p1, { baseAmount: venta + 0.2 })
    if (primeroMaterializado) await procesarEfectos(m)
    const p2 = await cobro(m, orderId, 0.1)
    await planear(p2)
    await procesarEfectos(m)
    return { p1, p2, snapshot }
  }

  it.each([
    [2.1, 'en cola', false, '0.12'],
    [2.1, 'materializado', true, '0.12'],
    [32.2, 'en cola', false, '1.62'],
    [32.2, 'materializado', true, '1.62'],
  ])('🔴 $%d + $0.20 de propina con el primer cobro %s: el segundo ($0.10) comisiona $0.01', async (venta, _, materializado, primera) => {
    const { p1, p2 } = await dosCobros(venta, materializado)
    expect([(await filaDe(p1)).netCommission.toFixed(2), (await filaDe(p2)).netCommission.toFixed(2)]).toEqual([primera, '0.01'])
  })

  it('🔴 el snapshot se escribe al centavo: base $32.40, no 32.400000000000006', async () => {
    const { snapshot } = await dosCobros(32.2, false)
    expect([snapshot.baseAmount, snapshot.tipAmount, snapshot.grossCommission, snapshot.netCommission]).toEqual([32.4, 0.2, 1.62, 1.62])
  })

  it('🔴 un snapshot VIEJO en cola (base 32.400000000000006) también se lee al centavo', async () => {
    const { p2 } = await dosCobros(32.2, false, true)
    expect((await filaDe(p2)).netCommission.toFixed(2)).toBe('0.01')
  })

  it('🔴 lo que ya recibió un cobro en cola se lee al centavo aunque su snapshot sea VIEJO (base y descuento)', async () => {
    m = await crearMundoComisiones('f2-otros', { includeTips: true, includeDiscount: true })
    const orderId = await orden(m, { subtotal: 32.3 })
    const p1 = await cobro(m, orderId, 32.2, { propina: 0.2 })
    await planear(p1)
    await snapshotViejo(m, p1, { baseAmount: 32.2 + 0.2, discountAmount: 0.02 + 0.07 })
    const p2 = await cobro(m, orderId, 0.1)
    const otros = await otrosCobros(prisma, { id: p2, venueId: m.venueId, orderId }, m.configId)
    expect(otros.map(o => [o.monto.toFixed(2), o.base?.toString(), o.descuento?.toString()])).toEqual([['32.20', '32.2', '0.09']])
  })

  it('🔴 el avance de metas también lee la cola al centavo: dos snapshots viejos de $32.40 suman $64.80', async () => {
    m = await crearMundoComisiones('f2-metas', { includeTips: true })
    for (let i = 0; i < 2; i++) {
      const pago = await cobro(m, await orden(m, { subtotal: 32.2 }), 32.2, { propina: 0.2 })
      await planear(pago)
      await snapshotViejo(m, pago, { baseAmount: 32.2 + 0.2 })
    }
    const avance = await committedAndPendingCommissionProgress(prisma, m.venueId, m.ana, new Date('2020-01-01T00:00:00Z'))
    expect(avance).toEqual({ amount: 64.8, count: 2 })
  })
})

describe('A6 F3 · el reparto multiplica antes de dividir (Codex bloque A r1 [P2])', () => {
  it('🔴 orden de $14 con $1.33 comisionable, cobros de $3 y $11 al 10 %: bases $0.29 + $1.04 y comisión $0.13, no $0.14', async () => {
    m = await crearMundoComisiones('f3-reparto')
    const [cat, otra] = [await categoria(m), await categoria(m)]
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { filterByCategories: true, categoryIds: [cat] } })
    const orderId = await orden(m, {
      subtotal: 14,
      renglones: [
        { categoryId: cat, precio: 1.33 },
        { categoryId: otra, precio: 12.67 },
      ],
    })
    const pagos: string[] = []
    for (const monto of [3, 11]) {
      const pago = await cobro(m, orderId, monto)
      await createCommissionForPayment(pago)
      pagos.push(pago)
    }
    const filas = await Promise.all(pagos.map(p => filaDe(p)))
    expect(filas.map(f => [f.baseAmount.toFixed(2), f.netCommission.toFixed(2)])).toEqual([
      ['0.29', '0.03'],
      ['1.04', '0.10'],
    ])
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.13')
  })
})
