import { prismaMock } from '@tests/__helpers__/setup'
import { persistInboundEvent, resolveConnectionByToken } from '@/services/aggregators/core/inboundEvent.service'
import { encryptCredential, decryptCredential, newWebhookToken, tokensEqual } from '@/services/aggregators/core/credentials'

const base = {
  provider: 'TOTALPASS' as const,
  connectionId: 'c1',
  venueId: 'v1',
  kind: 'BOOKING' as const,
  dedupKey: 'TOTALPASS:BOOKING:slot-1:active',
  payload: { a: 1 },
}
const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

describe('persistInboundEvent', () => {
  // nuevo
  it('guarda el evento crudo', async () => {
    prismaMock.aggregatorInboundEvent.create.mockResolvedValueOnce({ id: 'e1' } as any)
    await expect(persistInboundEvent(base)).resolves.toEqual({ event: { id: 'e1' }, duplicate: false })
    expect(prismaMock.aggregatorInboundEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ connectionId: 'c1', venueId: 'v1', kind: 'BOOKING', dedupKey: base.dedupKey, payload: { a: 1 } }),
      }),
    )
  })
  // nuevo — Review Focus 2: el mismo webhook dos veces
  it('el mismo webhook dos veces ⇒ duplicate, sin segundo evento', async () => {
    prismaMock.aggregatorInboundEvent.create.mockRejectedValueOnce(p2002())
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce({ id: 'e1' } as any)
    await expect(persistInboundEvent(base)).resolves.toEqual({ event: { id: 'e1' }, duplicate: true })
  })
  // nuevo
  it('un error que no es de duplicado se propaga', async () => {
    prismaMock.aggregatorInboundEvent.create.mockRejectedValueOnce(new Error('se cayó la base'))
    await expect(persistInboundEvent(base)).rejects.toThrow('se cayó la base')
    expect(prismaMock.aggregatorInboundEvent.findUnique).not.toHaveBeenCalled()
  })
})

describe('resolveConnectionByToken', () => {
  const conn = { id: 'c1', venueId: 'v1', provider: 'TOTALPASS', webhookToken: 'tok-ok', status: 'ACTIVE' }
  // nuevo
  it('token correcto del mismo proveedor ⇒ la conexión', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    await expect(resolveConnectionByToken('TOTALPASS', 'tok-ok')).resolves.toEqual(conn)
  })
  // nuevo
  it('token de otro proveedor ⇒ null', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    await expect(resolveConnectionByToken('WELLHUB', 'tok-ok')).resolves.toBeNull()
  })
  // nuevo
  it('token vacío ⇒ null sin consultar la base', async () => {
    await expect(resolveConnectionByToken('TOTALPASS', '')).resolves.toBeNull()
    expect(prismaMock.aggregatorConnection.findUnique).not.toHaveBeenCalled()
  })
})

describe('credenciales', () => {
  // nuevo
  it('cifra y descifra la llave de la sucursal; el token del webhook es largo y distinto cada vez', () => {
    const blob = encryptCredential('place-key-123')
    expect(Buffer.isBuffer(blob)).toBe(true)
    expect(blob.toString('utf8')).not.toContain('place-key-123')
    expect(decryptCredential(blob)).toBe('place-key-123')
    expect(decryptCredential(null)).toBeNull()
    const t1 = newWebhookToken()
    expect(t1.length).toBeGreaterThanOrEqual(43)
    expect(newWebhookToken()).not.toBe(t1)
  })
  // nuevo
  it('tokensEqual compara en tiempo constante y no truena con largos distintos', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true)
    expect(tokensEqual('abc', 'abd')).toBe(false)
    expect(tokensEqual('abc', 'abcd')).toBe(false)
  })
})
