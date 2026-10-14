// tests/unit/services/customer-display/customerDisplayDesign.copy.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  copyCustomerDisplayDesign,
  getEffectiveDesign,
  invalidateCustomerDisplayCache,
  previewCopyCustomerDisplay,
} from '@/services/customer-display/customerDisplayDesign.service'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const entrada = {
  venueId: 'v',
  staffId: 's',
  source: { terminalId: 't1', editToken: 'factory' },
  targets: [{ terminalId: 't2', editToken: 'factory' }],
}
const interbloqueo = () => new Prisma.PrismaClientKnownRequestError('deadlock detected', { code: 'P2034', clientVersion: 'test' })

beforeEach(() => {
  prismaMock.terminal.findMany.mockResolvedValue([
    { id: 't1', type: 'POS_ANDROID' },
    { id: 't2', type: 'POS_ANDROID' },
  ] as any)
})

it('un interbloqueo se reintenta UNA vez y el segundo intento puede ganar', async () => {
  prismaMock.$transaction
    .mockRejectedValueOnce(interbloqueo())
    .mockResolvedValueOnce({ escritos: [{ terminalId: 't2', changedKeys: [] }], promosOmitted: false })

  await expect(copyCustomerDisplayDesign(entrada)).resolves.toMatchObject({ copied: ['t2'] })
  expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
})

it('dos interbloqueos seguidos: 409 CUSTOMER_DISPLAY_BUSY, sin un tercer intento', async () => {
  prismaMock.$transaction.mockRejectedValueOnce(interbloqueo()).mockRejectedValueOnce(interbloqueo())

  await expect(copyCustomerDisplayDesign(entrada)).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_BUSY' })
  expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
})

// El reintento es SÓLO para el interbloqueo. Un candado que venció ya esperó su tope: repetirlo duplicaría la espera.
it('un lock_timeout (55P03) NO se reintenta: 409 BUSY al primer intento', async () => {
  prismaMock.$transaction.mockRejectedValueOnce(
    Object.assign(new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `55P03`', { code: 'P2010', clientVersion: 'test' }), {
      meta: { code: '55P03' },
    }),
  )

  await expect(copyCustomerDisplayDesign(entrada)).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_BUSY' })
  expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
})

it('el candado es UNA sentencia sobre todas las terminales, ORDENADA por id', async () => {
  prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockResolvedValueOnce([
    { id: 't1', venueId: 'v' },
    { id: 't2', venueId: 'v' },
  ] as any)
  prismaMock.customerDisplayDesign.findMany.mockResolvedValueOnce([] as any)
  prismaMock.customerDisplayDesign.create.mockResolvedValueOnce({ id: 'd2', revision: 1 } as any)

  await copyCustomerDisplayDesign(entrada)

  const [plantilla] = prismaMock.$queryRaw.mock.calls[0] as [TemplateStringsArray]
  expect(plantilla.join('?').replace(/\s+/g, ' ')).toContain('WHERE id = ANY(?::text[]) ORDER BY id FOR UPDATE')
})

// La espera de TODOS los candados tiene tope, y se fija ANTES de pedirlos (la misma regla que guardar y restablecer).
it('la PRIMERA sentencia de la transacción fija lock_timeout, antes del candado ordenado', async () => {
  const orden: string[] = []
  prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(prismaMock))
  prismaMock.$executeRawUnsafe.mockImplementationOnce(async (sql: string) => {
    orden.push(sql)
    return 0
  })
  prismaMock.$queryRaw.mockImplementationOnce(async () => {
    orden.push('CANDADO')
    return [
      { id: 't1', venueId: 'v' },
      { id: 't2', venueId: 'v' },
    ]
  })
  prismaMock.customerDisplayDesign.findMany.mockResolvedValueOnce([] as any)
  prismaMock.customerDisplayDesign.create.mockResolvedValueOnce({ id: 'd2', revision: 1 } as any)

  await copyCustomerDisplayDesign(entrada)

  expect(orden).toHaveLength(2)
  expect(orden[0]).toMatch(/^SET LOCAL lock_timeout = '\d+ms'$/)
  expect(orden[1]).toBe('CANDADO')
})

// El tope de 20 lo pone el SERVIDOR, y antes de tocar la base: una lista hostil no cuesta ni una consulta.
it('una lista hostil de miles de destinos se rechaza con INVALID_TARGETS sin consultar nada', async () => {
  const miles = Array.from({ length: 10_000 }, (_, i) => ({ terminalId: `x${i}`, editToken: 'factory' }))

  await expect(copyCustomerDisplayDesign({ ...entrada, targets: miles })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_TARGETS',
  })
  await expect(previewCopyCustomerDisplay({ venueId: 'v', source: entrada.source, targets: miles })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_TARGETS',
  })
  expect(prismaMock.terminal.findMany).not.toHaveBeenCalled()
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
})

it('un origen o un destino mal formado es un 400 con su código, no un 500 de la base', async () => {
  await expect(copyCustomerDisplayDesign({ ...entrada, source: { terminalId: '', editToken: 'factory' } })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_SOURCE',
  })
  await expect(copyCustomerDisplayDesign({ ...entrada, targets: [{ terminalId: 7, editToken: 'factory' } as any] })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_TARGETS',
  })
  await expect(copyCustomerDisplayDesign({ ...entrada, targets: null as any })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_TARGETS',
  })
  expect(prismaMock.terminal.findMany).not.toHaveBeenCalled()
})

// La tablet lee de la caché de 60 s: si copiar no la tirara, cada destino seguiría mostrando su diseño viejo. (La misma
// regla que guardar; sin esta prueba, quitar la invalidación de la copia no ponía nada en rojo.)
it('copiar invalida la caché de la ficha de CADA destino escrito', async () => {
  // DOS destinos (t2 y t3): con uno solo, una invalidación que sólo tirara «el primero» pasaba en verde.
  prismaMock.terminal.findMany.mockResolvedValue([
    { id: 't1', type: 'POS_ANDROID' },
    { id: 't2', type: 'POS_ANDROID' },
    { id: 't3', type: 'POS_ANDROID' },
  ] as any)
  prismaMock.terminal.findFirst.mockImplementation((async ({ where }: any) => ({
    id: where.id,
    venueId: 'v',
    name: `Caja ${where.id}`,
    type: 'POS_ANDROID',
    customerDisplayDesignVersion: 2,
    venue: { logo: null, updatedAt: new Date() },
    customerDisplayDesign: null,
  })) as any)
  const destinos = ['t2', 't3']
  try {
    // Se ceba la caché de los dos: la segunda lectura de cada uno sale de la caché, sin consultar la base.
    for (const id of destinos) {
      await getEffectiveDesign('v', id, { cache: true })
      await getEffectiveDesign('v', id, { cache: true })
    }
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2) // una consulta por destino; la segunda de cada uno, de la caché

    prismaMock.$transaction.mockResolvedValueOnce({
      escritos: [
        { terminalId: 't2', changedKeys: [] },
        { terminalId: 't3', changedKeys: [] },
      ],
      promosOmitted: false,
    })
    await expect(
      copyCustomerDisplayDesign({
        ...entrada,
        targets: [
          { terminalId: 't2', editToken: 'factory' },
          { terminalId: 't3', editToken: 'factory' },
        ],
      }),
    ).resolves.toMatchObject({ copied: ['t2', 't3'] })
    const lecturasTrasCopiar = prismaMock.terminal.findFirst.mock.calls.length

    // Los DOS se vuelven a leer de la base: ninguno quedó en la caché.
    for (const id of destinos) await getEffectiveDesign('v', id, { cache: true })
    expect(prismaMock.terminal.findFirst.mock.calls.length).toBe(lecturasTrasCopiar + 2)
    expect(prismaMock.terminal.findFirst.mock.calls.slice(lecturasTrasCopiar).map(([args]: any) => args.where.id)).toEqual(['t2', 't3'])
  } finally {
    // La caché es del módulo: no se deja estado para las pruebas que siguen.
    invalidateCustomerDisplayCache('t2')
    invalidateCustomerDisplayCache('t3')
  }
})

// MINOR 7: con el plan, TODOS los destinos reciben las mismas imágenes y el mismo logo del origen. Revisar el mismo
// conjunto de activos una vez por destino son hasta 20 consultas idénticas: se lee UNA vez por copia (y por vista previa).
describe('los activos se leen UNA vez por operación, no una por destino', () => {
  const tres = {
    ...entrada,
    targets: [
      { terminalId: 't2', editToken: 'factory' },
      { terminalId: 't3', editToken: 'factory' },
      { terminalId: 't4', editToken: 'factory' },
    ],
  }
  const ORIGEN = {
    id: 'd1',
    terminalId: 't1',
    revision: 1,
    updatedById: null,
    theme: 'LIGHT',
    accentColor: null,
    logoAssetId: 'lg',
    welcomeText: null,
    thanksText: null,
    slides: [{ assetId: 's1' }],
    slideSeconds: 8,
    showPromotions: false,
  }

  beforeEach(() => {
    prismaMock.terminal.findMany.mockResolvedValue(['t1', 't2', 't3', 't4'].map(id => ({ id, type: 'POS_ANDROID', name: id })) as any)
    prismaMock.customerDisplayDesign.findMany.mockResolvedValue([ORIGEN] as any)
    prismaMock.customerDisplayAsset.findMany.mockResolvedValue([
      { id: 'lg', kind: 'LOGO' },
      { id: 's1', kind: 'SLIDE' },
    ] as any)
  })

  it('la copia a tres destinos consulta los activos UNA vez', async () => {
    prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValueOnce(['t1', 't2', 't3', 't4'].map(id => ({ id, venueId: 'v' })) as any)
    prismaMock.customerDisplayDesign.create.mockResolvedValue({ id: 'dx', revision: 1 } as any)

    await expect(copyCustomerDisplayDesign({ ...tres, source: { terminalId: 't1', editToken: 'd1:1' } })).resolves.toMatchObject({
      copied: ['t2', 't3', 't4'],
    })
    expect(prismaMock.customerDisplayAsset.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.customerDisplayAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['s1', 'lg'] }, venueId: 'v' }, take: 2 }),
    )
  })

  it('la vista previa de tres destinos también', async () => {
    await previewCopyCustomerDisplay({ venueId: 'v', source: { terminalId: 't1', editToken: 'd1:1' }, targets: tres.targets })
    expect(prismaMock.customerDisplayAsset.findMany).toHaveBeenCalledTimes(1)
  })
})
