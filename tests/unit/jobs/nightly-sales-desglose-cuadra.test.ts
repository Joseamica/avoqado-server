/**
 * D21 — el «Desglose de ventas» por categoría del correo nocturno suma las ventas netas del mismo correo.
 *
 * Medido el 16-nov-2026 (Avoqado Full, 27-oct): las categorías sumaban $446.00 y las ventas netas $472.99. Los $26.99 eran 3
 * cobros rápidos de la TPV (FAST-…, importe libre): una cuenta SIN renglones, que la consulta de categorías (que parte de
 * los renglones) no puede ver. En toda la base local: 160 cuentas así, $28,757.69, también en Mindform.
 */
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({ getSalesSummary: jest.fn() }))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendSalesSummaryEmail: jest.fn().mockResolvedValue(true) },
}))

import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import emailService from '@/services/email.service'
import { NightlySalesSummaryJob } from '@/jobs/nightly-sales-summary.job'
import { prismaMock } from '@tests/__helpers__/setup'

const SIN_PRODUCTO = 'Ventas sin producto (importe libre)'
const cents = (n: number) => Math.round(n * 100)

type Fila = { name: string; itemsSold: number | null; netSales: number }

/** Lo que la consulta de categorías devuelve (la primera `$queryRaw` del job) y el resumen del día. */
async function desgloseCon(categorias: Array<[string, number, number]>, netSales: number, refunds = 0): Promise<Fila[]> {
  const resumen = { summary: { netSales, refunds, transactionCount: 1, grossSales: netSales + refunds, discounts: 0 } }
  ;(getSalesSummary as jest.Mock).mockResolvedValue(resumen)
  ;(prismaMock.$queryRaw as jest.Mock)
    .mockReset()
    .mockResolvedValueOnce(categorias.map(([name, items_sold, net_sales]) => ({ name, items_sold, net_sales })))
    .mockResolvedValue([])
  const resultado = await new NightlySalesSummaryJob().runNow('venue-full')
  expect(resultado).toMatchObject({ emailsSent: 1, errors: 0 })
  return (emailService.sendSalesSummaryEmail as jest.Mock).mock.calls[0][1].categoryBreakdown
}

const suma = (filas: Fila[]) => filas.reduce((s, f) => s + cents(f.netSales), 0)

beforeEach(() => {
  ;(emailService.sendSalesSummaryEmail as jest.Mock).mockClear()
  ;(prismaMock.venue.findMany as jest.Mock).mockResolvedValue([
    {
      id: 'venue-full',
      name: 'Avoqado Full',
      slug: 'avoqado-full',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      email: null,
      staff: [{ role: 'OWNER', staff: { id: 'duena', email: 'duena@example.com', firstName: 'Ana', lastName: 'López' } }],
    },
  ])
  ;(prismaMock.notificationPreference.findMany as jest.Mock).mockResolvedValue([{ staffId: 'duena' }])
})

describe('D21 · el desglose por categoría suma las ventas netas del correo', () => {
  it('🔴 el día medido: los cobros sin productos salen en su propio renglón y el desglose suma $472.99', async () => {
    const filas = await desgloseCon(
      [
        ['Bebidas', 10, 246],
        ['Hamburguesas', 1, 108.71],
        ['Sin categorizar', 5, 50],
        ['Entradas', 1, 41.29],
      ],
      472.99,
    )
    expect(filas).toContainEqual({ name: SIN_PRODUCTO, itemsSold: null, netSales: 26.99 })
    expect(suma(filas)).toBe(cents(472.99))
  })

  it('un día sin ventas de importe libre no lleva renglón de más', async () => {
    const filas = await desgloseCon(
      [
        ['Bebidas', 3, 90],
        ['Entradas', 1, 41.29],
      ],
      131.29,
    )
    expect(filas.map(f => f.name)).toEqual(['Bebidas', 'Entradas'])
    expect(suma(filas)).toBe(cents(131.29))
  })

  it('🔴 un día con SÓLO ventas de importe libre ya tiene desglose (antes salía vacío y el correo lo escondía)', async () => {
    const filas = await desgloseCon([], 26.99)
    expect(filas).toEqual([{ name: SIN_PRODUCTO, itemsSold: null, netSales: 26.99 }])
  })

  it('🔴 las devoluciones del día van en su renglón, en negativo, como las resta la cifra de ventas netas', async () => {
    const filas = await desgloseCon([['Bebidas', 5, 500]], 450, 50)
    expect(filas).toEqual([
      { name: 'Bebidas', itemsSold: 5, netSales: 500 },
      { name: 'Devoluciones', itemsSold: null, netSales: -50 },
    ])
    expect(suma(filas)).toBe(cents(450))
  })

  it('🔴 con más de 10 categorías, las demás se juntan en «Otras categorías» (antes se perdían con el LIMIT 10)', async () => {
    const categorias: Array<[string, number, number]> = Array.from({ length: 12 }, (_, i) => [`Cat ${i + 1}`, 1, 120 - i * 10])
    const total = categorias.reduce((s, [, , v]) => s + v, 0)
    const filas = await desgloseCon(categorias, total)
    expect(filas).toHaveLength(11)
    expect(filas[10]).toEqual({ name: 'Otras categorías', itemsSold: 2, netSales: 30 })
    expect(suma(filas)).toBe(cents(total))
  })

  it('los centavos de cada renglón cuadran con la cifra impresa (un renglón por peso con más de 2 decimales)', async () => {
    const filas = await desgloseCon([['Carnes', 1, 104.404]], 104.4)
    expect(filas).toEqual([{ name: 'Carnes', itemsSold: 1, netSales: 104.4 }])
  })

  it('si las categorías suman MÁS que las ventas netas (una venta cambió entre consultas) no inventa un renglón negativo', async () => {
    const filas = await desgloseCon([['Bebidas', 2, 727.5]], 553)
    expect(filas).toEqual([{ name: 'Bebidas', itemsSold: 2, netSales: 727.5 }])
  })

  it('un día sin ventas sigue sin desglose', async () => {
    expect(await desgloseCon([], 0)).toEqual([])
  })
})
