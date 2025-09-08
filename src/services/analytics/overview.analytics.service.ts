import { StaffRole } from '@prisma/client'
import logger from '@/config/logger'

interface BuildOverviewInput {
  timeRange?: '7d' | '30d' | '90d' | 'qtd' | 'ytd' | '12m'
  from?: string
  to?: string
  compareTo?: 'previous_period' | 'previous_year'
  orgId?: string
  venueId?: string
  segments?: string[]
  lang?: 'en' | 'es'
  maskSensitive: boolean
  viewerRole: StaffRole
}

export const buildAnalyticsOverview = async (input: BuildOverviewInput) => {
  const lang = input.lang || 'en'
  const L = (en: string, es: string) => (lang.startsWith('es') ? es : en)
  const now = new Date()
  const refreshedAt = now.toISOString()
  const orgId = input.orgId || 'unknown-org'
  const venueId = input.venueId || 'unknown-venue'

  // Mock time series helpers
  const genSeries = (points = 12, base = 100, variance = 0.1) =>
    Array.from({ length: points }, (_v, i) => {
      const factor = 1 + (Math.sin(i / 2) * variance + (Math.random() - 0.5) * variance)
      return Math.round(base * Math.pow(1.02, i) * factor)
    })

  const genPctSeries = (points = 12, base = 0.8, variance = 0.05) =>
    Array.from({ length: points }, (_v, i) => {
      const v = base + Math.sin(i / 3) * variance + (Math.random() - 0.5) * variance
      return Math.max(0, Math.min(1, v))
    })

  // Mock KPI values (static baselines for determinism)
  const financials = {
    arr: input.maskSensitive ? null : 1245000, // Annual Recurring Revenue ($)
    mrr: input.maskSensitive ? null : 103750, // Monthly Recurring Revenue ($)
    netNewArr: input.maskSensitive ? null : 42500, // $ this period
    nrr: 1.06, // 106%
    grr: 0.94, // 94%
    churnRate: 0.028, // 2.8%
    expansionRate: 0.042, // 4.2%
    arpa: input.maskSensitive ? null : 4850, // $ per account
    grossMargin: input.maskSensitive ? null : 0.79, // 79%
    ltv: input.maskSensitive ? null : 48000, // $ lifetime value
    cac: input.maskSensitive ? null : 9400, // $ acquisition cost
    ltvToCac: input.maskSensitive ? null : 5.11,
    dso: input.maskSensitive ? null : 34, // days sales outstanding
    forecast: input.maskSensitive
      ? null
      : {
          mrrBase: 104500,
          next4Q: [105000, 110000, 116000, 123000],
        },
    series: {
      mrr: genSeries(12, 88000, 0.08),
      nrr: genPctSeries(12, 1.04, 0.03),
      churnRate: genPctSeries(12, 0.025, 0.01),
    },
  }

  const growth = {
    signups: 420,
    lvr: 0.12, // lead velocity rate 12%
    activationRate: 0.63,
    pqls: 138,
    sqls: 94,
    freeToPaid: 0.27,
    winRate: 0.31,
    salesCycleDays: 28,
    cacByChannel: input.maskSensitive
      ? null
      : [
          { channel: 'Organic', cac: 2200 },
          { channel: 'Paid Search', cac: 6100 },
          { channel: 'Outbound', cac: 8800 },
        ],
    series: {
      signups: genSeries(12, 300, 0.2),
      activationRate: genPctSeries(12, 0.6, 0.06),
      winRate: genPctSeries(12, 0.3, 0.04),
    },
  }

  const engagement = {
    dau: 2640,
    wau: 8120,
    mau: 18250,
    stickiness: 0.145, // DAU/MAU
    activeAccounts: 385,
    seatUtilization: 0.72,
    featureAdoptionTop: [
      { feature: 'Orders', adoption: 0.81 },
      { feature: 'Payments', adoption: 0.67 },
      { feature: 'Inventory', adoption: 0.42 },
    ],
    reliability: { uptime: 0.9992, latencyP95: 320, errorRate: 0.0023 },
    feedback: { nps: 41, csat: 0.88, ces: 0.76 },
    series: {
      dau: genSeries(30, 2000, 0.15),
      stickiness: genPctSeries(12, 0.15, 0.03),
      nps: genSeries(12, 38, 0.1),
    },
  }

  const overview = {
    period: input.timeRange || (input.from && input.to ? 'custom' : '30d'),
    compareTo: input.compareTo || 'previous_period',
    segments: input.segments || [],
    kpiDeck: {
      financials: {
        arr: financials.arr,
        mrr: financials.mrr,
        netNewArr: financials.netNewArr,
        nrr: financials.nrr,
        churnRate: financials.churnRate,
      },
      growth: {
        signups: growth.signups,
        activationRate: growth.activationRate,
        winRate: growth.winRate,
        salesCycleDays: growth.salesCycleDays,
      },
      engagement: {
        dau: engagement.dau,
        mau: engagement.mau,
        stickiness: engagement.stickiness,
        uptime: engagement.reliability.uptime,
      },
    },
    visuals: {
      revenueBridge: input.maskSensitive
        ? null
        : [
            { label: L('Starting ARR', 'ARR inicial'), value: 1200000 },
            { label: L('New', 'Nuevos'), value: 60000 },
            { label: L('Expansion', 'Expansión'), value: 45000 },
            { label: L('Contraction', 'Contracción'), value: -25000 },
            { label: L('Churn', 'Cancelación'), value: -35000 },
            { label: L('Ending ARR', 'ARR final'), value: 1245000 },
          ],
      cohorts: { retention: [
        [1, 0.82, 0.71, 0.65],
        [1, 0.80, 0.69, 0.63],
        [1, 0.84, 0.73, 0.67],
      ] },
      funnels: {
        activation: [
          { stage: L('Signups', 'Registros'), value: growth.signups },
          { stage: L('Onboarded', 'Incorporados'), value: Math.round(growth.signups * growth.activationRate) },
          { stage: 'PQL', value: Math.round(growth.pqls) },
          { stage: 'SQL', value: Math.round(growth.sqls) },
          { stage: L('Won', 'Ganadas'), value: Math.round(growth.sqls * growth.winRate) },
        ],
      },
      timeseries: {
        mrr: financials.series.mrr,
        nrr: financials.series.nrr,
        churnRate: financials.series.churnRate,
        dau: engagement.series.dau,
        stickiness: engagement.series.stickiness,
      },
    },
    insights: [
      { severity: 'info', message: L('NRR at 106% (+2.1pp vs target)', 'NRR en 106% (+2.1 pp vs objetivo)'), code: 'nrr_above_target' },
      { severity: 'warn', message: L('Paid CAC increased 10% MoM', 'El CAC de pago aumentó 10% MoM'), code: 'cac_paid_up' },
      { severity: 'info', message: L('DAU/MAU stable at 14.5%', 'DAU/MAU estable en 14.5%'), code: 'stickiness_stable' },
    ],
    definitions: [
      { metric: 'NRR', formula: L('(Ending ARR + Churn + Contraction) / Starting ARR', '(ARR final + Cancelación + Contracción) / ARR inicial') },
      { metric: L('Net New ARR', 'ARR neta nueva'), formula: L('New + Expansion – Contraction – Churn', 'Nuevos + Expansión – Contracción – Cancelación') },
    ],
  }

  logger.debug?.('Built analytics overview (mock)', { orgId, venueId })

  return {
    orgId,
    venueId,
    refreshedAt,
    overview,
  }
}
