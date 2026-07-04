import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import * as svc from '@/services/financial-connections/financialConnection.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

export async function listProviders(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await prisma.financialProvider.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
    res.json({ success: true, data })
  } catch (e) {
    next(e)
  }
}
export async function listConnections(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await svc.listConnectionsForVenue(req.params.venueId) })
  } catch (e) {
    next(e)
  }
}
export async function createConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, email, password, accountKind } = req.body ?? {}
    if (!providerId || !email || !password) throw new BadRequestError('providerId, email y password son requeridos.')
    // Validación en el boundary (C5): ausente → MERCHANT (retrocompatible); basura → 400 visible
    // donde ocurrió, jamás una conexión del tipo equivocado que falla críptica 3 pasos después.
    if (accountKind != null && accountKind !== 'MERCHANT' && accountKind !== 'CLIENT') {
      throw new BadRequestError('accountKind debe ser MERCHANT o CLIENT.')
    }
    const kind = accountKind ?? 'MERCHANT'
    const staffId = (req as any).authContext?.userId
    const r = await svc.startConnection({ venueId: req.params.venueId, providerId, email, password, staffId, accountKind: kind })
    res.status(201).json({ success: true, data: r })
  } catch (e) {
    next(e)
  }
}

// Defense-in-depth: :venueId (del path, ya autorizado por checkPermission) debe coincidir
// con la sucursal REAL dueña de la conexión/cuenta :id — si no, 404 (no 403: no confirmamos
// existencia del recurso a quien no tiene acceso). Sin esto, un OWNER de otra sucursal podría
// operar sobre una conexión ajena con solo adivinar el id.
async function assertConnectionBelongsToVenue(connectionId: string, venueId: string): Promise<void> {
  const conn = await prisma.financialConnection.findUnique({ where: { id: connectionId }, select: { venueId: true } })
  if (!conn || conn.venueId !== venueId) throw new NotFoundError('Conexión no encontrada.')
}
async function assertAccountBelongsToVenue(financialAccountId: string, venueId: string): Promise<void> {
  const acc = await prisma.financialAccount.findUnique({
    where: { id: financialAccountId },
    select: { connection: { select: { venueId: true } } },
  })
  if (!acc || acc.connection.venueId !== venueId) throw new NotFoundError('Cuenta no encontrada.')
}
// MerchantAccount no tiene FK a venue: su pertenencia se resuelve por dónde está
// cableada — los slots de VenuePaymentConfig, los assignedMerchantIds de las
// terminales de la sucursal, o el config a nivel organización de esa sucursal.
// Sin este guard, cualquier OWNER podría re-apuntar el merchant de OTRO tenant
// a su propia cuenta bancaria con solo conocer el cuid.
async function assertMerchantAccountBelongsToVenue(merchantAccountId: string, venueId: string): Promise<void> {
  const bySlot = {
    OR: [{ primaryAccountId: merchantAccountId }, { secondaryAccountId: merchantAccountId }, { tertiaryAccountId: merchantAccountId }],
  }
  const [venueCfg, terminal, orgCfg] = await Promise.all([
    prisma.venuePaymentConfig.findFirst({ where: { venueId, ...bySlot }, select: { id: true } }),
    prisma.terminal.findFirst({ where: { venueId, assignedMerchantIds: { has: merchantAccountId } }, select: { id: true } }),
    prisma.organizationPaymentConfig.findFirst({
      where: { organization: { venues: { some: { id: venueId } } }, ...bySlot },
      select: { id: true },
    }),
  ])
  if (!venueCfg && !terminal && !orgCfg) throw new NotFoundError('Cuenta de cobro no encontrada.')
}

export async function validateDevice(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.body ?? {}
    if (!code) throw new BadRequestError('code es requerido.')
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    const staffId = (req as any).authContext?.userId
    res.json({ success: true, data: await svc.validateDevice(req.params.id, String(code), staffId) })
  } catch (e) {
    next(e)
  }
}
export async function validateTwoFactorAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.body ?? {}
    if (!code) throw new BadRequestError('code es requerido.')
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    const staffId = (req as any).authContext?.userId
    res.json({ success: true, data: await svc.validateTwoFactorAuth(req.params.id, String(code), staffId) })
  } catch (e) {
    next(e)
  }
}
export async function selectAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { externalId, merchantAccountId } = req.body ?? {}
    if (!externalId) throw new BadRequestError('externalId es requerido.')
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    if (merchantAccountId) await assertMerchantAccountBelongsToVenue(String(merchantAccountId), req.params.venueId)
    const staffId = (req as any).authContext?.userId
    res.json({ success: true, data: await svc.selectAccount(req.params.id, String(externalId), merchantAccountId, staffId) })
  } catch (e) {
    next(e)
  }
}
export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    res.json({ success: true, data: await svc.getBalanceForConnectionAccount(req.params.id) })
  } catch (e) {
    next(e)
  }
}

const MAX_MOVEMENTS_PAGE_SIZE = 50

function parseIsoDateParam(v: unknown, name: string): string | undefined {
  if (v == null || v === '') return undefined
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`${name} debe ser fecha ISO válida.`)
  return d.toISOString()
}

export async function getMovements(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const page = Math.max(0, Number(req.query.page ?? 0) || 0)
    const size = Math.min(MAX_MOVEMENTS_PAGE_SIZE, Math.max(1, Number(req.query.size ?? 10) || 10))
    const from = parseIsoDateParam(req.query.from, 'from')
    const to = parseIsoDateParam(req.query.to, 'to')
    res.json({ success: true, data: await svc.getMovementsForAccount(req.params.id, { page, size, from, to }) })
  } catch (e) {
    next(e)
  }
}

export async function getMovementStats(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const from = parseIsoDateParam(req.query.from, 'from')
    const to = parseIsoDateParam(req.query.to, 'to')
    res.json({ success: true, data: await svc.getMovementStatsForAccount(req.params.id, { from, to }) })
  } catch (e) {
    next(e)
  }
}

// Read-only: resuelve un número de cuenta destino a su nombre de beneficiario, para MOSTRARLO en la
// confirmación del traspaso ANTES de mover dinero. Va con checkPermission + assertAccountBelongsToVenue.
export async function resolveDestination(req: Request, res: Response, next: NextFunction) {
  try {
    const account = req.query.account
    if (typeof account !== 'string' || !/^\d{4,6}$/.test(account.trim())) {
      throw new BadRequestError('account debe ser un número interno de 4 a 6 dígitos.')
    }
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const data = await svc.resolveTransferDestination(req.params.id, account.trim())
    if (!data) throw new NotFoundError('Cuenta destino no encontrada.')
    res.json({ success: true, data })
  } catch (e) {
    next(e)
  }
}

// MUEVE DINERO. Va con checkPermission + assertAccountBelongsToVenue + rate limit (en las rutas).
export async function internalTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const { destinationAccount, amount, concept } = req.body ?? {}
    if (!destinationAccount || typeof destinationAccount !== 'string') throw new BadRequestError('destinationAccount es requerido.')
    const monto = Number(amount)
    if (!Number.isFinite(monto) || monto <= 0) throw new BadRequestError('amount debe ser un número mayor a 0.')
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const staffId = (req as any).authContext?.userId
    const data = await svc.sendInternalTransfer(req.params.id, {
      destAccountNumber: String(destinationAccount),
      amount: monto,
      concept: typeof concept === 'string' ? concept : '',
      staffId,
    })
    // El proveedor puede responder 200 con success:false (traspaso rechazado) — lo reflejamos honesto.
    res.status(data.ok ? 200 : 422).json({ success: data.ok, data })
  } catch (e) {
    next(e)
  }
}
// Read-only: catálogo de bancos destino para SPEI externo (poblar el selector antes de enviar).
export async function getSpeiBanks(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    res.json({ success: true, data: await svc.getSpeiBanks(req.params.id) })
  } catch (e) {
    next(e)
  }
}

// MUEVE DINERO fuera del ecosistema del proveedor. checkPermission + assertAccountBelongsToVenue
// + rate limit (en las rutas) + dedup/auditoría (en el service). La idempotencyKey la genera el
// FRONTEND (una por intento de envío): así el retry automático de POST del cliente HTTP reenvía
// la MISMA key y la idempotencia del proveedor absorbe el duplicado — con una key por request,
// un retry de red sería un segundo cobro.
export async function sendSpeiOut(req: Request, res: Response, next: NextFunction) {
  try {
    const { destinationClabe, beneficiaryName, idBanco, amount, concept, idempotencyKey } = req.body ?? {}
    if (!destinationClabe || typeof destinationClabe !== 'string') throw new BadRequestError('destinationClabe es requerida.')
    if (!beneficiaryName || typeof beneficiaryName !== 'string') throw new BadRequestError('beneficiaryName es requerido.')
    if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new BadRequestError('idempotencyKey es requerida.')
    if (typeof idBanco !== 'number' || !Number.isInteger(idBanco) || idBanco <= 0) {
      throw new BadRequestError('idBanco debe ser un entero positivo del catálogo de bancos.')
    }
    const monto = Number(amount)
    if (!Number.isFinite(monto) || monto <= 0) throw new BadRequestError('amount debe ser un número mayor a 0.')
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const staffId = (req as any).authContext?.userId
    const data = await svc.sendSpeiOut(req.params.id, {
      destinationClabe: String(destinationClabe),
      beneficiaryName: String(beneficiaryName),
      idBanco,
      amount: monto,
      concept: typeof concept === 'string' ? concept : '',
      idempotencyKey: String(idempotencyKey),
      staffId,
    })
    // El proveedor puede responder 200 con success:false (envío rechazado) — lo reflejamos honesto.
    res.status(data.ok ? 200 : 422).json({ success: data.ok, data })
  } catch (e) {
    next(e)
  }
}

export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    await svc.disconnect(req.params.id, (req as any).authContext?.userId)
    res.json({ success: true })
  } catch (e) {
    next(e)
  }
}
