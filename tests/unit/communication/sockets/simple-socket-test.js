const { io } = require('socket.io-client')

console.log('🔌 Testing Socket.IO connection to localhost:3000...\n')

// Create a simple test token (this will fail auth but test connection)
const socket = io('http://localhost:3000', {
  auth: { token: 'test-token' },
  timeout: 5000,
})

socket.on('connect', () => {
  console.log('✅ Connected to Socket.IO server!')
  console.log('Socket ID:', socket.id)
  socket.disconnect()
})

socket.on('connect_error', error => {
  console.log('❌ Connection error:', error.message)
  console.log('Error type:', error.type)
  console.log('Description:', error.description)
})

socket.on('authentication_error', error => {
  console.log('🔐 Authentication error (expected with test token):', error)
})

socket.on('disconnect', reason => {
  console.log('🔌 Disconnected:', reason)
  process.exit(0)
})

// Timeout after 10 seconds
setTimeout(() => {
  console.log('⏱️ Test timed out')
  socket.disconnect()
  process.exit(1)
}, 10000)
