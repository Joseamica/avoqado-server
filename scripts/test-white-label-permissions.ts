/**
 * Exhaustive White-Label Permissions Testing Script
 *
 * Tests the white-label access control system with different:
 * - User roles (OWNER, ADMIN, MANAGER, CASHIER, VIEWER)
 * - Features (SERIALIZED_STOCK, COMMAND_CENTER, etc.)
 * - Venues (white-label vs non-white-label)
 */

import axios, { AxiosError } from 'axios'

const API_BASE = 'http://localhost:8000/api/v1/dashboard'

// Test users with their expected roles
const TEST_USERS = {
  OWNER: { email: 'manager@playtelecom.mx', password: 'Avoqado123!' },
  MANAGER: { email: 'daniel@playtelecom.mx', password: 'Avoqado123!' },
  CASHIER: { email: 'maria.promotor@playtelecom.mx', password: 'Avoqado123!' },
  VIEWER: { email: 'joseamica@gmail.com', password: 'Avoqado123!' },
}

// White-label venue
const WL_VENUE_ID = 'cmko8m8vp00049kcxd3xk21za' // playtelecom-centro

// Expected access based on config:
// SERIALIZED_STOCK: OWNER, ADMIN, MANAGER, VIEWER
// COMMAND_CENTER: OWNER, ADMIN only
// STORES_ANALYSIS: OWNER, ADMIN, MANAGER, VIEWER
const EXPECTED_ACCESS = {
  // Feature: [roles that SHOULD have access]
  SERIALIZED_STOCK: ['OWNER', 'ADMIN', 'MANAGER', 'VIEWER'],
  COMMAND_CENTER: ['OWNER', 'ADMIN'],
  PROMOTERS_AUDIT: ['OWNER', 'ADMIN', 'MANAGER', 'VIEWER'],
}

// Endpoints to test for each feature
const FEATURE_ENDPOINTS = {
  SERIALIZED_STOCK: [
    { method: 'GET', path: `/venues/${WL_VENUE_ID}/stock/metrics` },
    { method: 'GET', path: `/venues/${WL_VENUE_ID}/stock/categories` },
    { method: 'GET', path: `/venues/${WL_VENUE_ID}/stock/movements` },
  ],
  COMMAND_CENTER: [
    { method: 'GET', path: `/venues/${WL_VENUE_ID}/command-center/summary` },
    { method: 'GET', path: `/venues/${WL_VENUE_ID}/command-center/activity` },
    { method: 'GET', path: `/venues/${WL_VENUE_ID}/command-center/insights` },
  ],
  PROMOTERS_AUDIT: [{ method: 'GET', path: `/venues/${WL_VENUE_ID}/promoters` }],
}

interface TestResult {
  feature: string
  endpoint: string
  role: string
  expected: 'ALLOW' | 'DENY'
  actual: 'ALLOW' | 'DENY'
  status: number
  passed: boolean
  error?: string
}

const results: TestResult[] = []

async function login(email: string, password: string): Promise<string | null> {
  try {
    const response = await axios.post(`${API_BASE}/login`, {
      email,
      password,
      venueId: WL_VENUE_ID,
    })
    return response.data.token
  } catch (error) {
    console.error(`Login failed for ${email}:`, (error as AxiosError).response?.data || (error as Error).message)
    return null
  }
}

async function testEndpoint(
  token: string,
  method: string,
  path: string,
  feature: string,
  role: string,
  expectedAccess: boolean,
): Promise<TestResult> {
  const expected = expectedAccess ? 'ALLOW' : 'DENY'

  try {
    const response = await axios({
      method: method as any,
      url: `${API_BASE}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const actual = 'ALLOW'
    return {
      feature,
      endpoint: `${method} ${path}`,
      role,
      expected,
      actual,
      status: response.status,
      passed: expected === actual,
    }
  } catch (error) {
    const axiosError = error as AxiosError
    const status = axiosError.response?.status || 0
    const actual = status === 403 ? 'DENY' : 'ALLOW'
    const errorData = axiosError.response?.data as any

    return {
      feature,
      endpoint: `${method} ${path}`,
      role,
      expected,
      actual,
      status,
      passed: expected === actual,
      error: status !== 403 && status !== 200 ? `Unexpected status: ${status} - ${errorData?.message || ''}` : undefined,
    }
  }
}

async function runTests() {
  console.log('='.repeat(80))
  console.log('WHITE-LABEL PERMISSIONS EXHAUSTIVE TEST')
  console.log('='.repeat(80))
  console.log()

  // Login all users
  console.log('Logging in test users...')
  const tokens: Record<string, string> = {}

  for (const [role, creds] of Object.entries(TEST_USERS)) {
    const token = await login(creds.email, creds.password)
    if (token) {
      tokens[role] = token
      console.log(`  ✓ ${role}: ${creds.email}`)
    } else {
      console.log(`  ✗ ${role}: ${creds.email} (login failed)`)
    }
  }
  console.log()

  // Test each feature
  for (const [feature, endpoints] of Object.entries(FEATURE_ENDPOINTS)) {
    console.log(`\nTesting feature: ${feature}`)
    console.log('-'.repeat(60))

    const allowedRoles = EXPECTED_ACCESS[feature as keyof typeof EXPECTED_ACCESS] || []

    for (const endpoint of endpoints) {
      for (const [role, token] of Object.entries(tokens)) {
        const shouldHaveAccess = allowedRoles.includes(role)
        const result = await testEndpoint(token, endpoint.method, endpoint.path, feature, role, shouldHaveAccess)
        results.push(result)

        const icon = result.passed ? '✓' : '✗'
        const color = result.passed ? '\x1b[32m' : '\x1b[31m'
        const reset = '\x1b[0m'

        console.log(
          `  ${color}${icon}${reset} ${role.padEnd(10)} | Expected: ${result.expected.padEnd(5)} | Actual: ${result.actual.padEnd(5)} | Status: ${result.status} ${result.error ? `| ${result.error}` : ''}`,
        )
      }
    }
  }

  // Summary
  console.log()
  console.log('='.repeat(80))
  console.log('SUMMARY')
  console.log('='.repeat(80))

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const total = results.length

  console.log(`Total tests: ${total}`)
  console.log(`\x1b[32mPassed: ${passed}\x1b[0m`)
  console.log(`\x1b[31mFailed: ${failed}\x1b[0m`)

  if (failed > 0) {
    console.log()
    console.log('Failed tests:')
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  - ${result.feature} | ${result.endpoint} | ${result.role}`)
      console.log(`    Expected: ${result.expected}, Actual: ${result.actual}, Status: ${result.status}`)
      if (result.error) console.log(`    Error: ${result.error}`)
    }
  }

  console.log()
  return failed === 0
}

// Run tests
runTests()
  .then(success => {
    process.exit(success ? 0 : 1)
  })
  .catch(err => {
    console.error('Test execution failed:', err)
    process.exit(1)
  })
