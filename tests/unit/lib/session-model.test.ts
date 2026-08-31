import { Prisma } from '@prisma/client'

describe('modelo Session', () => {
  it('expone los campos que el carril de sesiones necesita', () => {
    const campos = Prisma.dmmf.datamodel.models.find(m => m.name === 'Session')!.fields.map(f => f.name)
    expect(campos).toEqual(
      expect.arrayContaining([
        'id',
        'staffId',
        'venueId',
        'deviceId',
        'authMethod',
        'parentSessionId',
        'createdAt',
        'lastSeenAt',
        'revokedAt',
        'revokedReason',
      ]),
    )
  })

  it('RefreshGrant permite rotación, familia y retransmisión', () => {
    const campos = Prisma.dmmf.datamodel.models.find(m => m.name === 'RefreshGrant')!.fields.map(f => f.name)
    expect(campos).toEqual(
      expect.arrayContaining([
        'id',
        'sessionId',
        'familyId',
        'tokenHash',
        'successorEnc',
        'successorEncExpiresAt',
        'consumedAt',
        'rotatedToId',
        'expiresAt',
        'revokedAt',
      ]),
    )
  })

  it('tokenHash es único: dos grants no pueden compartir el mismo refresh', () => {
    const modelo = Prisma.dmmf.datamodel.models.find(m => m.name === 'RefreshGrant')!
    expect(modelo.fields.find(f => f.name === 'tokenHash')!.isUnique).toBe(true)
  })
})
