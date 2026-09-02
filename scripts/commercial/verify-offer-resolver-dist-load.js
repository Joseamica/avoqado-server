#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '../..')
const build = spawnSync('npm', ['run', 'build'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
  },
})

if (build.status !== 0) {
  process.stdout.write(build.stdout || '')
  process.stderr.write(build.stderr || '')
  process.exit(build.status ?? 1)
}

const resolverPath = path.join(repositoryRoot, 'dist', 'src', 'services', 'commercial', 'offers', 'commercialOfferStacking.service.js')
const resolver = require(resolverPath)

if (typeof resolver.resolveCommercialOfferV3 !== 'function' || typeof resolver.validateCommercialOfferResolutionV2 !== 'function') {
  throw new Error('COMMERCIAL_OFFER_RESOLVER_DIST_EXPORTS_MISSING')
}

const offerService = require(path.join(repositoryRoot, 'dist', 'src', 'services', 'commercial', 'offers', 'commercialOfferV3.service.js'))
const offerFixture = require(
  path.join(repositoryRoot, 'dist', 'src', 'contracts', 'commercial', 'fixtures', 'v3', 'commercial-offer-v3.json'),
)
const resolutionFixture = require(
  path.join(repositoryRoot, 'dist', 'src', 'contracts', 'commercial', 'fixtures', 'v3', 'commercial-offer-resolution-v2.json'),
)
const actual = resolver.resolveCommercialOfferV3({
  ...resolutionFixture.input,
  offer: offerService.validateCommercialOfferV3(offerFixture),
})
assert.deepStrictEqual(actual, resolutionFixture.expected)

const stackedOfferInput = JSON.parse(JSON.stringify(offerFixture))
const stackedSaas = stackedOfferInput.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')
const percentRule = {
  ...JSON.parse(JSON.stringify(stackedSaas.rules[0])),
  code: 'AA_DIST_PERCENT_OFF',
  type: 'PERCENT_OFF',
  priority: 10,
  percentBasisPoints: 1000,
}
delete percentRule.amount
stackedSaas.rules.push(percentRule)
stackedSaas.rules.sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
stackedSaas.stackingGroups = [
  {
    code: 'DIST_PUBLISHED_STACK',
    steps: [
      { position: 1, ruleCode: 'POS_FIXED_50' },
      { position: 2, ruleCode: 'AA_DIST_PERCENT_OFF' },
    ],
  },
]
const stackedOffer = offerService.validateCommercialOfferV3(stackedOfferInput)
const stackedResolution = resolver.resolveCommercialOfferV3({
  offer: stackedOffer,
  resolvedAt: resolutionFixture.input.resolvedAt,
  saasMatches: [{ lineKey: 'dist-line', ruleCodes: ['AA_DIST_PERCENT_OFF', 'POS_FIXED_50'] }],
  hardwareSelections: [],
  rateBlockers: [],
})
assert.deepStrictEqual(
  stackedResolution.applied.filter(item => item.subjectKind === 'SAAS_LINE').map(item => item.ruleCode),
  ['POS_FIXED_50', 'AA_DIST_PERCENT_OFF'],
)

process.stdout.write('PASS: compiled Commercial Offer resolver reproduced golden and published-stack resolutions\n')
