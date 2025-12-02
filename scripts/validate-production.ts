/**
 * Production Validation Script for Avoqado
 *
 * Validates that the system is correctly configured for production deployment.
 * Checks environment variables, database entities, and Blumon integration readiness.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/validate-production.ts
 *
 * Options:
 *   --test-blumon    Also test connection to Blumon APIs (requires credentials)
 *   --verbose        Show detailed information for each check
 *
 * @author Avoqado Team
 * @date 2025-12-02
 */

import prisma from '@/utils/prismaClient'
import axios from 'axios'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface CheckResult {
  name: string
  status: 'PASS' | 'FAIL' | 'WARN' | 'INFO'
  message: string
  details?: string[]
}

interface ValidationReport {
  timestamp: string
  environment: string
  checks: CheckResult[]
  summary: {
    total: number
    passed: number
    failed: number
    warnings: number
  }
  recommendation: 'GO' | 'NO-GO' | 'REVIEW'
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const REQUIRED_ENV_VARS = {
  core: ['NODE_ENV', 'DATABASE_URL', 'SESSION_SECRET', 'COOKIE_SECRET', 'ACCESS_TOKEN_SECRET'],
  blumon: ['USE_BLUMON_MOCK', 'BLUMON_KYC_EMAILS'],
  infrastructure: ['RABBITMQ_URL'],
}

const PRODUCTION_VALUES = {
  NODE_ENV: 'production',
  USE_BLUMON_MOCK: 'false',
}

const BLUMON_URLS = {
  sandbox: {
    tokenServer: 'https://sandbox-tokener.blumonpay.net',
    coreServer: 'https://sandbox-core.blumonpay.net',
    ecommerce: 'https://sandbox-ecommerce.blumonpay.net',
  },
  production: {
    tokenServer: 'https://tokener.blumonpay.net',
    coreServer: 'https://core.blumonpay.net',
    ecommerce: 'https://ecommerce.blumonpay.net',
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function log(emoji: string, message: string) {
  console.log(`${emoji} ${message}`)
}

function createCheck(name: string, status: CheckResult['status'], message: string, details?: string[]): CheckResult {
  return { name, status, message, details }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION CHECKS
// ═══════════════════════════════════════════════════════════════════════════

async function checkEnvironmentVariables(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  log('🔍', 'Checking environment variables...\n')

  // Check NODE_ENV
  const nodeEnv = process.env.NODE_ENV
  if (nodeEnv === 'production') {
    results.push(createCheck('NODE_ENV', 'PASS', 'Set to production'))
  } else {
    results.push(createCheck('NODE_ENV', 'WARN', `Set to "${nodeEnv}" (expected: production)`))
  }

  // Check USE_BLUMON_MOCK (ONLY for E-commerce)
  const useBlumonMock = process.env.USE_BLUMON_MOCK
  if (useBlumonMock === 'false') {
    results.push(createCheck('USE_BLUMON_MOCK', 'PASS', 'Set to false (E-commerce will use real Blumon API)'))
  } else if (useBlumonMock === 'true') {
    results.push(
      createCheck('USE_BLUMON_MOCK', 'WARN', 'Set to true (E-commerce will use mock)', [
        'Note: This only affects E-commerce (payment links)',
        'TPV (Android terminals) is controlled by APK build variant, NOT this variable',
      ]),
    )
  } else {
    results.push(
      createCheck('USE_BLUMON_MOCK', 'INFO', `Not set (defaults to true)`, [
        'E-commerce will use mock service',
        'Set USE_BLUMON_MOCK=false for real Blumon E-commerce API',
      ]),
    )
  }

  // Check required secrets exist (without exposing values)
  const secrets = ['ACCESS_TOKEN_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'DATABASE_URL']
  for (const secret of secrets) {
    if (process.env[secret] && process.env[secret]!.length >= 16) {
      results.push(createCheck(secret, 'PASS', 'Set and meets minimum length'))
    } else if (process.env[secret]) {
      results.push(createCheck(secret, 'FAIL', 'Set but too short (security risk)'))
    } else {
      results.push(createCheck(secret, 'FAIL', 'Not set (required for production)'))
    }
  }

  // Check BLUMON_KYC_EMAILS
  const kycEmails = process.env.BLUMON_KYC_EMAILS
  if (kycEmails && kycEmails.includes('@')) {
    const emails = kycEmails.split(',').length
    results.push(createCheck('BLUMON_KYC_EMAILS', 'PASS', `Set with ${emails} email(s)`))
  } else {
    results.push(createCheck('BLUMON_KYC_EMAILS', 'WARN', 'Not set', ['KYC documents will not be sent to Blumon automatically']))
  }

  // Check STRIPE_SECRET_KEY (production vs test)
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (stripeKey?.startsWith('sk_live_')) {
    results.push(createCheck('STRIPE_SECRET_KEY', 'PASS', 'Using LIVE key'))
  } else if (stripeKey?.startsWith('sk_test_')) {
    results.push(createCheck('STRIPE_SECRET_KEY', 'WARN', 'Using TEST key (not real payments)'))
  } else if (!stripeKey) {
    results.push(createCheck('STRIPE_SECRET_KEY', 'INFO', 'Not set (Stripe features disabled)'))
  }

  return results
}

async function checkDatabaseEntities(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  log('🔍', 'Checking database entities...\n')

  // Check PaymentProvider BLUMON exists
  try {
    const blumonProvider = await prisma.paymentProvider.findUnique({
      where: { code: 'BLUMON' },
    })

    if (blumonProvider) {
      if (blumonProvider.active) {
        results.push(createCheck('PaymentProvider BLUMON', 'PASS', 'Exists and is active'))
      } else {
        results.push(createCheck('PaymentProvider BLUMON', 'WARN', 'Exists but is INACTIVE'))
      }
    } else {
      results.push(
        createCheck('PaymentProvider BLUMON', 'FAIL', 'Does not exist', [
          'Run seed script or create manually in database',
          'Required for both TPV and E-commerce Blumon payments',
        ]),
      )
    }
  } catch (error) {
    results.push(createCheck('PaymentProvider BLUMON', 'FAIL', `Database error: ${error}`))
  }

  // Check MerchantAccounts (TPV)
  try {
    const merchantAccounts = await prisma.merchantAccount.findMany({
      where: {
        provider: { code: 'BLUMON' },
      },
      include: {
        provider: true,
        costStructures: {
          where: { active: true },
        },
      },
    })

    if (merchantAccounts.length === 0) {
      results.push(
        createCheck('MerchantAccounts (TPV)', 'INFO', 'No BLUMON merchant accounts found', [
          'Create MerchantAccount when you receive production terminals',
          'Each terminal needs a MerchantAccount with blumonSerialNumber',
        ]),
      )
    } else {
      const productionAccounts = merchantAccounts.filter(
        (ma: any) => ma.blumonEnvironment === 'PRODUCTION' || ma.blumonEnvironment === 'PROD',
      )
      const sandboxAccounts = merchantAccounts.filter((ma: any) => ma.blumonEnvironment === 'SANDBOX' || ma.blumonEnvironment === 'SAND')
      const activeAccounts = merchantAccounts.filter((ma: any) => ma.active)
      const accountsWithCostStructure = merchantAccounts.filter((ma: any) => ma.costStructures.length > 0)

      results.push(
        createCheck(
          'MerchantAccounts (TPV)',
          productionAccounts.length > 0 ? 'PASS' : 'WARN',
          `${merchantAccounts.length} total (${productionAccounts.length} PRODUCTION, ${sandboxAccounts.length} SANDBOX)`,
          [
            `Active: ${activeAccounts.length}`,
            `With cost structure: ${accountsWithCostStructure.length}`,
            productionAccounts.length === 0 ? '⚠️ No PRODUCTION accounts - payments will use sandbox' : '',
          ].filter(Boolean),
        ),
      )

      // Check each merchant account has required fields
      for (const ma of merchantAccounts) {
        const issues: string[] = []
        if (!(ma as any).blumonSerialNumber) issues.push('Missing blumonSerialNumber')
        if (!(ma as any).blumonPosId) issues.push('Missing blumonPosId')
        if (ma.costStructures.length === 0) issues.push('No active cost structure')

        if (issues.length > 0) {
          results.push(createCheck(`MerchantAccount ${ma.alias || ma.id.slice(0, 8)}`, 'WARN', 'Has issues', issues))
        }
      }
    }
  } catch (error) {
    results.push(createCheck('MerchantAccounts (TPV)', 'FAIL', `Database error: ${error}`))
  }

  // Check EcommerceMerchants
  try {
    const ecommerceMerchants = await prisma.ecommerceMerchant.findMany({
      where: {
        provider: { code: 'BLUMON' },
      },
      include: {
        provider: true,
        venue: true,
      },
    })

    if (ecommerceMerchants.length === 0) {
      results.push(
        createCheck('EcommerceMerchants', 'INFO', 'No BLUMON e-commerce merchants found', [
          'Create EcommerceMerchant to enable payment links feature',
          'Optional - only needed if using Blumon E-commerce SDK',
        ]),
      )
    } else {
      const activeCount = ecommerceMerchants.filter((em: any) => em.active).length
      const sandboxCount = ecommerceMerchants.filter((em: any) => em.sandboxMode).length
      const prodCount = ecommerceMerchants.filter((em: any) => !em.sandboxMode).length

      results.push(
        createCheck(
          'EcommerceMerchants',
          prodCount > 0 ? 'PASS' : 'WARN',
          `${ecommerceMerchants.length} total (${prodCount} PRODUCTION, ${sandboxCount} SANDBOX)`,
          [`Active: ${activeCount}`, sandboxCount > 0 && prodCount === 0 ? '⚠️ All merchants are in sandbox mode' : ''].filter(Boolean),
        ),
      )

      // Check credentials validity
      for (const em of ecommerceMerchants) {
        const creds = em.providerCredentials as any
        const hasValidToken = creds?.accessToken && creds.accessToken !== 'test_token'
        const tokenExpired = creds?.expiresAt && new Date(creds.expiresAt) < new Date()

        if (!hasValidToken) {
          results.push(
            createCheck(`EcommerceMerchant ${em.businessName}`, 'WARN', 'Missing valid OAuth token', [
              'Run OAuth flow to get valid credentials',
            ]),
          )
        } else if (tokenExpired) {
          results.push(
            createCheck(`EcommerceMerchant ${em.businessName}`, 'WARN', 'OAuth token expired', [
              `Expired at: ${creds.expiresAt}`,
              'Token will be refreshed automatically on next API call',
            ]),
          )
        }
      }
    }
  } catch (error) {
    results.push(createCheck('EcommerceMerchants', 'FAIL', `Database error: ${error}`))
  }

  // Check ProviderCostStructures
  try {
    const costStructures = await prisma.providerCostStructure.findMany({
      where: {
        provider: { code: 'BLUMON' },
        active: true,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
      },
      include: {
        merchantAccount: true,
      },
    })

    if (costStructures.length === 0) {
      results.push(
        createCheck('ProviderCostStructures', 'WARN', 'No active cost structures for BLUMON', [
          'Cost structures define commission rates for each merchant account',
          'Create before processing production payments',
        ]),
      )
    } else {
      results.push(
        createCheck('ProviderCostStructures', 'PASS', `${costStructures.length} active cost structure(s)`, [
          ...costStructures.map(
            (cs: any) =>
              `${cs.merchantAccount.alias || cs.merchantAccountId.slice(0, 8)}: Debit ${Number(cs.debitRate) * 100}%, Credit ${Number(cs.creditRate) * 100}%`,
          ),
        ]),
      )
    }
  } catch (error) {
    results.push(createCheck('ProviderCostStructures', 'FAIL', `Database error: ${error}`))
  }

  return results
}

async function checkBlumonConnectivity(testProduction: boolean): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  log('🔍', 'Checking Blumon API connectivity...\n')

  const environments = testProduction ? ['sandbox', 'production'] : ['sandbox']

  for (const env of environments) {
    const urls = BLUMON_URLS[env as keyof typeof BLUMON_URLS]

    // Test token server
    try {
      const response = await axios.get(urls.tokenServer, { timeout: 5000 })
      results.push(createCheck(`Blumon ${env} Token Server`, 'PASS', 'Reachable'))
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        results.push(createCheck(`Blumon ${env} Token Server`, 'FAIL', `Cannot connect: ${error.code}`))
      } else if (error.response) {
        // Server responded (even with error) means it's reachable
        results.push(createCheck(`Blumon ${env} Token Server`, 'PASS', `Reachable (status: ${error.response.status})`))
      } else {
        results.push(createCheck(`Blumon ${env} Token Server`, 'WARN', `Connection issue: ${error.message}`))
      }
    }

    // Test core server
    try {
      const response = await axios.get(urls.coreServer, { timeout: 5000 })
      results.push(createCheck(`Blumon ${env} Core Server`, 'PASS', 'Reachable'))
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        results.push(createCheck(`Blumon ${env} Core Server`, 'FAIL', `Cannot connect: ${error.code}`))
      } else if (error.response) {
        results.push(createCheck(`Blumon ${env} Core Server`, 'PASS', `Reachable (status: ${error.response.status})`))
      } else {
        results.push(createCheck(`Blumon ${env} Core Server`, 'WARN', `Connection issue: ${error.message}`))
      }
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════════

function generateReport(checks: CheckResult[]): ValidationReport {
  const passed = checks.filter(c => c.status === 'PASS').length
  const failed = checks.filter(c => c.status === 'FAIL').length
  const warnings = checks.filter(c => c.status === 'WARN').length

  let recommendation: ValidationReport['recommendation']
  if (failed > 0) {
    recommendation = 'NO-GO'
  } else if (warnings > 2) {
    recommendation = 'REVIEW'
  } else {
    recommendation = 'GO'
  }

  return {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'unknown',
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
      warnings,
    },
    recommendation,
  }
}

function printReport(report: ValidationReport, verbose: boolean) {
  console.log('\n')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('     AVOQADO PRODUCTION VALIDATION REPORT')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`  Timestamp: ${report.timestamp}`)
  console.log(`  Environment: ${report.environment}`)
  console.log('═══════════════════════════════════════════════════════════════════\n')

  // Print checks
  for (const check of report.checks) {
    const statusEmoji = check.status === 'PASS' ? '✅' : check.status === 'FAIL' ? '❌' : check.status === 'WARN' ? '⚠️' : 'ℹ️'

    console.log(`${statusEmoji} ${check.name}`)
    console.log(`   ${check.message}`)

    if (verbose && check.details && check.details.length > 0) {
      for (const detail of check.details) {
        console.log(`   └─ ${detail}`)
      }
    }
    console.log('')
  }

  // Print summary
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('                         SUMMARY')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`  Total Checks: ${report.summary.total}`)
  console.log(`  ✅ Passed:    ${report.summary.passed}`)
  console.log(`  ❌ Failed:    ${report.summary.failed}`)
  console.log(`  ⚠️ Warnings:  ${report.summary.warnings}`)
  console.log('═══════════════════════════════════════════════════════════════════\n')

  // Print recommendation
  const recEmoji = report.recommendation === 'GO' ? '🟢' : report.recommendation === 'NO-GO' ? '🔴' : '🟡'
  const recMessage =
    report.recommendation === 'GO'
      ? 'System is ready for production'
      : report.recommendation === 'NO-GO'
        ? 'System has critical issues - DO NOT deploy to production'
        : 'System has warnings - Review before deploying'

  console.log(`  ${recEmoji} RECOMMENDATION: ${report.recommendation}`)
  console.log(`     ${recMessage}\n`)

  // Print important notes
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('                    IMPORTANT NOTES')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  ⚠️ REMEMBER: Blumon has TWO separate integrations:')
  console.log('')
  console.log('  📱 TPV (Android terminals):')
  console.log('     - Environment controlled by APK BUILD VARIANT')
  console.log('     - USE_BLUMON_MOCK does NOT affect TPV')
  console.log('     - Compile with: ./gradlew assembleProductionRelease')
  console.log('')
  console.log('  🌐 E-commerce (payment links):')
  console.log('     - Environment controlled by USE_BLUMON_MOCK')
  console.log('     - USE_BLUMON_MOCK=false → Real Blumon API')
  console.log('     - USE_BLUMON_MOCK=true → Mock service')
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2)
  const testBlumon = args.includes('--test-blumon')
  const verbose = args.includes('--verbose') || args.includes('-v')

  console.log('\n')
  log('🚀', 'Starting Avoqado Production Validation...')
  console.log('')

  const allChecks: CheckResult[] = []

  // Run all checks
  const envChecks = await checkEnvironmentVariables()
  allChecks.push(...envChecks)

  const dbChecks = await checkDatabaseEntities()
  allChecks.push(...dbChecks)

  if (testBlumon) {
    const connectivityChecks = await checkBlumonConnectivity(true)
    allChecks.push(...connectivityChecks)
  }

  // Generate and print report
  const report = generateReport(allChecks)
  printReport(report, verbose)

  // Cleanup
  await prisma.$disconnect()

  // Exit with appropriate code
  process.exit(report.recommendation === 'NO-GO' ? 1 : 0)
}

main().catch(async error => {
  console.error('❌ Fatal error during validation:', error)
  await prisma.$disconnect()
  process.exit(1)
})
