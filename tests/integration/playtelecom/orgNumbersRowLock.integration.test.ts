/**
 * Corrección del número desde el back-office (plan A7, `PATCH …/:id/numbers`) contra Postgres real: la fila se toma con
 * `FOR UPDATE OF sv`, así que dos correcciones de la misma venta al mismo tiempo se forman. La segunda lee como «antes»
 * lo que escribió la primera (no el número viejo) y quedan dos renglones de bitácora que encadenan.
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/playtelecom/orgNumbersRowLock.integration.test.ts
 */
import { randomUUID } from 'crypto'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { setOrgSaleVerificationNumbers } from '@/services/dashboard/sale-verification.org.dashboard.service'

// El interruptor es de A3; aquí se prueba el candado de la fila.
jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ __esModule: true, isLinkingNumberEnabledForOrg: async () => true }))

const tag = `candado-numero-${randomUUID()}`
const ORG = cuid()
let venueId = ''
let editorId = ''
let svId = ''
const ORIGINAL = '5511111111'

beforeAll(async () => {
  await prisma.organization.create({ data: { id: ORG, name: tag, email: `${ORG}@example.test`, phone: '5500000000' } })
  venueId = (await prisma.venue.create({ data: { organizationId: ORG, name: `${tag} A`, slug: tag } })).id
  editorId = (await prisma.staff.create({ data: { email: `${tag}@example.test`, firstName: 'Back', lastName: 'Office' } })).id
  const order = await prisma.order.create({ data: { venueId, orderNumber: randomUUID(), subtotal: 100, taxAmount: 0, total: 100 } })
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: 100,
      method: 'CASH',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
    },
  })
  svId = (
    await prisma.saleVerification.create({
      data: {
        venueId,
        paymentId: payment.id,
        staffId: editorId,
        photos: ['f1'],
        status: 'PENDING',
        isPortabilidad: false,
        serialNumbers: ['ICC-CANDADO'],
        linkingNumber: ORIGINAL,
        linkingNumberSource: 'TPV',
      },
    })
  ).id
})

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { organizationId: ORG } })
  if (venueId) {
    await prisma.saleVerification.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (editorId) await prisma.staff.deleteMany({ where: { id: editorId } })
  await prisma.organization.deleteMany({ where: { id: ORG } })
  await prisma.$disconnect()
})

describe('PATCH numbers: FOR UPDATE OF sv', () => {
  it('dos correcciones a la vez: la segunda ve como «antes» lo que dejó la primera y quedan dos bitácoras encadenadas', async () => {
    const corregir = (linkingNumber: string) =>
      setOrgSaleVerificationNumbers(ORG, { saleVerificationId: svId, editedById: editorId, linkingNumber, reason: 'Foto' })

    await Promise.all([corregir('5522222222'), corregir('5533333333')])

    const logs = await prisma.activityLog.findMany({
      where: { organizationId: ORG, entityId: svId, action: 'SALE_VERIFICATION_NUMBER_EDIT' },
      select: { data: true },
      take: 10,
    })
    expect(logs).toHaveLength(2)
    const pasos = logs.map(l => l.data as { before: string | null; after: string })
    const primero = pasos.find(p => p.before === ORIGINAL)
    expect(primero).toBeDefined()
    const segundo = pasos.find(p => p !== primero)!
    expect(segundo.before).toBe(primero!.after) // sin el candado las dos leerían el número viejo
    expect(segundo.after).not.toBe(primero!.after)

    const fila = await prisma.saleVerification.findUnique({
      where: { id: svId },
      select: { linkingNumber: true, linkingNumberSource: true },
    })
    expect(fila).toEqual({ linkingNumber: segundo.after, linkingNumberSource: 'BACKOFFICE' })
  })
})
