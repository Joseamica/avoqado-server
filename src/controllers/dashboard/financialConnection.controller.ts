import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import * as svc from '@/services/financial-connections/financialConnection.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

export async function listProviders(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await prisma.financialProvider.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
    res.json({ success: true, data })
  } catch (e) { next(e) }
}
export async function listConnections(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await svc.listConnectionsForVenue(req.params.venueId) }) } catch (e) { next(e) }
}
export async function createConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, email, password } = req.body ?? {}
    if (!providerId || !email || !password) throw new BadRequestError('providerId, email y password son requeridos.')
    const staffId = (req as any).authContext?.userId
    const r = await svc.startConnection({ venueId: req.params.venueId, providerId, email, password, staffId })
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
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
  const bySlot = { OR: [{ primaryAccountId: merchantAccountId }, { secondaryAccountId: merchantAccountId }, { tertiaryAccountId: merchantAccountId }] }
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
  } catch (e) { next(e) }
}
export async function validateTwoFactorAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.body ?? {}
    if (!code) throw new BadRequestError('code es requerido.')
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    const staffId = (req as any).authContext?.userId
    res.json({ success: true, data: await svc.validateTwoFactorAuth(req.params.id, String(code), staffId) })
  } catch (e) { next(e) }
}
export async function selectAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { externalId, merchantAccountId } = req.body ?? {}
    if (!externalId) throw new BadRequestError('externalId es requerido.')
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    if (merchantAccountId) await assertMerchantAccountBelongsToVenue(String(merchantAccountId), req.params.venueId)
    const staffId = (req as any).authContext?.userId
    res.json({ success: true, data: await svc.selectAccount(req.params.id, String(externalId), merchantAccountId, staffId) })
  } catch (e) { next(e) }
}
export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    res.json({ success: true, data: await svc.getBalanceForConnectionAccount(req.params.id) })
  } catch (e) { next(e) }
}
export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    await assertConnectionBelongsToVenue(req.params.id, req.params.venueId)
    await svc.disconnect(req.params.id, (req as any).authContext?.userId)
    res.json({ success: true })
  } catch (e) { next(e) }
}
