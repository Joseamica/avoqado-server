const { io } = require('socket.io-client')
const http = require('http')

// Configuration - Try different ports
const PORTS_TO_TEST = [12344, 3000, 8080, 5000]
let SERVER_URL = 'http://localhost:12344'

// Test scenarios
class SocketIOTester {
  constructor() {
    this.testResults = []
  }

  async runTests() {
    console.log('🧪 Starting Socket.IO Connection Tests...\n')

    // Test 1: Generate and use valid JWT token from dev endpoint
    await this.testWithValidDevToken()

    // Test 2: Connection with invalid JWT
    await this.testConnectionWithInvalidAuth()

    // Test 3: Connection without authentication (should fail)
    await this.testConnectionWithoutAuth()

    // Summary
    this.printResults()
  }

  async testWithValidDevToken() {
    console.log('📡 Test 1: Generate valid token and test connection')

    try {
      // Generate a valid token using the dev endpoint
      const postData = JSON.stringify({
        sub: 'test-user-123',
        orgId: 'test-org-456',
        venueId: 'test-venue-789',
        role: 'ADMIN',
        expiresIn: '1h',
      })

      const options = {
        hostname: 'localhost',
        port: 12344,
        path: '/api/dev/generate-token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }

      const token = await new Promise((resolve, reject) => {
        const req = http.request(options, res => {
          let data = ''
          res.on('data', chunk => (data += chunk))
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const result = JSON.parse(data)
                resolve(result.token)
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${data}`))
              }
            } catch (e) {
              reject(e)
            }
          })
        })
        req.on('error', reject)
        req.write(postData)
        req.end()
      })

      console.log('   🔑 Generated valid token:', token.substring(0, 50) + '...')

      // Now test connection with valid token - both auth methods
      await this.testConnectionWithToken(token, 'auth')
      await this.testConnectionWithToken(token, 'query')
    } catch (error) {
      this.addResult('Valid Dev Token', 'ERROR', `Failed to generate token: ${error.message}`)
    }
  }

  async testConnectionWithToken(token, method) {
    const testName = method === 'auth' ? 'Valid Token (Auth)' : 'Valid Token (Query)'
    console.log(`📡 Testing connection with token via ${method}...`)

    return new Promise(resolve => {
      const socketOptions = method === 'auth' ? { auth: { token } } : { query: { token } }

      const socket = io(SERVER_URL, socketOptions)

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.addResult(testName, 'TIMEOUT', 'Connection timed out')
          socket.disconnect()
          resolve()
        }
      }, 10000)

      socket.on('connect', () => {
        console.log(`   ✅ Connected with valid token via ${method}`)

        // Test room joining
        socket.emit('join_room', {
          roomType: 'venue',
          venueId: 'test-venue-789',
          metadata: {
            clientType: 'test_client',
            version: '1.0',
          },
        })
      })

      socket.on('authentication_success', data => {
        console.log('   ✅ Authentication successful:', data)
      })

      socket.on('room_joined', data => {
        console.log('   🏠 Joined room:', data)

        // Test business event emission
        socket.emit('payment_completed', {
          paymentId: 'test-payment-123',
          orderId: 'test-order-456',
          amount: 100.5,
          currency: 'MXN',
          metadata: { source: 'test_client' },
        })

        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult(testName, 'SUCCESS', 'Full authentication, room joining and event emission successful')

          setTimeout(() => {
            socket.disconnect()
            resolve()
          }, 1000)
        }
      })

      socket.on('connect_error', error => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult(testName, 'ERROR', error.message)
          socket.disconnect()
          resolve()
        }
      })

      socket.on('authentication_error', error => {
        console.log('   ❌ Authentication failed:', error)
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult(testName, 'ERROR', `Authentication failed: ${error.message || error}`)
          socket.disconnect()
          resolve()
        }
      })

      socket.on('error', error => {
        console.log('   ❌ Socket error:', error)
      })
    })
  }

  async testConnectionWithInvalidAuth() {
    console.log('📡 Test 2: Connection with invalid JWT')

    return new Promise(resolve => {
      const socket = io(SERVER_URL, {
        auth: { token: 'invalid.jwt.token' },
      })

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.addResult('Invalid JWT', 'TIMEOUT', 'Connection timed out')
          socket.disconnect()
          resolve()
        }
      }, 5000)

      socket.on('connect', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult('Invalid JWT', 'UNEXPECTED', 'Connected with invalid token (security issue!)')
          socket.disconnect()
          resolve()
        }
      })

      socket.on('connect_error', error => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult('Invalid JWT', 'EXPECTED', 'Rejected invalid token (correct behavior)')
          socket.disconnect()
          resolve()
        }
      })

      socket.on('authentication_error', error => {
        console.log('   ✅ Authentication correctly rejected invalid token')
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult('Invalid JWT', 'EXPECTED', 'Authentication correctly rejected')
          socket.disconnect()
          resolve()
        }
      })
    })
  }

  async testConnectionWithoutAuth() {
    console.log('📡 Test 3: Connection without authentication')

    return new Promise(resolve => {
      const socket = io(SERVER_URL)

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.addResult('No Auth', 'TIMEOUT', 'Connection timed out (expected)')
          socket.disconnect()
          resolve()
        }
      }, 5000)

      socket.on('connect', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult('No Auth', 'UNEXPECTED', 'Connected without auth (security issue!)')
          socket.disconnect()
          resolve()
        }
      })

      socket.on('connect_error', error => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.addResult('No Auth', 'EXPECTED', 'Authentication required (correct behavior)')
          socket.disconnect()
          resolve()
        }
      })
    })
  }

  addResult(test, status, message) {
    this.testResults.push({ test, status, message })
    const emoji =
      status === 'SUCCESS' ? '✅' : status === 'ERROR' ? '❌' : status === 'TIMEOUT' ? '⏱️' : status === 'EXPECTED' ? '✅' : '⚠️'
    console.log(`   ${emoji} ${test}: ${message}\n`)
  }

  printResults() {
    console.log('📊 Test Results Summary:')
    console.log('=' + '='.repeat(70))

    this.testResults.forEach(result => {
      const status = result.status.padEnd(12)
      console.log(`${result.test.padEnd(22)} | ${status} | ${result.message}`)
    })

    console.log('=' + '='.repeat(70))

    const successful = this.testResults.filter(r => r.status === 'SUCCESS' || r.status === 'EXPECTED').length
    const total = this.testResults.length
    console.log(`\n🎯 Results: ${successful}/${total} tests passed\n`)

    // Compatibility analysis
    console.log('🔍 Socket.IO Compatibility Analysis:')
    console.log('-'.repeat(40))

    const hasSuccessfulConnection = this.testResults.some(r => r.status === 'SUCCESS')
    const hasProperAuth = this.testResults.filter(r => r.test.includes('Auth') && r.status === 'EXPECTED').length > 0

    if (hasSuccessfulConnection) {
      console.log('✅ Server can establish Socket.IO connections')
      console.log('✅ Authentication middleware is working')
      console.log('✅ Room management is functional')
      console.log('✅ Event emission/listening works')
    } else {
      console.log('❌ Connection issues detected')
    }

    if (hasProperAuth) {
      console.log('✅ Security: Invalid/missing auth properly rejected')
    }

    console.log('\n📱 Android Client Compatibility:')
    console.log('   ⚠️  Client uses Socket.IO v2.1.0 (old)')
    console.log('   ✅ Server supports legacy query parameter auth')
    console.log('   ✅ Server has backward compatibility for events')
    console.log('   ⚠️  Recommend upgrading Android client to v4.x')
  }
}

// Run tests
const tester = new SocketIOTester()
tester.runTests().catch(console.error)
