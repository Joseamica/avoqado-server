import { redactDirectoryResult } from '@/mcp/directory/redact'

const asText = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const parsed = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

// El directorio no publica identificadores fiscales ni de integraciones, ni invita a comprar planes.
describe('filtro de respuestas del catálogo de directorio', () => {
  it('quita folios fiscales, RFC e identificadores de integraciones a cualquier profundidad', () => {
    const r = redactDirectoryResult(
      asText({
        transfer: { id: 't1', fiscalUuid: 'UUID-CFDI', fiscalReference: 'F-1', lines: [{ qty: 2, rfc: 'XAXX010101000' }] },
        channels: [
          {
            provider: 'UBER',
            ownerAuthorizedClientId: 'cid',
            ownerAuthorizedStoreId: 'store',
            ownerAuthorizedByIntentId: 'i',
            activatingIntentId: 'a',
            activationOwner: 'o',
            ownerAuthorizedEnvironment: 'prod',
            revocationVersion: 2,
            externalAccountId: 'acc',
            externalLocationId: 'loc',
            active: true,
          },
        ],
        rows: [{ amount: 10, externalMerchantId: 'm1', issuerCountryCode: 'MX', internationalityShadow: { a: 1 }, providerReference: 'p' }],
      }),
    )
    expect(parsed(r)).toEqual({
      transfer: { id: 't1', lines: [{ qty: 2 }] },
      channels: [{ provider: 'UBER', active: true }],
      rows: [{ amount: 10 }],
    })
  })

  it('elimina la invitación a subir de plan y conserva el aviso de qué falta', () => {
    const msg =
      'Las reservaciones no está incluido en el plan actual de este local (requiere RESERVATIONS). El dueño puede subir de plan en el dashboard (Configuración → Plan).'
    const r = redactDirectoryResult(asText({ ok: false, planRequired: true, error: msg }))
    expect(parsed(r).error).toBe('Las reservaciones no está incluido en el plan actual de este local (requiere RESERVATIONS).')
  })

  it('deja intactas las respuestas sin datos sensibles y el texto que no es JSON', () => {
    const data = { venueId: 'v1', total: 3, items: [{ name: 'Café', price: 35 }] }
    expect(parsed(redactDirectoryResult(asText(data)))).toEqual(data)
    const plain = { content: [{ type: 'text', text: 'Orden KDS no encontrada' }], isError: true }
    expect(redactDirectoryResult(plain)).toEqual(plain)
  })
})
