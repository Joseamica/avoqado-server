/**
 * "Lo que se pone se puede quitar" — simetría poner/quitar sobre un cheque bajo /tpv.
 *
 * CASO MEDIDO (auditoría de permisos de piso, 2026-08-18). Al darle al cajero
 * `tables:pay-any` para cobrar la mesa de otro, quedó a la vista una asimetría que ya
 * existía en el par de CARGOS POR SERVICIO:
 *
 *   POST   …/orders/:orderId/service-charges       orders:update  SIN checkTableOwnership
 *   DELETE …/orders/:orderId/service-charges/:id   orders:update  CON checkTableOwnership
 *
 * El cajero PONE el cargo en una mesa ajena y después recibe 403 al intentar QUITARLO.
 * Un estado del que el usuario no puede salir, y la UI le miente: le ofrece el botón de
 * deshacer porque el permiso (`orders:update`) sí lo tiene — lo que lo frena es un guard
 * que el POST no aplicó.
 *
 * 🔑 POR QUÉ SE QUITA DEL DELETE Y NO SE PONE EN EL POST. Que el cajero pueda aplicar
 * cargos y descuentos sobre una mesa ajena es una decisión TOMADA y respaldada por el
 * mercado: ninguno de los tres referentes ata el descuento/cargo a de quién es la mesa
 * (Square lo gobierna con "Apply Restricted Discounts and Comps", Toast con `3.1
 * Discounts` + código de gerente, Fudo con `Crear descuentos`). La propiedad de mesa,
 * donde existe, controla qué VES, no qué puedes hacer. Con el POST abierto por decisión,
 * el candado del DELETE no protege nada: sólo deja basura que nadie puede limpiar.
 *
 * Este archivo fija la SIMETRÍA como invariante, no el estado suelto de cada ruta: si
 * mañana alguien cierra el POST, el test exige cerrar el DELETE también (y al revés).
 * La ablación de abajo es la que impide que esto se lea como "quitamos candados".
 */

import type { NextFunction, Request, Response } from 'express'
import { StaffRole } from '@prisma/client'
import tpvRouter from '@/routes/tpv.routes'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueSettings: { findUnique: jest.fn() },
    order: { findFirst: jest.fn(), findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue-1'
const CAJERO = 'staff-cajero'
const MESERO = 'staff-mesero'

const POST_CARGO = '/venues/:venueId/orders/:orderId/service-charges'
const DELETE_CARGO = '/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId'
const POST_CANCEL = '/venues/:venueId/orders/:orderId/cancel'
const PATCH_ITEMS = '/venues/:venueId/orders/:orderId/items'

/**
 * ¿Esta ruta monta `checkTableOwnership`? Devuelve la lista de override con la que se
 * montó, o `undefined` si NO lleva el guard. La marca `ownershipOverridePermissions` la
 * expone la propia factory para poder auditar el cableado sin ejecutarlo.
 */
function ownershipLayerOf(router: any, method: string, path: string): { handle: any; overrides?: string[] } | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const found = routeLayers.find(rl => Array.isArray((rl.handle as any)?.ownershipOverridePermissions))
    if (!found) return undefined
    return { handle: found.handle, overrides: (found.handle as any).ownershipOverridePermissions }
  }
  return undefined
}

type Veredicto = { paso: true } | { paso: false; status: number; code?: string }

/**
 * Corre DE VERDAD el guard de propiedad que monte la ruta (si monta alguno) con un
 * cajero pegándole a una mesa de otro mesero, y devuelve el veredicto observable.
 * Sin guard montado → pasa. Esto es comportamiento, no cableado: si alguien reemplaza
 * el middleware por otro equivalente, el test lo sigue midiendo igual.
 */
async function correrGuardDePropiedad(method: string, path: string, role: StaffRole = StaffRole.CASHIER): Promise<Veredicto> {
  const capa = ownershipLayerOf(tpvRouter, method, path)
  if (!capa) return { paso: true }

  const req = {
    params: { venueId: VENUE, orderId: 'order-1', tableId: 'mesa-5' },
    authContext: { userId: CAJERO, venueId: VENUE, role },
  } as unknown as Request

  let status = 0
  let body: any
  const res = {
    status(code: number) {
      status = code
      return this
    },
    json(payload: any) {
      body = payload
      return this
    },
  } as unknown as Response

  let llamoNext = false
  const next: NextFunction = () => {
    llamoNext = true
  }

  await capa.handle(req, res, next)
  return llamoNext ? { paso: true } : { paso: false, status, code: body?.code }
}

beforeEach(() => {
  jest.clearAllMocks()
  // Switch de propiedad de mesa ENCENDIDO (PRO, opt-in) — si estuviera apagado el
  // middleware es un no-op y el test no probaría nada.
  ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ enforceTableOwnership: true })
  // La mesa es de OTRO mesero.
  ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
    tableId: 'mesa-5',
    servedById: MESERO,
    servedBy: { firstName: 'Juan', lastName: 'Pérez' },
  })
  ;(prisma.order.findMany as jest.Mock).mockResolvedValue([{ servedById: MESERO, servedBy: { firstName: 'Juan', lastName: 'Pérez' } }])
  // No es SUPERADMIN y el venue no tiene permisos personalizados.
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
})

describe('Cargos por servicio: el cajero quita el cargo que él mismo puso en una mesa ajena', () => {
  it('PONE el cargo en la mesa ajena (estado previo, ya decidido: no se toca)', async () => {
    await expect(correrGuardDePropiedad('post', POST_CARGO)).resolves.toEqual({ paso: true })
  })

  it('🔴 y lo QUITA — este es el arreglo: antes devolvía 403 TABLE_OWNED_BY_OTHER', async () => {
    await expect(correrGuardDePropiedad('delete', DELETE_CARGO)).resolves.toEqual({ paso: true })
  })

  it('🔴 la SIMETRÍA es el invariante: poner y quitar montan el MISMO guard de propiedad', () => {
    const poner = ownershipLayerOf(tpvRouter, 'post', POST_CARGO)
    const quitar = ownershipLayerOf(tpvRouter, 'delete', DELETE_CARGO)
    expect(quitar?.overrides).toEqual(poner?.overrides)
  })

  it('ningún rol del piso queda atrapado: WAITER y CASHIER pueden deshacer igual', async () => {
    for (const role of [StaffRole.CASHIER, StaffRole.WAITER]) {
      await expect(correrGuardDePropiedad('delete', DELETE_CARGO, role)).resolves.toEqual({ paso: true })
    }
  })
})

/**
 * ABLACIÓN — sin esto, "quitamos un candado" no se distingue de "abrimos la mesa ajena".
 * Estas rutas SIGUEN cerradas para el cajero con la misma mesa ajena y el mismo switch.
 */
describe('Ablación: el cajero sigue SIN poder editar el resto de la mesa ajena', () => {
  const CERRADAS: Array<[string, string, string]> = [
    ['post', POST_CANCEL, 'cancelar la cuenta'],
    ['patch', PATCH_ITEMS, 'agregar/editar líneas'],
  ]

  it.each(CERRADAS)('🔴 %s %s (%s) → 403 TABLE_OWNED_BY_OTHER', async (method, path) => {
    await expect(correrGuardDePropiedad(method, path)).resolves.toEqual({
      paso: false,
      status: 403,
      code: 'TABLE_OWNED_BY_OTHER',
    })
  })

  it('esas rutas conservan el override DEFAULT (no ganan el de cobro)', () => {
    for (const [method, path] of CERRADAS) {
      expect(ownershipLayerOf(tpvRouter, method, path)?.overrides).toEqual(['tables:manage-all'])
    }
  })

  it('MANAGER sí pasa en las cerradas — el candado sigue vivo y sigue teniendo su llave', async () => {
    for (const [method, path] of CERRADAS) {
      await expect(correrGuardDePropiedad(method, path, StaffRole.MANAGER)).resolves.toEqual({ paso: true })
    }
  })

  /**
   * CONTEO REAL: cuántas rutas de /tpv montan el guard de propiedad. Antes del arreglo
   * eran 3 (cancel, PATCH items, DELETE service-charges); después son 2. Si alguien
   * "arregla" otra asimetría quitando candados en bloque, este número lo delata.
   */
  it('exactamente 2 rutas de /tpv montan checkTableOwnership', () => {
    const conGuard: string[] = []
    for (const layer of (tpvRouter as any).stack ?? []) {
      if (!layer.route) continue
      const metodos = new Set<string>((layer.route.stack ?? []).map((rl: any) => rl.method))
      for (const method of metodos) {
        if (ownershipLayerOf(tpvRouter, method, layer.route.path)) conGuard.push(`${method.toUpperCase()} ${layer.route.path}`)
      }
    }
    expect(conGuard.sort()).toEqual(['PATCH /venues/:venueId/orders/:orderId/items', 'POST /venues/:venueId/orders/:orderId/cancel'])
  })
})
