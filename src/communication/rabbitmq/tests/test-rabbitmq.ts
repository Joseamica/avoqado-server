import { connectToRabbitMQ, closeRabbitMQConnection } from '../connection'
import { publishCommand } from '../publisher'
import { startEventConsumer } from '../consumer'

// Un pequeño truco para cerrar la conexión y terminar el script después de la prueba
const closeConnectionAfterDelay = () => {
  setTimeout(async () => {
    await closeRabbitMQConnection()
    console.log('🚪 Conexión cerrada. Prueba finalizada.')
    process.exit(0)
  }, 5000) // Espera 5 segundos antes de cerrar
}

const runTest = async () => {
  try {
    // 1. Nos conectamos y configuramos toda la topología (exchanges, colas, etc.)
    await connectToRabbitMQ()

    // 2. Iniciamos nuestro consumidor para que empiece a escuchar eventos
    await startEventConsumer()

    // 3. Esperamos un par de segundos para asegurar que el consumidor esté listo
    console.log('⏳ Esperando 2 segundos para que el consumidor se inicialice...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 4. Publicamos un comando de prueba
    // Simulamos un comando que viene de nuestro backend para el POS SoftRestaurant
    const testRoutingKey = 'command.softrestaurant.order.create'
    const testPayload = {
      orderId: 'test-123',
      venueId: 'venue-abc',
      items: [{ productId: 'p-001', quantity: 2 }],
    }

    // NOTA: Para esta prueba, no estamos realmente procesando el comando,
    // solo estamos verificando que un mensaje puede ser publicado y recibido.
    // En un escenario real, el "Productor" en Windows publicaría un evento, no un comando.
    // Usamos publishCommand aquí solo para probar que la publicación funciona.
    const eventRoutingKey = 'pos.softrestaurant.order.updated'
    await publishCommand(eventRoutingKey, testPayload)

    // 5. Dejamos el script corriendo por un momento para ver los logs y luego lo cerramos
    closeConnectionAfterDelay()
  } catch (error) {
    console.error('❌ La prueba de RabbitMQ falló:', error)
    process.exit(1)
  }
}

runTest()
