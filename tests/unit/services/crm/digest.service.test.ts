/**
 * «Nuevo prospecto» (spec 2026-10-30 §5.3, plan task 5; recipients by ruling 21): one email per person who holds
 * «Editar», each with its own idempotency key — Resend sends one email per call and refuses a key reused with other
 * content — and nothing the email service does can make it throw.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getCrmAccess } from '@/services/crm/access.service'
import { getPending } from '@/services/crm/accounts.service'
import { notifyNewProspect, notifyReturningProspect, runDailyDigest } from '@/services/crm/digest.service'
import emailService from '@/services/email.service'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
jest.mock('@/services/crm/access.service', () => ({ ...jest.requireActual('@/services/crm/access.service'), getCrmAccess: jest.fn() }))
jest.mock('@/services/crm/accounts.service', () => ({ getPending: jest.fn() }))

const send = emailService.sendEmailWithResult as jest.Mock
const accessOf = getCrmAccess as jest.Mock
const pendingOf = getPending as jest.Mock

const ACCOUNT = 'caccountl0000000000000001'
const STAFF_A = 'cstaffsla0000000000000001'
const STAFF_B = 'cstaffslb0000000000000001'
const STAFF_C = 'cstaffslc0000000000000001'
const STAFF_D = 'cstaffsld0000000000000001'
const STAFF_F = 'cstaffslf0000000000000001'
const STAFF_G = 'cstaffslg0000000000000001'

// 🔴 Fuera de producción sólo sale a la lista de prueba (`testAllowlist`). Estas pruebas son del contenido, las llaves y la cola, así
// que ponen en la lista a todos los vendedores que usan; las de la lista misma van al final de cada bloque.
const EN_LA_LISTA = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'].map(letra => `${letra}@avoqado.io`).join(',')
const LISTA_ORIGINAL = process.env.CRM_CORREO_PRUEBAS
afterAll(() => {
  if (LISTA_ORIGINAL === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = LISTA_ORIGINAL
})

let keyRows: Array<Record<string, unknown>>
/** Staff ids that already hold a claimed row somewhere (`PlatformAccess.staffId`). */
let holders: string[]
/** `EmailSuppression` (rebote duro o queja) y `CrmEmailOptOut` (baja de marketing), por correo en minúsculas. */
let suprimidos: Map<string, 'HARD_BOUNCE' | 'COMPLAINT'>
let bajas: Set<string>
/** Correos cuya consulta de bloqueo truena (se cayó la base). */
let consultaFalla: Set<string>

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
  process.env.CRM_CORREO_PRUEBAS = EN_LA_LISTA
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
  suprimidos = new Map()
  bajas = new Set()
  consultaFalla = new Set()
  prismaMock.crmEmailOptOut.findUnique.mockReset().mockImplementation(async ({ where }: { where: { email: string } }) => {
    if (consultaFalla.has(where.email)) throw new Error('se cayó la base')
    return bajas.has(where.email) ? { id: 'cbajaoptout000000000001' } : null
  })
  prismaMock.emailSuppression.findUnique.mockReset().mockImplementation(async ({ where }: { where: { email: string } }) => {
    if (consultaFalla.has(where.email)) throw new Error('se cayó la base')
    const reason = suprimidos.get(where.email)
    return reason ? { reason } : null
  })
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
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_A }))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_B }))

    // Not even the database can make it throw.
    prismaMock.crmAccount.findUnique.mockRejectedValueOnce(new Error('database is down'))
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(false)
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

describe('fuera de producción: el aviso de prospecto sólo sale a la lista de prueba', () => {
  it('sólo le llega a quien está en la lista, y la entrada no se reintenta por eso (true)', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'b@avoqado.io'

    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)

    expect(send.mock.calls.map(([email]) => email.to)).toEqual(['b@avoqado.io'])
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('outside the test list'),
      expect.objectContaining({ accountId: ACCOUNT, staffId: STAFF_A }),
    )
  })

  it('con la lista vacía no sale nada y cuenta como «nada que mandar»: el barrido no lo reintenta 5 veces', async () => {
    process.env.CRM_CORREO_PRUEBAS = ''

    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)
    await expect(notifyReturningProspect(ACCOUNT, 'centry000000000000000001')).resolves.toBe(true)

    expect(send).not.toHaveBeenCalled()
  })

  it('en producción sale a todos, con la lista vacía: el comportamiento de hoy', async () => {
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.env.CRM_CORREO_PRUEBAS = ''
    try {
      await notifyNewProspect(ACCOUNT)
    } finally {
      process.env.NODE_ENV = env
    }

    expect(send.mock.calls.map(([email]) => email.to)).toEqual(['a@avoqado.io', 'b@avoqado.io'])
  })
})

describe('los avisos internos y las bajas (Codex r1, P1): un rebote o una queja los frenan, la baja de marketing no', () => {
  it('REBOTE o QUEJA: a quien rebotó no se le manda, a los demás sí; sin nadie que reciba cuenta como «nada que mandar» (true)', async () => {
    suprimidos.set('a@avoqado.io', 'HARD_BOUNCE')

    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)
    expect(send.mock.calls.map(([email]) => email.to)).toEqual(['b@avoqado.io'])
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[CRM]'),
      expect.objectContaining({ accountId: ACCOUNT, staffId: STAFF_A, motivo: 'REBOTE' }),
    )

    send.mockClear()
    suprimidos.set('b@avoqado.io', 'COMPLAINT')
    await expect(notifyReturningProspect(ACCOUNT, 'centry000000000000000001')).resolves.toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('la BAJA de marketing (CrmEmailOptOut) NO frena el aviso: es trabajo del equipo, no marketing', async () => {
    bajas.add('a@avoqado.io')
    bajas.add('b@avoqado.io')

    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)
    await expect(notifyReturningProspect(ACCOUNT, 'centry000000000000000001')).resolves.toBe(true)

    expect(send.mock.calls.map(([email]) => email.to)).toEqual(['a@avoqado.io', 'b@avoqado.io', 'a@avoqado.io', 'b@avoqado.io'])
  })

  // Codex código r2 P1: una queja registra supresión Y baja; una baja vieja más un rebote nuevo, igual. La baja no tapa la supresión.
  it.each([
    ['baja + rebote', 'HARD_BOUNCE', 'REBOTE'],
    ['baja + queja', 'COMPLAINT', 'QUEJA'],
  ] as const)('%s: la supresión frena el aviso aunque también haya baja', async (_caso, reason, motivo) => {
    bajas.add('a@avoqado.io')
    suprimidos.set('a@avoqado.io', reason)

    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)
    expect(send.mock.calls.map(([email]) => email.to)).toEqual(['b@avoqado.io'])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_A, motivo }))
  })

  it('si la consulta del bloqueo falla, a esa persona no se le manda y el aviso dice false para que el barrido lo reintente', async () => {
    consultaFalla.add('a@avoqado.io')

    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(false)

    // A la otra persona sí salió, con su llave: el reintento sólo repite a A.
    expect(send.mock.calls.map(([email]) => [email.to, email.idempotencyKey])).toEqual([
      ['b@avoqado.io', `crm-nuevo:${ACCOUNT}:${STAFF_B}`],
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[CRM]'),
      expect.objectContaining({ accountId: ACCOUNT, staffId: STAFF_A }),
    )
  })
})

describe('ruling 49: the notice says whether it reached everyone, and repeats a fixed content', () => {
  it('aviso_dice_si_salio_a_todos: true only when every send went out', async () => {
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)

    send.mockResolvedValueOnce({ ok: true, transient: false }).mockResolvedValueOnce({ ok: false, transient: true, errorCode: '500' })
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(false)

    // Nothing to send is not a failure to retry: the account is gone, or nobody holds «Editar».
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce(null)
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)
    prismaMock.platformAccess.findMany.mockResolvedValueOnce([])
    await expect(notifyNewProspect(ACCOUNT)).resolves.toBe(true)
  })

  it('con_contenido_fijo_no_relee_la_ficha: the saved content is what goes out, under the same keys', async () => {
    const content = {
      name: 'Café Ana',
      giro: 'Bar',
      ventasRango: 'menos de 100k',
      sucursales: 1,
      modulos: ['qr'],
      qualificationAvailable: true,
    }
    // The account changed since (another form): the retry still sends what the first send said.
    prismaMock.crmAccount.findUnique.mockResolvedValue({
      id: ACCOUNT,
      name: 'Otro nombre',
      giro: 'Cafetería',
      ventasRango: null,
      sucursales: null,
      modulos: [],
    })

    await expect(notifyNewProspect(ACCOUNT, content)).resolves.toBe(true)
    await expect(notifyReturningProspect(ACCOUNT, 'centrylnd0000000000000009', content)).resolves.toBe(true)

    expect(prismaMock.crmAccount.findUnique).not.toHaveBeenCalled()
    expect(send.mock.calls[0][0]).toMatchObject({ subject: 'Nuevo prospecto: Café Ana', idempotencyKey: `crm-nuevo:${ACCOUNT}:${STAFF_A}` })
    expect(send.mock.calls[0][0].text).toContain('Tipo de negocio: Bar')
    expect(send.mock.calls[2][0]).toMatchObject({ subject: 'Volvió un prospecto: Café Ana' })
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
    await expect(notifyReturningProspect(ACCOUNT, ENTRY)).resolves.toBe(false)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ accountId: ACCOUNT }))
  })
})

/**
 * The daily digest (spec 2026-10-30 §5.4, plan task 7, ruling 32): one email per person and day, whatever happens — two
 * runs at once, a process that dies before or after sending (twice), Resend failing. A row is reserved first; only who
 * reserved it sends, with the key `crm-aviso:<person>:<day>` and the content saved on the row.
 */
describe('runDailyDigest', () => {
  const MIN = 60_000
  /** Monday 2 November 2026, 8:30:33 in Mexico City (UTC−6 all year since 2022): the first tick of the morning. */
  const T0 = new Date('2026-11-02T14:30:33Z')
  const DAY = '2026-11-02'
  const KEY_A = `crm-aviso:${STAFF_A}:${DAY}`
  const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN)

  interface SendRow {
    id: string
    staffId: string
    day: string
    kind: string
    status: string
    attempts: number
    reservedAt: Date
    content: unknown
  }
  /** `CrmDigestSend` as the database keeps it: `@@unique([staffId, day, kind])`, and updates that only touch what matches. */
  let sends: SendRow[]
  /** How many «ENVIADO» marks still blow up: the process died right after Resend took the email. */
  let crashesAfterSend: number

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, cond]) => {
      if (field === 'OR') return (cond as Array<Record<string, unknown>>).some(alt => matches(row, alt))
      const value = row[field]
      if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime()
      if (cond && typeof cond === 'object') {
        const op = cond as { in?: unknown[]; lt?: number | Date | string; gte?: number; not?: unknown }
        if (op.in) return op.in.includes(value)
        if (op.lt !== undefined) return (value as number | Date | string) < op.lt
        if (op.gte !== undefined) return (value as number) >= op.gte
        if ('not' in op) return op.not === Prisma.DbNull ? value !== null : value !== op.not
      }
      return value === cond
    })

  const section = (total: number, names: string[] = []) => ({
    total,
    rows: names.map((name, index) => ({ id: `caccountd${String(index).padStart(16, '0')}`, name })),
  })
  const pending = (over: Record<string, ReturnType<typeof section>> = {}) => ({
    vencidas: section(0),
    hoy: section(0),
    sinSiguientePaso: section(0),
    estancados: section(0),
    nuevosSinDueno: section(0),
    ...over,
  })
  const access = (staffId: string, admin = false) => ({
    staffId,
    isSuperadmin: false,
    ver: 'propios',
    editar: 'propios',
    contactar: false,
    campanas: false,
    exportar: false,
    ventas: false,
    admin,
  })

  beforeEach(() => {
    sends = []
    crashesAfterSend = 0
    // One seller with «Ver»: A (a claimed row).
    keyRows = [row({ email: 'a@avoqado.io', staffId: STAFF_A, editarScope: null })]
    prismaMock.staff.findMany.mockResolvedValue([{ id: STAFF_A, email: 'a@avoqado.io', active: true, emailVerified: true }])
    accessOf.mockReset().mockImplementation(async (staffId: string) => (staffId === STAFF_A ? access(STAFF_A) : null))
    pendingOf
      .mockReset()
      .mockResolvedValue(pending({ vencidas: section(2, ['Café Ana', 'Taquería Lalo']), hoy: section(1, ['Estética Sol']) }))
    prismaMock.crmActivity.count.mockReset().mockResolvedValue(0)

    prismaMock.crmDigestSend.create.mockReset().mockImplementation(async ({ data }: { data: Omit<SendRow, 'id' | 'attempts'> }) => {
      if (sends.some(s => s.staffId === data.staffId && s.day === data.day && s.kind === data.kind)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
      }
      const created = { id: `cdigestsd${String(sends.length).padStart(16, '0')}`, attempts: 0, ...data }
      sends.push(created)
      return { ...created }
    })
    // Copies, like a real database: what a run read never changes under it when another run writes (review M-1).
    prismaMock.crmDigestSend.findMany
      .mockReset()
      .mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        sends.filter(s => matches({ ...s }, where)).map(s => ({ ...s })),
      )
    prismaMock.crmDigestSend.updateMany
      .mockReset()
      .mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (data.status === 'ENVIADO' && crashesAfterSend > 0) {
          crashesAfterSend--
          throw new Error('the process died after sending')
        }
        const hit = sends.filter(s => matches({ ...s }, where))
        for (const s of hit) {
          const { attempts, ...rest } = data as { attempts?: number | { increment: number }; content?: unknown }
          if (rest.content === Prisma.DbNull) rest.content = null
          Object.assign(s, rest)
          if (attempts !== undefined) s.attempts = typeof attempts === 'number' ? attempts : s.attempts + attempts.increment
        }
        return { count: hit.length }
      })
  })

  it('el_resumen_no_guarda_contenido_que_ya_no_se_repite (D1, M3): ENVIADO y cerrado quedan sin contenido; el de días anteriores se vacía; el de hoy en FALLO lo conserva', async () => {
    const guardado = { to: 'x@avoqado.io', subject: 'Tus pendientes', html: '<p>Café Ana</p>', text: 'Café Ana' }
    sends.push(
      {
        id: 'cdigestsd0000000000000080',
        staffId: 'cstaffold000000000000001',
        day: '2026-10-30',
        kind: 'DIARIO',
        status: 'FALLO',
        attempts: 1,
        reservedAt: at(-3 * 24 * 60),
        content: guardado,
      },
      {
        id: 'cdigestsd0000000000000081',
        staffId: 'cstaffold000000000000002',
        day: DAY,
        kind: 'DIARIO',
        status: 'FALLO',
        attempts: 1,
        reservedAt: at(-1),
        content: guardado,
      },
    )
    send.mockImplementation(async (o: { to: string }) => (o.to === 'a@avoqado.io' ? { ok: true } : { ok: false, transient: true }))
    accessOf.mockImplementation(async (staffId: string) =>
      staffId === STAFF_A || staffId === 'cstaffold000000000000002' ? access(staffId) : null,
    )

    await runDailyDigest(T0)

    const porId = (id: string) => sends.find(s => s.id === id)!
    // El de otro día ya no se repite: se vacía.
    expect(porId('cdigestsd0000000000000080').content).toBeNull()
    // El de hoy que falló todavía puede repetirse: conserva su contenido y sus intentos.
    expect(porId('cdigestsd0000000000000081')).toEqual(expect.objectContaining({ status: 'FALLO', content: guardado }))
    // El que salió hoy queda sin contenido.
    expect(sends.find(s => s.staffId === STAFF_A)).toEqual(expect.objectContaining({ status: 'ENVIADO', content: null }))
  })

  it('el_resumen_cerrado_para_siempre_no_guarda_su_contenido (D1, M3)', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'
    await runDailyDigest(T0)
    expect(sends).toEqual([expect.objectContaining({ staffId: STAFF_A, status: 'FALLO', attempts: 3, content: null })])
  })

  it('dos_corridas_un_envio: two runs at once reserve ONE row and send ONE email; the next tick sends nothing', async () => {
    await Promise.all([runDailyDigest(T0), runDailyDigest(T0)])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ to: 'a@avoqado.io', idempotencyKey: KEY_A }))
    expect(sends).toEqual([expect.objectContaining({ staffId: STAFF_A, day: DAY, kind: 'DIARIO', status: 'ENVIADO', attempts: 0 })])
    // Both reached the insert: the unique key, not luck, decided who sends.
    expect(prismaMock.crmDigestSend.create).toHaveBeenCalledTimes(2)

    await runDailyDigest(at(15))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('caida_antes_de_enviar_se_retoma: a row reserved 11 minutes ago and never sent goes out on the next run, once', async () => {
    const content = {
      to: 'a@avoqado.io',
      subject: 'Tus pendientes de hoy: 2 vencidas y 1 para hoy',
      html: '<p>guardado</p>',
      text: 'guardado',
    }
    sends.push(
      {
        id: 'cdigestsd0000000000000091',
        staffId: STAFF_A,
        day: DAY,
        kind: 'DIARIO',
        status: 'APARTADO',
        attempts: 0,
        reservedAt: at(-11),
        content,
      },
      // Reserved 9 minutes ago: maybe still sending — not taken.
      {
        id: 'cdigestsd0000000000000092',
        staffId: STAFF_B,
        day: DAY,
        kind: 'DIARIO',
        status: 'APARTADO',
        attempts: 0,
        reservedAt: at(-9),
        content: { ...content, to: 'b@avoqado.io' },
      },
    )

    await runDailyDigest(T0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ ...content, idempotencyKey: KEY_A })
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', reservedAt: T0 }))
    expect(sends[1].status).toBe('APARTADO')
    // A already has today's row: no second summary is built for them.
    expect(prismaMock.crmDigestSend.create).not.toHaveBeenCalled()

    await runDailyDigest(at(1))
    expect(send.mock.calls.filter(([email]) => email.to === 'a@avoqado.io')).toHaveLength(1)
  })

  it('retomar_usa_el_mismo_contenido_guardado: the retry sends what was built at 8:30, not what is pending now', async () => {
    send.mockResolvedValueOnce({ ok: false, transient: true, errorCode: 'rate_limit' })
    await runDailyDigest(T0)
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'FALLO', attempts: 1 }))

    // By 8:45 the pipeline changed: the summary is NOT rebuilt (Resend refuses a key reused with other content).
    pendingOf.mockResolvedValue(pending({ vencidas: section(9, ['Otro negocio']) }))
    await runDailyDigest(at(15))

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0])
    expect(send.mock.calls[1][0].subject).toBe('Tus pendientes de hoy: 2 vencidas y 1 para hoy')
    expect(sends[0].status).toBe('ENVIADO')
  })

  it('caida_tras_enviar_reintenta_con_la_misma_llave: two crashes after sending still carry ONE key, so Resend delivers once', async () => {
    crashesAfterSend = 2
    await runDailyDigest(T0) // sent, died before marking
    expect(sends[0].status).toBe('APARTADO')
    await runDailyDigest(at(11)) // retaken, sent again, died again
    expect(sends[0].status).toBe('APARTADO')
    await runDailyDigest(at(22)) // retaken, sent, marked
    expect(sends[0].status).toBe('ENVIADO')

    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.map(([email]) => email.idempotencyKey)).toEqual([KEY_A, KEY_A, KEY_A])
    expect(send.mock.calls[2][0]).toEqual(send.mock.calls[0][0])
  })

  it('fallo_reintenta_hasta_3: a failing email is tried three times that morning, never a fourth', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit' })
    for (const minutes of [0, 15, 30, 45, 60]) await runDailyDigest(at(minutes))

    expect(send).toHaveBeenCalledTimes(3)
    expect(new Set(send.mock.calls.map(([email]) => email.idempotencyKey))).toEqual(new Set([KEY_A]))
    // Sin intentos que gastar ya no se repite: no guarda su contenido (D1, Codex A r1).
    expect(sends).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3, content: null })])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_A }))
  })

  it('un fallo que todavía tiene intentos conserva su contenido para repetir el mismo correo', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit' })
    await runDailyDigest(T0)
    expect(sends).toEqual([
      expect.objectContaining({ status: 'FALLO', attempts: 1, content: expect.objectContaining({ to: 'a@avoqado.io' }) }),
    ])
  })

  it('dos_retomas_un_envio: two runs retaking the same stale row at once send it ONCE (the CAS on its reservation)', async () => {
    const content = { to: 'a@avoqado.io', subject: 'Tus pendientes de hoy: 2 vencidas y 1 para hoy', html: '<p>g</p>', text: 'g' }
    sends.push({
      id: 'cdigestsd0000000000000093',
      staffId: STAFF_A,
      day: DAY,
      kind: 'DIARIO',
      status: 'APARTADO',
      attempts: 0,
      reservedAt: T0,
      content,
    })

    await Promise.all([runDailyDigest(at(11)), runDailyDigest(at(11))])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ ...content, idempotencyKey: KEY_A })
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', reservedAt: at(11) }))
  })

  it('a run that lost its reservation never overwrites the mark of the run that took it over', async () => {
    // 8:30: the email hangs in Resend for more than 10 minutes.
    let finishFirst: (result: { ok: boolean; transient: boolean; errorCode?: string }) => void = () => undefined
    send.mockImplementationOnce(() => new Promise(resolve => (finishFirst = resolve)))
    const first = runDailyDigest(T0)
    await new Promise(resolve => setImmediate(resolve))
    expect(send).toHaveBeenCalledTimes(1)

    // 8:41: another run retakes the row and its send goes out.
    await runDailyDigest(at(11))
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', reservedAt: at(11) }))

    // The 8:30 send finally fails: its mark no longer matches the row, so «ENVIADO» stays.
    finishFirst({ ok: false, transient: true, errorCode: 'timeout' })
    await first
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', attempts: 0 }))
  })

  it('a retake that read the row just before its slow holder marked it does not send it again (status in the CAS)', async () => {
    // 8:30: the email hangs in Resend for more than 10 minutes.
    let finishFirst: (result: { ok: boolean; transient: boolean }) => void = () => undefined
    send.mockImplementationOnce(() => new Promise(resolve => (finishFirst = resolve)))
    const first = runDailyDigest(T0)
    await new Promise(resolve => setImmediate(resolve))

    // 8:41: the retake reads the row as stale; right after that read, the 8:30 send comes back and marks it «ENVIADO»
    // (its reservation is unchanged), and only then does the retake try its CAS.
    prismaMock.crmDigestSend.findMany.mockImplementationOnce(async ({ where }: { where: Record<string, unknown> }) => {
      const read = sends.filter(s => matches({ ...s }, where)).map(s => ({ ...s }))
      finishFirst({ ok: true, transient: false })
      await first
      return read
    })
    await runDailyDigest(at(11))

    expect(send).toHaveBeenCalledTimes(1)
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', reservedAt: T0 }))
  })

  it('retomar_revalida_el_acceso: someone who lost CRM access after 8:30 does not get the saved email, and the row closes', async () => {
    send.mockResolvedValueOnce({ ok: false, transient: true, errorCode: 'rate_limit' })
    await runDailyDigest(T0)
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'FALLO', attempts: 1 }))

    // Deactivated at 8:40 (or their «Ver» taken away): `getCrmAccess` is the one rule.
    accessOf.mockResolvedValue(null)
    await runDailyDigest(at(15))
    expect(send).toHaveBeenCalledTimes(1)
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'FALLO', attempts: 3 }))

    // Closed for good: not even with the access back is it retaken that morning.
    accessOf.mockResolvedValue({ ...access(STAFF_A), ver: null })
    await runDailyDigest(at(30))
    accessOf.mockImplementation(async () => access(STAFF_A))
    await runDailyDigest(at(45))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('fuera_de_la_lista: fuera de producción el aviso diario no sale, y su fila se cierra para siempre (FALLO sin intentos que gastar)', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'

    await runDailyDigest(T0)
    expect(send).not.toHaveBeenCalled()
    expect(sends).toEqual([expect.objectContaining({ staffId: STAFF_A, day: DAY, status: 'FALLO', attempts: 3 })])

    // Ningún tick posterior la retoma ni la vuelve a reservar.
    await runDailyDigest(at(15))
    await runDailyDigest(at(45))
    expect(send).not.toHaveBeenCalled()
    expect(sends).toHaveLength(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('outside the test list'),
      expect.objectContaining({ staffId: STAFF_A }),
    )
  })

  it('fuera_de_la_lista_al_retomar: una fila apartada que un tick posterior retoma tampoco sale fuera de la lista', async () => {
    sends.push({
      id: 'cdigestsd0000000000000099',
      staffId: STAFF_A,
      day: DAY,
      kind: 'DIARIO',
      status: 'APARTADO',
      attempts: 0,
      reservedAt: at(-11),
      content: { to: 'a@avoqado.io', subject: 's', html: '<p>guardado</p>', text: 'guardado' },
    })
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'

    await runDailyDigest(T0)

    expect(send).not.toHaveBeenCalled()
    expect(sends).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3 })])
  })

  it('rebote_o_queja_frena_el_resumen: una dirección suprimida no recibe el resumen y su fila se cierra para siempre', async () => {
    suprimidos.set('a@avoqado.io', 'COMPLAINT')

    await runDailyDigest(T0)
    expect(send).not.toHaveBeenCalled()
    expect(sends).toEqual([expect.objectContaining({ staffId: STAFF_A, day: DAY, status: 'FALLO', attempts: 3 })])
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[CRM]'),
      expect.objectContaining({ staffId: STAFF_A, motivo: 'QUEJA' }),
    )

    // Ningún tick posterior la retoma, aunque la dirección se limpie.
    suprimidos.clear()
    await runDailyDigest(at(15))
    await runDailyDigest(at(45))
    expect(send).not.toHaveBeenCalled()
    expect(sends).toHaveLength(1)
  })

  it('rebote_frena_el_resumen_al_retomar: una fila apartada que se retoma tras un rebote tampoco sale', async () => {
    sends.push({
      id: 'cdigestsd0000000000000098',
      staffId: STAFF_A,
      day: DAY,
      kind: 'DIARIO',
      status: 'APARTADO',
      attempts: 0,
      reservedAt: at(-11),
      content: { to: 'a@avoqado.io', subject: 's', html: '<p>guardado</p>', text: 'guardado' },
    })
    suprimidos.set('a@avoqado.io', 'HARD_BOUNCE')

    await runDailyDigest(T0)

    expect(send).not.toHaveBeenCalled()
    expect(sends).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3 })])
  })

  it.each([
    ['baja + rebote', 'HARD_BOUNCE', 'REBOTE'],
    ['baja + queja', 'COMPLAINT', 'QUEJA'],
  ] as const)('%s_frena_el_resumen: la baja no tapa la supresión (Codex código r2 P1)', async (_caso, reason, motivo) => {
    bajas.add('a@avoqado.io')
    suprimidos.set('a@avoqado.io', reason)

    await runDailyDigest(T0)

    expect(send).not.toHaveBeenCalled()
    expect(sends).toEqual([expect.objectContaining({ staffId: STAFF_A, status: 'FALLO', attempts: 3 })])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ staffId: STAFF_A, motivo }))
  })

  it('la_baja_de_marketing_no_frena_el_resumen: quien se dio de baja de una campaña sigue recibiendo su resumen', async () => {
    bajas.add('a@avoqado.io')

    await runDailyDigest(T0)

    expect(send).toHaveBeenCalledTimes(1)
    expect(sends).toEqual([expect.objectContaining({ staffId: STAFF_A, status: 'ENVIADO' })])
  })

  it('consulta_de_bloqueo_falla_se_reintenta: si no se puede revisar, no sale ni se cierra; el siguiente tick lo manda una vez', async () => {
    consultaFalla.add('a@avoqado.io')

    await runDailyDigest(T0)
    expect(send).not.toHaveBeenCalled()
    expect(sends).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 1 })])

    consultaFalla.clear()
    await runDailyDigest(at(15))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].idempotencyKey).toBe(KEY_A)
    expect(sends).toEqual([expect.objectContaining({ status: 'ENVIADO' })])
  })

  it('error_permanente_no_reintenta: a refusal that will not change (an undeliverable address) closes the row at once', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'UNDELIVERABLE_RECIPIENT' })
    await runDailyDigest(T0)
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'FALLO', attempts: 3 }))

    await runDailyDigest(at(15))
    await runDailyDigest(at(30))
    expect(send).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[CRM]'),
      expect.objectContaining({ error: 'UNDELIVERABLE_RECIPIENT' }),
    )
  })

  it('sin_pendientes_no_manda: nothing pending reserves nothing; «sin dueño» only counts for an admin', async () => {
    pendingOf.mockResolvedValue(pending())
    await runDailyDigest(T0)
    expect(prismaMock.crmDigestSend.create).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    // A seller without «admin»: new prospects nobody owns are not theirs to chase.
    pendingOf.mockResolvedValue(pending({ nuevosSinDueno: section(4, ['Café Nuevo']) }))
    await runDailyDigest(T0)
    expect(send).not.toHaveBeenCalled()
    expect(prismaMock.crmActivity.count).not.toHaveBeenCalled()

    // Someone who lost CRM access in between gets nothing either.
    accessOf.mockResolvedValue(null)
    pendingOf.mockResolvedValue(pending({ vencidas: section(3) }))
    await runDailyDigest(T0)
    expect(send).not.toHaveBeenCalled()
  })

  it('fin_de_semana_no_manda: Saturday and Sunday, and outside 8:30–11:00, the run does nothing', async () => {
    await runDailyDigest(new Date('2026-10-31T15:00:00Z')) // Saturday 9:00
    await runDailyDigest(new Date('2026-11-01T15:00:00Z')) // Sunday 9:00
    await runDailyDigest(new Date('2026-11-02T14:15:00Z')) // Monday 8:15
    await runDailyDigest(new Date('2026-11-02T17:15:00Z')) // Monday 11:15

    expect(prismaMock.crmDigestSend.findMany).not.toHaveBeenCalled()
    expect(prismaMock.crmDigestSend.create).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    await runDailyDigest(new Date('2026-11-02T17:00:00Z')) // Monday 11:00, the last tick
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the email: the plan’s subject, totals and up to five names without contact data; an admin also gets «sin dueño»', async () => {
    accessOf.mockResolvedValue(access(STAFF_A, true))
    prismaMock.crmActivity.count.mockResolvedValue(2)
    pendingOf.mockResolvedValue(
      pending({
        estancados: section(7, ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis', 'Siete']),
        nuevosSinDueno: section(3, ['Café <Nuevo>']),
      }),
    )

    await runDailyDigest(T0)

    const [email] = send.mock.calls[0]
    // Textual from the plan, even with 0 and 0: the stale ones are what is pending.
    expect(email.subject).toBe('Tus pendientes de hoy: 0 vencidas y 0 para hoy')
    expect(email.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(email.html.match(/https:\/\/avoqado\.io\/isotipo\.svg/g)).toHaveLength(2)
    expect(email.html).toContain('background-color:#000000')
    expect(email.text).toContain('Estancados: 7 · Uno, Dos, Tres, Cuatro, Cinco y 2 más')
    expect(email.text).not.toContain('Seis')
    expect(email.text).toContain('Sin dueño: 3 · Café <Nuevo>')
    expect(email.html).toContain('Café &lt;Nuevo&gt;')
    expect(email.text).toContain('Actividades sin responsable: 2')
    expect(email.text).toContain('/crm/pendientes')
    // The unassigned activities an admin sees are the live ones of the accounts they can see (rulings 12 and 30).
    expect(prismaMock.crmActivity.count).toHaveBeenCalledWith({
      where: { doneAt: null, assigneeStaffId: null, account: { AND: [expect.anything(), { archivedAt: null }] } },
    })
    // Reserved with the content it then sent (so a retake repeats the same email); once sent it no longer keeps it (D1).
    expect(prismaMock.crmDigestSend.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: { to: 'a@avoqado.io', subject: email.subject, html: email.html, text: email.text } }),
      }),
    )
    expect(sends[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', content: null }))
  })
})
