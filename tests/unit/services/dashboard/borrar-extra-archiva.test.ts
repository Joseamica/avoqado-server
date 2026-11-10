/**
 * D17 (founder, 9-nov, opción A): el `DELETE` de un extra lo ARCHIVA (`active=false`), nunca lo destruye. La respuesta sigue igual:
 * mismos 404 y el mismo registro `MODIFIER_DELETED`.
 */
import { logAction } from '@/services/dashboard/activity-log.service'
import { deleteModifier } from '@/services/dashboard/menu.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'cjld2cjxh0000qzrmn831i7rn'
const groupId = 'cjld2cjxh0001qzrmn831i7ro'
const modifierId = 'cjld2cjxh0002qzrmn831i7rp'

describe('D17 · borrar un extra lo archiva', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.modifierGroup.findFirst.mockResolvedValue({ id: groupId } as any)
    prismaMock.modifier.findFirst.mockResolvedValue({ id: modifierId, name: 'Shot', active: true } as any)
    prismaMock.modifier.update.mockResolvedValue({ id: modifierId, name: 'Shot', active: false } as any)
  })

  it('lo apaga y no lo destruye', async () => {
    await expect(deleteModifier(venueId, groupId, modifierId)).resolves.toBeUndefined()

    expect(prismaMock.modifier.update).toHaveBeenCalledWith({ where: { id: modifierId }, data: { active: false } })
    expect(prismaMock.modifier.delete).not.toHaveBeenCalled()
    expect(prismaMock.modifier.deleteMany).not.toHaveBeenCalled()
  })

  it('deja el mismo registro que hoy', async () => {
    await deleteModifier(venueId, groupId, modifierId)

    expect(logAction).toHaveBeenCalledWith({
      venueId,
      action: 'MODIFIER_DELETED',
      entity: 'Modifier',
      entityId: modifierId,
      data: { name: 'Shot' },
    })
  })

  it('uno que ya estaba apagado también se puede quitar (no es un 404 nuevo)', async () => {
    prismaMock.modifier.findFirst.mockResolvedValue({ id: modifierId, name: 'Shot', active: false } as any)

    await expect(deleteModifier(venueId, groupId, modifierId)).resolves.toBeUndefined()
    expect(prismaMock.modifier.findFirst).toHaveBeenCalledWith({ where: { id: modifierId, groupId } })
  })

  // Regresión: los 404 de hoy
  it('grupo inexistente, archivado o de otro negocio: 404 y no toca nada', async () => {
    prismaMock.modifierGroup.findFirst.mockResolvedValue(null)

    await expect(deleteModifier(venueId, groupId, modifierId)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.modifierGroup.findFirst).toHaveBeenCalledWith({ where: { id: groupId, venueId, active: true } })
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
  })

  it('extra que no es de ese grupo: 404 y no toca nada', async () => {
    prismaMock.modifier.findFirst.mockResolvedValue(null)

    await expect(deleteModifier(venueId, groupId, modifierId)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
  })
})
