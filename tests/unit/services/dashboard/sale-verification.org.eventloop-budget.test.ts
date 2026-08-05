/**
 * Presupuesto de event loop de las agregaciones de ventas org.
 *
 * 🔴 ESTE ES EL TEST QUE IMPIDE QUE VUELVA A PASAR EL 2026-08-04.
 *
 * Ese día la pantalla de Ventas de PlayTelecom retuvo el hilo del servidor ~9 s por
 * endpoint, y `/dashboard/auth/status` —que no hace nada pesado— tardó 33.7 segundos.
 * Node atiende de uno en uno: mientras una agregación hace CPU síncrono, NADIE más se
 * atiende. En una plataforma de pagos eso es inaceptable.
 *
 * No mide cuánto TARDA una agregación (esperar a Postgres puede tardar y está bien): mide
 * cuánto tiempo SEGUIDO retiene el hilo. Si alguien vuelve a meter un bucle pesado sobre
 * miles de filas, esto truena en CI antes de llegar a producción.
 *
 * El mock devuelve ~20 renglones ya agrupados, que es justo lo que Postgres regresa desde
 * la migración. Si una agregación volviera a leer filas crudas, el post-procesamiento en
 * JS se dispararía y el presupuesto se rompería.
 */
import {
  getOrgSalesSummary,
  getSalesByMonth,
  getSalesByWeek,
  getSalesBySaleTypeWeekly,
  getSalesByCity,
  getSalesByStore,
  getSalesByPromoter,
  getSalesByPromoterWeekly,
  getSalesByPromoterDaily,
  getSalesBySupervisor,
  getSalesBySimType,
  getSalesBySimTypeWeekly,
} from '@/services/dashboard/sale-verification.org.dashboard.service'
import { measureEventLoopBlock, EVENT_LOOP_BUDGET_MS } from '@/utils/eventLoopBudget'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    payment: { findMany: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
  },
}))

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { broadcastToUser: jest.fn() } }))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const ORG_ID = 'org-playtelecom'

/** ~20 renglones agrupados: lo que Postgres devuelve tras la migración. */
function filasAgregadas() {
  return Array.from({ length: 20 }, (_, i) => ({
    bucket: `2026-W${String(i + 10).padStart(2, '0')}`,
    week: `W${String(i + 10).padStart(2, '0')}`,
    month: `2026-${String((i % 12) + 1).padStart(2, '0')}`,
    day_key: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
    city: `Ciudad ${i % 3}`,
    venue_id: `v${i % 5}`,
    venue_name: `BAE ${i % 5}`,
    staff_id: `s${i % 4}`,
    first_name: 'Ana',
    last_name: 'López',
    category_name: 'SIM Prepago',
    is_portabilidad: i % 2 === 0,
    count: BigInt(i + 1),
    completed_count: BigInt(i + 1),
    to_review: BigInt(0),
    to_review_previous: BigInt(0),
    revenue: '150.50',
    total_revenue: '5000.00',
    confirmed_revenue: '3000.00',
    total_count: BigInt(100),
    pending_count: BigInt(1),
    failed_count: BigInt(1),
    rejected_count: BigInt(1),
    without_verification_count: BigInt(0),
  }))
}

const agregaciones: Array<[string, () => Promise<unknown>]> = [
  ['getOrgSalesSummary', () => getOrgSalesSummary(ORG_ID, {})],
  ['getSalesByMonth', () => getSalesByMonth(ORG_ID, {})],
  ['getSalesByWeek', () => getSalesByWeek(ORG_ID, {})],
  ['getSalesBySaleTypeWeekly', () => getSalesBySaleTypeWeekly(ORG_ID, {})],
  ['getSalesByCity', () => getSalesByCity(ORG_ID, {})],
  ['getSalesByStore', () => getSalesByStore(ORG_ID, {})],
  ['getSalesByPromoter', () => getSalesByPromoter(ORG_ID, {})],
  ['getSalesByPromoterWeekly', () => getSalesByPromoterWeekly(ORG_ID, {})],
  ['getSalesByPromoterDaily', () => getSalesByPromoterDaily(ORG_ID)],
  ['getSalesBySupervisor', () => getSalesBySupervisor(ORG_ID, {})],
  ['getSalesBySimType', () => getSalesBySimType(ORG_ID, {})],
  ['getSalesBySimTypeWeekly', () => getSalesBySimTypeWeekly(ORG_ID, {})],
]

describe('presupuesto de event loop — ninguna agregación retiene el hilo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue(filasAgregadas())
    ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValue([])
  })

  it.each(agregaciones)('%s se mantiene bajo los 50 ms', async (_nombre, fn) => {
    const { maxBlockMs } = await measureEventLoopBlock(fn)
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
  })

  it('las 12 juntas, en paralelo como las dispara el dashboard, tampoco lo rompen', async () => {
    // Ésta es la forma exacta del incidente: el navegador las lanza todas a la vez.
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      await Promise.all(agregaciones.map(([, fn]) => fn()))
    })
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
  })

  it('ninguna agregación lee filas crudas — todas agrupan en Postgres', async () => {
    for (const [, fn] of agregaciones) await fn()
    expect(prisma.saleVerification.findMany).not.toHaveBeenCalled()
    expect(prisma.payment.findMany).not.toHaveBeenCalled()
  })
})
