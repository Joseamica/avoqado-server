/** El permiso del equipo respeta la lápida de «Eliminar» (D7) y no cuenta lo que no escribe. */
import { createHash } from 'node:crypto'
import { prismaMock } from '@tests/__helpers__/setup'
import { installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import { escribirConsentimientoDelEquipoTx } from '@/services/crm/consent.service'

const AT = new Date('2026-11-05T12:00:00Z')
const run = (emails: string[]) =>
  escribirConsentimientoDelEquipoTx(prismaMock as any, {
    emails,
    accountId: 'caccount000000000000000001',
    source: 'MANUAL',
    staffId: 'cstaff0000000000000000001',
    at: AT,
  })

it('🔴 un correo eliminado del CRM no se escribe ni se cuenta; los demás sí', async () => {
  const db = installCrmInboundFake(prismaMock)
  db.erased.push({ keyHash: createHash('sha256').update('EMAIL:ana@cafe.mx').digest('hex'), scope: '', erasedAt: new Date() })
  expect(await run(['Ana@Cafe.mx', 'beto@cafe.mx'])).toBe(1)
  expect(db.consents.map(consent => consent.email)).toEqual(['beto@cafe.mx'])
})

it('todos eliminados: 0, sin permiso y sin evento en la línea de tiempo', async () => {
  const db = installCrmInboundFake(prismaMock)
  db.erased.push({ keyHash: createHash('sha256').update('EMAIL:ana@cafe.mx').digest('hex'), scope: '', erasedAt: new Date() })
  expect(await run(['ana@cafe.mx'])).toBe(0)
  expect(db.consents).toHaveLength(0)
  expect(db.events).toHaveLength(0)
})
