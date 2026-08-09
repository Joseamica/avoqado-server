import { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import * as productService from '@/services/dashboard/product.dashboard.service'
import * as dashboardProductController from '@/controllers/dashboard/product.dashboard.controller'
import * as mobileProductController from '@/controllers/mobile/product.mobile.controller'
import { toLegacyProductPayload, toLegacyVenuePayload } from '@/utils/legacyProductPayload'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))

const venueId = '<venue-id>'
const productId = '<product-id>'
const categoryId = '<category-id>'
const internalProduct = {
  id: productId,
  venueId,
  categoryId,
  name: 'Producto interno',
  createdById: '<internal-actor-id>',
  trackInventory: false,
  arbitraryLegacyField: { retained: true },
}

function makeResponse(): Response {
  const response = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(response.status as jest.Mock).mockReturnValue(response)
  return response
}

function responseBody(response: Response): any {
  return (response.json as jest.Mock).mock.calls[0][0]
}

function expectSanitizedProduct(product: any): void {
  expect(product).not.toHaveProperty('createdById')
  expect(product).toHaveProperty('arbitraryLegacyField', { retained: true })
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.restoreAllMocks())

describe('H1A internal-field legacy boundaries', () => {
  it('removes only the internal scalar without mutating Product or Venue inputs', () => {
    const productInput = { id: productId, createdById: '<actor>', arbitrary: { nested: true } }
    const venueInput = { id: venueId, catalogGovernanceEnforcedAt: '<fence>', arbitrary: { nested: true } }

    const productOutput = toLegacyProductPayload(productInput)
    const venueOutput = toLegacyVenuePayload(venueInput)

    // Copy-and-delete keeps mocks/alternate clients byte-compatible without
    // erasing provenance from the object that an internal writer still owns.
    expect(productOutput).toEqual({ id: productId, arbitrary: { nested: true } })
    expect(venueOutput).toEqual({ id: venueId, arbitrary: { nested: true } })
    expect(productInput).toHaveProperty('createdById', '<actor>')
    expect(venueInput).toHaveProperty('catalogGovernanceEnforcedAt', '<fence>')
    expect(productOutput).not.toBe(productInput)
    expect(venueOutput).not.toBe(venueInput)
  })

  it('sanitizes every direct dashboard Product response boundary', async () => {
    jest.spyOn(productService, 'getProducts').mockResolvedValue([internalProduct] as never)
    jest.spyOn(productService, 'getProduct').mockResolvedValue(internalProduct as never)
    jest.spyOn(productService, 'createProduct').mockResolvedValue(internalProduct as never)
    jest.spyOn(productService, 'updateProduct').mockResolvedValue(internalProduct as never)
    const next = jest.fn() as NextFunction

    const calls: Array<[Response, () => Promise<void>, (body: any) => any]> = [
      [
        makeResponse(),
        async function () {
          await dashboardProductController.getProductsHandler({ params: { venueId }, query: {} } as unknown as Request, calls[0][0], next)
        },
        body => body.data[0],
      ],
      [
        makeResponse(),
        async function () {
          await dashboardProductController.getProductHandler({ params: { venueId, productId } } as unknown as Request, calls[1][0], next)
        },
        body => body.data,
      ],
      [
        makeResponse(),
        async function () {
          await dashboardProductController.createProductHandler(
            { params: { venueId }, body: { name: internalProduct.name } } as unknown as Request,
            calls[2][0],
            next,
          )
        },
        body => body.data,
      ],
      [
        makeResponse(),
        async function () {
          await dashboardProductController.updateProductHandler(
            { params: { venueId, productId }, body: { name: internalProduct.name } } as unknown as Request,
            calls[3][0],
            next,
          )
        },
        body => body.data,
      ],
      [
        makeResponse(),
        async function () {
          await dashboardProductController.deleteProductImageHandler(
            { params: { venueId, productId } } as unknown as Request,
            calls[4][0],
            next,
          )
        },
        body => body.data,
      ],
    ]

    for (const [response, invoke, extractProduct] of calls) {
      await invoke()
      expectSanitizedProduct(extractProduct(responseBody(response)))
    }
    expect(next).not.toHaveBeenCalled()
  })

  it('sanitizes mobile Product list/create/update before availability fields are added', async () => {
    prismaMock.product.findMany.mockResolvedValue([internalProduct] as never)
    prismaMock.product.create.mockResolvedValue(internalProduct as never)
    prismaMock.product.findFirst.mockResolvedValue({ id: productId } as never)
    prismaMock.product.update.mockResolvedValue(internalProduct as never)
    const next = jest.fn() as NextFunction

    const listResponse = makeResponse()
    await mobileProductController.listProducts({ params: { venueId } } as unknown as Request, listResponse, next)
    expectSanitizedProduct(responseBody(listResponse).data[0])

    const createResponse = makeResponse()
    await mobileProductController.createProduct(
      { params: { venueId }, body: { name: internalProduct.name, categoryId } } as unknown as Request,
      createResponse,
      next,
    )
    expectSanitizedProduct(responseBody(createResponse).data)

    const updateResponse = makeResponse()
    await mobileProductController.updateProduct(
      { params: { venueId, productId }, body: { name: internalProduct.name } } as unknown as Request,
      updateResponse,
      next,
    )
    expectSanitizedProduct(responseBody(updateResponse).data)
    expect(next).not.toHaveBeenCalled()
  })
})
