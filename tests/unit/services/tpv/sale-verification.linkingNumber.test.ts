/**
 * Número de vinculación desde la terminal (spec §5.3.2, plan A5): reglas de proof-of-sale y de la ruta del número.
 *
 * Una base de mentira con estado (una venta, su pago y la bitácora) para que el orden de llegada, los candados y el
 * máximo `captureSeq` por aparato se prueben de verdad entre dos llamadas. Sin `TEST_DATABASE_URL`.
 */

import { createOrUpdateProofOfSale, setNumberFromTerminal, type TerminalCapture } from '@/services/tpv/sale-verification.service'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { isLinkingNumberEnabledForOrg } from '@/services/playtelecom/linkingNumber.flag'
import { isNumberDuplicate } from '@/services/playtelecom/linkingNumber.duplicates'
import { createProofOfSaleSchema, setVerificationNumberSchema } from '@/schemas/tpv.schema'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn() },
    saleVerification: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ __esModule: true, isLinkingNumberEnabledForOrg: jest.fn() }))
jest.mock('@/services/playtelecom/linkingNumber.duplicates', () => ({ __esModule: true, isNumberDuplicate: jest.fn() }))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const PAYMENT = 'pay-1'
const VER = 'ver-1'
const PROMOTER = 'staff-promoter'
const CASHIER = 'staff-cashier'
const ICCID = '8952140012345678901F'
const NOW = new Date('2026-11-02T12:00:00.000Z')
const VINC = 'https://x/vinculacion.jpg'
const PORT = 'https://x/portabilidad.jpg'

type Row = Record<string, any>
type World = {
  paymentVenue: string
  sv: Row | null
  processedById: string | null
  tags: string[]
  skus: Array<string | null>
  staffVenues: Array<{ staffId: string; venueId: string }>
  moveOnTransaction: boolean
  activity: Row[]
}
let w: World
let tx: {
  $queryRaw: jest.Mock
  saleVerification: { update: jest.Mock; create: jest.Mock }
  activityLog: { create: jest.Mock }
}

const sale = (over: Row = {}): Row => ({
  id: VER,
  venueId: VENUE_A,
  paymentId: PAYMENT,
  staffId: PROMOTER,
  photos: [],
  scannedProducts: [],
  status: 'PENDING',
  inventoryDeducted: false,
  isPortabilidad: false,
  serialNumbers: [ICCID],
  deviceId: null,
  notes: null,
  reviewedById: null,
  reviewedAt: null,
  reviewNotes: null,
  rejectionReasons: [],
  linkingNumber: null,
  linkingNumberSource: null,
  linkingNumberSetAt: null,
  portedNumber: null,
  portedNumberSource: null,
  portedNumberSetAt: null,
  appliedCaptureSeqs: {},
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const capture = (seq: number, deviceId = 'device-1'): TerminalCapture => ({
  seq,
  deviceId,
  idempotencyKey: `key-${deviceId}-${seq}`,
  capturedAt: new Date('2026-11-02T11:59:00.000Z'),
})

function sqlText(query: any): string {
  if (Array.isArray(query?.strings)) return query.strings.join('?')
  return String(query?.sql ?? query)
}

beforeEach(() => {
  jest.resetAllMocks()
  w = {
    paymentVenue: VENUE_A,
    sv: sale(),
    processedById: PROMOTER,
    tags: [],
    skus: [ICCID],
    staffVenues: [{ staffId: PROMOTER, venueId: VENUE_A }],
    moveOnTransaction: false,
    activity: [],
  }
  ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(true)
  ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(true)
  ;(isNumberDuplicate as jest.Mock).mockResolvedValue(false)

  // La búsqueda va por organización (no por la tienda del token); con otra organización no hay venta.
  ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async ({ where }: any) =>
    where?.id === PAYMENT && where?.venue?.organizationId === ORG
      ? {
          id: PAYMENT,
          venueId: w.paymentVenue,
          processedById: w.processedById,
          saleVerification: w.sv ? { staffId: w.sv.staffId } : null,
          order: { tags: w.tags, items: w.skus.map(productSku => ({ productSku })) },
        }
      : null,
  )
  ;(prisma.saleVerification.findFirst as jest.Mock).mockImplementation(async ({ where }: any) =>
    w.sv && where?.id === w.sv.id && where?.venue?.organizationId === ORG
      ? { id: w.sv.id, venueId: w.sv.venueId, paymentId: w.sv.paymentId, staffId: w.sv.staffId }
      : null,
  )
  ;(prisma.staffVenue.findFirst as jest.Mock).mockImplementation(async ({ where }: any) =>
    where?.active === true && w.staffVenues.some(s => s.staffId === where.staffId && s.venueId === where.venueId) ? { id: 'sv-row' } : null,
  )

  tx = {
    $queryRaw: jest.fn(async (query: any) => {
      const text = sqlText(query)
      const values: unknown[] = Array.isArray(query?.values) ? query.values : []
      if (text.includes('FROM "Payment"')) return values.includes(w.paymentVenue) ? [{ id: PAYMENT, venueId: w.paymentVenue }] : []
      if (text.includes('FROM "SaleVerification"')) return w.sv && values.includes(w.sv.venueId) ? [{ ...w.sv }] : []
      throw new Error(`consulta inesperada: ${text}`)
    }),
    saleVerification: {
      update: jest.fn(async ({ data }: any) => (w.sv = { ...w.sv, ...data })),
      create: jest.fn(async ({ data }: any) => (w.sv = sale({ ...data }))),
    },
    activityLog: { create: jest.fn(async ({ data }: any) => w.activity.push(data)) },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: (client: typeof tx) => unknown) => {
    // El job de SIM de evento mueve la venta A→B entre la búsqueda y el candado.
    if (w.moveOnTransaction) {
      w.paymentVenue = VENUE_B
      if (w.sv) w.sv.venueId = VENUE_B
    }
    return callback(tx)
  })
})

const proof = (
  photoUrls: string[],
  opts: { capture?: TerminalCapture; linkingNumber?: string; portedNumber?: string; orgId?: string } = {},
  label: 'Vinculacion' | 'Portabilidad' | undefined = 'Vinculacion',
  staffId = PROMOTER,
) => createOrUpdateProofOfSale(VENUE_A, PAYMENT, photoUrls, staffId, VER, undefined, label, { orgId: ORG, ...opts })

const numberOnly = (number: string, cap: TerminalCapture, slot: 'VINCULACION' | 'PORTABILIDAD' = 'VINCULACION', staffId = PROMOTER) =>
  setNumberFromTerminal({ venueId: VENUE_A, orgId: ORG, staffId, verificationId: VER, slot, number, capture: cap })

describe('terminal publicada (sin captureSeq): exactamente lo de hoy', () => {
  it('una foto sobre una venta COMPLETED la guarda y la regresa a PENDING', async () => {
    w.sv = sale({ status: 'COMPLETED', photos: ['https://x/old.jpg'], reviewedAt: NOW })

    const result = await proof([VINC])

    expect(result).toEqual({ verificationId: VER, status: 'PENDING' })
    expect(w.sv!.photos).toEqual([VINC])
    expect(w.sv!.status).toBe('PENDING')
    expect(tx.saleVerification.update.mock.calls[0][0].data).toEqual({ photos: [VINC], status: 'PENDING' })
  })

  it('una venta REJECTED responde 400 con code SALE_REJECTED y no escribe', async () => {
    w.sv = sale({ status: 'REJECTED' })

    await expect(proof([VINC])).rejects.toMatchObject({ statusCode: 400, code: 'SALE_REJECTED' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('un número sin captureSeq responde 400 CAPTURE_REQUIRED antes de abrir la transacción', async () => {
    await expect(proof([VINC], { linkingNumber: '5512345678' })).rejects.toMatchObject({ statusCode: 400, code: 'CAPTURE_REQUIRED' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('terminal nueva (con captureSeq)', () => {
  it('una venta COMPLETED contesta SALE_ALREADY_APPROVED y la fila no cambia', async () => {
    const approved = sale({ status: 'COMPLETED', photos: ['https://x/old.jpg'], linkingNumber: '5511111111', linkingNumberSource: 'TPV' })
    w.sv = { ...approved }

    const result = await proof([VINC], { capture: capture(1), linkingNumber: '5522222222' })

    expect(result).toMatchObject({ verificationId: VER, status: 'COMPLETED', outcome: 'SALE_ALREADY_APPROVED' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
    expect(w.sv).toEqual(approved)
  })

  it('una venta REJECTED también responde 400 SALE_REJECTED', async () => {
    w.sv = sale({ status: 'REJECTED' })
    await expect(proof([VINC], { capture: capture(1) })).rejects.toMatchObject({ statusCode: 400, code: 'SALE_REJECTED' })
  })

  it('FAILED + foto ⇒ PENDING y se limpian los motivos y la nota', async () => {
    w.sv = sale({ status: 'FAILED', rejectionReasons: ['ILLEGIBLE_IMAGES'], reviewNotes: 'borrosa', reviewedAt: NOW })

    const result = await proof([VINC], { capture: capture(1) })

    expect(result).toMatchObject({ status: 'PENDING', outcome: 'APPLIED', photoOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({ status: 'PENDING', rejectionReasons: [], reviewNotes: null, photos: [VINC] })
  })

  // A11b punto 5: corregir sólo el número no borra lo que el back-office pidió corregir.
  it('FAILED + sólo número (ruta del número) ⇒ vuelve a PENDING con la nota y los motivos, sin tocar las fotos', async () => {
    w.sv = sale({ status: 'FAILED', photos: [VINC], rejectionReasons: ['DUPLICATE_LINKING'], reviewNotes: 'repetido', reviewedAt: NOW })

    const result = await numberOnly('55 1234-5678', capture(2))

    expect(result).toMatchObject({ status: 'PENDING', outcome: 'APPLIED', linkingNumberOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({
      status: 'PENDING',
      rejectionReasons: ['DUPLICATE_LINKING'],
      reviewNotes: 'repetido',
      photos: [VINC],
      linkingNumber: '5512345678',
    })
    const data = tx.saleVerification.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('photos')
    expect(data).not.toHaveProperty('reviewNotes')
    expect(data).not.toHaveProperty('rejectionReasons')
  })

  it('FAILED + proof-of-sale con la foto vieja (SUPERSEDED) y número nuevo ⇒ PENDING con la nota del back-office', async () => {
    w.sv = sale({
      status: 'FAILED',
      photos: [VINC],
      appliedCaptureSeqs: { PHOTO_VINCULACION: { 'device-1': 5 } },
      rejectionReasons: ['DUPLICATE_LINKING'],
      reviewNotes: 'repetido',
      reviewedAt: NOW,
    })

    const result = await proof(['https://x/vieja.jpg'], { capture: capture(3), linkingNumber: '5512345678' })

    expect(result).toMatchObject({ status: 'PENDING', photoOutcome: 'SUPERSEDED_BY_NEWER', linkingNumberOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({ status: 'PENDING', photos: [VINC], rejectionReasons: ['DUPLICATE_LINKING'], reviewNotes: 'repetido' })
  })

  it('número sin marcador ⇒ se escribe con fuente TPV y su hora, sin bitácora (no había uno)', async () => {
    const result = await proof([VINC], { capture: capture(1), linkingNumber: '(55) 1234.5678' })

    expect(result).toMatchObject({ outcome: 'APPLIED', linkingNumberOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({ linkingNumber: '5512345678', linkingNumberSource: 'TPV' })
    expect(w.sv!.linkingNumberSetAt).toBeInstanceOf(Date)
    expect(w.activity).toEqual([])
  })

  it('número distinto sobre uno de la TPV ⇒ se escribe y deja SALE_VERIFICATION_NUMBER_SET en la transacción', async () => {
    w.sv = sale({ portedNumber: '5511111111', portedNumberSource: 'TPV', isPortabilidad: true })

    const result = await proof([PORT], { capture: capture(3), portedNumber: '5522222222' }, 'Portabilidad')

    expect(result).toMatchObject({ portedNumberOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({ portedNumber: '5522222222', portedNumberSource: 'TPV' })
    expect(w.activity).toEqual([
      expect.objectContaining({
        staffId: PROMOTER,
        venueId: VENUE_A,
        organizationId: ORG,
        action: 'SALE_VERIFICATION_NUMBER_SET',
        entity: 'SaleVerification',
        entityId: VER,
        data: expect.objectContaining({
          field: 'portedNumber',
          before: '5511111111',
          after: '5522222222',
          source: 'TPV',
          idempotencyKey: 'key-device-1-3',
          capturedAt: '2026-11-02T11:59:00.000Z',
        }),
      }),
    ])
  })

  it('el mismo número otra vez ⇒ UNCHANGED, sin bitácora', async () => {
    w.sv = sale({ linkingNumber: '5512345678', linkingNumberSource: 'TPV' })

    const result = await numberOnly('5512345678', capture(4))

    expect(result).toMatchObject({ outcome: 'APPLIED', linkingNumberOutcome: 'UNCHANGED' })
    expect(w.activity).toEqual([])
  })

  it.each(['BACKOFFICE', 'EXTERNAL_SALE', 'IMPORT'])(
    'número escrito por %s ⇒ LOCKED_BY_BACKOFFICE y la foto sí se guarda',
    async source => {
      w.sv = sale({ linkingNumber: '5511111111', linkingNumberSource: source })

      const result = await proof([VINC], { capture: capture(1), linkingNumber: '5522222222' })

      expect(result).toMatchObject({ outcome: 'APPLIED', photoOutcome: 'APPLIED', linkingNumberOutcome: 'LOCKED_BY_BACKOFFICE' })
      expect(w.sv).toMatchObject({ linkingNumber: '5511111111', linkingNumberSource: source, photos: [VINC] })
      expect(w.activity).toEqual([])
    },
  )

  it('la ruta del número con un número del back-office ⇒ LOCKED_BY_BACKOFFICE y nada se escribe', async () => {
    w.sv = sale({ status: 'FAILED', linkingNumber: '5511111111', linkingNumberSource: 'BACKOFFICE' })

    const result = await numberOnly('5522222222', capture(1))

    expect(result).toMatchObject({ outcome: 'SUPERSEDED_BY_NEWER', linkingNumberOutcome: 'LOCKED_BY_BACKOFFICE', status: 'FAILED' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('sin número en el cuerpo ⇒ el guardado no se toca', async () => {
    w.sv = sale({ linkingNumber: '5511111111', linkingNumberSource: 'TPV' })

    const result = await proof([VINC], { capture: capture(1) })

    expect(result.linkingNumberOutcome).toBeUndefined()
    expect(w.sv).toMatchObject({ linkingNumber: '5511111111', photos: [VINC] })
    expect(tx.saleVerification.update.mock.calls[0][0].data).not.toHaveProperty('linkingNumber')
  })

  it('dos capturas del mismo aparato invertidas: la 5 sale SUPERSEDED_BY_NEWER; el reenvío de la 6 también; otro aparato se aplica', async () => {
    await proof(['https://x/seq6.jpg'], { capture: capture(6), linkingNumber: '5566666666' })
    expect(w.sv).toMatchObject({ photos: ['https://x/seq6.jpg'], linkingNumber: '5566666666' })

    const late = await proof(['https://x/seq5.jpg'], { capture: capture(5), linkingNumber: '5555555555' })
    expect(late).toMatchObject({
      outcome: 'SUPERSEDED_BY_NEWER',
      photoOutcome: 'SUPERSEDED_BY_NEWER',
      linkingNumberOutcome: 'SUPERSEDED_BY_NEWER',
    })
    expect(w.sv).toMatchObject({ photos: ['https://x/seq6.jpg'], linkingNumber: '5566666666' })

    const replay = await proof(['https://x/seq6.jpg'], { capture: capture(6), linkingNumber: '5566666666' })
    expect(replay).toMatchObject({ outcome: 'SUPERSEDED_BY_NEWER', photoOutcome: 'SUPERSEDED_BY_NEWER' })
    expect(tx.saleVerification.update).toHaveBeenCalledTimes(1)

    // Terminal reinstalada (otro captureDeviceId): su primera captura se aplica aunque su contador empiece en 1.
    const reinstalled = await proof(['https://x/new-device.jpg'], { capture: capture(1, 'device-2'), linkingNumber: '5577777777' })
    expect(reinstalled).toMatchObject({ outcome: 'APPLIED', photoOutcome: 'APPLIED', linkingNumberOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({ photos: ['https://x/new-device.jpg'], linkingNumber: '5577777777' })
    expect(w.sv!.appliedCaptureSeqs).toEqual({
      PHOTO_VINCULACION: { 'device-1': 6, 'device-2': 1 },
      LINKING: { 'device-1': 6, 'device-2': 1 },
    })
  })

  it('la ruta del número con un captureSeq viejo del mismo aparato ⇒ SUPERSEDED_BY_NEWER', async () => {
    await numberOnly('5566666666', capture(6))
    const late = await numberOnly('5555555555', capture(5))

    expect(late).toMatchObject({ outcome: 'SUPERSEDED_BY_NEWER', linkingNumberOutcome: 'SUPERSEDED_BY_NEWER' })
    expect(w.sv!.linkingNumber).toBe('5566666666')
  })

  it('foto y número son destinos distintos: no se estorban', async () => {
    // Foto (seq 5) y luego el número solo (seq 6).
    await proof([VINC], { capture: capture(5) })
    const n = await numberOnly('5512345678', capture(6))
    expect(n).toMatchObject({ outcome: 'APPLIED', linkingNumberOutcome: 'APPLIED' })

    // Una foto más nueva sin número (seq 8) no tapa a un número más viejo (seq 7) de la ruta del número.
    await proof(['https://x/seq8.jpg'], { capture: capture(8) })
    const older = await numberOnly('5599999999', capture(7))
    expect(older).toMatchObject({ outcome: 'APPLIED', linkingNumberOutcome: 'APPLIED' })
    expect(w.sv).toMatchObject({ photos: ['https://x/seq8.jpg'], linkingNumber: '5599999999' })
  })

  it.each(['+52 55 1234 5678', '525512345678', '55123456', '551234567O'])(
    'número inválido (%s) ⇒ 400 INVALID_LINKING_NUMBER antes de abrir la transacción',
    async bad => {
      await expect(proof([VINC], { capture: capture(1), linkingNumber: bad })).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_LINKING_NUMBER',
      })
      await expect(numberOnly(bad, capture(1))).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LINKING_NUMBER' })
      expect(prisma.$transaction).not.toHaveBeenCalled()
    },
  )

  it('acepta 9 dígitos', async () => {
    const result = await proof([VINC], { capture: capture(1), linkingNumber: '551234567' })
    expect(result.linkingNumberOutcome).toBe('APPLIED')
    expect(w.sv!.linkingNumber).toBe('551234567')
  })

  it('con el interruptor apagado: proof-of-sale ignora los números, guarda la foto y contesta DISABLED', async () => {
    ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(false)
    w.sv = sale({ isPortabilidad: true })

    const result = await proof([VINC], { capture: capture(1), linkingNumber: '5512345678', portedNumber: '5587654321' })

    expect(result).toMatchObject({
      outcome: 'APPLIED',
      photoOutcome: 'APPLIED',
      linkingNumberOutcome: 'DISABLED',
      portedNumberOutcome: 'DISABLED',
    })
    expect(w.sv).toMatchObject({ photos: [VINC], linkingNumber: null, portedNumber: null })
    expect(isLinkingNumberEnabledForOrg).toHaveBeenCalledWith(ORG)
  })

  it('con el interruptor apagado: la ruta del número responde 422 LINKING_NUMBER_DISABLED', async () => {
    ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(false)

    await expect(numberOnly('5512345678', capture(1))).rejects.toMatchObject({ statusCode: 422, code: 'LINKING_NUMBER_DISABLED' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('con el interruptor apagado, un número mal escrito también responde 422 LINKING_NUMBER_DISABLED (no 400)', async () => {
    ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(false)

    await expect(numberOnly('+52 55 1234 5678', capture(1))).rejects.toMatchObject({ statusCode: 422, code: 'LINKING_NUMBER_DISABLED' })
  })

  it('la respuesta trae linkingDuplicate/portedDuplicate de isNumberDuplicate', async () => {
    w.sv = sale({ isPortabilidad: true })
    ;(isNumberDuplicate as jest.Mock).mockImplementation(async (_org: string, n: string) => n === '5512345678')

    const result = await proof([VINC], { capture: capture(1), linkingNumber: '5512345678', portedNumber: '5587654321' })

    expect(result).toMatchObject({ linkingDuplicate: true, portedDuplicate: false })
    expect(isNumberDuplicate).toHaveBeenCalledWith(ORG, '5512345678', { verificationId: VER, iccid: ICCID })
    expect(isNumberDuplicate).toHaveBeenCalledWith(ORG, '5587654321', { verificationId: VER, iccid: ICCID })
  })
})

// A11b punto 4b: un portado en una venta que no es de portabilidad no se guarda (luego nadie lo podría borrar).
describe('portado en una venta que no es portabilidad', () => {
  it('proof-of-sale: la foto y la vinculación entran; el portado no se guarda y sale NOT_PORTABILIDAD', async () => {
    const result = await proof([VINC], { capture: capture(1), linkingNumber: '5512345678', portedNumber: '557777777' })

    expect(result).toMatchObject({ outcome: 'APPLIED', linkingNumberOutcome: 'APPLIED', portedNumberOutcome: 'NOT_PORTABILIDAD' })
    expect(w.sv).toMatchObject({ photos: [VINC], linkingNumber: '5512345678', portedNumber: null, portedNumberSource: null })
    expect(w.sv!.appliedCaptureSeqs).not.toHaveProperty('PORTED')
    expect(isNumberDuplicate).not.toHaveBeenCalledWith(ORG, '557777777', expect.anything())
  })

  it('la ruta del número: NOT_PORTABILIDAD y nada se escribe', async () => {
    const result = await numberOnly('557777777', capture(1), 'PORTABILIDAD')

    expect(result).toMatchObject({ outcome: 'SUPERSEDED_BY_NEWER', portedNumberOutcome: 'NOT_PORTABILIDAD' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('la venta cobrada sin verificación usa la portabilidad de la orden', async () => {
    w.sv = null
    const result = await proof([PORT], { capture: capture(1), portedNumber: '5587654321' }, 'Portabilidad')

    expect(result).toMatchObject({ outcome: 'APPLIED', portedNumberOutcome: 'NOT_PORTABILIDAD' })
    expect(tx.saleVerification.create.mock.calls[0][0].data).toMatchObject({ isPortabilidad: false })
    expect(tx.saleVerification.create.mock.calls[0][0].data).not.toHaveProperty('portedNumber')
  })
})

// A11b punto 6: la terminal reintenta una captura que sí entró (no supo la respuesta) y entretanto la venta se aprobó.
describe('reintento de una captura ya aplicada', () => {
  it('se aprobó después ⇒ SUPERSEDED_BY_NEWER (ya aplicada), no SALE_ALREADY_APPROVED', async () => {
    await expect(proof([VINC], { capture: capture(7), linkingNumber: '5512345678' })).resolves.toMatchObject({ outcome: 'APPLIED' })
    w.sv = { ...w.sv!, status: 'COMPLETED' } // el back-office la aprueba

    const retry = await proof([VINC], { capture: capture(7), linkingNumber: '5512345678' })

    expect(retry).toMatchObject({
      status: 'COMPLETED',
      outcome: 'SUPERSEDED_BY_NEWER',
      photoOutcome: 'SUPERSEDED_BY_NEWER',
      linkingNumberOutcome: 'SUPERSEDED_BY_NEWER',
    })
    expect(tx.saleVerification.update).toHaveBeenCalledTimes(1)
  })

  it('se rechazó después ⇒ también SUPERSEDED_BY_NEWER, no 400 SALE_REJECTED', async () => {
    await proof([VINC], { capture: capture(7) })
    w.sv = { ...w.sv!, status: 'REJECTED' }

    await expect(proof([VINC], { capture: capture(7) })).resolves.toMatchObject({ outcome: 'SUPERSEDED_BY_NEWER' })
  })

  it('una captura NUEVA sobre la venta aprobada sigue saliendo SALE_ALREADY_APPROVED', async () => {
    await proof([VINC], { capture: capture(7) })
    w.sv = { ...w.sv!, status: 'COMPLETED' }

    await expect(proof([VINC], { capture: capture(8) })).resolves.toMatchObject({ outcome: 'SALE_ALREADY_APPROVED' })
  })

  it('si un número de la petición no había entrado, no es reintento: la venta aprobada no se toca', async () => {
    await proof([VINC], { capture: capture(7) })
    w.sv = { ...w.sv!, status: 'COMPLETED' }

    await expect(proof([VINC], { capture: capture(7), linkingNumber: '5512345678' })).resolves.toMatchObject({
      outcome: 'SALE_ALREADY_APPROVED',
    })
    expect(w.sv!.linkingNumber).toBeNull()
  })
})

describe('venta movida por el job de SIM de evento', () => {
  it('se encuentra por paymentId dentro de la organización y se acepta porque el staff es el promotor', async () => {
    w.paymentVenue = VENUE_B
    w.sv = sale({ venueId: VENUE_B })

    const result = await proof([VINC], { capture: capture(1), linkingNumber: '5512345678' })

    expect(result).toMatchObject({ outcome: 'APPLIED' })
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAYMENT, venue: { organizationId: ORG } } }),
    )
    expect(tx.saleVerification.update.mock.calls[0][0].where).toEqual({ id: VER, paymentId: PAYMENT, venueId: VENUE_B })
    expect(moduleService.isModuleEnabled).toHaveBeenCalledWith(VENUE_B, 'SERIALIZED_INVENTORY')
  })

  it('otro staff con StaffVenue activo en la tienda de la venta también puede; sin él, 404', async () => {
    w.staffVenues.push({ staffId: CASHIER, venueId: VENUE_A })
    await expect(proof([VINC], { capture: capture(1) }, 'Vinculacion', CASHIER)).resolves.toMatchObject({ outcome: 'APPLIED' })

    await expect(proof([VINC], { capture: capture(2) }, 'Vinculacion', 'staff-stranger')).rejects.toMatchObject({ statusCode: 404 })
    await expect(numberOnly('5512345678', capture(3), 'VINCULACION', 'staff-stranger')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('si cambia de tienda entre la búsqueda y el candado ⇒ 409 VERIFICATION_MOVED, sin escribir', async () => {
    w.moveOnTransaction = true
    await expect(proof([VINC], { capture: capture(1) })).rejects.toMatchObject({ statusCode: 409, code: 'VERIFICATION_MOVED' })

    w.paymentVenue = VENUE_A
    w.sv!.venueId = VENUE_A
    await expect(numberOnly('5512345678', capture(2))).rejects.toMatchObject({ statusCode: 409, code: 'VERIFICATION_MOVED' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('de otra organización ⇒ 404', async () => {
    await expect(proof([VINC], { capture: capture(1), orgId: OTHER_ORG })).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      setNumberFromTerminal({
        venueId: VENUE_A,
        orgId: OTHER_ORG,
        staffId: PROMOTER,
        verificationId: VER,
        slot: 'VINCULACION',
        number: '5512345678',
        capture: capture(1),
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('venta cobrada cuya verificación no se creó', () => {
  it('la primera foto (Portabilidad) crea la verificación con los datos de la orden y la foto en su ranura', async () => {
    w.sv = null
    w.tags = ['portabilidad']
    w.skus = [ICCID, null]
    w.processedById = PROMOTER
    w.staffVenues.push({ staffId: CASHIER, venueId: VENUE_A }) // sube la foto otra persona de la tienda

    const result = await createOrUpdateProofOfSale(VENUE_A, PAYMENT, [PORT], CASHIER, undefined, undefined, 'Portabilidad', {
      orgId: ORG,
      capture: capture(1),
      portedNumber: '5587654321',
    })

    expect(result).toMatchObject({ status: 'PENDING', outcome: 'APPLIED', photoOutcome: 'APPLIED', portedNumberOutcome: 'APPLIED' })
    expect(tx.saleVerification.create.mock.calls[0][0].data).toMatchObject({
      venueId: VENUE_A,
      paymentId: PAYMENT,
      staffId: PROMOTER,
      photos: ['', PORT],
      isPortabilidad: true,
      serialNumbers: [ICCID],
      status: 'PENDING',
      portedNumber: '5587654321',
      portedNumberSource: 'TPV',
      appliedCaptureSeqs: { PHOTO_PORTABILIDAD: { 'device-1': 1 }, PORTED: { 'device-1': 1 } },
    })
  })

  it('los ICCID de la orden se leen en un orden estable (createdAt, id): serialNumbers[0] es el que usan los repetidos', async () => {
    w.sv = null

    await createOrUpdateProofOfSale(VENUE_A, PAYMENT, [VINC], PROMOTER, undefined, undefined, undefined, { orgId: ORG })

    const items = (prisma.payment.findFirst as jest.Mock).mock.calls[0][0].select.order.select.items
    expect(items.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
  })

  it('sin quien cobró, el staff es el remitente (terminal vieja, sin captura)', async () => {
    w.sv = null
    w.processedById = null

    const result = await createOrUpdateProofOfSale(VENUE_A, PAYMENT, [VINC], PROMOTER, undefined, undefined, undefined, { orgId: ORG })

    expect(result).toEqual({ verificationId: VER, status: 'PENDING' })
    expect(tx.saleVerification.create.mock.calls[0][0].data).toMatchObject({
      staffId: PROMOTER,
      photos: [VINC],
      isPortabilidad: false,
      serialNumbers: [ICCID],
    })
  })
})

describe('schemas de la terminal', () => {
  const PAYMENT_CUID = 'cjld2cjxh0000qzrmn831i7rn'
  const captureBody = { idempotencyKey: 'k-1', captureSeq: 7, captureDeviceId: 'device-1', capturedAt: '2026-11-02T11:59:00-06:00' }

  it('proof-of-sale conserva los campos nuevos (Zod tiraría en silencio los que no declara)', () => {
    const parsed = createProofOfSaleSchema.parse({
      body: { paymentId: PAYMENT_CUID, photoUrls: [VINC], linkingNumber: '55 1234 5678', portedNumber: '5587654321', ...captureBody },
    })
    expect(parsed.body).toMatchObject({ linkingNumber: '55 1234 5678', portedNumber: '5587654321', ...captureBody })
  })

  it('proof-of-sale de una terminal publicada sigue pasando sin nada nuevo', () => {
    expect(createProofOfSaleSchema.safeParse({ body: { paymentId: PAYMENT_CUID, photoUrls: [VINC] } }).success).toBe(true)
  })

  it('captureSeq sin su aparato, llave u hora ⇒ issue con code CAPTURE_REQUIRED', () => {
    const r = createProofOfSaleSchema.safeParse({ body: { paymentId: PAYMENT_CUID, photoUrls: [VINC], captureSeq: 1 } })
    expect(r.success).toBe(false)
    expect((r as any).error.errors[0].params).toEqual({ code: 'CAPTURE_REQUIRED' })
  })

  it('la ruta del número exige slot, número y la captura completa', () => {
    const params = { verificationId: PAYMENT_CUID }
    expect(
      setVerificationNumberSchema.safeParse({ params, body: { slot: 'VINCULACION', number: '5512345678', ...captureBody } }).success,
    ).toBe(true)
    expect(setVerificationNumberSchema.safeParse({ params, body: { slot: 'VINCULACION', number: '5512345678' } }).success).toBe(false)
    expect(setVerificationNumberSchema.safeParse({ params, body: { slot: 'OTRO', number: '5512345678', ...captureBody } }).success).toBe(
      false,
    )
  })
})
