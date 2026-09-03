/**
 * 🔴 PRUEBA NEGATIVA — la carga masiva de ventas PASADAS **no** estampa `Order.shiftId`, y no
 * es un olvido.
 *
 * El 3-sep-2026 se conectó `Order.shiftId` en los sitios que crean órdenes, porque
 * `getActiveShifts` cuenta las órdenes del turno agrupando por ese campo y salía «0 órdenes» en
 * todos los venues. **Este sitio quedó fuera a propósito**, y esta prueba existe para que el
 * siguiente que barra los `order.create` buscando el patrón no lo «complete» sin leer el porqué.
 *
 * El porqué, en una línea: aquí `createdAt` es la fecha de la HOJA de Excel del cliente —ventas
 * de otros días y de otras tiendas, porque el venue se resuelve POR RENGLÓN—. Estampar «el turno
 * abierto ahora» metería ventas de la semana pasada dentro del corte de hoy, y ese corte lo firma
 * una persona. Un `shiftId` nulo sólo deja el renglón fuera de un conteo; uno equivocado mete
 * dinero ajeno en la caja de alguien.
 *
 * Andamiaje copiado de `manualSale.service.test.ts`, la suite que ya ejercita esta función.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    serializedItemCustodyEvent: { create: jest.fn() },
  },
}))

const resolveIccidMock = jest.fn()
const resolveVenueMock = jest.fn()
const resolveStaffByCodeMock = jest.fn()
const resolveCategoryMock = jest.fn()
const mapPaymentFormMock = jest.fn()
const parseAmountMock = jest.fn()
jest.mock('@/services/dashboard/manualSale.resolvers', () => ({
  __esModule: true,
  resolveIccid: (...a: any[]) => resolveIccidMock(...a),
  resolveVenue: (...a: any[]) => resolveVenueMock(...a),
  resolveStaffByCode: (...a: any[]) => resolveStaffByCodeMock(...a),
  resolveCategory: (...a: any[]) => resolveCategoryMock(...a),
  mapPaymentForm: (...a: any[]) => mapPaymentFormMock(...a),
  parseAmount: (...a: any[]) => parseAmountMock(...a),
  mapSaleStatus: (...a: any[]) => jest.requireActual('@/services/dashboard/manualSale.resolvers').mapSaleStatus(...a),
}))

jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  __esModule: true,
  serializedInventoryService: { markAsSold: jest.fn().mockResolvedValue({ item: { id: 'sim-1' } }) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import { createOneManualSale } from '@/services/dashboard/manualSale.service'
import prisma from '@/utils/prismaClient'
import type { ManualSaleRowInput } from '@/schemas/dashboard/manualSale.schema'

const prismaMock = prisma as jest.Mocked<typeof prisma>

const ORG_ID = 'org-1'
const ACTOR_STAFF_ID = 'actor-staff-1'
const STORE_VENUE_ID = 'store-venue-1'

/** Una venta de HACE MESES, que es exactamente el caso que hace peligroso estampar el turno. */
const renglonViejo: ManualSaleRowInput = {
  iccid: '8952140064323812041F',
  promoterCode: 'P123',
  promoterName: 'Ana López',
  storeId: '898',
  storeName: 'BAE MUÑOZ SLP (898)',
  saleDate: '2026-04-24',
  saleType: 'Línea nueva',
  paymentForm: 'Efectivo',
  amount: 150,
  simType: 'SIM de Evento',
}

function clienteDeTransaccion() {
  return {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { create: jest.fn().mockResolvedValue({ id: 'orderitem-1' }) },
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    saleVerification: { create: jest.fn().mockResolvedValue({ id: 'verification-1' }) },
    // 🔴 El turno NO existe en este cliente a propósito: si alguien "arregla" el servicio para
    // resolverlo aquí, la llamada revienta en vez de pasar de largo.
  }
}

describe('createOneManualSale — la venta importada NO se ata al turno abierto (deliberado)', () => {
  let tx: ReturnType<typeof clienteDeTransaccion>

  beforeEach(() => {
    jest.clearAllMocks()
    tx = clienteDeTransaccion()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    resolveIccidMock.mockResolvedValue({
      item: {
        id: 'sim-1',
        serialNumber: '8952140064323812041F',
        categoryId: 'cat-1',
        custodyState: 'SUPERVISOR_HELD',
        assignedSupervisorId: 'sup-1',
      },
    })
    resolveVenueMock.mockResolvedValue({
      venue: { id: STORE_VENUE_ID, name: 'BAE MUÑOZ SLP', slug: 'bae-munoz-slp', timezone: 'America/Mexico_City' },
    })
    resolveStaffByCodeMock.mockResolvedValue({ staff: { id: 'seller-1', firstName: 'Ana', lastName: 'López', employeeCode: 'P123' } })
    resolveCategoryMock.mockResolvedValue({ categoryId: 'cat-1' })
    mapPaymentFormMock.mockReturnValue({ method: 'CASH', amountApplies: true })
    parseAmountMock.mockReturnValue(new Prisma.Decimal(150))
  })

  it('la orden nace SIN `shiftId`, aunque haya un turno abierto ahora mismo', async () => {
    const resultado = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, renglonViejo)

    expect(resultado.ok).toBe(true)
    const datos = tx.order.create.mock.calls[0][0].data
    // Ni el campo, ni un valor: la orden importada no pertenece a ningún turno.
    expect(datos.shiftId ?? null).toBeNull()
    // Y la fecha demuestra por qué: es de abril, no de hoy.
    expect((datos.createdAt as Date).toISOString()).toContain('2026-04-24')
  })

  it('no se consulta el turno abierto en ningún momento', () => {
    // Si mañana alguien mete un `turnoAbiertoDelNegocio` aquí, este archivo lo caza aunque el
    // valor acabe siendo nulo por casualidad en el entorno de pruebas.
    const fuente = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../src/services/dashboard/manualSale.service.ts'),
      'utf8',
    )
    expect(fuente).not.toMatch(/turnoAbiertoDelNegocio/)
    // Y el porqué sigue escrito junto al `create`, que es donde lo va a leer quien lo cambie.
    expect(fuente).toMatch(/NO se estampa `shiftId`, y es DELIBERADO/)
  })
})
