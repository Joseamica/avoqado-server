/**
 * Máquina de efectivo (rediseño r3): el arnés de las pruebas del folio. Corre el núcleo REAL (`crearVentaDeMostradorEnTx` +
 * `registrarAbonoEnTx`) contra el doble de Prisma, con las tablas de la máquina en memoria (`maquinaEnMemoria.ts`). Cada archivo de
 * prueba pone sus propios `jest.mock` (van antes de los import) y llama `prepararArnes` en su `beforeEach`.
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'

import { BadRequestError } from '@/errors/AppError'
import type { AutorDeLaMaquina, CierreDeLaMaquina, LectorDelPedido } from '@/services/cashMachine/ventaDeLaMaquina'
import { instalarMaquinaEnMemoria, type BaseDeLaMaquina } from './maquinaEnMemoria'

export const D = (v: number) => new Prisma.Decimal(v)
export const VENUE = 'venue-1'
export const REF = 'AQ0123456789AB'
export const CREDENCIAL = 'credencial-de-la-pc'
export const HASH_DE_LA_PC = createHash('sha256').update(CREDENCIAL).digest('hex')
/** La PC emparejada (`terminal-pc`, emparejamiento `b1`). */
export const PC: AutorDeLaMaquina = { userId: 'staff-cajera', deviceUid: 'pc-uid-1', credencial: CREDENCIAL }
/** Otra PC del negocio (`terminal-pc-B`), con su propia credencial. */
export const PC_B: AutorDeLaMaquina = { userId: 'staff-B', deviceUid: 'pc-uid-2', credencial: 'credencial-de-B' }
export const GERENTE = 'staff-gerente'

export const CARRITO = { items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750 }], orderType: 'TAKEOUT', source: 'AVOQADO_ANDROID' }

export const cierre = (over: Partial<CierreDeLaMaquina> = {}): CierreDeLaMaquina => ({
  outcome: 'PAGADO',
  dueCents: 18750,
  saleCents: 18750,
  tipCents: 0,
  creditCents: 20000,
  changeDispensedCents: 1250,
  occurredAtKnown: true,
  occurredAt: '2026-11-20T18:00:00.000Z',
  saleShiftId: 'shift-A',
  ...over,
})

/** El lector del carrito congelado (lo que hace el controlador con `leerCarritoDeLaMaquina`): uno sin productos es un 400. */
export const lector: jest.MockedFunction<LectorDelPedido> = jest.fn(async (crudo: unknown, vendedor: string) => {
  const c = crudo as { items?: unknown[]; staffId?: string } | null
  if (!c || !Array.isArray(c.items) || c.items.length === 0) throw new BadRequestError('Se requiere al menos un producto')
  return { ...(c as object), staffId: c.staffId ?? vendedor } as never
})

export interface Arnes {
  base: BaseDeLaMaquina
  /** Lo que la cuenta debe (pesos) según el servidor. */
  subtotal: { pesos: number }
  turnoA: { id: string; status: string; endTime: Date | null; startTime: Date } | null
  turnoB: { id: string; status: string; endTime: Date | null; startTime: Date }
}

const sqlDe = (a: any): string => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? a?.strings?.join('?') ?? ''))

export function prepararArnes(prismaMock: any): Arnes {
  const base = instalarMaquinaEnMemoria(prismaMock)
  const arnes: Arnes = {
    base,
    subtotal: { pesos: 187.5 },
    turnoA: { id: 'shift-A', status: 'OPEN', endTime: null, startTime: new Date('2026-11-20T14:00:00.000Z') },
    turnoB: { id: 'shift-B', status: 'OPEN', endTime: null, startTime: new Date('2026-11-20T17:00:00.000Z') },
  }
  base.vinculos.push(
    {
      id: 'b1',
      venueId: VENUE,
      deviceId: 'terminal-pc',
      machineIp: '192.168.1.50',
      credentialHash: HASH_DE_LA_PC,
      active: true,
      revokedAt: null,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      id: 'bB',
      venueId: VENUE,
      deviceId: 'terminal-pc-B',
      machineIp: '192.168.1.51',
      credentialHash: createHash('sha256').update('credencial-de-B').digest('hex'),
      active: false,
      revokedAt: new Date('2026-11-10T00:00:00.000Z'),
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
    },
  )
  lector.mockClear()
  prismaMock.$queryRaw.mockImplementation(async (plantilla: any) => {
    const sql = sqlDe(plantilla)
    if (sql.includes('hashtextextended')) return [{ pg_advisory_xact_lock: '' }]
    if (sql.includes('clock_timestamp')) return [{ ms: BigInt(Date.parse('2026-11-20T18:05:00.000Z')) }]
    return [{ id: 'order-1' }]
  })
  prismaMock.staffVenue.findFirst.mockImplementation(async (a: any) => ({
    id: 'sv',
    staffId: a?.where?.staffId,
    venueId: VENUE,
    active: true,
  }))
  prismaMock.terminal.findFirst.mockImplementation(async (a: any) =>
    a?.where?.deviceUid === 'pc-uid-1' ? { id: 'terminal-pc' } : a?.where?.deviceUid === 'pc-uid-2' ? { id: 'terminal-pc-B' } : null,
  )
  prismaMock.shift.findFirst.mockImplementation(async (a: any) => {
    const where = a?.where ?? {}
    if (where.id) return [arnes.turnoA, arnes.turnoB].find(t => t && t.id === where.id) ?? null
    // El turno vivo del negocio: A mientras siga abierto; si no, B.
    if (where.status?.in || where.status === 'OPEN') return arnes.turnoA?.status === 'OPEN' ? arnes.turnoA : arnes.turnoB
    return null
  })
  prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findFirst.mockResolvedValue({ shiftId: null })
  prismaMock.order.findUnique.mockImplementation(async (a: any) =>
    a?.where?.venueId_externalId
      ? null
      : {
          id: 'order-1',
          orderNumber: 'ORD-1',
          paymentStatus: 'PENDING',
          subtotal: D(arnes.subtotal.pesos),
          discountAmount: D(0),
          serviceChargeAmount: D(0),
          status: 'CONFIRMED',
          contratoDePrecio: 'IVA_INCLUIDO',
          taxAmount: D(0),
          originSystem: 'AVOQADO',
          version: 1,
          areaTicketCode: null,
          tableId: null,
          total: D(arnes.subtotal.pesos),
          paidAmount: D(0),
          remainingBalance: D(arnes.subtotal.pesos),
        },
  )
  prismaMock.order.create.mockImplementation(async ({ data }: any) => ({ id: 'order-1', ...data, items: [], promotions: [] }))
  prismaMock.order.update.mockImplementation(async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    ...data,
    items: [],
    promotions: [],
  }))
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'payment-1', createdAt: new Date(), ...data }))
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-abierta' })
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$executeRaw.mockResolvedValue(0)
  return arnes
}
