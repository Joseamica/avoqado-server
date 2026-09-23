import prisma from '@/utils/prismaClient'

// Migración aditiva del KDS de Uber (fase 1, tarea 1): sólo verifica que las columnas
// y tablas nuevas existen, son opcionales, y que el índice de unicidad de
// DeliveryLineAction está bien formado. No prueba comportamiento — eso es de las
// tareas siguientes, que sí usan estos campos.
describe('migración uber-kds fase 1', () => {
  it('Order tiene las columnas nuevas y son opcionales', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'Order' AND column_name IN
        ('customerPhonePin','deliveryChannelLinkId','providerAcceptedAt','providerAcceptedEvidence',
         'readyReportedAt','deliveryOpInFlight','deliveryOpInFlightAt','deliveryOpToken','deliveryReconcileBlocked')`
    expect(cols).toHaveLength(9)
    expect(cols.every(c => c.is_nullable === 'YES')).toBe(true)
  })

  it('OrderItem, KdsOrder y KdsOrderItem tienen las columnas nuevas y son opcionales', async () => {
    const orderItemCols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'OrderItem' AND column_name IN ('externalLineId','removedAt')`
    expect(orderItemCols).toHaveLength(2)
    expect(orderItemCols.every(c => c.is_nullable === 'YES')).toBe(true)

    const kdsOrderCols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'KdsOrder' AND column_name IN ('customerName','customerContact')`
    expect(kdsOrderCols).toHaveLength(2)
    expect(kdsOrderCols.every(c => c.is_nullable === 'YES')).toBe(true)

    const kdsOrderItemCols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'KdsOrderItem' AND column_name IN ('orderItemId','externalLineId','removedAt')`
    expect(kdsOrderItemCols).toHaveLength(3)
    expect(kdsOrderItemCols.every(c => c.is_nullable === 'YES')).toBe(true)
  })

  it('DeliveryChannelLink tiene las columnas de autorización del dueño y activación', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'DeliveryChannelLink' AND column_name IN
        ('ownerAuthorizedAt','ownerAuthorizedEnvironment','ownerAuthorizedStoreId','ownerAuthorizedClientId',
         'ownerAuthorizedByIntentId','activatingIntentId','activationOwner','revocationVersion')`
    expect(cols).toHaveLength(8)
    const revocationVersion = cols.find(c => c.column_name === 'revocationVersion')
    expect(revocationVersion?.is_nullable).toBe('NO') // tiene @default(0), NOT NULL con default es aditivo
    expect(cols.filter(c => c.column_name !== 'revocationVersion').every(c => c.is_nullable === 'YES')).toBe(true)
  })

  it('DeliveryLineAction existe con la unicidad por (orderId, lineId, action)', async () => {
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'DeliveryLineAction'`
    expect(
      idx.some(i => /UNIQUE/i.test(i.indexdef) && /orderId/.test(i.indexdef) && /lineId/.test(i.indexdef) && /action/.test(i.indexdef)),
    ).toBe(true)
  })

  it('DeliveryConnectIntent existe con activationOwner y activationLeaseUntil', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'DeliveryConnectIntent' AND column_name IN ('activationOwner','activationLeaseUntil')`
    expect(cols).toHaveLength(2)
    expect(cols.every(c => c.is_nullable === 'YES')).toBe(true)
  })
})
