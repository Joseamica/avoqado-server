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
} from './_mundoComisiones'

let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
afterEach(() => borrarMundoComisiones(m))

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
