/**
 * `scripts/seed-device-menus-feature.ts`: la siembra de PUBLICACIÓN de DEVICE_MENUS (Parte E del plan «Menú del aparato»).
 *
 * Prisma y la puesta al día de los contratos van simulados: aquí se prueba lo que el script DECIDE (qué escribe, qué se niega,
 * qué reporta y con qué código sale), no Postgres. Molde: sembrarFuncionTarjetasDeRegalo.test.ts (las negativas salen ANTES de
 * escribir), sin su parte de precio de lista: DEVICE_MENUS va incluida en Pro y Premium y no se vende suelta.
 */
import fs from 'fs'
import path from 'path'

const mockEstado = {
  catalogo: [] as ReadonlyArray<{ featureCode: string | null }>,
  codigosDePuestaAlDia: [] as string[],
}
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    feature: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    $disconnect: jest.fn(),
  },
}))
jest.mock('@/config/featureCatalog', () => ({
  get FEATURE_CATALOG() {
    return mockEstado.catalogo
  },
}))
jest.mock('@/services/access/basePlan.service', () => ({ elPlanConcede: jest.fn() }))
jest.mock('@/services/launchCampaigns/hybridPlanCatchUp', () => ({
  get PLAN_CATCH_UP_CODES() {
    return mockEstado.codigosDePuestaAlDia
  },
  addPlanFeatureToLivePlanContracts: jest.fn(),
  staleCampaigns: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { elPlanConcede } from '@/services/access/basePlan.service'
import { addPlanFeatureToLivePlanContracts, staleCampaigns } from '@/services/launchCampaigns/hybridPlanCatchUp'
import {
  CODIGO,
  CODIGOS_SIN_FILA,
  NegativaDeSiembra,
  codigoDeSalida,
  sembrarFuncionMenuDelAparato,
  type ReporteDeSiembra,
} from '../../../scripts/seed-device-menus-feature'

const db = prisma as any
// El catálogo REAL por default: si alguien quita DEVICE_MENUS del catálogo, el camino feliz de abajo se niega.
const CATALOGO_REAL = jest.requireActual('@/config/featureCatalog').FEATURE_CATALOG as ReadonlyArray<{ featureCode: string | null }>
const CODIGOS_DEL_SCRIPT = [CODIGO, ...CODIGOS_SIN_FILA]
const CODIGOS_DE_PUESTA_AL_DIA = ['SERVICE_PAY', 'GIFT_CARDS', ...CODIGOS_DEL_SCRIPT]
const BASE = 'avoqado_siembra_test'
const URL_DE_PRUEBA = `postgresql://u:SECRETO@localhost:5432/${BASE}`
const CONFIRMADO = { apply: true, confirmHost: 'localhost', confirmDb: BASE }
const SIN_CONTRATOS = { contracts: 0, grants: 0, skippedContracts: [], inFlightPurchases: [], staleCampaigns: [] }
const URL_ANTES = process.env.DATABASE_URL
const lineas: string[] = []
const log = (linea: string) => lineas.push(linea)

/** «No se escribió NADA»: ni la fila Feature ni un solo contrato. */
function nadaSeEscribio() {
  expect(db.feature.upsert).not.toHaveBeenCalled()
  expect(db.feature.update).not.toHaveBeenCalled()
  expect(addPlanFeatureToLivePlanContracts).not.toHaveBeenCalled()
}

afterAll(() => {
  if (URL_ANTES === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = URL_ANTES
})
beforeEach(() => {
  jest.clearAllMocks()
  lineas.length = 0
  process.env.DATABASE_URL = URL_DE_PRUEBA
  mockEstado.catalogo = CATALOGO_REAL
  mockEstado.codigosDePuestaAlDia = [...CODIGOS_DE_PUESTA_AL_DIA]
  db.feature.findUnique.mockResolvedValue(null)
  db.feature.upsert.mockResolvedValue({})
  db.feature.update.mockResolvedValue({})
  jest.mocked(elPlanConcede).mockReturnValue(true)
  jest.mocked(addPlanFeatureToLivePlanContracts).mockResolvedValue({ ...SIN_CONTRATOS } as never)
  jest.mocked(staleCampaigns).mockResolvedValue([])
})

describe('las negativas salen ANTES de escribir («no se escribió NADA»)', () => {
  it('sin DATABASE_URL no hay base a la que conectarse', async () => {
    delete process.env.DATABASE_URL
    const error = await sembrarFuncionMenuDelAparato(CONFIRMADO, log).catch(e => e)
    expect(error).toBeInstanceOf(NegativaDeSiembra)
    expect(error.message).toMatch(/Falta DATABASE_URL/)
    nadaSeEscribio()
  })

  it('una DATABASE_URL que no es una URL se niega y NO imprime su valor', async () => {
    process.env.DATABASE_URL = 'esto-no-es-una-url y trae SECRETO'
    const error = await sembrarFuncionMenuDelAparato(CONFIRMADO, log).catch(e => e)
    expect(error).toBeInstanceOf(NegativaDeSiembra)
    expect(error.message).toMatch(/no es una URL válida/)
    expect(error.message).not.toContain('SECRETO')
    nadaSeEscribio()
  })

  it.each([
    ['sin repetir nada', {}],
    ['con el host mal', { confirmHost: 'otro-host', confirmDb: BASE }],
    ['con la base mal (otra base del mismo servidor)', { confirmHost: 'localhost', confirmDb: 'av-db-25' }],
  ])('--apply %s: no escribe nada y dice cómo confirmar', async (_caso, confirmar) => {
    const error = await sembrarFuncionMenuDelAparato({ apply: true, ...confirmar }, log).catch(e => e)
    expect(error).toBeInstanceOf(NegativaDeSiembra)
    expect(error.message).toContain(`--confirm-host localhost --confirm-db ${BASE}`)
    expect(db.feature.findUnique).not.toHaveBeenCalled()
    nadaSeEscribio()
  })

  describe.each(CODIGOS_DEL_SCRIPT)('%s', codigo => {
    it.each([
      [
        'el árbol desde el que corre no la trae en el catálogo',
        () => (mockEstado.catalogo = CATALOGO_REAL.filter(f => f.featureCode !== codigo)),
        /no está en el catálogo/,
      ],
      [
        'el árbol no la trae en la lista de puesta al día',
        () => (mockEstado.codigosDePuestaAlDia = CODIGOS_DE_PUESTA_AL_DIA.filter(c => c !== codigo)),
        /no es una función de plan/,
      ],
      [
        'Premium no la concede',
        () => jest.mocked(elPlanConcede).mockImplementation((tier, c) => !(tier === 'PREMIUM' && c === codigo)),
        /no es una función de plan/,
      ],
      [
        'Pro no la concede',
        () => jest.mocked(elPlanConcede).mockImplementation((tier, c) => !(tier === 'PRO' && c === codigo)),
        /no es una función de plan/,
      ],
    ])('con --apply confirmado, si %s → NegativaDeSiembra y NADA se escribe', async (_caso, preparar, mensaje) => {
      preparar()
      const error = await sembrarFuncionMenuDelAparato(CONFIRMADO, log).catch(e => e)
      expect(error).toBeInstanceOf(NegativaDeSiembra)
      expect(error.message).toMatch(mensaje)
      expect(error.message).toContain(codigo)
      expect(db.feature.findUnique).not.toHaveBeenCalled()
      nadaSeEscribio()
    })
  })
})

describe('simulación (sin --apply): lee, reporta y NO escribe', () => {
  it('imprime host y base sin la contraseña, y dice que crearía la fila', async () => {
    const r = await sembrarFuncionMenuDelAparato({ apply: false }, log)
    expect(r).toMatchObject({ host: 'localhost', base: BASE, feature: 'CREATE', contracts: null, staleCampaigns: [] })
    expect(lineas[0]).toContain('localhost')
    expect(lineas[0]).toContain(BASE)
    expect(lineas[0]).toContain('SIMULACIÓN')
    expect(lineas.join('\n')).not.toContain('SECRETO')
    for (const c of CODIGOS_DEL_SCRIPT) expect(staleCampaigns).toHaveBeenCalledWith(c)
    nadaSeEscribio()
  })

  it('una fila apagada se reporta como apagada; con --reactivar sólo anuncia que la encendería', async () => {
    db.feature.findUnique.mockResolvedValue({ active: false })
    expect((await sembrarFuncionMenuDelAparato({ apply: false }, log)).feature).toBe('INACTIVE')
    expect((await sembrarFuncionMenuDelAparato({ apply: false, reactivar: true }, log)).feature).toBe('REACTIVATE')
    nadaSeEscribio()
  })

  it('lista las ofertas de plan que todavía no traen la función', async () => {
    jest.mocked(staleCampaigns).mockResolvedValue([{ id: 'c1', code: 'L_PLAN_PRO' }])
    const r = await sembrarFuncionMenuDelAparato({ apply: false }, log)
    expect(r.staleCampaigns).toEqual([{ id: 'c1', code: 'L_PLAN_PRO' }])
    expect(lineas.join('\n')).toContain('L_PLAN_PRO')
    nadaSeEscribio()
  })
})

describe('--apply confirmado', () => {
  it('crea la fila Feature con precio 0 y sin nada de Stripe, y pone al día los contratos de plan vivos', async () => {
    const r = await sembrarFuncionMenuDelAparato(CONFIRMADO, log)
    expect(r.feature).toBe('CREATE')
    expect(db.feature.upsert).toHaveBeenCalledTimes(1)
    const { where, update, create } = db.feature.upsert.mock.calls[0][0]
    expect(where).toEqual({ code: CODIGO })
    expect(update).toEqual({}) // si otra corrida la creó en este instante, no se toca
    expect(create).toMatchObject({ code: CODIGO, name: 'Menú de cada aparato', category: 'OPERATIONS', monthlyPrice: 0, active: true })
    expect(create).not.toHaveProperty('stripeProductId')
    expect(create).not.toHaveProperty('stripePriceId')
    expect(db.feature.update).not.toHaveBeenCalled()
    expect(addPlanFeatureToLivePlanContracts).toHaveBeenCalledTimes(3)
    for (const c of CODIGOS_DEL_SCRIPT) expect(addPlanFeatureToLivePlanContracts).toHaveBeenCalledWith(c)
    // KITCHEN_DISPLAY y CUSTOMER_DISPLAY_PROMOS no llevan fila Feature: la única fila es la de DEVICE_MENUS.
    expect(db.feature.findUnique).toHaveBeenCalledTimes(1)
    expect(lineas.join('\n')).not.toContain('SECRETO')
  })

  it('una fila que ya existe y está activa no se toca; los contratos se ponen al día igual (idempotente)', async () => {
    db.feature.findUnique.mockResolvedValue({ active: true })
    const r = await sembrarFuncionMenuDelAparato(CONFIRMADO, log)
    expect(r.feature).toBe('EXISTS')
    expect(db.feature.upsert).not.toHaveBeenCalled()
    expect(db.feature.update).not.toHaveBeenCalled()
    for (const c of CODIGOS_DEL_SCRIPT) expect(addPlanFeatureToLivePlanContracts).toHaveBeenCalledWith(c)
  })

  it('🔴 una fila APAGADA no se reactiva en silencio: se reporta y se deja (los contratos se ponen al día igual)', async () => {
    db.feature.findUnique.mockResolvedValue({ active: false })
    const r = await sembrarFuncionMenuDelAparato(CONFIRMADO, log)
    expect(r.feature).toBe('INACTIVE')
    expect(db.feature.upsert).not.toHaveBeenCalled()
    expect(db.feature.update).not.toHaveBeenCalled()
    expect(lineas.find(l => l.includes('Feature'))).toMatch(/APAGADA.*--reactivar/)
    for (const c of CODIGOS_DEL_SCRIPT) expect(addPlanFeatureToLivePlanContracts).toHaveBeenCalledWith(c)
  })

  it('con --reactivar enciende la fila apagada tocando SÓLO `active` (ni precio ni nombre)', async () => {
    db.feature.findUnique.mockResolvedValue({ active: false })
    const r = await sembrarFuncionMenuDelAparato({ ...CONFIRMADO, reactivar: true }, log)
    expect(r.feature).toBe('REACTIVATE')
    expect(db.feature.update).toHaveBeenCalledTimes(1)
    expect(db.feature.update).toHaveBeenCalledWith({ where: { code: CODIGO }, data: { active: true } })
    expect(db.feature.upsert).not.toHaveBeenCalled()
  })

  it('--reactivar no hace nada si la fila no existe o ya está activa', async () => {
    await sembrarFuncionMenuDelAparato({ ...CONFIRMADO, reactivar: true }, log)
    expect(db.feature.update).not.toHaveBeenCalled()
    db.feature.findUnique.mockResolvedValue({ active: true })
    await sembrarFuncionMenuDelAparato({ ...CONFIRMADO, reactivar: true }, log)
    expect(db.feature.update).not.toHaveBeenCalled()
  })

  it('volver a correrlo no cambia nada de la fila', async () => {
    expect((await sembrarFuncionMenuDelAparato(CONFIRMADO, log)).feature).toBe('CREATE')
    expect(db.feature.upsert).toHaveBeenCalledTimes(1)
    db.feature.findUnique.mockResolvedValue({ active: true })
    expect((await sembrarFuncionMenuDelAparato(CONFIRMADO, log)).feature).toBe('EXISTS')
    expect(db.feature.upsert).toHaveBeenCalledTimes(1)
    expect(db.feature.update).not.toHaveBeenCalled()
  })

  it('reporta lo que dejó la puesta al día de los contratos y las ofertas por republicar', async () => {
    jest.mocked(addPlanFeatureToLivePlanContracts).mockResolvedValueOnce({
      contracts: 2,
      grants: 3,
      skippedContracts: [{ contractId: 'k1', reason: 'SELECTION_BOUNDARY_FULL' }],
      inFlightPurchases: [{ status: 'PENDING', purchases: 1 }],
      staleCampaigns: [{ id: 'c1', code: 'L_PLAN_PRO' }],
    } as never)
    const r = await sembrarFuncionMenuDelAparato(CONFIRMADO, log)
    expect(r.contracts).toEqual({
      contracts: 2,
      grants: 3,
      skippedContracts: [{ contractId: 'k1', reason: `${CODIGO}: SELECTION_BOUNDARY_FULL` }],
      inFlightPurchases: [{ status: 'PENDING', purchases: 1 }],
    })
    expect(r.staleCampaigns).toEqual([{ id: 'c1', code: 'L_PLAN_PRO' }])
    expect(lineas.join('\n')).toContain('Contratos de plan puestos al día: 2 · accesos de periodo creados: 3 · saltados: 1')
    expect(lineas.join('\n')).toContain('saltado k1: DEVICE_MENUS: SELECTION_BOUNDARY_FULL')
    expect(lineas.join('\n')).toContain('PENDING: 1')
    expect(lineas.join('\n')).toContain('L_PLAN_PRO')
    expect(staleCampaigns).not.toHaveBeenCalled() // con --apply las ofertas por republicar salen del resultado de la puesta al día
  })

  it('imprime el motivo de los primeros 20 contratos saltados y cuenta el resto (el código de salida 1 tiene que poder leerse)', async () => {
    const saltados = Array.from({ length: 25 }, (_, i) => ({ contractId: `k${i}`, reason: `MOTIVO_${i}` }))
    jest.mocked(addPlanFeatureToLivePlanContracts).mockResolvedValueOnce({ ...SIN_CONTRATOS, skippedContracts: saltados } as never)
    const r = await sembrarFuncionMenuDelAparato(CONFIRMADO, log)
    expect(r.contracts?.skippedContracts).toHaveLength(25)
    expect(lineas.filter(l => l.startsWith('  saltado '))).toHaveLength(20)
    expect(lineas.join('\n')).toContain('saltado k19: DEVICE_MENUS: MOTIVO_19')
    expect(lineas.join('\n')).not.toContain('MOTIVO_20')
    expect(lineas.join('\n')).toContain('…y 5 más')
  })
})

describe('código de salida (0 = al día o simulación · 1 = contratos sin poner al día · 2 = falta volver a correrlo)', () => {
  const reporte = (parte: Partial<ReporteDeSiembra> = {}): ReporteDeSiembra => ({
    host: 'localhost',
    base: BASE,
    feature: 'EXISTS',
    contracts: { contracts: 1, grants: 1, skippedContracts: [], inFlightPurchases: [] },
    staleCampaigns: [],
    ...parte,
  })
  const contratos = (parte: Partial<NonNullable<ReporteDeSiembra['contracts']>>) => ({
    contracts: 1,
    grants: 1,
    skippedContracts: [],
    inFlightPurchases: [],
    ...parte,
  })

  it('simulación → 0, aunque haya ofertas por republicar', () => {
    expect(codigoDeSalida(false, reporte({ contracts: null, staleCampaigns: [{ id: 'c1', code: 'L_PLAN_PRO' }] }))).toBe(0)
  })
  it('todo al día → 0', () => {
    expect(codigoDeSalida(true, reporte())).toBe(0)
  })
  it('un contrato que no se pudo poner al día → 1, aunque además haya ofertas por republicar', () => {
    const r = reporte({
      contracts: contratos({ skippedContracts: [{ contractId: 'k1', reason: 'x' }] }),
      staleCampaigns: [{ id: 'c1', code: 'L_PLAN_PRO' }],
    })
    expect(codigoDeSalida(true, r)).toBe(1)
  })
  it('ofertas de plan por republicar → 2', () => {
    expect(codigoDeSalida(true, reporte({ staleCampaigns: [{ id: 'c1', code: 'L_PLAN_PRO' }] }))).toBe(2)
  })
  it('compras de plan en curso → 2', () => {
    expect(codigoDeSalida(true, reporte({ contracts: contratos({ inFlightPurchases: [{ status: 'PENDING', purchases: 2 }] }) }))).toBe(2)
  })
  it('🔴 una fila apagada que se dejó así NO es un fallo: no cambia el código', () => {
    expect(codigoDeSalida(true, reporte({ feature: 'INACTIVE' }))).toBe(0)
  })
})

describe('🔴 DEVICE_MENUS no se vende suelta: el script no sabe de precios de lista ni de Stripe', () => {
  it('no importa ni nombra el camino de los precios de lista', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../scripts/seed-device-menus-feature.ts'), 'utf8')
    expect(fuente).not.toMatch(/hybridListPrice|saveListPrice|retryListPrice|listPriceBoard|planSeedOutcome|stripeProductId|stripePriceId/)
  })
})
