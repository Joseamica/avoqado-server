import fs from 'node:fs'
import path from 'node:path'
import { createPlatformWebhookClassifier } from '@/services/stripe-webhooks/platformWebhookClassifier.service'
import type {
  PlatformWebhookClassificationRepository,
  PlatformWebhookClassificationTransaction,
} from '@/services/stripe-webhooks/platformWebhookClassifier.service'

const repoRoot = path.resolve(__dirname, '../../../..')
const entrypoints = [
  path.join(repoRoot, 'src/services/stripe-webhooks/platformWebhookClassifier.service.ts'),
  path.join(repoRoot, 'src/services/stripe-webhooks/platformWebhookClassifier.prisma.ts'),
]

interface GraphFileSystem {
  readFile(file: string): string
  exists(file: string): boolean
}

const realFileSystem: GraphFileSystem = {
  readFile: file => fs.readFileSync(file, 'utf8'),
  exists: file => fs.existsSync(file),
}

function literalModuleSpecifiers(source: string): string[] {
  const matches = source.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  )
  return [...matches].map(match => match[1] ?? match[2] ?? match[3]).filter((specifier): specifier is string => Boolean(specifier))
}

function firstPartyGraph(roots: string[], fileSystem: GraphFileSystem = realFileSystem): Map<string, string> {
  const graph = new Map<string, string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (graph.has(file)) continue
    const source = fileSystem.readFile(file)
    graph.set(file, source)
    for (const specifier of literalModuleSpecifiers(source)) {
      if (!specifier?.startsWith('.') && !specifier?.startsWith('@/')) continue
      const absolute = specifier.startsWith('@/')
        ? path.join(repoRoot, 'src', specifier.slice(2))
        : path.resolve(path.dirname(file), specifier)
      const candidates = [`${absolute}.ts`, path.join(absolute, 'index.ts')]
      const target = candidates.find(candidate => fileSystem.exists(candidate))
      if (target && target.startsWith(path.join(repoRoot, 'src'))) pending.push(target)
    }
  }
  return graph
}

function architectureViolations(graph: Map<string, string>): string[] {
  const violations: string[] = []
  for (const [file, source] of graph) {
    const relative = path.relative(repoRoot, file)
    literalModuleSpecifiers(source)
      .filter(specifier => ['stripe', 'axios', 'node:http', 'node:https', 'http', 'https'].includes(specifier))
      .forEach(specifier => violations.push(`${relative}: import ${specifier}`))
    if (/\bfetch\s*\(/.test(source)) violations.push(`${relative}: fetch()`)
    if (/live[-_.]?(?:resolver|lookup)|stripe\.(?:customers|subscriptions|invoices|paymentIntents|charges)\./i.test(source)) {
      violations.push(`${relative}: live provider resolver`)
    }
  }
  return violations
}

const localOnlyTransaction: PlatformWebhookClassificationTransaction = {
  async findBindings() {
    return []
  },
  async findFallbackAuthorities() {
    return { candidates: [], creditPackDrain: false }
  },
  async inspectBindingRelationship() {
    return 'SUBJECT_MISSING'
  },
  async loadDurableSignedEvent() {
    return null
  },
  async createOrCompareBindings() {
    return []
  },
}

const localOnlyRepository: PlatformWebhookClassificationRepository = {
  async runInTransaction(work) {
    return work(localOnlyTransaction)
  },
}

describe('P3-1A1b classifier local-only architecture', () => {
  describe('new classifier guardrails', () => {
    it('keeps every transitive first-party module free of provider/network imports and fetch calls', () => {
      const graph = firstPartyGraph(entrypoints)

      expect([...graph.keys()].map(file => path.relative(repoRoot, file)).sort()).toEqual([
        'src/services/stripe-webhooks/platformWebhookClassifier.extractor.ts',
        'src/services/stripe-webhooks/platformWebhookClassifier.prisma.ts',
        'src/services/stripe-webhooks/platformWebhookClassifier.service.ts',
        'src/services/stripe-webhooks/platformWebhookInbox.service.ts',
      ])
      expect(architectureViolations(graph)).toEqual([])
    })

    it('does not load Stripe or axios transitively from either classifier entrypoint', () => {
      jest.doMock('stripe', () => {
        throw new Error('Stripe provider module loaded by local classifier')
      })
      jest.doMock('axios', () => {
        throw new Error('Axios module loaded by local classifier')
      })

      expect(() => {
        jest.isolateModules(() => {
          require('@/services/stripe-webhooks/platformWebhookClassifier.service')
          require('@/services/stripe-webhooks/platformWebhookClassifier.prisma')
        })
      }).not.toThrow()

      jest.dontMock('stripe')
      jest.dontMock('axios')
    })

    it('executes all registered families while fetch and HTTP(S) requests are trapped', async () => {
      const originalFetch = global.fetch
      const fetchTrap = jest.fn(() => {
        throw new Error('fetch called by local classifier')
      })
      Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: fetchTrap })
      const httpModule = require('node:http') as typeof import('node:http')
      const httpsModule = require('node:https') as typeof import('node:https')
      const httpTrap = jest.spyOn(httpModule, 'request').mockImplementation(() => {
        throw new Error('http.request called by local classifier')
      })
      const httpsTrap = jest.spyOn(httpsModule, 'request').mockImplementation(() => {
        throw new Error('https.request called by local classifier')
      })
      const classifier = createPlatformWebhookClassifier({ repository: localOnlyRepository })
      const fixtures: Array<[string, Record<string, unknown>]> = [
        ['checkout.session.completed', { id: 'cs_1' }],
        ['checkout.session.async_payment_succeeded', { id: 'cs_2' }],
        ['checkout.session.async_payment_failed', { id: 'cs_3' }],
        ['customer.subscription.created', { id: 'sub_1' }],
        ['customer.subscription.updated', { id: 'sub_2' }],
        ['customer.subscription.deleted', { id: 'sub_3' }],
        ['customer.subscription.trial_will_end', { id: 'sub_4' }],
        ['invoice.paid', { id: 'in_1' }],
        ['invoice.payment_succeeded', { id: 'in_2' }],
        ['invoice.payment_failed', { id: 'in_3' }],
        ['payment_intent.succeeded', { id: 'pi_1' }],
        ['payment_intent.payment_failed', { id: 'pi_2' }],
        ['charge.refunded', { id: 'ch_1' }],
        ['charge.dispute.created', { id: 'dp_1', charge: 'ch_2' }],
        ['charge.dispute.closed', { id: 'dp_2', charge: 'ch_3' }],
        ['customer.deleted', { id: 'cus_1' }],
        ['payment_method.attached', { id: 'pm_1', customer: 'cus_2' }],
      ]

      try {
        const results = await Promise.all(
          fixtures.map(([type, object], index) =>
            classifier.classify({
              webhookEventId: `we_${index}`,
              stripeEventId: `evt_${index}`,
              type,
              object,
            }),
          ),
        )
        expect(results).toHaveLength(17)
        expect(results.every(result => result.state === 'PENDING')).toBe(true)
        expect(fetchTrap).not.toHaveBeenCalled()
        expect(httpTrap).not.toHaveBeenCalled()
        expect(httpsTrap).not.toHaveBeenCalled()
      } finally {
        httpTrap.mockRestore()
        httpsTrap.mockRestore()
        Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: originalFetch })
      }
    })
  })

  describe('regressions', () => {
    it.each([
      [
        'alias',
        path.join(repoRoot, 'src/services/stripe-webhooks/__virtual__/alias-entry.ts'),
        "export const load = () => import('@/services/stripe-webhooks/__virtual__/forbidden-helper')",
      ],
      [
        'relative',
        path.join(repoRoot, 'src/services/stripe-webhooks/__virtual__/relative-entry.ts'),
        "export const load = () => import('./forbidden-helper')",
      ],
    ] as const)('traverses a literal dynamic %s import and detects its hidden forbidden dependency', (_kind, entry, entrySource) => {
      const helper = path.join(repoRoot, 'src/services/stripe-webhooks/__virtual__/forbidden-helper.ts')
      const sources = new Map([
        [entry, entrySource],
        [helper, "import 'node:https'\nexport const hidden = true"],
      ])
      const graph = firstPartyGraph([entry], {
        readFile(file) {
          const source = sources.get(file)
          if (source === undefined) throw new Error(`Missing virtual fixture ${file}`)
          return source
        },
        exists: file => sources.has(file),
      })

      expect([...graph.keys()]).toContain(helper)
      expect(architectureViolations(graph)).toContain('src/services/stripe-webhooks/__virtual__/forbidden-helper.ts: import node:https')
    })

    it('includes first-party modules imported through the canonical @/ alias', () => {
      const fixture = path.join(repoRoot, 'tests/unit/services/stripe-webhooks/fixtures/platformWebhookClassifier.alias-entry.ts')
      const files = [...firstPartyGraph([fixture]).keys()].map(file => path.relative(repoRoot, file)).sort()

      expect(files).toEqual([
        'src/services/stripe-webhooks/platformWebhookClassifier.extractor.ts',
        'src/services/stripe-webhooks/platformWebhookInbox.service.ts',
        'tests/unit/services/stripe-webhooks/fixtures/platformWebhookClassifier.alias-entry.ts',
      ])
    })

    it('allows only local persistence boundaries outside the first-party graph', () => {
      const sources = [...firstPartyGraph(entrypoints).values()].join('\n')
      expect(sources).toContain("from '@prisma/client'")
      expect(sources).not.toContain("from 'pg'")
    })
  })
})
