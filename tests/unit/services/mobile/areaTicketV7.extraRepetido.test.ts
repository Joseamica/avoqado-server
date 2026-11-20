/**
 * Vales por área con la MISMA opción elegida varias veces (grupo que deja repetir, encargo a508f4; Codex r1 #3 y #4):
 * - lo que se aparta al emitir es una porción por VEZ, igual que lo que consume el cobro (un renglón por vez);
 * - [X] y [X, X] son vales distintos: el reintento con la misma llave y otra cantidad de veces es conflicto (409), no éxito.
 */
import { Prisma } from '@prisma/client'
import { buildReservationSpecs, issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'venue-1'

describe('Vale con un extra repetido: lo que se aparta', () => {
  beforeEach(() => jest.clearAllMocks())

  it('2 veces un extra de insumo y 2 veces uno ligado a platillo apartan el doble que una vez', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p-paquete', name: 'Paquete', trackInventory: false, inventoryMethod: null, inventory: null, recipe: null },
    ] as any)
    prismaMock.modifier.findMany.mockResolvedValue([
      {
        id: 'mod-cochinita',
        groupId: 'g-flautas',
        inventoryMode: 'ADDITION',
        rawMaterial: null,
        quantityPerUnit: null,
        unit: null,
        linkedProduct: {
          id: 'p-flauta-cochinita',
          name: 'Flauta Cochinita',
          venueId,
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          soldByWeight: false,
          inventory: { id: 'inv-cochinita' },
          recipe: null,
        },
      },
      {
        id: 'mod-queso',
        groupId: 'g-extras',
        inventoryMode: 'ADDITION',
        rawMaterial: { id: 'raw-queso', name: 'Queso', unit: 'GRAM' },
        quantityPerUnit: new Prisma.Decimal('30'),
        unit: 'GRAM',
        linkedProduct: null,
      },
    ] as any)

    const specs = await buildReservationSpecs(
      venueId,
      [{ clientLineId: 'l1', modifierIds: ['mod-cochinita', 'mod-queso', 'mod-cochinita', 'mod-queso'] }] as any,
      [{ productId: 'p-paquete', quantity: '1', weightKg: null }] as any,
    )
    const porDestino = Object.fromEntries(specs.map((s: any) => [s.inventoryId, s.quantityBaseUnits.toString()]))
    expect(porDestino).toEqual({ 'inv-cochinita': '2', 'raw-queso': '60' })
  })

  it('regresión: cada extra una vez aparta lo mismo que antes', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p-burger', name: 'Hamburguesa', trackInventory: false, inventoryMethod: null, inventory: null, recipe: null },
    ] as any)
    prismaMock.modifier.findMany.mockResolvedValue([
      {
        id: 'mod-queso',
        groupId: 'g1',
        inventoryMode: 'ADDITION',
        rawMaterial: { id: 'raw-queso', name: 'Queso', unit: 'GRAM' },
        quantityPerUnit: new Prisma.Decimal('30'),
        unit: 'GRAM',
        linkedProduct: null,
      },
    ] as any)
    const specs = await buildReservationSpecs(
      venueId,
      [{ clientLineId: 'l1', modifierIds: ['mod-queso'] }] as any,
      [{ productId: 'p-burger', quantity: '2', weightKg: null }] as any,
    )
    expect(specs.map((s: any) => s.quantityBaseUnits.toString())).toEqual(['60'])
  })
})

describe('Vale con un extra repetido: reintento con la misma llave', () => {
  const cero = new Prisma.Decimal(0)
  const guardado = (veces: number) => ({
    id: 'ticket-1',
    code: '812345678',
    status: 'ISSUED',
    fulfillmentModeSnapshot: 'IMMEDIATE',
    settlementRoute: 'AVOQADO',
    fulfillmentArea: null,
    sourceTerminal: null,
    currency: 'MXN',
    subtotal: new Prisma.Decimal(168),
    discountAmount: cero,
    taxAmount: cero,
    total: new Prisma.Decimal(168),
    pricingSnapshotHash: 'hash',
    printStatus: 'PENDING',
    version: 1,
    lines: [
      {
        id: 'line-1',
        clientLineId: 'l1',
        productId: 'p-paquete',
        productNameSnapshot: 'Paquete',
        skuSnapshot: null,
        categoryNameSnapshot: null,
        modifiersSnapshot: Array.from({ length: veces }, () => ({
          modifierId: 'mod-cochinita',
          name: 'Cochinita',
          quantity: 1,
          price: '0.00',
        })),
        quantity: new Prisma.Decimal(1),
        weightKg: null,
        unitPrice: new Prisma.Decimal(168),
        discountAmount: cero,
        appliedDiscountId: null,
        taxAmount: cero,
        total: new Prisma.Decimal(168),
        notes: null,
        orderItem: null,
      },
    ],
    fulfillment: null,
    externalSettlement: null,
  })
  const reintento = (veces: number) => ({
    idempotencyKey: 'k-vale',
    deviceUid: 'device-1',
    lines: [{ clientLineId: 'l1', productId: 'p-paquete', quantity: '1', modifierIds: Array(veces).fill('mod-cochinita') }],
  })

  beforeEach(() => jest.clearAllMocks())

  it('guardado con 1 vez y reintento con 2 veces ⇒ 409, no el vale viejo', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(guardado(1) as any)
    await expect(issueAreaTicket(venueId, reintento(2) as any)).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })

  it('guardado con 2 veces y reintento con 1 vez ⇒ 409', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(guardado(2) as any)
    await expect(issueAreaTicket(venueId, reintento(1) as any)).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })

  it('el mismo vale con 2 veces se reconoce al repetirse (no 409)', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(guardado(2) as any)
    await expect(issueAreaTicket(venueId, reintento(2) as any)).resolves.toMatchObject({ id: 'ticket-1' })
  })
})
