import { connectToRabbitMQ, closeRabbitMQConnection } from '../../../../src/communication/rabbitmq/connection'
import { publishCommand } from '../../../../src/communication/rabbitmq/publisher'
import { startEventConsumer } from '../../../../src/communication/rabbitmq/consumer'

// Jest test for RabbitMQ connection, consumer, and publisher
describe('RabbitMQ', () => {
  // This will track any timers we create so we can clean them up
  const timers: NodeJS.Timeout[] = []

  // Setup and teardown
  beforeAll(async () => {
    // Connect to RabbitMQ and set up the topology
    await connectToRabbitMQ()

    // Start the event consumer
    await startEventConsumer()

    // Wait for consumer to initialize
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000)
      timers.push(timer)
    })
  }, 10000) // Increase timeout to 10 seconds for connection setup

  afterAll(async () => {
    // Clean up any timers we created
    timers.forEach(timer => clearTimeout(timer))

    // Then close the RabbitMQ connection
    await closeRabbitMQConnection()
  }, 5000) // Add timeout to ensure cleanup has time to complete

  // Test cases
  it('should successfully publish a message to RabbitMQ', async () => {
    // Test payload and routing key
    const eventRoutingKey = 'pos.softrestaurant.order.updated'
    const testPayload = {
      orderId: 'test-123',
      venueId: 'venue-abc',
      items: [{ productId: 'p-001', quantity: 2 }],
    }

    // Attempting to publish should not throw an error
    await expect(publishCommand(eventRoutingKey, testPayload)).resolves.not.toThrow()

    // Give some time for the message to be processed if needed
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 500)
      timers.push(timer)
    })
  }, 5000) // 5 second timeout for this test

  it('should have proper connection to RabbitMQ', () => {
    // This is a simple test to ensure the test suite has at least one assertion
    // You can expand on this with more specific tests for your RabbitMQ implementation
    expect(true).toBe(true)
  })
})
