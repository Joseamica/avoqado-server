/**
 * «Nuevo prospecto» (spec 2026-10-30 §5.3, plan task 5; recipients by ruling 21): one email per person who holds
 * «Editar», each with its own idempotency key — Resend sends one email per call and refuses a key reused with other
 * content — and nothing the email service does can make it throw.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { notifyNewProspect, notifyReturningProspect } from '@/services/crm/digest.service'
import emailService from '@/services/email.service'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))

const send = emailService.sendEmailWithResult as jest.Mock

const ACCOUNT = 'caccountl0000000000000001'
const STAFF_A = 'cstaffsla0000000000000001'
const STAFF_B = 'cstaffslb0000000000000001'
const STAFF_C = 'cstaffslc0000000000000001'
const STAFF_D = 'cstaffsld0000000000000001'
const STAFF_F = 'cstaffslf0000000000000001'
const STAFF_G = 'cstaffslg0000000000000001'

let keyRows: Array<Record<string, unknown>>
/** Staff ids that already hold a claimed row somewhere (`PlatformAccess.staffId`). */
let holders: string[]

/** A key row as `PlatformAccess` stores it. */
const row = (over: Record<string, unknown>) => ({
  email: 'x@avoqado.io',
  staffId: null,
  verScope: 'propios',
  editarScope: 'propios',
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  ...over,
})

beforeEach(() => {
  prismaMock.crmAccount.findUnique.mockReset()
  prismaMock.platformAccess.findMany.mockReset()
  prismaMock.staff.findMany.mockReset()
  prismaMock.crmAccount.findUnique.mockResolvedValue({
    id: ACCOUNT,
    name: 'Café Ana',
    giro: 'Cafetería',
    ventasRango: '500k-1m',
    sucursales: 3,
    modulos: ['mesas', 'cocina'],
  })
  keyRows = [
    row({ email: 'a@avoqado.io', staffId: STAFF_A, verScope: 'todos' }), // claimed: that Staff
    row({ email: 'b@avoqado.io' }), // unclaimed: the verified Staff with that exact email
    row({ email: 'c@avoqado.io', staffId: STAFF_C, editarScope: null }), // sees, does not edit
    row({ email: 'e@avoqado.io', verScope: null, editarScope: 'todos' }), // «Editar» without «Ver» grants nothing
    row({ email: 'd@avoqado.io' }), // unclaimed, but its Staff never verified the email
  ]
  holders = []
  // The key rows, or — asked by `staffId` — which of those people already hold a row.
  prismaMock.platformAccess.findMany.mockImplementation(async ({ where }: { where: { staffId?: { in: string[] } } }) =>
    where.staffId ? holders.filter(id => where.staffId?.in.includes(id)).map(staffId => ({ staffId })) : keyRows,
  )
  prismaMock.staff.findMany.mockResolvedValue([
    { id: STAFF_A, email: 'a@avoqado.io', active: true, emailVerified: true },
    { id: STAFF_B, email: 'b@avoqado.io', active: true, emailVerified: true },
    { id: STAFF_D, email: 'd@avoqado.io', active: true, emailVerified: false },
  ])
  send.mockResolvedValue({ ok: true, transient: false })
})

describe('notifyNewProspect', () => {
  it('nuevo_prospecto_una_llave_por_vendedor', async () => {
    await notifyNewProspect(ACCOUNT)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([email]) => [email.to, email.idempotencyKey])).toEqual([
      ['a@avoqado.io', `crm-nuevo:${ACCOUNT}:${STAFF_A}`],
      ['b@avoqado.io', `crm-nuevo:${ACCOUNT}:${STAFF_B}`],
    ])
    const [email] = send.mock.calls[0]
    expect(email.subject).toBe('Nuevo prospecto: Café Ana')
    // The Avoqado email standard (EMAIL_STANDARDS.md): no emoji in the subject, the logo twice, a black CTA, plain text.
    expect(email.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(email.html.match(/https:\/\/avoqado\.io\/isotipo\.svg/g)).toHaveLength(2)
    expect(email.html).toContain('background-color:#000000')
    expect(email.text).toContain('Café Ana')
    expect(email.text).toContain('/crm/pendientes')
    // Only the people with «Editar»: the account's phone and email stay in the CRM (spec §5.10).
    expect(prismaMock.crmAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ contacts: expect.anything() }) }),
    )
    // Rows the database could not have narrowed are still filtered by `effectiveKeys`, and the lookup is ONE query.
    expect(prismaMock.staff.findMany).toHaveBeenCalledTimes(1)
  })

  it('nobody without CRM access gets it: a claimed row whose Staff changed email, or a Staff who already holds another row (ruling 26)', async () => {
    keyRows.push(
      row({ email: 'f@avoqado.io', staffId: STAFF_F }), // claimed by F, who now signs in as f-nuevo@: the row is not F's
      row({ email: 'g@avoqado.io' }), // unclaimed; its verified Staff G already holds another row (P2002 in `holdsRow`)
    )
    holders = [STAFF_G]
    prismaMock.staff.findMany.mockResolvedValue([
      { id: STAFF_A, email: 'a@avoqado.io', active: true, emailVerified: true },
      { id: STAFF_B, email: 'b@avoqado.io', active: true, emailVerified: true },
      { id: STAFF_F, email: 'f-nuevo@avoqado.io', active: true, emailVerified: true },
      { id: STAFF_G, email: 'g@avoqado.io', active: true, emailVerified: true },
    ])

    await notifyNewProspect(ACCOUNT)

    expect(send.mock.calls.map(([email]) => email.to)).toEqual(['a@avoqado.io', 'b@avoqado.io'])
    // Asked only about the Staff found by email — the claimed rows already say who holds them.
    expect(prismaMock.platformAccess.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { staffId: { in: [STAFF_B, STAFF_G] } } }),
    )
  })

  it('nuevo_prospecto_no_lanza_si_falla_el_correo', async () => {
    // One send blows up, the other is refused: the notice still resolves, and says who did not get it.
    send.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce({ ok: false, transient: true, errorCode: 'rate_limit' })
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_A }))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_B }))

    // Not even the database can make it throw.
    prismaMock.crmAccount.findUnique.mockRejectedValueOnce(new Error('database is down'))
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ accountId: ACCOUNT }))
  })

  it('a long business name keeps the subject short, and a missing account or team sends nothing', async () => {
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce({
      id: ACCOUNT,
      name: 'N'.repeat(300),
      giro: null,
      ventasRango: null,
      sucursales: null,
      modulos: [],
    })
    await notifyNewProspect(ACCOUNT)
    expect(send.mock.calls[0][0].subject.length).toBeLessThanOrEqual(60)

    send.mockClear()
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce(null)
    await notifyNewProspect(ACCOUNT)
    prismaMock.platformAccess.findMany.mockResolvedValueOnce([])
    await notifyNewProspect(ACCOUNT)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('the notice of an account without the form’s qualification', () => {
  it('says «no disponible (alta anterior al CRM)» instead of four blank rows', async () => {
    // An old signup the sweep loaded (ruling 30b): the form's answers were never kept.
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce({
      id: ACCOUNT,
      name: 'Taquería Lalo',
      giro: null,
      ventasRango: null,
      sucursales: null,
      modulos: [],
      qualificationAvailable: false,
    })

    await notifyNewProspect(ACCOUNT)

    const [email] = send.mock.calls[0]
    expect(email.text).toContain('Calificación: no disponible (alta anterior al CRM)')
    expect(email.html).toContain('no disponible (alta anterior al CRM)')
    for (const blank of ['Tipo de negocio', 'Sucursales', 'Ventas al mes', 'Qué pidió']) {
      expect(email.text).not.toContain(blank)
      expect(email.html).not.toContain(blank)
    }
    expect(email.text).not.toMatch(/: —$/m) // the footer's «S.A. de C.V. — Ciudad» is not a blank row
  })

  it('keeps the four rows when the account has its qualification', async () => {
    await notifyNewProspect(ACCOUNT)

    const [email] = send.mock.calls[0]
    expect(email.text).toContain('Tipo de negocio: Cafetería')
    expect(email.text).toContain('Qué pidió: mesas, cocina')
    expect(email.text).not.toContain('no disponible')
  })
})

describe('notifyReturningProspect (ruling 31)', () => {
  const ENTRY = 'centrylnd0000000000000009'

  it('volvio_su_propia_llave_por_vendedor: an archived prospect that came back, keyed by account, entry and person', async () => {
    await notifyReturningProspect(ACCOUNT, ENTRY)

    expect(send.mock.calls.map(([email]) => [email.to, email.idempotencyKey])).toEqual([
      ['a@avoqado.io', `crm-volvio:${ACCOUNT}:${ENTRY}:${STAFF_A}`],
      ['b@avoqado.io', `crm-volvio:${ACCOUNT}:${ENTRY}:${STAFF_B}`],
    ])
    const [email] = send.mock.calls[0]
    expect(email.subject).toBe('Volvió un prospecto: Café Ana')
    expect(email.text).toMatch(/archivado/i)
    expect(email.text).toContain('/crm/pendientes')
    expect(email.html.match(/https:\/\/avoqado\.io\/isotipo\.svg/g)).toHaveLength(2)
  })

  it('a long name keeps its subject within 60 characters, and nothing makes it throw', async () => {
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce({
      id: ACCOUNT,
      name: 'N'.repeat(300),
      giro: null,
      ventasRango: null,
      sucursales: null,
      modulos: [],
    })
    await notifyReturningProspect(ACCOUNT, ENTRY)
    expect(send.mock.calls[0][0].subject.length).toBeLessThanOrEqual(60)

    prismaMock.crmAccount.findUnique.mockRejectedValueOnce(new Error('database is down'))
    await expect(notifyReturningProspect(ACCOUNT, ENTRY)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ accountId: ACCOUNT }))
  })
})
