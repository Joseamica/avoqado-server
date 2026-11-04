/**
 * La supresión unida del correo de Avoqado: quien se dio de baja (`CrmEmailOptOut`) y quien rebotó o se quejó
 * (`EmailSuppression`) no recibe NADA más. `isBlocked` contesta por qué y `filtrarBloqueados` lo hace en lote.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { filtrarBloqueados, isBlocked, optOut } from '@/services/crm/email/optOut.service'

const STAFF = 'cstaffadmin000000000000001'

/** Un `CrmEmailOptOut` y un `EmailSuppression` en memoria, con la llave única de la base: lo que importa es lo que el servicio le pide. */
function baseEnMemoria(opts: { bajas?: string[]; suprimidos?: Array<{ email: string; reason: 'HARD_BOUNCE' | 'COMPLAINT' }> } = {}) {
  const bajas = new Set(opts.bajas ?? [])
  const suprimidos = new Map((opts.suprimidos ?? []).map(s => [s.email, s.reason]))
  prismaMock.crmEmailOptOut.findUnique.mockImplementation(async ({ where }: any) => (bajas.has(where.email) ? { id: 'x' } : null))
  prismaMock.crmEmailOptOut.findMany.mockImplementation(async ({ where }: any) =>
    (where.email.in as string[]).filter(e => bajas.has(e)).map(email => ({ email })),
  )
  prismaMock.crmEmailOptOut.createMany.mockImplementation(async ({ data, skipDuplicates }: any) => {
    let count = 0
    for (const fila of data) {
      if (bajas.has(fila.email)) {
        if (!skipDuplicates) throw new Error('Unique constraint failed on the fields: (`email`)')
        continue
      }
      bajas.add(fila.email)
      count += 1
    }
    return { count }
  })
  prismaMock.emailSuppression.findUnique.mockImplementation(async ({ where }: any) =>
    suprimidos.has(where.email) ? { reason: suprimidos.get(where.email) } : null,
  )
  prismaMock.emailSuppression.findMany.mockImplementation(async ({ where }: any) =>
    (where.email.in as string[]).filter(e => suprimidos.has(e)).map(email => ({ email })),
  )
  return { bajas, suprimidos }
}

beforeEach(() => {
  for (const fn of [
    prismaMock.crmEmailOptOut.findUnique,
    prismaMock.crmEmailOptOut.findMany,
    prismaMock.crmEmailOptOut.createMany,
    prismaMock.emailSuppression.findUnique,
    prismaMock.emailSuppression.findMany,
  ])
    fn.mockReset()
})

describe('isBlocked', () => {
  it('quien no está en ninguna de las dos tablas no está bloqueado', async () => {
    baseEnMemoria()
    await expect(isBlocked('ana@example.com')).resolves.toBe(false)
  })

  it('da «BAJA» tras optOut', async () => {
    baseEnMemoria()
    await optOut('ana@example.com', 'UN_CLIC')
    await expect(isBlocked('ana@example.com')).resolves.toBe('BAJA')
  })

  it('da «REBOTE» con una supresión HARD_BOUNCE y «QUEJA» con una COMPLAINT', async () => {
    baseEnMemoria({
      suprimidos: [
        { email: 'rebote@example.com', reason: 'HARD_BOUNCE' },
        { email: 'queja@example.com', reason: 'COMPLAINT' },
      ],
    })
    await expect(isBlocked('rebote@example.com')).resolves.toBe('REBOTE')
    await expect(isBlocked('queja@example.com')).resolves.toBe('QUEJA')
  })

  it('la baja manda sobre el rebote: quien pidió no recibir sigue diciendo «BAJA» aunque además haya rebotado', async () => {
    baseEnMemoria({ bajas: ['ana@example.com'], suprimidos: [{ email: 'ana@example.com', reason: 'HARD_BOUNCE' }] })
    await expect(isBlocked('ana@example.com')).resolves.toBe('BAJA')
  })

  it('busca el correo normalizado: mayúsculas y espacios no esquivan la baja', async () => {
    baseEnMemoria({ bajas: ['ana@example.com'], suprimidos: [{ email: 'rebote@example.com', reason: 'HARD_BOUNCE' }] })
    await expect(isBlocked('  Ana@Example.COM ')).resolves.toBe('BAJA')
    await expect(isBlocked('REBOTE@example.com')).resolves.toBe('REBOTE')
  })

  it('un alias +etiqueta es OTRA dirección: no hereda la baja (misma regla que la supresión global)', async () => {
    baseEnMemoria({ bajas: ['ana@example.com'] })
    await expect(isBlocked('ana+promos@example.com')).resolves.toBe(false)
  })

  it('si la base falla, lanza: quien manda NO debe tomar un error por «no está bloqueado»', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockRejectedValue(new Error('db caída'))
    prismaMock.emailSuppression.findUnique.mockResolvedValue(null)
    await expect(isBlocked('ana@example.com')).rejects.toThrow('db caída')
  })
})

describe('optOut', () => {
  it('guarda el correo normalizado con su origen y quién lo pidió', async () => {
    baseEnMemoria()
    await optOut('  Ana@Example.COM ', 'ADMIN', STAFF)
    expect(prismaMock.crmEmailOptOut.createMany).toHaveBeenCalledWith({
      data: [{ email: 'ana@example.com', source: 'ADMIN', actorStaffId: STAFF }],
      skipDuplicates: true,
    })
  })

  it('sin actor guarda actorStaffId nulo (la baja de un clic no tiene staff)', async () => {
    baseEnMemoria()
    await optOut('ana@example.com', 'UN_CLIC')
    expect(prismaMock.crmEmailOptOut.createMany.mock.calls[0][0].data[0]).toEqual({
      email: 'ana@example.com',
      source: 'UN_CLIC',
      actorStaffId: null,
    })
  })

  it('🔴 dos optOut del mismo correo dejan UNA fila y no truenan (el segundo clic de Gmail, el doble toque)', async () => {
    const { bajas } = baseEnMemoria()
    await optOut('ana@example.com', 'UN_CLIC')
    await expect(optOut('ANA@example.com', 'UN_CLIC')).resolves.toBeUndefined()
    await expect(optOut('ana@example.com', 'ADMIN', STAFF)).resolves.toBeUndefined()
    expect([...bajas]).toEqual(['ana@example.com'])
    // Siempre con skipDuplicates: la llave única hace de candado y nadie lee-antes-de-escribir.
    for (const [args] of prismaMock.crmEmailOptOut.createMany.mock.calls) expect(args.skipDuplicates).toBe(true)
  })

  it('deja ActivityLog sin venue sólo la primera vez: repetir la baja no ensucia la bitácora', async () => {
    baseEnMemoria()
    await optOut('ana@example.com', 'ADMIN', STAFF)
    await optOut('ana@example.com', 'ADMIN', STAFF)
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF,
        venueId: null,
        action: 'CRM_EMAIL_OPT_OUT',
        entity: 'CrmEmailOptOut',
        data: { source: 'ADMIN' },
      }),
    )
  })

  it('🔴 la_bitacora_de_la_baja_no_lleva_el_correo (D1, H3): la fila de bajas ya dice cuál y cuándo', async () => {
    baseEnMemoria()
    await optOut('ana@example.com', 'UN_CLIC')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CRM_EMAIL_OPT_OUT', data: { source: 'UN_CLIC' } }))
    expect(JSON.stringify(jest.mocked(logAction).mock.calls)).not.toContain('ana@example.com')
  })

  it('un clic anónimo se registra sin staff', async () => {
    baseEnMemoria()
    await optOut('ana@example.com', 'UN_CLIC')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: null, venueId: null, data: expect.objectContaining({ source: 'UN_CLIC' }) }),
    )
  })
})

describe('filtrarBloqueados', () => {
  it('junta bajas, rebotes y quejas en un Set de correos normalizados, con UNA consulta por tabla', async () => {
    baseEnMemoria({
      bajas: ['baja@example.com'],
      suprimidos: [
        { email: 'rebote@example.com', reason: 'HARD_BOUNCE' },
        { email: 'queja@example.com', reason: 'COMPLAINT' },
      ],
    })

    const bloqueados = await filtrarBloqueados(prismaMock, [
      'Baja@Example.com',
      'rebote@example.com',
      'QUEJA@example.com',
      'libre@example.com',
      'baja@example.com',
    ])

    expect([...bloqueados].sort()).toEqual(['baja@example.com', 'queja@example.com', 'rebote@example.com'])
    expect(prismaMock.crmEmailOptOut.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.emailSuppression.findMany).toHaveBeenCalledTimes(1)
    // No es N consultas: nada de findUnique por persona.
    expect(prismaMock.crmEmailOptOut.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.emailSuppression.findUnique).not.toHaveBeenCalled()
  })

  it('la consulta lleva su tope (a lo más una fila por correo pedido) y sin repetidos', async () => {
    baseEnMemoria()
    await filtrarBloqueados(prismaMock, ['a@example.com', 'A@example.com', 'b@example.com'])
    const args = prismaMock.crmEmailOptOut.findMany.mock.calls[0][0]
    expect(args.where.email.in).toEqual(['a@example.com', 'b@example.com'])
    expect(args.take).toBe(2)
  })

  it('sin correos no toca la base', async () => {
    baseEnMemoria()
    await expect(filtrarBloqueados(prismaMock, [])).resolves.toEqual(new Set())
    expect(prismaMock.crmEmailOptOut.findMany).not.toHaveBeenCalled()
    expect(prismaMock.emailSuppression.findMany).not.toHaveBeenCalled()
  })

  it('usa el cliente de la transacción que le pasan, no el global', async () => {
    const tx = {
      crmEmailOptOut: { findMany: jest.fn().mockResolvedValue([{ email: 'a@example.com' }]) },
      emailSuppression: { findMany: jest.fn().mockResolvedValue([]) },
    }
    await expect(filtrarBloqueados(tx as never, ['a@example.com'])).resolves.toEqual(new Set(['a@example.com']))
    expect(prismaMock.crmEmailOptOut.findMany).not.toHaveBeenCalled()
  })
})
