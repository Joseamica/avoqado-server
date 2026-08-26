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

import { addStaffDocument, listStaffDocuments, removeStaffDocument } from '@/services/dashboard/staffDocument.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const VENUE_ID = 'venue-1'
const STAFF_ID = 'staff-1'
const DOC_ID = 'doc-1'
const ACTOR_ID = 'staff-boss'

const input = (over: Partial<any> = {}) => ({
  type: 'ID' as const,
  fileName: 'ine.pdf',
  fileUrl: 'https://storage.googleapis.com/bucket/prod/venues/x/staff/ine.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 120_000,
  ...over,
})

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
    mockLogAction.mockReset()
  })

  it('no deja subir un documento a alguien de otro negocio', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    await expect(addStaffDocument(VENUE_ID, STAFF_ID, input(), ACTOR_ID)).rejects.toThrow(NotFoundError)
    expect(prismaMock.staffDocument.create).not.toHaveBeenCalled()
  })

  it('guarda quién lo subió', async () => {
    await addStaffDocument(VENUE_ID, STAFF_ID, input(), ACTOR_ID)

    expect(prismaMock.staffDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ uploadedById: ACTOR_ID, venueId: VENUE_ID, staffId: STAFF_ID }) }),
    )
  })

  it('un tipo OTRO sin nombre no se acepta', async () => {
    // Sin etiqueta, "OTRO" no le dice nada a quien abra la carpeta dentro de un año.
    await expect(addStaffDocument(VENUE_ID, STAFF_ID, input({ type: 'OTHER', label: '  ' }), ACTOR_ID)).rejects.toThrow(BadRequestError)
    expect(prismaMock.staffDocument.create).not.toHaveBeenCalled()
  })

  it('un tipo OTRO con nombre sí se acepta', async () => {
    await expect(
      addStaffDocument(VENUE_ID, STAFF_ID, input({ type: 'OTHER', label: 'Carta de recomendación' }), ACTOR_ID),
    ).resolves.toBeDefined()
  })

  it('deja rastro en la bitácora — quién abrió el expediente de quién', async () => {
    await addStaffDocument(VENUE_ID, STAFF_ID, input(), ACTOR_ID)

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
