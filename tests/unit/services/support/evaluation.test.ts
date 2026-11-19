jest.mock('@/services/support/access.service', () => ({
  ...jest.requireActual('@/services/support/access.service'),
  resolveHelpAccess: jest.fn().mockResolvedValue(null),
}))
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { searchVerifiedHelp, type VerifiedSection, type HelpApp } from '@/services/support/knowledge.service'
import { selectSections, createSupportAiClient, composeSupportAnswer } from '@/services/support/answer.service'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
import type { HelpAccess } from '@/services/support/access.service'

const cases: {
  id: string
  app: HelpApp
  role: string
  whiteLabel: boolean
  plan: string
  scenario: string
  question: string
  expected: string
}[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../fixtures/support/evaluacion-respuestas.json'), 'utf8'))
it.each(cases)('$id ($role, WL=$whiteLabel, $plan): $expected', async item => {
  const guide: VerifiedSection = {
    id: `${item.app}/intro/guia-sintetica`,
    app: item.app,
    title: 'Guía sintética',
    summary: 'Resumen de prueba.',
    steps: ['Abre la ayuda pública.'],
    // T-F6 (H3): the steps only go out with the whole guide.
    whole: '*Pasos*\n\n1. Abre la ayuda pública.',
    publicUrl: `https://avoqado.io/help/${item.app}/intro/guia-sintetica`,
    keywords: [],
    requiredPermissions: ['help:read'],
  }
  if (item.scenario === 'wrong-app') guide.app = item.app === 'dashboard' ? 'android' : 'dashboard'
  if (['unknown-version', 'old-version'].includes(item.scenario)) guide.versionMin = '2.10.0'
  if (['device-missing', 'device-other'].includes(item.scenario)) guide.deviceFamily = 'PAX'
  const found = await searchVerifiedHelp(
    {
      topic: item.question,
      app: item.app,
      sectionId: guide.id,
      ...(item.scenario === 'old-version' ? { appVersion: '2.9.0' } : {}),
      ...(item.scenario === 'device-other' ? { deviceFamily: 'NEXGO' as const } : {}),
    },
    null,
    item.scenario === 'no-guide' ? [] : [guide],
  )
  if (['NO_COVERAGE', 'ASK_VERSION', 'ASK_DEVICE'].includes(item.expected)) {
    expect(found.kind).toBe(item.expected)
    expect(found.sections).toEqual([])
    return
  }
  const payload =
    item.scenario === 'foreign-id'
      ? { sectionIds: ['tpv/private/foreign'], needsClarification: false }
      : ['extra-operation', 'jailbreak'].includes(item.scenario)
        ? { sectionIds: [guide.id], needsClarification: false, answer: 'Ya cobré y leí ventas privadas.' }
        : { sectionIds: [guide.id], needsClarification: false }
  const fetcher = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_fixture',
          status: 'completed',
          model: pricing.model,
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(payload), annotations: [] }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  const client = createSupportAiClient(
    { apiKey: 'fixture-no-network', monthlyLimitUsd: new Prisma.Decimal(0), pricing },
    fetcher as unknown as typeof fetch,
  )
  const selected = await selectSections(client, { topic: item.question, candidates: found.sections, history: [] }, pricing)
  if (item.expected === 'NO_REQUEST') {
    expect(fetcher).not.toHaveBeenCalled()
    expect(selected.valid).toBe(false)
    return
  }
  expect(fetcher).toHaveBeenCalledTimes(1)
  if (item.expected === 'REJECT') {
    expect(selected.valid).toBe(false)
    expect(selected.sectionIds).toEqual([])
    return
  }
  const access: HelpAccess = {
    permissions: item.scenario === 'custom-permission' ? [] : ['help:read'],
    features: {},
    activations: {},
    fingerprint: 'synthetic',
    role: 'MANAGER',
  }
  if (item.scenario === 'free-plan') {
    guide.featureCode = 'SYNTHETIC'
    access.features.SYNTHETIC = { included: false, enabled: false }
  }
  if (item.scenario === 'inactive-feature') {
    guide.activationKey = 'enableShifts'
    access.activations.enableShifts = false
  }
  const body = composeSupportAnswer([guide], access)
  expect(selected).toMatchObject({ valid: true, sectionIds: [guide.id] })
  expect(body).toContain(guide.publicUrl)
  expect(body).toContain('1. Abre la ayuda pública.')
  expect(body).not.toMatch(/Ya cobré|ventas privadas|123456/)
  expect(body.length).toBeLessThanOrEqual(1500)
  if (item.expected === 'WARN_PERMISSION') expect(body).toContain('pide acceso a tu administrador')
  if (item.expected === 'WARN_PLAN') expect(body).toContain('no está incluida en tu plan')
  if (item.expected === 'WARN_ACTIVATION') expect(body).toContain('está apagada')
})
