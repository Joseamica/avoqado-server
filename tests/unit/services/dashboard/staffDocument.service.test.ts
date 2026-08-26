/**
 * Expediente del personal.
 *
 * 🔴 Son DATOS PERSONALES SENSIBLES: identificación, CURP, número de seguro social,
 * contratos. Dos invariantes que estas pruebas defienden:
 *
 *  1. **Aislamiento entre negocios.** Un id de otro negocio no debe devolver nada, ni
 *     dejar subir nada. Es lo único que separa el expediente de una persona del de otra
 *     empresa que use la misma plataforma.
 *  2. **El borrado es SUAVE.** En México hay obligación de conservar ciertos documentos
 *     laborales después de que la persona se va; un borrado duro deja al negocio sin con
 *     qué responder.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))

const mockSave = jest.fn().mockResolvedValue({ path: 'private/test/staff/venue-1/staff-1/1_ine.pdf' })
const mockSign = jest.fn().mockResolvedValue('https://signed.example/doc?sig=abc')
jest.mock('@/services/privateStorage.service', () => ({
  savePrivateFile: (...a: unknown[]) => mockSave(...(a as [])),
  signPrivateFileUrl: (...a: unknown[]) => mockSign(...(a as [])),
  deletePrivateFile: jest.fn(),
}))

import { addStaffDocument, getStaffDocumentUrl, listStaffDocuments, removeStaffDocument } from '@/services/dashboard/staffDocument.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const VENUE_ID = 'venue-1'
const STAFF_ID = 'staff-1'
const DOC_ID = 'doc-1'
const ACTOR_ID = 'staff-boss'

const input = (over: Partial<any> = {}) => ({ type: 'ID' as const, ...over })
const file = { originalname: 'ine.pdf', mimetype: 'application/pdf', size: 120_000, buffer: Buffer.from('pdf') }

describe('listStaffDocuments', () => {
  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockReset().mockResolvedValue({ id: 'sv-1' } as any)
    prismaMock.staffDocument.findMany.mockReset().mockResolvedValue([])
  })

  it('exige que la persona trabaje en ESTE negocio', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    await expect(listStaffDocuments(VENUE_ID, STAFF_ID)).rejects.toThrow(NotFoundError)
    expect(prismaMock.staffDocument.findMany).not.toHaveBeenCalled()
  })

  it('no devuelve los documentos ya dados de baja', async () => {
    await listStaffDocuments(VENUE_ID, STAFF_ID)

    expect(prismaMock.staffDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffId: STAFF_ID, venueId: VENUE_ID, deletedAt: null }),
      }),
    )
  })
})

describe('addStaffDocument', () => {
  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockReset().mockResolvedValue({ id: 'sv-1' } as any)
    prismaMock.staffDocument.create.mockReset().mockResolvedValue({ id: DOC_ID, type: 'ID' } as any)
    mockSave.mockReset().mockResolvedValue({ path: 'private/test/staff/venue-1/staff-1/1_ine.pdf' })
    mockLogAction.mockReset()
  })

  it('no deja subir un documento a alguien de otro negocio', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    await expect(addStaffDocument(VENUE_ID, STAFF_ID, input(), file, ACTOR_ID)).rejects.toThrow(NotFoundError)
    expect(prismaMock.staffDocument.create).not.toHaveBeenCalled()
  })

  it('guarda quién lo subió', async () => {
    await addStaffDocument(VENUE_ID, STAFF_ID, input(), file, ACTOR_ID)

    expect(prismaMock.staffDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ uploadedById: ACTOR_ID, venueId: VENUE_ID, staffId: STAFF_ID }) }),
    )
  })

  it('🔴 el archivo va a la caja fuerte, acotada al negocio y a la persona', async () => {
    await addStaffDocument(VENUE_ID, STAFF_ID, input(), file, ACTOR_ID)

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ scope: `staff/${VENUE_ID}/${STAFF_ID}`, fileName: 'ine.pdf', contentType: 'application/pdf' }),
    )
  })

  it('🔴 guarda la RUTA privada, nunca una URL', async () => {
    await addStaffDocument(VENUE_ID, STAFF_ID, input(), file, ACTOR_ID)

    const data = prismaMock.staffDocument.create.mock.calls[0][0].data
    expect(data.storagePath).toMatch(/^private\//)
    expect(data.storagePath).not.toMatch(/^https?:/)
    expect(data).not.toHaveProperty('fileUrl')
  })

  it('no toca la base si la subida a Storage falla', async () => {
    mockSave.mockRejectedValueOnce(new Error('bucket down'))

    await expect(addStaffDocument(VENUE_ID, STAFF_ID, input(), file, ACTOR_ID)).rejects.toThrow('bucket down')
    expect(prismaMock.staffDocument.create).not.toHaveBeenCalled()
  })

  it('un tipo OTRO sin nombre no se acepta', async () => {
    // Sin etiqueta, "OTRO" no le dice nada a quien abra la carpeta dentro de un año.
    await expect(addStaffDocument(VENUE_ID, STAFF_ID, input({ type: 'OTHER', label: '  ' }), file, ACTOR_ID)).rejects.toThrow(
      BadRequestError,
    )
    expect(prismaMock.staffDocument.create).not.toHaveBeenCalled()
  })

  it('un tipo OTRO con nombre sí se acepta', async () => {
    await expect(
      addStaffDocument(VENUE_ID, STAFF_ID, input({ type: 'OTHER', label: 'Carta de recomendación' }), file, ACTOR_ID),
    ).resolves.toBeDefined()
  })

  it('deja rastro en la bitácora — quién abrió el expediente de quién', async () => {
    await addStaffDocument(VENUE_ID, STAFF_ID, input(), file, ACTOR_ID)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: ACTOR_ID, venueId: VENUE_ID, action: 'STAFF_DOCUMENT_ADDED', entity: 'StaffDocument' }),
    )
  })
})

describe('removeStaffDocument', () => {
  beforeEach(() => {
    prismaMock.staffDocument.findFirst.mockReset().mockResolvedValue({ id: DOC_ID, staffId: STAFF_ID } as any)
    prismaMock.staffDocument.update.mockReset().mockResolvedValue({ id: DOC_ID } as any)
    prismaMock.staffDocument.delete.mockReset()
    mockLogAction.mockReset()
  })

  it('🔴 NUNCA borra la fila: marca la baja', async () => {
    await removeStaffDocument(VENUE_ID, DOC_ID, ACTOR_ID)

    expect(prismaMock.staffDocument.delete).not.toHaveBeenCalled()
    expect(prismaMock.staffDocument.update).toHaveBeenCalledWith({
      where: { id: DOC_ID },
      data: expect.objectContaining({ deletedAt: expect.any(Date), deletedById: ACTOR_ID }),
    })
  })

  it('un documento de otro negocio no existe para este', async () => {
    prismaMock.staffDocument.findFirst.mockResolvedValue(null)

    await expect(removeStaffDocument(VENUE_ID, DOC_ID, ACTOR_ID)).rejects.toThrow(NotFoundError)
    expect(prismaMock.staffDocument.update).not.toHaveBeenCalled()
  })

  it('busca acotado al negocio y descartando los ya dados de baja', async () => {
    await removeStaffDocument(VENUE_ID, DOC_ID, ACTOR_ID)

    expect(prismaMock.staffDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: DOC_ID, venueId: VENUE_ID, deletedAt: null }) }),
    )
  })
})

describe('getStaffDocumentUrl — la única forma de abrir el archivo', () => {
  beforeEach(() => {
    prismaMock.staffDocument.findFirst.mockReset().mockResolvedValue({
      id: DOC_ID,
      staffId: STAFF_ID,
      storagePath: 'private/test/staff/venue-1/staff-1/1_ine.pdf',
      fileName: 'ine.pdf',
      mimeType: 'application/pdf',
    } as any)
    mockSign.mockReset().mockResolvedValue('https://signed.example/doc?sig=abc')
    mockLogAction.mockReset()
  })

  it('firma la ruta privada con caducidad corta', async () => {
    const r = await getStaffDocumentUrl(VENUE_ID, DOC_ID, ACTOR_ID)

    expect(mockSign).toHaveBeenCalledWith('private/test/staff/venue-1/staff-1/1_ine.pdf', 10)
    expect(r.url).toMatch(/^https:/)
    expect(r.expiresInMinutes).toBe(10)
  })

  it('un documento de otro negocio no se firma', async () => {
    prismaMock.staffDocument.findFirst.mockResolvedValue(null)

    await expect(getStaffDocumentUrl(VENUE_ID, DOC_ID, ACTOR_ID)).rejects.toThrow(NotFoundError)
    expect(mockSign).not.toHaveBeenCalled()
  })

  it('un documento dado de baja tampoco se firma', async () => {
    await getStaffDocumentUrl(VENUE_ID, DOC_ID, ACTOR_ID)
    expect(prismaMock.staffDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: DOC_ID, venueId: VENUE_ID, deletedAt: null }) }),
    )
  })

  it('abrir un documento sensible deja rastro de quién vio el expediente de quién', async () => {
    await getStaffDocumentUrl(VENUE_ID, DOC_ID, ACTOR_ID)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: ACTOR_ID, venueId: VENUE_ID, action: 'STAFF_DOCUMENT_VIEWED', entityId: DOC_ID }),
    )
  })

  it('la lista NO trae ni ruta ni URL: sólo metadatos', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' } as any)
    prismaMock.staffDocument.findMany.mockResolvedValue([])
    await listStaffDocuments(VENUE_ID, STAFF_ID)
    const select = prismaMock.staffDocument.findMany.mock.calls[0][0].select
    expect(select).not.toHaveProperty('storagePath')
    expect(select).not.toHaveProperty('fileUrl')
  })
})
