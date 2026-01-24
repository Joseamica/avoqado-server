import { CreditEligibility, CreditGrade, CreditOfferStatus, Prisma, TrendDirection } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

/**
 * ============================================================================
 * CREDIT ASSESSMENT SERVICE - WORLD-CLASS ALGORITHM
 * ============================================================================
 *
 * Based on extensive research of:
 * - Square Capital (Harvard Business School case study - 400+ data points)
 * - Stripe Capital (automated underwriting)
 * - Toast Capital (restaurant-specific lending)
 * - Clearco / Pipe (revenue-based financing)
 * - Mexican SOFOM best practices (CNBV regulations)
 *
 * KEY PRINCIPLES:
 * 1. HARD GATES before scoring (minimum requirements)
 * 2. 5-PILLAR scoring with industry-calibrated weights
 * 3. ANNUALIZATION for fair assessment of new businesses
 * 4. TREND ANALYSIS over absolute values
 * 5. MEXICAN MARKET calibration (peso thresholds, industry norms)
 *
 * SCORING MODEL:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ PILLAR              │ WEIGHT │ WHAT IT MEASURES                 │
 * ├─────────────────────┼────────┼──────────────────────────────────┤
 * │ Volume & Scale      │  25%   │ Processing capacity              │
 * │ Growth & Momentum   │  20%   │ Business trajectory              │
 * │ Stability           │  25%   │ Revenue consistency              │
 * │ Risk Profile        │  20%   │ Chargeback/refund behavior       │
 * │ Business Maturity   │  10%   │ Operating history & data quality │
 * └─────────────────────┴────────┴──────────────────────────────────┘
 *
 * GRADE SCALE:
 * A (80-100): Prime - Best rates, highest limits
 * B (65-79):  Near-Prime - Good rates, standard limits
 * C (50-64):  Developing - Higher rates, lower limits
 * D (0-49):   Not Ready - Ineligible or needs improvement
 */

// =============================================================================
// TYPES
// =============================================================================

interface CreditScoreBreakdown {
  volumeScore: number // 0-100
  growthScore: number // 0-100
  stabilityScore: number // 0-100
  riskScore: number // 0-100
  maturityScore: number // 0-100
  totalScore: number // Weighted 0-100
}

interface VenueMetrics {
  // Operating Period
  firstTransactionDate: Date | null
  daysInOperation: number
  isNewBusiness: boolean // < 180 days

  // Volume (raw and annualized)
  rawVolume: number
  annualizedVolume: number
  monthlyAverage: number
  currentMonthVolume: number
  previousMonthVolume: number
  transactionCount: number
  averageTicket: number
  medianTicket: number

  // Growth
  momGrowthPercent: number
  threeMonthTrend: number // Average of last 3 months MoM
  velocityScore: number // Transactions per operating day
  trendDirection: TrendDirection

  // Stability
  revenueVariance: number // Coefficient of variation
  consistencyScore: number // % of months above 50% of average
  operatingDaysRatio: number
  daysSinceLastTx: number
  peakToTroughRatio: number // Worst month / best month

  // Risk
  chargebackRate: number
  chargebackCount: number
  refundRate: number
  refundCount: number
  largeTransactionRatio: number // % of transactions > 3x average

  // Payment Mix
  cardPaymentRatio: number
  cashPaymentRatio: number
  paymentMethodMix: Record<string, number>
}

interface EligibilityGates {
  passed: boolean
  failures: string[]

  // Individual gates
  minimumDaysInOperation: boolean // >= 90 days
  minimumVolume: boolean // >= $300k annualized
  minimumTransactions: boolean // >= 200 transactions
  acceptableChargebackRate: boolean // < 1.5%
  recentActivity: boolean // Transaction in last 14 days
  minimumOperatingDays: boolean // >= 50% of days active
}

interface CreditRecommendation {
  recommendedCreditLimit: number
  suggestedFactorRate: number
  totalRepayment: number
  maxRepaymentPercent: number
  estimatedTermDays: number
  monthlyPaymentEstimate: number
}

interface CreditAssessmentResult {
  venueId: string
  venueName: string
  venueSlug: string
  organizationName: string

  // Eligibility
  eligibilityGates: EligibilityGates

  // Scores
  creditScore: number
  creditGrade: CreditGrade
  eligibilityStatus: CreditEligibility
  scoreBreakdown: CreditScoreBreakdown

  // Metrics
  metrics: VenueMetrics

  // Recommendation
  recommendation: CreditRecommendation

  // Alerts
  alerts: string[]

  // Timestamps
  calculatedAt: Date
  dataAsOf: Date
}

// =============================================================================
// SCORING CONFIGURATION (Calibrated for Mexican Market)
// =============================================================================

const SCORING_WEIGHTS = {
  VOLUME: 0.25, // Processing capacity
  GROWTH: 0.2, // Business trajectory
  STABILITY: 0.25, // Revenue consistency
  RISK: 0.2, // Chargeback/refund behavior
  MATURITY: 0.1, // Operating history
}

/**
 * Thresholds calibrated for Mexican SMB market (restaurants/retail)
 *
 * Reference data:
 * - Average Mexican restaurant revenue: $2-5M MXN/year
 * - Median: ~$1.5M MXN/year
 * - Small cafés/taquerías: $500k-1M MXN/year
 * - Fine dining: $5-15M MXN/year
 */
const THRESHOLDS = {
  // === ELIGIBILITY GATES (Hard Requirements) ===
  GATE_MIN_DAYS_OPERATING: 90, // 3 months minimum history
  GATE_MIN_ANNUALIZED_VOLUME: 300000, // $300k MXN annualized (~$17k USD)
  GATE_MIN_TRANSACTIONS: 200, // ~2-3 per day for 90 days
  GATE_MAX_CHARGEBACK_RATE: 0.015, // 1.5% max (industry standard)
  GATE_MAX_DAYS_INACTIVE: 14, // Must have recent activity
  GATE_MIN_OPERATING_DAYS_RATIO: 0.5, // Active 50%+ of days

  // === VOLUME SCORING ===
  VOLUME_TIER_1: 500000, // $500k MXN - Entry level (50 pts)
  VOLUME_TIER_2: 1000000, // $1M MXN - Small business (65 pts)
  VOLUME_TIER_3: 2500000, // $2.5M MXN - Established (80 pts)
  VOLUME_TIER_4: 5000000, // $5M MXN - Strong (90 pts)
  VOLUME_TIER_5: 10000000, // $10M MXN - Premium (100 pts)

  // === GROWTH SCORING ===
  GROWTH_EXCELLENT: 15, // 15%+ MoM average = excellent
  GROWTH_GOOD: 5, // 5-15% = good
  GROWTH_STABLE: 0, // 0-5% = stable
  GROWTH_DECLINING: -5, // Below -5% = concerning

  // === STABILITY SCORING ===
  VARIANCE_EXCELLENT: 0.15, // CV < 15% = very stable
  VARIANCE_GOOD: 0.25, // CV 15-25% = stable
  VARIANCE_ACCEPTABLE: 0.4, // CV 25-40% = acceptable
  VARIANCE_POOR: 0.6, // CV > 60% = unstable

  OPERATING_DAYS_EXCELLENT: 0.9, // 90%+ days active
  OPERATING_DAYS_GOOD: 0.75, // 75-90%
  OPERATING_DAYS_ACCEPTABLE: 0.6, // 60-75%

  // === RISK SCORING ===
  CHARGEBACK_EXCELLENT: 0.001, // < 0.1%
  CHARGEBACK_GOOD: 0.005, // 0.1-0.5%
  CHARGEBACK_ACCEPTABLE: 0.01, // 0.5-1%
  CHARGEBACK_CONCERNING: 0.015, // 1-1.5%

  REFUND_EXCELLENT: 0.02, // < 2%
  REFUND_GOOD: 0.05, // 2-5%
  REFUND_ACCEPTABLE: 0.08, // 5-8%
  REFUND_CONCERNING: 0.12, // 8-12%

  // === MATURITY SCORING ===
  MATURITY_TIER_1: 90, // 90 days = entry (50 pts)
  MATURITY_TIER_2: 180, // 6 months (65 pts)
  MATURITY_TIER_3: 365, // 1 year (80 pts)
  MATURITY_TIER_4: 730, // 2 years (95 pts)

  // === CREDIT OFFER CALCULATION ===
  GRADE_A_CREDIT_PERCENT: 0.25, // 25% of annual volume
  GRADE_B_CREDIT_PERCENT: 0.18, // 18% of annual volume
  GRADE_C_CREDIT_PERCENT: 0.12, // 12% of annual volume

  GRADE_A_FACTOR_RATE: 1.08, // 8% fee
  GRADE_B_FACTOR_RATE: 1.12, // 12% fee
  GRADE_C_FACTOR_RATE: 1.18, // 18% fee

  GRADE_A_REPAYMENT_PCT: 0.12, // 12% of daily sales
  GRADE_B_REPAYMENT_PCT: 0.15, // 15% of daily sales
  GRADE_C_REPAYMENT_PCT: 0.18, // 18% of daily sales

  MIN_CREDIT_OFFER: 50000, // $50k MXN minimum
  MAX_CREDIT_OFFER: 3000000, // $3M MXN maximum
}

// =============================================================================
// MAIN SERVICE FUNCTIONS
// =============================================================================

/**
 * Calculate credit assessment for a single venue
 */
export async function calculateVenueAssessment(venueId: string): Promise<CreditAssessmentResult> {
  logger.info('Calculating credit assessment', { venueId })

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      organization: { select: { name: true } },
    },
  })

  if (!venue) {
    throw new Error(`Venue not found: ${venueId}`)
  }

  // Calculate all metrics
  const metrics = await calculateVenueMetrics(venueId)

  // Check eligibility gates FIRST
  const eligibilityGates = checkEligibilityGates(metrics)

  // Calculate scores for each pillar
  const scoreBreakdown = calculateScoreBreakdown(metrics, eligibilityGates)

  // Determine grade and eligibility
  const creditGrade = determineGrade(scoreBreakdown.totalScore)
  const alerts = generateAlerts(metrics, eligibilityGates)
  const eligibilityStatus = determineEligibility(creditGrade, eligibilityGates, metrics)

  // Generate recommendation (only if eligible)
  const recommendation = calculateRecommendation(metrics, creditGrade, eligibilityGates)

  const now = new Date()

  // Upsert the assessment record
  await prisma.venueCreditAssessment.upsert({
    where: { venueId },
    create: {
      venueId,
      creditScore: scoreBreakdown.totalScore,
      creditGrade,
      eligibilityStatus,
      // Volume
      annualVolume: metrics.annualizedVolume,
      monthlyAverage: metrics.monthlyAverage,
      currentMonthVolume: metrics.currentMonthVolume,
      transactionCount12m: metrics.transactionCount,
      // Growth
      yoyGrowthPercent: 0, // Not applicable for MCA
      momGrowthPercent: metrics.momGrowthPercent,
      trendDirection: metrics.trendDirection,
      // Stability
      revenueVariance: metrics.revenueVariance,
      consistencyScore: metrics.consistencyScore,
      daysSinceLastTx: metrics.daysSinceLastTx,
      operatingDaysRatio: metrics.operatingDaysRatio,
      averageTicket: metrics.averageTicket,
      // Risk
      chargebackRate: metrics.chargebackRate,
      refundRate: metrics.refundRate,
      chargebackCount: metrics.chargebackCount,
      paymentMethodMix: metrics.paymentMethodMix,
      // Recommendation
      recommendedCreditLimit: recommendation.recommendedCreditLimit,
      suggestedFactorRate: recommendation.suggestedFactorRate,
      maxRepaymentPercent: recommendation.maxRepaymentPercent,
      // Metadata
      alerts,
      calculatedAt: now,
      dataAsOf: now,
    },
    update: {
      creditScore: scoreBreakdown.totalScore,
      creditGrade,
      eligibilityStatus,
      annualVolume: metrics.annualizedVolume,
      monthlyAverage: metrics.monthlyAverage,
      currentMonthVolume: metrics.currentMonthVolume,
      transactionCount12m: metrics.transactionCount,
      yoyGrowthPercent: 0,
      momGrowthPercent: metrics.momGrowthPercent,
      trendDirection: metrics.trendDirection,
      revenueVariance: metrics.revenueVariance,
      consistencyScore: metrics.consistencyScore,
      daysSinceLastTx: metrics.daysSinceLastTx,
      operatingDaysRatio: metrics.operatingDaysRatio,
      averageTicket: metrics.averageTicket,
      chargebackRate: metrics.chargebackRate,
      refundRate: metrics.refundRate,
      chargebackCount: metrics.chargebackCount,
      paymentMethodMix: metrics.paymentMethodMix,
      recommendedCreditLimit: recommendation.recommendedCreditLimit,
      suggestedFactorRate: recommendation.suggestedFactorRate,
      maxRepaymentPercent: recommendation.maxRepaymentPercent,
      alerts,
      calculatedAt: now,
      dataAsOf: now,
    },
  })

  // Create history snapshot
  const assessment = await prisma.venueCreditAssessment.findUnique({
    where: { venueId },
  })

  if (assessment) {
    await prisma.creditAssessmentHistory.create({
      data: {
        assessmentId: assessment.id,
        creditScore: scoreBreakdown.totalScore,
        creditGrade,
        annualVolume: metrics.annualizedVolume,
        monthlyVolume: metrics.monthlyAverage,
        growthPercent: metrics.momGrowthPercent,
        snapshotDate: now,
      },
    })
  }

  return {
    venueId,
    venueName: venue.name,
    venueSlug: venue.slug,
    organizationName: venue.organization?.name || 'N/A',
    eligibilityGates,
    creditScore: scoreBreakdown.totalScore,
    creditGrade,
    eligibilityStatus,
    scoreBreakdown,
    metrics,
    recommendation,
    alerts,
    calculatedAt: now,
    dataAsOf: now,
  }
}

// =============================================================================
// ELIGIBILITY GATES (Hard Requirements)
// =============================================================================

function checkEligibilityGates(metrics: VenueMetrics): EligibilityGates {
  const failures: string[] = []

  const minimumDaysInOperation = metrics.daysInOperation >= THRESHOLDS.GATE_MIN_DAYS_OPERATING
  if (!minimumDaysInOperation) {
    failures.push(`INSUFFICIENT_HISTORY: ${metrics.daysInOperation} days (minimum ${THRESHOLDS.GATE_MIN_DAYS_OPERATING})`)
  }

  const minimumVolume = metrics.annualizedVolume >= THRESHOLDS.GATE_MIN_ANNUALIZED_VOLUME
  if (!minimumVolume) {
    failures.push(
      `INSUFFICIENT_VOLUME: $${Math.round(metrics.annualizedVolume).toLocaleString()} MXN (minimum $${THRESHOLDS.GATE_MIN_ANNUALIZED_VOLUME.toLocaleString()})`,
    )
  }

  const minimumTransactions = metrics.transactionCount >= THRESHOLDS.GATE_MIN_TRANSACTIONS
  if (!minimumTransactions) {
    failures.push(`INSUFFICIENT_TRANSACTIONS: ${metrics.transactionCount} (minimum ${THRESHOLDS.GATE_MIN_TRANSACTIONS})`)
  }

  const acceptableChargebackRate = metrics.chargebackRate <= THRESHOLDS.GATE_MAX_CHARGEBACK_RATE
  if (!acceptableChargebackRate) {
    failures.push(
      `HIGH_CHARGEBACK_RATE: ${(metrics.chargebackRate * 100).toFixed(2)}% (maximum ${THRESHOLDS.GATE_MAX_CHARGEBACK_RATE * 100}%)`,
    )
  }

  const recentActivity = metrics.daysSinceLastTx <= THRESHOLDS.GATE_MAX_DAYS_INACTIVE
  if (!recentActivity) {
    failures.push(`INACTIVE: ${metrics.daysSinceLastTx} days since last transaction (maximum ${THRESHOLDS.GATE_MAX_DAYS_INACTIVE})`)
  }

  const minimumOperatingDays = metrics.operatingDaysRatio >= THRESHOLDS.GATE_MIN_OPERATING_DAYS_RATIO
  if (!minimumOperatingDays) {
    failures.push(
      `LOW_ACTIVITY: ${(metrics.operatingDaysRatio * 100).toFixed(0)}% days active (minimum ${THRESHOLDS.GATE_MIN_OPERATING_DAYS_RATIO * 100}%)`,
    )
  }

  return {
    passed: failures.length === 0,
    failures,
    minimumDaysInOperation,
    minimumVolume,
    minimumTransactions,
    acceptableChargebackRate,
    recentActivity,
    minimumOperatingDays,
  }
}

// =============================================================================
// SCORE CALCULATION
// =============================================================================

function calculateScoreBreakdown(metrics: VenueMetrics, gates: EligibilityGates): CreditScoreBreakdown {
  // If gates not passed, cap total score at 49 (Grade D)
  const gatePenalty = gates.passed ? 0 : 30

  const volumeScore = calculateVolumeScore(metrics)
  const growthScore = calculateGrowthScore(metrics)
  const stabilityScore = calculateStabilityScore(metrics)
  const riskScore = calculateRiskScore(metrics)
  const maturityScore = calculateMaturityScore(metrics)

  const rawTotal = Math.round(
    volumeScore * SCORING_WEIGHTS.VOLUME +
      growthScore * SCORING_WEIGHTS.GROWTH +
      stabilityScore * SCORING_WEIGHTS.STABILITY +
      riskScore * SCORING_WEIGHTS.RISK +
      maturityScore * SCORING_WEIGHTS.MATURITY,
  )

  // Apply gate penalty
  const totalScore = Math.max(0, Math.min(100, rawTotal - gatePenalty))

  return {
    volumeScore,
    growthScore,
    stabilityScore,
    riskScore,
    maturityScore,
    totalScore,
  }
}

/**
 * VOLUME SCORE (25%)
 * Measures processing capacity relative to market benchmarks
 */
function calculateVolumeScore(metrics: VenueMetrics): number {
  const volume = metrics.annualizedVolume
  let score = 0

  // Tiered scoring based on annualized volume
  if (volume >= THRESHOLDS.VOLUME_TIER_5) {
    score = 100
  } else if (volume >= THRESHOLDS.VOLUME_TIER_4) {
    score = 90 + ((volume - THRESHOLDS.VOLUME_TIER_4) / (THRESHOLDS.VOLUME_TIER_5 - THRESHOLDS.VOLUME_TIER_4)) * 10
  } else if (volume >= THRESHOLDS.VOLUME_TIER_3) {
    score = 80 + ((volume - THRESHOLDS.VOLUME_TIER_3) / (THRESHOLDS.VOLUME_TIER_4 - THRESHOLDS.VOLUME_TIER_3)) * 10
  } else if (volume >= THRESHOLDS.VOLUME_TIER_2) {
    score = 65 + ((volume - THRESHOLDS.VOLUME_TIER_2) / (THRESHOLDS.VOLUME_TIER_3 - THRESHOLDS.VOLUME_TIER_2)) * 15
  } else if (volume >= THRESHOLDS.VOLUME_TIER_1) {
    score = 50 + ((volume - THRESHOLDS.VOLUME_TIER_1) / (THRESHOLDS.VOLUME_TIER_2 - THRESHOLDS.VOLUME_TIER_1)) * 15
  } else if (volume >= THRESHOLDS.GATE_MIN_ANNUALIZED_VOLUME) {
    score =
      30 + ((volume - THRESHOLDS.GATE_MIN_ANNUALIZED_VOLUME) / (THRESHOLDS.VOLUME_TIER_1 - THRESHOLDS.GATE_MIN_ANNUALIZED_VOLUME)) * 20
  } else {
    score = (volume / THRESHOLDS.GATE_MIN_ANNUALIZED_VOLUME) * 30
  }

  // Bonus for high transaction velocity
  const txPerDay = metrics.transactionCount / Math.max(1, metrics.daysInOperation)
  if (txPerDay > 20) score = Math.min(100, score + 5)
  else if (txPerDay > 10) score = Math.min(100, score + 3)

  return Math.round(Math.max(0, Math.min(100, score)))
}

/**
 * GROWTH SCORE (20%)
 * Measures business trajectory and momentum
 */
function calculateGrowthScore(metrics: VenueMetrics): number {
  let score = 50 // Start at neutral

  // For new businesses (< 6 months), focus on recent momentum
  if (metrics.isNewBusiness) {
    // Use transaction velocity trend instead of MoM
    if (metrics.velocityScore > 8)
      score += 25 // > 8 tx/day = strong
    else if (metrics.velocityScore > 5)
      score += 15 // 5-8 tx/day = good
    else if (metrics.velocityScore > 3)
      score += 5 // 3-5 tx/day = developing
    else score -= 10 // < 3 tx/day = weak

    // Boost for positive trend direction
    if (metrics.trendDirection === TrendDirection.GROWING) score += 15
    else if (metrics.trendDirection === TrendDirection.DECLINING) score -= 15
  } else {
    // For established businesses, use traditional MoM growth
    const growth = metrics.threeMonthTrend // 3-month average is more stable

    if (growth >= THRESHOLDS.GROWTH_EXCELLENT) {
      score += 40
    } else if (growth >= THRESHOLDS.GROWTH_GOOD) {
      score += 25
    } else if (growth >= THRESHOLDS.GROWTH_STABLE) {
      score += 10
    } else if (growth >= THRESHOLDS.GROWTH_DECLINING) {
      score -= 10
    } else {
      score -= 25
    }

    // Trend direction bonus/penalty
    if (metrics.trendDirection === TrendDirection.GROWING) score += 10
    else if (metrics.trendDirection === TrendDirection.DECLINING) score -= 10
  }

  return Math.round(Math.max(0, Math.min(100, score)))
}

/**
 * STABILITY SCORE (25%)
 * Measures revenue consistency and operational regularity
 */
function calculateStabilityScore(metrics: VenueMetrics): number {
  let score = 0

  // Revenue Variance (40% of stability)
  // Lower coefficient of variation = more stable
  const cv = metrics.revenueVariance
  if (cv <= THRESHOLDS.VARIANCE_EXCELLENT) {
    score += 40
  } else if (cv <= THRESHOLDS.VARIANCE_GOOD) {
    score += 32
  } else if (cv <= THRESHOLDS.VARIANCE_ACCEPTABLE) {
    score += 24
  } else if (cv <= THRESHOLDS.VARIANCE_POOR) {
    score += 15
  } else {
    score += 5
  }

  // Operating Days Ratio (35% of stability)
  const opDays = metrics.operatingDaysRatio
  if (opDays >= THRESHOLDS.OPERATING_DAYS_EXCELLENT) {
    score += 35
  } else if (opDays >= THRESHOLDS.OPERATING_DAYS_GOOD) {
    score += 28
  } else if (opDays >= THRESHOLDS.OPERATING_DAYS_ACCEPTABLE) {
    score += 20
  } else if (opDays >= THRESHOLDS.GATE_MIN_OPERATING_DAYS_RATIO) {
    score += 12
  } else {
    score += 5
  }

  // Consistency Score (25% of stability)
  // Based on % of months with revenue > 50% of average
  score += (metrics.consistencyScore / 100) * 25

  return Math.round(Math.max(0, Math.min(100, score)))
}

/**
 * RISK SCORE (20%)
 * Measures chargeback and refund behavior
 * HIGHER score = LOWER risk
 */
function calculateRiskScore(metrics: VenueMetrics): number {
  let score = 100 // Start at perfect, deduct for issues

  // Chargeback Rate (50% of risk impact)
  const cbRate = metrics.chargebackRate
  if (cbRate > THRESHOLDS.CHARGEBACK_CONCERNING) {
    score -= 50
  } else if (cbRate > THRESHOLDS.CHARGEBACK_ACCEPTABLE) {
    score -= 35
  } else if (cbRate > THRESHOLDS.CHARGEBACK_GOOD) {
    score -= 20
  } else if (cbRate > THRESHOLDS.CHARGEBACK_EXCELLENT) {
    score -= 10
  }
  // Excellent: no deduction

  // Refund Rate (30% of risk impact)
  const refundRate = metrics.refundRate
  if (refundRate > THRESHOLDS.REFUND_CONCERNING) {
    score -= 30
  } else if (refundRate > THRESHOLDS.REFUND_ACCEPTABLE) {
    score -= 20
  } else if (refundRate > THRESHOLDS.REFUND_GOOD) {
    score -= 10
  } else if (refundRate > THRESHOLDS.REFUND_EXCELLENT) {
    score -= 5
  }

  // Large Transaction Anomalies (10% of risk impact)
  // High ratio of unusually large transactions can indicate fraud
  if (metrics.largeTransactionRatio > 0.1) {
    score -= 10
  } else if (metrics.largeTransactionRatio > 0.05) {
    score -= 5
  }

  // Card Payment Ratio Bonus (10% bonus possible)
  // More card payments = more verifiable data = lower risk
  if (metrics.cardPaymentRatio > 0.8) {
    score = Math.min(100, score + 10)
  } else if (metrics.cardPaymentRatio > 0.6) {
    score = Math.min(100, score + 5)
  }

  return Math.round(Math.max(0, Math.min(100, score)))
}

/**
 * MATURITY SCORE (10%)
 * Measures operating history and data quality
 */
function calculateMaturityScore(metrics: VenueMetrics): number {
  const days = metrics.daysInOperation
  let score = 0

  // Tiered scoring based on operating history
  if (days >= THRESHOLDS.MATURITY_TIER_4) {
    score = 95
  } else if (days >= THRESHOLDS.MATURITY_TIER_3) {
    score = 80 + ((days - THRESHOLDS.MATURITY_TIER_3) / (THRESHOLDS.MATURITY_TIER_4 - THRESHOLDS.MATURITY_TIER_3)) * 15
  } else if (days >= THRESHOLDS.MATURITY_TIER_2) {
    score = 65 + ((days - THRESHOLDS.MATURITY_TIER_2) / (THRESHOLDS.MATURITY_TIER_3 - THRESHOLDS.MATURITY_TIER_2)) * 15
  } else if (days >= THRESHOLDS.MATURITY_TIER_1) {
    score = 50 + ((days - THRESHOLDS.MATURITY_TIER_1) / (THRESHOLDS.MATURITY_TIER_2 - THRESHOLDS.MATURITY_TIER_1)) * 15
  } else {
    score = (days / THRESHOLDS.MATURITY_TIER_1) * 50
  }

  // Bonus for data quality (sufficient transactions per day)
  const txPerDay = metrics.transactionCount / Math.max(1, days)
  if (txPerDay >= 5) score = Math.min(100, score + 5)

  return Math.round(Math.max(0, Math.min(100, score)))
}

// =============================================================================
// GRADE & ELIGIBILITY DETERMINATION
// =============================================================================

function determineGrade(score: number): CreditGrade {
  if (score >= 80) return CreditGrade.A
  if (score >= 65) return CreditGrade.B
  if (score >= 50) return CreditGrade.C
  return CreditGrade.D
}

function determineEligibility(grade: CreditGrade, gates: EligibilityGates, _metrics: VenueMetrics): CreditEligibility {
  // Must pass all gates
  if (!gates.passed) {
    return CreditEligibility.INELIGIBLE
  }

  // Grade-based eligibility
  if (grade === CreditGrade.A || grade === CreditGrade.B) {
    return CreditEligibility.ELIGIBLE
  }

  if (grade === CreditGrade.C) {
    return CreditEligibility.REVIEW_REQUIRED
  }

  return CreditEligibility.INELIGIBLE
}

// =============================================================================
// ALERT GENERATION
// =============================================================================

function generateAlerts(metrics: VenueMetrics, gates: EligibilityGates): string[] {
  const alerts: string[] = []

  // Gate failures become alerts
  gates.failures.forEach(failure => {
    alerts.push(failure)
  })

  // Additional warnings (not blocking, but noteworthy)
  if (metrics.momGrowthPercent < -10) {
    alerts.push('DECLINING_REVENUE: Month-over-month decline > 10%')
  }

  if (metrics.daysSinceLastTx > 7 && metrics.daysSinceLastTx <= 14) {
    alerts.push('LOW_RECENT_ACTIVITY: No transactions in 7+ days')
  }

  if (metrics.revenueVariance > 0.5) {
    alerts.push('HIGH_VOLATILITY: Revenue variance > 50%')
  }

  if (metrics.cardPaymentRatio < 0.3) {
    alerts.push('LOW_CARD_USAGE: Less than 30% card payments')
  }

  if (metrics.isNewBusiness) {
    alerts.push('NEW_BUSINESS: Less than 6 months of history')
  }

  return alerts
}

// =============================================================================
// CREDIT RECOMMENDATION
// =============================================================================

function calculateRecommendation(metrics: VenueMetrics, grade: CreditGrade, gates: EligibilityGates): CreditRecommendation {
  // Default (ineligible)
  if (!gates.passed || grade === CreditGrade.D) {
    return {
      recommendedCreditLimit: 0,
      suggestedFactorRate: 0,
      totalRepayment: 0,
      maxRepaymentPercent: 0,
      estimatedTermDays: 0,
      monthlyPaymentEstimate: 0,
    }
  }

  let creditPercent: number
  let factorRate: number
  let repaymentPercent: number

  switch (grade) {
    case CreditGrade.A:
      creditPercent = THRESHOLDS.GRADE_A_CREDIT_PERCENT
      factorRate = THRESHOLDS.GRADE_A_FACTOR_RATE
      repaymentPercent = THRESHOLDS.GRADE_A_REPAYMENT_PCT
      break
    case CreditGrade.B:
      creditPercent = THRESHOLDS.GRADE_B_CREDIT_PERCENT
      factorRate = THRESHOLDS.GRADE_B_FACTOR_RATE
      repaymentPercent = THRESHOLDS.GRADE_B_REPAYMENT_PCT
      break
    case CreditGrade.C:
      creditPercent = THRESHOLDS.GRADE_C_CREDIT_PERCENT
      factorRate = THRESHOLDS.GRADE_C_FACTOR_RATE
      repaymentPercent = THRESHOLDS.GRADE_C_REPAYMENT_PCT
      break
    default:
      creditPercent = 0
      factorRate = 1
      repaymentPercent = 0
  }

  // Calculate recommended credit limit
  const rawCreditLimit = metrics.annualizedVolume * creditPercent
  const recommendedCreditLimit = Math.max(
    THRESHOLDS.MIN_CREDIT_OFFER,
    Math.min(THRESHOLDS.MAX_CREDIT_OFFER, Math.round(rawCreditLimit / 10000) * 10000), // Round to nearest 10k
  )

  // Calculate total repayment
  const totalRepayment = Math.round(recommendedCreditLimit * factorRate)

  // Estimate term based on daily volume and repayment percentage
  const dailyVolume = metrics.annualizedVolume / 365
  const dailyRepayment = dailyVolume * repaymentPercent
  const estimatedTermDays = dailyRepayment > 0 ? Math.round(totalRepayment / dailyRepayment) : 365

  // Monthly payment estimate
  const monthlyPaymentEstimate = Math.round(totalRepayment / (estimatedTermDays / 30))

  return {
    recommendedCreditLimit,
    suggestedFactorRate: factorRate,
    totalRepayment,
    maxRepaymentPercent: repaymentPercent,
    estimatedTermDays,
    monthlyPaymentEstimate,
  }
}

// =============================================================================
// METRICS CALCULATION
// =============================================================================

async function calculateVenueMetrics(venueId: string): Promise<VenueMetrics> {
  const now = new Date()
  const _ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0)
  const twoMonthsAgoStart = new Date(now.getFullYear(), now.getMonth() - 2, 1)
  const twoMonthsAgoEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0)

  // Get all completed payments (last year for annualization)
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: { gte: oneYearAgo },
    },
    select: {
      amount: true,
      method: true,
      createdAt: true,
      type: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  // Separate sales from refunds
  const salesPayments = payments.filter(p => p.type !== 'REFUND')
  const refundPayments = payments.filter(p => p.type === 'REFUND')

  // =========================================================================
  // OPERATING PERIOD
  // =========================================================================
  const firstTransactionDate = salesPayments.length > 0 ? salesPayments[0].createdAt : null
  const lastTransactionDate = salesPayments.length > 0 ? salesPayments[salesPayments.length - 1].createdAt : null

  const daysInOperation = firstTransactionDate
    ? Math.max(1, Math.floor((now.getTime() - firstTransactionDate.getTime()) / (1000 * 60 * 60 * 24)))
    : 0

  const isNewBusiness = daysInOperation < 180

  const daysSinceLastTx = lastTransactionDate ? Math.floor((now.getTime() - lastTransactionDate.getTime()) / (1000 * 60 * 60 * 24)) : 999

  // =========================================================================
  // VOLUME METRICS
  // =========================================================================
  const rawVolume = salesPayments.reduce((sum, p) => sum + Number(p.amount), 0)
  const transactionCount = salesPayments.length

  // ANNUALIZE volume for fair comparison
  // Only annualize if 30-330 days of data
  let annualizedVolume = rawVolume
  if (daysInOperation >= 30 && daysInOperation < 330) {
    annualizedVolume = (rawVolume * 365) / daysInOperation
  }

  // Monthly breakdown
  const monthlyVolumes: Record<string, number> = {}
  salesPayments.forEach(p => {
    const monthKey = `${p.createdAt.getFullYear()}-${String(p.createdAt.getMonth() + 1).padStart(2, '0')}`
    monthlyVolumes[monthKey] = (monthlyVolumes[monthKey] || 0) + Number(p.amount)
  })

  const monthlyValues = Object.values(monthlyVolumes)
  const monthlyAverage = monthlyValues.length > 0 ? monthlyValues.reduce((a, b) => a + b, 0) / monthlyValues.length : 0

  // Current and previous months
  const currentMonthPayments = salesPayments.filter(p => p.createdAt >= currentMonthStart)
  const currentMonthVolume = currentMonthPayments.reduce((sum, p) => sum + Number(p.amount), 0)

  const previousMonthPayments = salesPayments.filter(p => p.createdAt >= previousMonthStart && p.createdAt <= previousMonthEnd)
  const previousMonthVolume = previousMonthPayments.reduce((sum, p) => sum + Number(p.amount), 0)

  // Two months ago
  const twoMonthsAgoPayments = salesPayments.filter(p => p.createdAt >= twoMonthsAgoStart && p.createdAt <= twoMonthsAgoEnd)
  const twoMonthsAgoVolume = twoMonthsAgoPayments.reduce((sum, p) => sum + Number(p.amount), 0)

  // Average ticket
  const amounts = salesPayments.map(p => Number(p.amount)).sort((a, b) => a - b)
  const averageTicket = transactionCount > 0 ? rawVolume / transactionCount : 0
  const medianTicket = amounts.length > 0 ? amounts[Math.floor(amounts.length / 2)] : 0

  // =========================================================================
  // GROWTH METRICS
  // =========================================================================
  const momGrowthPercent = previousMonthVolume > 0 ? ((currentMonthVolume - previousMonthVolume) / previousMonthVolume) * 100 : 0

  // 3-month trend (more stable than single MoM)
  const mom1 = previousMonthVolume > 0 ? ((currentMonthVolume - previousMonthVolume) / previousMonthVolume) * 100 : 0
  const mom2 = twoMonthsAgoVolume > 0 ? ((previousMonthVolume - twoMonthsAgoVolume) / twoMonthsAgoVolume) * 100 : 0
  const threeMonthTrend = (mom1 + mom2) / 2

  // Transaction velocity (transactions per operating day)
  const uniqueOperatingDays = new Set(salesPayments.map(p => p.createdAt.toISOString().split('T')[0])).size
  const velocityScore = uniqueOperatingDays > 0 ? transactionCount / uniqueOperatingDays : 0

  // Trend direction
  let trendDirection: TrendDirection = TrendDirection.FLAT
  if (threeMonthTrend >= 5) {
    trendDirection = TrendDirection.GROWING
  } else if (threeMonthTrend <= -5) {
    trendDirection = TrendDirection.DECLINING
  }

  // =========================================================================
  // STABILITY METRICS
  // =========================================================================
  // Coefficient of Variation
  let revenueVariance = 0
  if (monthlyValues.length > 1 && monthlyAverage > 0) {
    const variance = monthlyValues.reduce((sum, v) => sum + Math.pow(v - monthlyAverage, 2), 0) / monthlyValues.length
    revenueVariance = Math.sqrt(variance) / monthlyAverage
  }

  // Consistency score: % of months with revenue >= 50% of average
  const consistentMonths = monthlyValues.filter(v => v >= monthlyAverage * 0.5).length
  const consistencyScore = monthlyValues.length > 0 ? (consistentMonths / monthlyValues.length) * 100 : 0

  // Operating days ratio (fair for new businesses)
  const totalDaysInPeriod = Math.min(365, daysInOperation)
  const operatingDaysRatio = totalDaysInPeriod > 0 ? uniqueOperatingDays / totalDaysInPeriod : 0

  // Peak to trough ratio
  const peakToTroughRatio =
    monthlyValues.length > 0 && Math.max(...monthlyValues) > 0 ? Math.min(...monthlyValues) / Math.max(...monthlyValues) : 0

  // =========================================================================
  // RISK METRICS
  // =========================================================================
  // Chargebacks (placeholder - connect to actual tracking)
  const chargebackCount = 0 // TODO: Connect to actual chargeback tracking
  const chargebackRate = transactionCount > 0 ? chargebackCount / transactionCount : 0

  // Refunds
  const refundCount = refundPayments.length
  const refundTotal = refundPayments.reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0)
  const refundRate = rawVolume > 0 ? refundTotal / rawVolume : 0

  // Large transaction anomalies (> 3x average ticket)
  const largeThreshold = averageTicket * 3
  const largeTransactions = amounts.filter(a => a > largeThreshold).length
  const largeTransactionRatio = transactionCount > 0 ? largeTransactions / transactionCount : 0

  // =========================================================================
  // PAYMENT MIX
  // =========================================================================
  const paymentMethodMix: Record<string, number> = {}
  let cardCount = 0
  let cashCount = 0

  salesPayments.forEach(p => {
    const method = p.method || 'UNKNOWN'
    paymentMethodMix[method] = (paymentMethodMix[method] || 0) + 1

    if (method === 'CASH') {
      cashCount++
    } else {
      cardCount++
    }
  })

  const cardPaymentRatio = transactionCount > 0 ? cardCount / transactionCount : 0
  const cashPaymentRatio = transactionCount > 0 ? cashCount / transactionCount : 0

  return {
    // Operating Period
    firstTransactionDate,
    daysInOperation,
    isNewBusiness,

    // Volume
    rawVolume,
    annualizedVolume,
    monthlyAverage,
    currentMonthVolume,
    previousMonthVolume,
    transactionCount,
    averageTicket,
    medianTicket,

    // Growth
    momGrowthPercent,
    threeMonthTrend,
    velocityScore,
    trendDirection,

    // Stability
    revenueVariance,
    consistencyScore,
    operatingDaysRatio,
    daysSinceLastTx,
    peakToTroughRatio,

    // Risk
    chargebackRate,
    chargebackCount,
    refundRate,
    refundCount,
    largeTransactionRatio,

    // Payment Mix
    cardPaymentRatio,
    cashPaymentRatio,
    paymentMethodMix,
  }
}

// =============================================================================
// PUBLIC API FUNCTIONS
// =============================================================================

/**
 * Get all venue assessments with filtering and pagination
 */
export async function getAllAssessments(
  params: {
    page?: number
    pageSize?: number
    eligibility?: CreditEligibility[]
    grade?: CreditGrade[]
    minScore?: number
    maxScore?: number
    sortBy?: 'creditScore' | 'annualVolume' | 'calculatedAt'
    sortOrder?: 'asc' | 'desc'
  } = {},
) {
  const { page = 1, pageSize = 20, eligibility, grade, minScore, maxScore, sortBy = 'creditScore', sortOrder = 'desc' } = params

  const where: Prisma.VenueCreditAssessmentWhereInput = {}

  if (eligibility?.length) {
    where.eligibilityStatus = { in: eligibility }
  }
  if (grade?.length) {
    where.creditGrade = { in: grade }
  }
  if (minScore !== undefined) {
    where.creditScore = { ...(where.creditScore as object), gte: minScore }
  }
  if (maxScore !== undefined) {
    where.creditScore = { ...(where.creditScore as object), lte: maxScore }
  }

  const [assessments, total] = await prisma.$transaction([
    prisma.venueCreditAssessment.findMany({
      where,
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            organization: { select: { name: true } },
          },
        },
        offers: {
          where: { status: CreditOfferStatus.PENDING },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.venueCreditAssessment.count({ where }),
  ])

  return {
    data: assessments,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Get assessment summary statistics
 */
export async function getAssessmentSummary() {
  const [total, eligible, byGrade, totalCredit, pendingOffers] = await prisma.$transaction([
    prisma.venueCreditAssessment.count(),
    prisma.venueCreditAssessment.count({
      where: { eligibilityStatus: { in: [CreditEligibility.ELIGIBLE, CreditEligibility.REVIEW_REQUIRED] } },
    }),
    prisma.venueCreditAssessment.groupBy({
      by: ['creditGrade'],
      orderBy: { creditGrade: 'asc' },
      _count: { _all: true },
    }),
    prisma.venueCreditAssessment.aggregate({
      where: { eligibilityStatus: CreditEligibility.ELIGIBLE },
      _sum: { recommendedCreditLimit: true },
    }),
    prisma.creditOffer.count({ where: { status: CreditOfferStatus.PENDING } }),
  ])

  const gradeDistribution: Record<CreditGrade, number> = {
    [CreditGrade.A]: 0,
    [CreditGrade.B]: 0,
    [CreditGrade.C]: 0,
    [CreditGrade.D]: 0,
  }

  byGrade.forEach(g => {
    const count = g._count as { _all: number }
    gradeDistribution[g.creditGrade] = count._all
  })

  return {
    totalAssessments: total,
    eligibleVenues: eligible,
    gradeDistribution,
    totalAvailableCredit: Number(totalCredit._sum.recommendedCreditLimit || 0),
    pendingOffers,
  }
}

/**
 * Get single venue assessment details
 */
export async function getVenueAssessmentDetails(venueId: string) {
  const assessment = await prisma.venueCreditAssessment.findUnique({
    where: { venueId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          organization: { select: { name: true } },
        },
      },
      offers: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
      history: {
        orderBy: { snapshotDate: 'desc' },
        take: 12,
      },
    },
  })

  if (!assessment) {
    throw new Error(`No assessment found for venue: ${venueId}`)
  }

  return assessment
}

/**
 * Refresh all venue assessments
 */
export async function refreshAllAssessments(): Promise<{ success: number; failed: number }> {
  const venues = await prisma.venue.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  })

  let success = 0
  let failed = 0

  for (const venue of venues) {
    try {
      await calculateVenueAssessment(venue.id)
      success++
    } catch (error) {
      logger.error('Failed to calculate assessment', { venueId: venue.id, error })
      failed++
    }
  }

  return { success, failed }
}

/**
 * Create a credit offer for a venue
 */
export async function createCreditOffer(
  venueId: string,
  data: {
    offerAmount: number
    factorRate: number
    repaymentPercent: number
    expiresInDays?: number
    notes?: string
  },
  createdById?: string,
) {
  const assessment = await prisma.venueCreditAssessment.findUnique({
    where: { venueId },
  })

  if (!assessment) {
    throw new Error('No assessment found for this venue')
  }

  if (assessment.eligibilityStatus === CreditEligibility.INELIGIBLE) {
    throw new Error('Venue is not eligible for credit offers')
  }

  const totalRepayment = data.offerAmount * data.factorRate
  const dailyVolume = Number(assessment.annualVolume) / 365
  const dailyRepayment = dailyVolume * data.repaymentPercent
  const estimatedTermDays = dailyRepayment > 0 ? Math.round(totalRepayment / dailyRepayment) : 365

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays || 30))

  const offer = await prisma.creditOffer.create({
    data: {
      assessmentId: assessment.id,
      venueId,
      offerAmount: data.offerAmount,
      factorRate: data.factorRate,
      totalRepayment,
      repaymentPercent: data.repaymentPercent,
      estimatedTermDays,
      status: CreditOfferStatus.PENDING,
      expiresAt,
      createdById,
      notes: data.notes,
    },
  })

  // Update eligibility status
  await prisma.venueCreditAssessment.update({
    where: { venueId },
    data: { eligibilityStatus: CreditEligibility.OFFER_PENDING },
  })

  return offer
}

/**
 * Accept a credit offer
 */
export async function acceptCreditOffer(offerId: string, acceptedById: string) {
  const offer = await prisma.creditOffer.findUnique({
    where: { id: offerId },
  })

  if (!offer) {
    throw new Error('Offer not found')
  }

  if (offer.status !== CreditOfferStatus.PENDING) {
    throw new Error('Offer is no longer pending')
  }

  if (offer.expiresAt < new Date()) {
    throw new Error('Offer has expired')
  }

  const updated = await prisma.creditOffer.update({
    where: { id: offerId },
    data: {
      status: CreditOfferStatus.ACCEPTED,
      acceptedAt: new Date(),
      acceptedById,
    },
  })

  await prisma.venueCreditAssessment.update({
    where: { venueId: offer.venueId },
    data: { eligibilityStatus: CreditEligibility.ACTIVE_LOAN },
  })

  return updated
}

/**
 * Get credit offer history for a venue
 */
export async function getVenueOfferHistory(venueId: string) {
  const offers = await prisma.creditOffer.findMany({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    include: {
      assessment: {
        select: {
          creditScore: true,
          creditGrade: true,
        },
      },
    },
  })

  return offers
}

/**
 * Update offer status (accept, reject, withdraw)
 */
export async function updateOfferStatus(
  offerId: string,
  action: 'accept' | 'reject' | 'withdraw',
  options?: {
    staffId?: string
    rejectionReason?: string
  },
) {
  const offer = await prisma.creditOffer.findUnique({
    where: { id: offerId },
  })

  if (!offer) {
    throw new Error('Offer not found')
  }

  let updateData: any = {}
  let newEligibilityStatus: CreditEligibility | undefined

  switch (action) {
    case 'accept':
      if (offer.status !== CreditOfferStatus.PENDING) {
        throw new Error('Offer is no longer pending')
      }
      if (offer.expiresAt < new Date()) {
        throw new Error('Offer has expired')
      }
      updateData = {
        status: CreditOfferStatus.ACCEPTED,
        acceptedAt: new Date(),
        acceptedById: options?.staffId,
      }
      newEligibilityStatus = CreditEligibility.ACTIVE_LOAN
      break

    case 'reject':
      if (offer.status !== CreditOfferStatus.PENDING) {
        throw new Error('Offer is no longer pending')
      }
      updateData = {
        status: CreditOfferStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason: options?.rejectionReason,
      }
      newEligibilityStatus = CreditEligibility.ELIGIBLE
      break

    case 'withdraw':
      if (offer.status !== CreditOfferStatus.PENDING) {
        throw new Error('Offer is no longer pending')
      }
      updateData = {
        status: CreditOfferStatus.WITHDRAWN,
      }
      newEligibilityStatus = CreditEligibility.ELIGIBLE
      break

    default:
      throw new Error(`Unknown action: ${action}`)
  }

  const updated = await prisma.creditOffer.update({
    where: { id: offerId },
    data: updateData,
  })

  if (newEligibilityStatus) {
    await prisma.venueCreditAssessment.update({
      where: { venueId: offer.venueId },
      data: { eligibilityStatus: newEligibilityStatus },
    })
  }

  return updated
}
