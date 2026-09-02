import { randomUUID } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { Prisma, StaffRole } from '@prisma/client'

import AppError from '@/errors/AppError'
import fullApp from '@/app'
import superadminRoutes from '@/routes/superadmin.routes'
import prisma from '@/utils/prismaClient'
import { buildValidCommercialDraft } from '../../__helpers__/commercialDraft'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { getUserAccess } from '@/services/access/access.service'

const basePath = '/api/v1/superadmin/commercial'

function api() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/superadmin', superadminRoutes)
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details })
    }
    return res.status(500).json({ message: error.message })
  })
  return app
}

function bearer(input: { staffId: string; organizationId: string; venueId: string; role: StaffRole }): string {
  return jwt.sign(
    { sub: input.staffId, orgId: input.organizationId, venueId: input.venueId, role: input.role },
    process.env.ACCESS_TOKEN_SECRET!,
    { algorithm: 'HS256', expiresIn: '15m' },
  )
}

function draftInput() {
  const draft = buildValidCommercialDraft()
  return {
    name: draft.name,
    description: draft.description,
    products: draft.products,
    pricebooks: draft.pricebooks,
    prices: draft.prices,
    bundles: draft.bundles,
    bundleItems: draft.bundleItems,
    featureBindings: draft.featureBindings,
  }
}

describe('Commercial Superadmin API — real auth, permissions and PostgreSQL workflow', () => {
  const suffix = randomUUID()
  let organizationId: string
  let venueId: string
  let superadminId: string
  let inactiveSuperadminId: string
  let disabledSuperadminId: string
  let managerId: string
  let disabledOwnerId: string
  let superadminToken: string
  let inactiveSuperadminToken: string
  let disabledSuperadminToken: string
  let managerToken: string

  afterEach(() => {
    jest.restoreAllMocks()
  })

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Commercial API ${suffix}`,
        email: `commercial-api-${suffix}@example.test`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Commercial API ${suffix}`,
        slug: `commercial-api-${suffix}`,
      },
    })
    venueId = venue.id

    const [superadmin, inactiveSuperadmin, disabledSuperadmin, manager, disabledOwner] = await Promise.all([
      prisma.staff.create({
        data: {
          email: `commercial-api-root-${suffix}@example.test`,
          firstName: 'Commercial',
          lastName: 'Root',
        },
      }),
      prisma.staff.create({
        data: {
          email: `commercial-api-inactive-root-${suffix}@example.test`,
          firstName: 'Commercial',
          lastName: 'Inactive Root',
        },
      }),
      prisma.staff.create({
        data: {
          email: `commercial-api-disabled-root-${suffix}@example.test`,
          firstName: 'Commercial',
          lastName: 'Disabled Root',
          active: false,
        },
      }),
      prisma.staff.create({
        data: {
          email: `commercial-api-manager-${suffix}@example.test`,
          firstName: 'Commercial',
          lastName: 'Manager',
        },
      }),
      prisma.staff.create({
        data: {
          email: `commercial-api-disabled-owner-${suffix}@example.test`,
          firstName: 'Commercial',
          lastName: 'Disabled Owner',
          active: false,
        },
      }),
    ])
    superadminId = superadmin.id
    inactiveSuperadminId = inactiveSuperadmin.id
    disabledSuperadminId = disabledSuperadmin.id
    managerId = manager.id
    disabledOwnerId = disabledOwner.id

    await prisma.staffVenue.createMany({
      data: [
        { staffId: superadminId, venueId, role: StaffRole.SUPERADMIN },
        { staffId: inactiveSuperadminId, venueId, role: StaffRole.SUPERADMIN, active: false },
        { staffId: disabledSuperadminId, venueId, role: StaffRole.SUPERADMIN, active: true },
        { staffId: managerId, venueId, role: StaffRole.MANAGER },
      ],
    })
    await prisma.staffOrganization.create({
      data: {
        staffId: disabledOwnerId,
        organizationId,
        role: 'OWNER',
        isActive: true,
        isPrimary: true,
      },
    })

    superadminToken = bearer({ staffId: superadminId, organizationId, venueId, role: StaffRole.SUPERADMIN })
    inactiveSuperadminToken = bearer({ staffId: inactiveSuperadminId, organizationId, venueId, role: StaffRole.SUPERADMIN })
    disabledSuperadminToken = bearer({ staffId: disabledSuperadminId, organizationId, venueId, role: StaffRole.SUPERADMIN })
    managerToken = bearer({ staffId: managerId, organizationId, venueId, role: StaffRole.MANAGER })
  })

  it('enforces the production parent authentication and SUPERADMIN role before commercial handlers', async () => {
    await request(api()).get(`${basePath}/drafts`).expect(401)

    const denied = await request(api()).get(`${basePath}/drafts`).set('Authorization', `Bearer ${managerToken}`).expect(403)
    expect(denied.body.message).toContain('SUPERADMIN')
  })

  it('uses active database authority instead of trusting a stale or forged SUPERADMIN claim', async () => {
    const inactive = await request(api()).get(`${basePath}/drafts`).set('Authorization', `Bearer ${inactiveSuperadminToken}`).expect(403)
    expect(inactive.body.message).toContain('SUPERADMIN')

    const forgedClaim = bearer({ staffId: managerId, organizationId, venueId, role: StaffRole.SUPERADMIN })
    const forged = await request(api()).get(`${basePath}/drafts`).set('Authorization', `Bearer ${forgedClaim}`).expect(403)
    expect(forged.body.message).toContain('SUPERADMIN')
  })

  it('revokes an existing SUPERADMIN session when the Staff account is disabled, including early app-update routes', async () => {
    const parent = await request(api()).get(`${basePath}/drafts`).set('Authorization', `Bearer ${disabledSuperadminToken}`).expect(403)
    expect(parent.body.message).toContain('SUPERADMIN')

    const earlyMount = await request(fullApp)
      .get('/api/v1/superadmin/app-updates')
      .set('Authorization', `Bearer ${disabledSuperadminToken}`)
    expect({ status: earlyMount.status, body: earlyMount.body, text: earlyMount.text }).toMatchObject({
      status: 403,
      body: { message: expect.stringContaining('SUPERADMIN') },
    })
  })

  it('does not revive a disabled Staff account through an active organization OWNER membership', async () => {
    await expect(
      resolveUserRoleForVenue({ userId: disabledOwnerId, targetVenueId: venueId, tokenVenueId: venueId, tokenRole: StaffRole.OWNER }),
    ).resolves.toMatchObject({ role: null, source: 'none' })

    await expect(getUserAccess(disabledOwnerId, venueId)).rejects.toThrow('no access')
  })

  it('validates both v2 money boundaries through the endpoint without leaking a v1 snapshot, then previews and publishes the v2 maximum', async () => {
    let maximumDraftId = ''

    for (const amount of ['21474836.48', '9999999999.99']) {
      const draft = draftInput()
      draft.prices.find(price => price.code === 'POS_MONTHLY')!.amount = amount
      const created = await request(api())
        .post(`${basePath}/drafts`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send({ draft, reason: `Crear borrador con importe v2 ${amount}` })
        .expect(201)
      const draftId = created.body.data.id as string

      const validation = await request(api())
        .post(`${basePath}/drafts/${draftId}/validate`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .expect(200)

      expect(validation.body.data.valid).toBe(true)
      expect(validation.body.data).not.toHaveProperty('normalizedSnapshot')
      if (amount === '9999999999.99') maximumDraftId = draftId
    }

    const preview = await request(api())
      .post(`${basePath}/drafts/${maximumDraftId}/preview`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ expectedRevision: 1 })
      .expect(200)
    expect(preview.body.data.snapshot).toMatchObject({ schemaVersion: 2, contractVersion: '2.0.0' })
    expect(preview.body.data.snapshot.products.find((product: { code: string }) => product.code === 'POS').prices[0].amount).toBe(
      '9999999999.99',
    )

    const published = await request(api())
      .post(`${basePath}/drafts/${maximumDraftId}/publish`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({
        expectedRevision: 1,
        previewToken: preview.body.data.previewToken,
        checksum: preview.body.data.checksum,
        reason: 'Publicar importe máximo exacto del contrato v2',
        confirm: true,
      })
      .expect(201)

    expect(published.body.data.schemaVersion).toBe(2)
    expect(published.body.data.snapshot.products.find((product: { code: string }) => product.code === 'POS').prices[0].amount).toBe(
      '9999999999.99',
    )
  })

  it('uses one publishability authority for an active priced product without a capability', async () => {
    const draft = draftInput()
    draft.featureBindings = draft.featureBindings.filter(binding => binding.productCode !== 'POS')
    const created = await request(api())
      .post(`${basePath}/drafts`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ draft, reason: 'Probar producto activo sin capacidad' })
      .expect(201)
    const draftId = created.body.data.id as string

    const validation = await request(api())
      .post(`${basePath}/drafts/${draftId}/validate`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .expect(200)
    expect(validation.body.data.valid).toBe(false)
    expect(validation.body.data.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PRICED_PRODUCT_WITHOUT_CAPABILITY' })]),
    )

    const preview = await request(api())
      .post(`${basePath}/drafts/${draftId}/preview`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ expectedRevision: 1 })
      .expect(409)
    expect(preview.body).toMatchObject({
      code: 'COMMERCIAL_DRAFT_INVALID',
      details: { errors: expect.arrayContaining([expect.objectContaining({ code: 'PRICED_PRODUCT_WITHOUT_CAPABILITY' })]) },
    })
  })

  it('uses one publishability authority for a priced bundle whose items resolve no capabilities', async () => {
    const draft = draftInput()
    draft.featureBindings = draft.featureBindings.filter(binding => binding.productCode !== 'POS')
    draft.prices = draft.prices.filter(price => price.code !== 'POS_MONTHLY')
    draft.bundles = [
      {
        code: 'POS_PACK',
        slug: 'paquete-pos',
        name: 'Paquete POS',
        description: 'Paquete sin capacidades para probar publicación.',
        active: true,
        sortOrder: 10,
      },
    ]
    draft.bundleItems = [{ bundleCode: 'POS_PACK', productCode: 'POS', quantity: 1, sortOrder: 10 }]
    draft.prices.push({
      code: 'POS_PACK_MONTHLY',
      pricebookCode: 'MX_STANDARD',
      bundleCode: 'POS_PACK',
      billingUnit: 'VENUE_MONTH',
      amount: '399.00',
      taxBehavior: 'EXCLUSIVE',
      active: true,
    })
    const created = await request(api())
      .post(`${basePath}/drafts`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ draft, reason: 'Probar paquete activo sin capacidades' })
      .expect(201)
    const draftId = created.body.data.id as string

    const validation = await request(api())
      .post(`${basePath}/drafts/${draftId}/validate`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .expect(200)
    expect(validation.body.data.valid).toBe(false)
    expect(validation.body.data.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PRICED_BUNDLE_WITHOUT_CAPABILITY' })]),
    )

    const preview = await request(api())
      .post(`${basePath}/drafts/${draftId}/preview`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ expectedRevision: 1 })
      .expect(409)
    expect(preview.body).toMatchObject({
      code: 'COMMERCIAL_DRAFT_INVALID',
      details: { errors: expect.arrayContaining([expect.objectContaining({ code: 'PRICED_BUNDLE_WITHOUT_CAPABILITY' })]) },
    })
  })

  it('creates, conditionally edits, previews, publishes and activates through real adapters', async () => {
    const initialDraft = draftInput()
    const created = await request(api())
      .post(`${basePath}/drafts`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ draft: initialDraft, reason: 'Crear borrador desde la API integrada' })
      .expect(201)

    const draftId = created.body.data.id as string
    const firstEtag = created.headers.etag as string
    expect(firstEtag).toMatch(new RegExp(`^W/"commercial-draft:${draftId}:1"$`))
    expect(created.body.data.revision).toBe(1)

    const changedDraft = { ...initialDraft, description: 'Catálogo editado por la API real.' }
    const updated = await request(api())
      .put(`${basePath}/drafts/${draftId}`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .set('If-Match', firstEtag)
      .send({ draft: changedDraft, reason: 'Confirmar concurrencia optimista desde API' })
      .expect(200)

    expect(updated.body.data.revision).toBe(2)
    expect(updated.headers.etag).toBe(`W/"commercial-draft:${draftId}:2"`)

    const stale = await request(api())
      .put(`${basePath}/drafts/${draftId}`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .set('If-Match', firstEtag)
      .send({ draft: changedDraft, reason: 'Intento con revisión anterior' })
      .expect(409)
    expect(stale.body.code).toBe('COMMERCIAL_DRAFT_CONFLICT')

    const validation = await request(api())
      .post(`${basePath}/drafts/${draftId}/validate`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .expect(200)
    expect(validation.body.data.valid).toBe(true)

    const preview = await request(api())
      .post(`${basePath}/drafts/${draftId}/preview`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({ expectedRevision: 2 })
      .expect(200)
    expect(preview.body.data).toEqual(
      expect.objectContaining({
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        previewToken: expect.any(String),
      }),
    )

    const outboxCreateInputs: Prisma.CommercialPublicationOutboxCreateArgs[] = []
    const originalTransaction = prisma.$transaction.bind(prisma) as unknown as (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => Promise<unknown>
    jest.spyOn(prisma, '$transaction').mockImplementation((async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      originalTransaction(async tx => {
        const outboxDelegate = new Proxy(tx.commercialPublicationOutbox, {
          get(target, property) {
            if (property !== 'create') return Reflect.get(target, property, target)
            return (input: Prisma.CommercialPublicationOutboxCreateArgs) => {
              outboxCreateInputs.push(input)
              return target.create(input)
            }
          },
        })
        const observedTx = new Proxy(tx, {
          get(target, property) {
            return property === 'commercialPublicationOutbox' ? outboxDelegate : Reflect.get(target, property, target)
          },
        }) as Prisma.TransactionClient
        return operation(observedTx)
      })) as never)
    const published = await request(api())
      .post(`${basePath}/drafts/${draftId}/publish`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({
        expectedRevision: 2,
        previewToken: preview.body.data.previewToken,
        checksum: preview.body.data.checksum,
        reason: 'Publicar catálogo desde la API integrada',
        confirm: true,
      })
      .expect(201)

    expect(published.body.data.schemaVersion).toBe(2)
    expect(outboxCreateInputs).toHaveLength(1)
    expect(outboxCreateInputs[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ payloadVersion: 1 }) }))
    const publicationId = published.body.data.id as string
    const current = await prisma.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } })
    const expectedActivationRevision = current?.revision ?? 0

    const activated = await request(api())
      .post(`${basePath}/publications/${publicationId}/activate`)
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({
        expectedActivationRevision,
        reason: 'Activar catálogo desde la API integrada',
        confirm: true,
      })
      .expect(200)

    expect(activated.body).toEqual({
      success: true,
      data: {
        publicationId,
        previousPublicationId: current?.publicationId ?? null,
        revision: expectedActivationRevision + 1,
      },
    })

    const [storedActivation, draftAuditCount, publicationAuditCount, activationAuditCount, publicationOutboxCount, activationOutboxCount] =
      await Promise.all([
        prisma.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } }),
        prisma.activityLog.count({ where: { entity: 'CommercialDraft', entityId: draftId, staffId: superadminId } }),
        prisma.activityLog.count({ where: { entity: 'CommercialPublication', entityId: publicationId, staffId: superadminId } }),
        prisma.activityLog.count({ where: { entity: 'CommercialPublicationActivation', entityId: 'PRODUCTION', staffId: superadminId } }),
        prisma.commercialPublicationOutbox.count({ where: { publicationId, eventType: 'PUBLICATION_CREATED' } }),
        prisma.commercialPublicationOutbox.count({ where: { publicationId, eventType: 'PUBLICATION_ACTIVATED' } }),
      ])

    expect(storedActivation).toMatchObject({ publicationId, revision: expectedActivationRevision + 1 })
    expect(draftAuditCount).toBeGreaterThanOrEqual(2)
    expect(publicationAuditCount).toBe(1)
    expect(activationAuditCount).toBe(1)
    expect(publicationOutboxCount).toBe(1)
    expect(activationOutboxCount).toBe(1)
  })
})
