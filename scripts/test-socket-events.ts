// ⚠️ DELETE AFTER: Testing Socket.IO menu events
// Purpose: Test that menu CRUD operations emit Socket.IO events
// Created: 2025-01-15
// Delete when: FASE 1.E testing complete

import axios from 'axios'
import { io, Socket } from 'socket.io-client'

const API_BASE = 'http://localhost:12344/api/v1'
const VENUE_ID = 'cmhtrvsvk00ad9krx8gb9jgbq' // avoqado-full
const CATEGORY_ID = 'cmhtrvtdx00gk9krxcyo4zpah' // Tacos Mexicanos

// Test credentials (you'll need to provide actual credentials)
const TEST_EMAIL = 'admin@avoqado.io' // Replace with actual test email
const TEST_PASSWORD = 'test123' // Replace with actual password

interface TestResult {
  step: string
  success: boolean
  details?: any
  error?: string
}

const results: TestResult[] = []

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function logStep(step: string, success: boolean, details?: any, error?: string) {
  const result: TestResult = { step, success, details, error }
  results.push(result)

  const emoji = success ? '✅' : '❌'
  console.log(`${emoji} ${step}`)
  if (details) console.log('   Details:', details)
  if (error) console.log('   Error:', error)
}

async function testSocketEvents() {
  console.log('\n📡 SOCKET.IO EVENT TESTING - FASE 1.E\n')
  console.log('═'.repeat(60))

  const authToken: string | null = null
  let socket: Socket | null = null
  let createdProductId: string | null = null

  // ========================================
  // STEP 1: Authenticate
  // ========================================
  try {
    console.log('\n🔐 STEP 1: Authentication...')

    // For testing purposes, you can use Firebase Auth or create a test token
    // This is a placeholder - you'll need to implement actual authentication

    logStep('Authentication', false, null, 'Manual authentication required - please provide token')

    // ⚠️ MANUAL: Set token here after getting it from browser or Postman
    // authToken = 'your-jwt-token-here'

    return // Exit early - manual setup required
  } catch (error: any) {
    logStep('Authentication', false, null, error.message)
    return
  }

  // ========================================
  // STEP 2: Connect to Socket.IO
  // ========================================
  try {
    console.log('\n🔌 STEP 2: Connecting to Socket.IO...')

    socket = io('http://localhost:12344', {
      auth: {
        token: authToken,
      },
      transports: ['websocket'],
    })

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000)

      socket!.on('connect', () => {
        clearTimeout(timeout)
        logStep('Socket.IO Connection', true, { socketId: socket!.id })
        resolve()
      })

      socket!.on('connect_error', err => {
        clearTimeout(timeout)
        logStep('Socket.IO Connection', false, null, err.message)
        reject(err)
      })
    })

    // Join venue room
    socket!.emit('join_venue', { venueId: VENUE_ID })
    await sleep(500)
    logStep('Join Venue Room', true, { venueId: VENUE_ID })
  } catch (error: any) {
    logStep('Socket.IO Setup', false, null, error.message)
    return
  }

  // ========================================
  // STEP 3: Listen for Socket events
  // ========================================
  const receivedEvents: any[] = []

  const menuEvents = [
    'menu_item_created',
    'menu_item_updated',
    'menu_item_deleted',
    'product_price_changed',
    'menu_item_availability_changed',
    'menu_updated',
  ]

  menuEvents.forEach(eventName => {
    socket!.on(eventName, data => {
      console.log(`\n📨 Received: ${eventName}`)
      console.log('   Data:', JSON.stringify(data, null, 2))
      receivedEvents.push({ event: eventName, data, timestamp: new Date().toISOString() })
    })
  })

  logStep('Socket Event Listeners', true, { events: menuEvents })

  // ========================================
  // STEP 4: Create Product (Test menu_item_created)
  // ========================================
  try {
    console.log('\n📦 STEP 4: Creating product...')

    const productData = {
      name: `Test Product Socket ${Date.now()}`,
      description: 'Testing Socket.IO events',
      price: 99.99,
      sku: `TEST-SOCKET-${Date.now()}`,
      categoryId: CATEGORY_ID,
      active: true,
    }

    const response = await axios.post(`${API_BASE}/dashboard/venues/${VENUE_ID}/products`, productData, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    })

    createdProductId = response.data.id
    logStep('Create Product (API)', true, { productId: createdProductId, name: productData.name })

    // Wait for Socket.IO events
    await sleep(1000)

    const createEvents = receivedEvents.filter(e => e.event === 'menu_item_created' || e.event === 'menu_updated')

    if (createEvents.length > 0) {
      logStep('Socket Events Received (CREATE)', true, {
        events: createEvents.map(e => e.event),
        count: createEvents.length,
      })
    } else {
      logStep('Socket Events Received (CREATE)', false, null, 'No events received after 1 second')
    }
  } catch (error: any) {
    logStep('Create Product', false, null, error.response?.data?.message || error.message)
  }

  // ========================================
  // STEP 5: Update Price (Test product_price_changed)
  // ========================================
  if (createdProductId) {
    try {
      console.log('\n💰 STEP 5: Updating product price...')

      receivedEvents.length = 0 // Clear previous events

      const response = await axios.patch(
        `${API_BASE}/dashboard/venues/${VENUE_ID}/products/${createdProductId}`,
        { price: 149.99 },
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
        },
      )

      logStep('Update Price (API)', true, { newPrice: 149.99 })

      // Wait for Socket.IO events
      await sleep(1000)

      const priceEvents = receivedEvents.filter(e => e.event === 'product_price_changed' || e.event === 'menu_item_updated')

      if (priceEvents.length > 0) {
        logStep('Socket Events Received (PRICE CHANGE)', true, {
          events: priceEvents.map(e => e.event),
          count: priceEvents.length,
        })

        const priceChangeEvent = priceEvents.find(e => e.event === 'product_price_changed')
        if (priceChangeEvent) {
          console.log('   📊 Price Change Details:')
          console.log(`      Old Price: ${priceChangeEvent.data.oldPrice}`)
          console.log(`      New Price: ${priceChangeEvent.data.newPrice}`)
          console.log(`      Change: ${priceChangeEvent.data.priceChange}`)
          console.log(`      Percent: ${priceChangeEvent.data.priceChangePercent}%`)
        }
      } else {
        logStep('Socket Events Received (PRICE CHANGE)', false, null, 'No events received after 1 second')
      }
    } catch (error: any) {
      logStep('Update Price', false, null, error.response?.data?.message || error.message)
    }
  }

  // ========================================
  // STEP 6: Update Availability (Test menu_item_availability_changed)
  // ========================================
  if (createdProductId) {
    try {
      console.log('\n🔄 STEP 6: Changing product availability...')

      receivedEvents.length = 0 // Clear previous events

      const response = await axios.patch(
        `${API_BASE}/dashboard/venues/${VENUE_ID}/products/${createdProductId}`,
        { active: false },
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
        },
      )

      logStep('Update Availability (API)', true, { available: false })

      // Wait for Socket.IO events
      await sleep(1000)

      const availabilityEvents = receivedEvents.filter(e => e.event === 'menu_item_availability_changed' || e.event === 'menu_item_updated')

      if (availabilityEvents.length > 0) {
        logStep('Socket Events Received (AVAILABILITY)', true, {
          events: availabilityEvents.map(e => e.event),
          count: availabilityEvents.length,
        })
      } else {
        logStep('Socket Events Received (AVAILABILITY)', false, null, 'No events received after 1 second')
      }
    } catch (error: any) {
      logStep('Update Availability', false, null, error.response?.data?.message || error.message)
    }
  }

  // ========================================
  // STEP 7: Delete Product (Test menu_item_deleted)
  // ========================================
  if (createdProductId) {
    try {
      console.log('\n🗑️  STEP 7: Deleting product...')

      receivedEvents.length = 0 // Clear previous events

      await axios.delete(`${API_BASE}/dashboard/venues/${VENUE_ID}/products/${createdProductId}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })

      logStep('Delete Product (API)', true)

      // Wait for Socket.IO events
      await sleep(1000)

      const deleteEvents = receivedEvents.filter(e => e.event === 'menu_item_deleted' || e.event === 'menu_updated')

      if (deleteEvents.length > 0) {
        logStep('Socket Events Received (DELETE)', true, {
          events: deleteEvents.map(e => e.event),
          count: deleteEvents.length,
        })
      } else {
        logStep('Socket Events Received (DELETE)', false, null, 'No events received after 1 second')
      }
    } catch (error: any) {
      logStep('Delete Product', false, null, error.response?.data?.message || error.message)
    }
  }

  // ========================================
  // CLEANUP & SUMMARY
  // ========================================
  if (socket) {
    socket!.disconnect()
    logStep('Socket Disconnect', true)
  }

  console.log('\n' + '═'.repeat(60))
  console.log('📊 TEST SUMMARY')
  console.log('═'.repeat(60))

  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  console.log(`✅ Passed: ${passed}`)
  console.log(`❌ Failed: ${failed}`)
  console.log(`📈 Success Rate: ${Math.round((passed / results.length) * 100)}%`)

  console.log('\n📝 MANUAL SETUP REQUIRED:')
  console.log('   1. Get auth token from browser (DevTools → Application → Cookies → accessToken)')
  console.log('   2. Set authToken variable in line 50')
  console.log('   3. Run script again: npx ts-node -r tsconfig-paths/register scripts/test-socket-events.ts')
  console.log('   4. Open Android app with Timber logs: adb logcat -s Timber')
  console.log('   5. Open Web dashboard console to see Socket.IO events')

  console.log('\n')
}

// Run tests
testSocketEvents().catch(console.error)
