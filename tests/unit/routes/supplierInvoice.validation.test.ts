import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))
jest.mock('@/services/dashboard/supplierInvoiceInbox.service', () => ({
  getSupplierInvoiceInbox: jest.fn(),
  getInvoiceInventoryCatalog: jest.fn(),
}))
jest.mock('@/services/dashboard/supplierInvoiceInventory.service', () => ({
  confirmSupplierInvoiceInventory: jest.fn(),
  previewSupplierInvoiceInventory: jest.fn(),
}))
import router from '@/routes/dashboard/inventory.routes'
import { getSupplierInvoiceInbox } from '@/services/dashboard/supplierInvoiceInbox.service'
import { confirmSupplierInvoiceInventory } from '@/services/dashboard/supplierInvoiceInventory.service'

const app = express()
app.use(express.json())
app.use((req: Request, _res: Response, next: NextFunction) => {
  ;(req as any).authContext = { userId: 'staff', venueId: 'venue' }
  next()
})
app.use('/inventory', router)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message })
})

beforeEach(() => jest.clearAllMocks())

it.each([
  ['get', '/supplier-invoices/inbox?page=-1', undefined],
  ['get', '/supplier-invoices/catalog?kind=INJECT', undefined],
  ['post', '/supplier-invoices/invoice/inventory', { confirmationToken: 'junk' }],
  ['post', '/purchase-invoices/invoice/lines/line/identify', { purchaseUnit: 'INVALID' }],
] as const)('invalid %s %s returns 400 before the service runs', async (method, path, body) => {
  const response = await request(app)[method](`/inventory${path}`).send(body)
  expect(response.status).toBe(400)
  expect(confirmSupplierInvoiceInventory).not.toHaveBeenCalled()
})

it('valid paging still applies defaults and the server cap', async () => {
  jest.mocked(getSupplierInvoiceInbox).mockResolvedValue({ items: [], total: 0 } as any)
  expect((await request(app).get('/inventory/supplier-invoices/inbox?limit=999999')).status).toBe(200)
  expect(getSupplierInvoiceInbox).toHaveBeenCalledWith(undefined, 1, 100, undefined)
})
