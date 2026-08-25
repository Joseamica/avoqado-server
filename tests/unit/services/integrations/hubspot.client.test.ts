/**
 * HubSpot Forms API client tests.
 *
 * Lo que de verdad importa comprobar aquí no es que el POST salga, sino las
 * dos garantías del diseño: que la integración esté APAGADA mientras no la
 * configuren, y que NUNCA pueda tumbar un lead — ni por red caída, ni por un
 * 400 de HubSpot. El lead vale; el espejo en el CRM es un extra.
 *
 * Mockea `axios` a nivel de módulo. Este cliente llama `axios.post` directo
 * (no usa `axios.create`), así que el mock es plano.
 */
import axios from 'axios'

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}))

import { sendLeadToHubspot, isHubspotEnabled } from '@/services/integrations/hubspot.client'

const mockPost = (axios as unknown as { post: jest.Mock }).post

const LEAD = {
  email: 'ana@tacosana.mx',
  firstName: 'Ana',
  lastName: 'Ruiz',
  phone: '5512345678',
  companyName: 'Tacos Ana',
}

const HUTK = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

describe('hubspot.client', () => {
  const envOriginal = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.HUBSPOT_PORTAL_ID = '51907484'
    process.env.HUBSPOT_FORM_GUID = 'form-guid-de-prueba'
    mockPost.mockResolvedValue({ status: 200, data: {} })
  })

  afterEach(() => {
    process.env = { ...envOriginal }
  })

  // ---------------------------------------------------------------
  // 1. LO NUEVO
  // ---------------------------------------------------------------

  it('no manda nada mientras falte la configuración', async () => {
    delete process.env.HUBSPOT_FORM_GUID

    expect(isHubspotEnabled()).toBe(false)
    await expect(sendLeadToHubspot(LEAD)).resolves.toBe(false)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('manda el lead al formulario configurado con los campos estándar', async () => {
    await expect(sendLeadToHubspot(LEAD)).resolves.toBe(true)

    const [url, body] = mockPost.mock.calls[0]
    expect(url).toBe('https://api.hsforms.com/submissions/v3/integration/submit/51907484/form-guid-de-prueba')
    expect(body.fields).toEqual([
      { name: 'email', value: 'ana@tacosana.mx' },
      { name: 'firstname', value: 'Ana' },
      { name: 'lastname', value: 'Ruiz' },
      { name: 'phone', value: '5512345678' },
      { name: 'company', value: 'Tacos Ana' },
    ])
  })

  it('viaja el hutk cuando el visitante traía la cookie — es lo que da la atribución', async () => {
    await sendLeadToHubspot({ ...LEAD, hutk: HUTK, pageUri: 'https://avoqado.io/restaurants', pageName: 'Restaurantes' })

    const [, body] = mockPost.mock.calls[0]
    expect(body.context).toEqual({
      hutk: HUTK,
      pageUri: 'https://avoqado.io/restaurants',
      pageName: 'Restaurantes',
    })
  })

  it('omite context por completo si no hay nada que mandar (HubSpot rechaza un hutk vacío)', async () => {
    await sendLeadToHubspot(LEAD)

    const [, body] = mockPost.mock.calls[0]
    expect(body).not.toHaveProperty('context')
  })

  // ---------------------------------------------------------------
  // 2. LA GARANTÍA DURA: el CRM nunca puede costar un lead
  // ---------------------------------------------------------------

  it('devuelve false sin lanzar cuando HubSpot responde 400', async () => {
    mockPost.mockRejectedValue({ response: { status: 400, data: { message: 'FIELD_NOT_IN_FORM_DEFINITION' } } })

    await expect(sendLeadToHubspot(LEAD)).resolves.toBe(false)
  })

  it('devuelve false sin lanzar cuando la red se cae', async () => {
    mockPost.mockRejectedValue(new Error('ECONNRESET'))

    await expect(sendLeadToHubspot(LEAD)).resolves.toBe(false)
  })

  it('devuelve false sin lanzar cuando HubSpot pasa su rate limit (429)', async () => {
    mockPost.mockRejectedValue({ response: { status: 429, data: {} } })

    await expect(sendLeadToHubspot(LEAD)).resolves.toBe(false)
  })

  // ---------------------------------------------------------------
  // 3. REGRESIÓN: nada de esto debe cambiar de forma silenciosa
  // ---------------------------------------------------------------

  it('sigue apagado si sólo está el portal, sin formulario', async () => {
    delete process.env.HUBSPOT_FORM_GUID
    expect(isHubspotEnabled()).toBe(false)
  })

  it('sigue apagado si sólo está el formulario, sin portal', async () => {
    delete process.env.HUBSPOT_PORTAL_ID
    expect(isHubspotEnabled()).toBe(false)
  })

  it('no manda campos vacíos: HubSpot rechazaría el envío completo', async () => {
    await sendLeadToHubspot({ ...LEAD, phone: '   ' })

    const [, body] = mockPost.mock.calls[0]
    expect(body.fields.map((f: { name: string }) => f.name)).not.toContain('phone')
    expect(body.fields).toHaveLength(4)
  })

  it('usa un timeout acotado: el formulario no puede quedarse esperando al CRM', async () => {
    await sendLeadToHubspot(LEAD)

    const [, , config] = mockPost.mock.calls[0]
    expect(config.timeout).toBeLessThanOrEqual(10_000)
  })
})
