import * as amqplib from 'amqplib';
import type ActualLogger from '../../../../src/config/logger'; // Import type for casting

// Import constants to be used in assertions
import {
  POS_EVENTS_EXCHANGE as ACTUAL_POS_EVENTS_EXCHANGE,
  POS_COMMANDS_EXCHANGE as ACTUAL_POS_COMMANDS_EXCHANGE,
  AVOQADO_EVENTS_QUEUE as ACTUAL_AVOQADO_EVENTS_QUEUE,
} from '../../../../src/communication/rabbitmq/connection';

// Mock setTimeout and clearTimeout for controlling timers
// Must be called at the top level of the describe block or file
jest.useFakeTimers();

// Explicitly mock amqplib at the top level
jest.mock('amqplib');
// Explicitly mock logger at the top level
jest.mock('../../../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('RabbitMQ Connection', () => {
  let mockAmqplibConnect: jest.Mock;
  let mockLogger: jest.Mocked<typeof ActualLogger>;
  let mockChannel: any;
  let mockConnectionObj: any;
  let mockChannelModel: any;

  // To hold the re-imported module's functions and constants
  let connectToRabbitMQ: () => Promise<void>;
  let closeRabbitMQConnection: () => Promise<void>;
  let getRabbitMQChannel: () => any; // ConfirmChannel
  let getRabbitMQConnection: () => any; // Connection

  beforeEach(() => {
    jest.resetModules(); // Reset modules to clear state

    // Assign mocked amqplib.connect after resetModules and jest.mock
    mockAmqplibConnect = require('amqplib').connect as jest.Mock;

    // Assign mocked logger after resetModules and jest.mock
    mockLogger = require('@/config/logger') as jest.Mocked<typeof ActualLogger>;

    jest.spyOn(global, 'setTimeout');

    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockConnectionObj = { // This is the Connection instance
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockChannelModel = { // This is what amqplib.connect resolves to
        connection: mockConnectionObj,
        createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
        close: jest.fn().mockResolvedValue(undefined)
    };
    mockAmqplibConnect.mockResolvedValue(mockChannelModel);

    // Re-import functions from the module under test
    const rabbitMQModule = require('../../../../src/communication/rabbitmq/connection');
    connectToRabbitMQ = rabbitMQModule.connectToRabbitMQ;
    closeRabbitMQConnection = rabbitMQModule.closeRabbitMQConnection;
    getRabbitMQChannel = rabbitMQModule.getRabbitMQChannel;
    getRabbitMQConnection = rabbitMQModule.getRabbitMQConnection;
  });

  afterEach(async () => {
    if (closeRabbitMQConnection) {
      await closeRabbitMQConnection(); // Attempt to clean up
    }
    jest.clearAllTimers(); // Ensure all timers are cleared after each test
  });

  describe('connectToRabbitMQ', () => {
    it('should connect successfully, set up topology, and event handlers', async () => {
      await connectToRabbitMQ();

      expect(mockAmqplibConnect).toHaveBeenCalledTimes(1);
      // We don't check RABBITMQ_URL value itself, just that connect was called.

      expect(mockChannelModel.createConfirmChannel).toHaveBeenCalledTimes(1);
      
      // Topology setup
      expect(mockChannel.assertExchange).toHaveBeenCalledWith('dead_letter_exchange', 'direct', { durable: true });
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('avoqado_events_dead_letter_queue', { durable: true });
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('avoqado_events_dead_letter_queue', 'dead_letter_exchange', 'dead-letter');
      
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(ACTUAL_POS_EVENTS_EXCHANGE, 'topic', { durable: true });
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(ACTUAL_POS_COMMANDS_EXCHANGE, 'topic', { durable: true });
      
      expect(mockChannel.assertQueue).toHaveBeenCalledWith(ACTUAL_AVOQADO_EVENTS_QUEUE, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': 'dead_letter_exchange',
          'x-dead-letter-routing-key': 'dead-letter',
        },
      });

      // Event handlers
      expect(mockConnectionObj.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockConnectionObj.on).toHaveBeenCalledWith('close', expect.any(Function));

      // Logging
      expect(mockLogger.info).toHaveBeenCalledWith('🔌 Connecting to RabbitMQ...'); // From connectToRabbitMQ
      expect(mockLogger.info).toHaveBeenCalledWith('🔌 Conectando a RabbitMQ...'); // From connectWithRetry
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Conexión con RabbitMQ establecida.');
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Topología de RabbitMQ asegurada.');

      // Check channel and connection getters
      expect(getRabbitMQChannel()).toBe(mockChannel);
      expect(getRabbitMQConnection()).toBe(mockConnectionObj);
    });

    it('should not attempt to connect if channel already exists (idempotency)', async () => {
      // First connection
      await connectToRabbitMQ();
      expect(mockAmqplibConnect).toHaveBeenCalledTimes(1);
      mockAmqplibConnect.mockClear(); 
      mockLogger.info.mockClear();

      // Second call should not trigger a new connection attempt as channel is already set
      await connectToRabbitMQ();
      expect(mockAmqplibConnect).not.toHaveBeenCalled();
      // The outer connectToRabbitMQ logs "Connecting to RabbitMQ..." 
      expect(mockLogger.info).toHaveBeenCalledWith('🔌 Connecting to RabbitMQ...');
      // Ensure other connection-specific logs from connectWithRetry are not called again
      expect(mockLogger.info).not.toHaveBeenCalledWith('🔌 Conectando a RabbitMQ...');
      expect(mockLogger.info).toHaveBeenCalledTimes(1); // Only the outer log from the second call
    });
  });

  describe('getRabbitMQChannel (before connection)', () => {
    it('should throw an error if channel is not initialized', () => {
      // Note: connectToRabbitMQ is NOT called in this test's scope before this
      expect(() => getRabbitMQChannel()).toThrow(
        'El canal de RabbitMQ no ha sido inicializado. Asegúrate de llamar a connectToRabbitMQ() al iniciar la aplicación.'
      );
    });
  });

  describe('getRabbitMQConnection (before connection)', () => {
    it('should throw an error if connection is not initialized', () => {
      // Note: connectToRabbitMQ is NOT called in this test's scope before this
      expect(() => getRabbitMQConnection()).toThrow(
        'La conexión de RabbitMQ no ha sido inicializada. Asegúrate de llamar a connectToRabbitMQ() al iniciar la aplicación.'
      );
    });
  });

  describe('closeRabbitMQConnection', () => {
    it('should close the channel and connection, and log success', async () => {
      // First, establish a connection
      await connectToRabbitMQ();
      mockLogger.info.mockClear(); // Clear logs from connection

      await closeRabbitMQConnection();

      expect(mockChannel.close).toHaveBeenCalledTimes(1);
      expect(mockChannelModel.close).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Conexión con RabbitMQ cerrada correctamente.');

      // Verify internal state is nulled (by trying to get them and expecting errors)
      expect(() => getRabbitMQChannel()).toThrow();
      expect(() => getRabbitMQConnection()).toThrow();
    });

    it('should not throw an error if called when no connection exists', async () => {
      // Ensure no connection is established
      mockLogger.info.mockClear();
      mockLogger.error.mockClear();

      await expect(closeRabbitMQConnection()).resolves.not.toThrow();
      expect(mockChannel.close).not.toHaveBeenCalled();
      expect(mockChannelModel.close).not.toHaveBeenCalled();
      // It shouldn't log success if nothing was closed, but also no error
      expect(mockLogger.info).not.toHaveBeenCalledWith('✅ Conexión con RabbitMQ cerrada correctamente.');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should log an error if channel.close() fails', async () => {
      await connectToRabbitMQ();
      mockLogger.error.mockClear();
      const closeError = new Error('Channel close failed');
      mockChannel.close.mockRejectedValueOnce(closeError);

      await closeRabbitMQConnection();

      expect(mockLogger.error).toHaveBeenCalledWith('❌ Error al cerrar la conexión con RabbitMQ:', closeError);
    });

    it('should log an error if channelModel.close() (connection) fails', async () => {
      await connectToRabbitMQ();
      mockLogger.error.mockClear();
      const closeError = new Error('Connection close failed');
      mockChannelModel.close.mockRejectedValueOnce(closeError);

      await closeRabbitMQConnection();

      expect(mockLogger.error).toHaveBeenCalledWith('❌ Error al cerrar la conexión con RabbitMQ:', closeError);
    });
  });

  describe('Connection Failure and Retry Logic', () => {
    it('should log an error and schedule a retry if initial connection fails', async () => {
      const connectError = new Error('Initial connection failed');
      mockAmqplibConnect.mockRejectedValueOnce(connectError);

      // Do not await connectToRabbitMQ fully here as it will enter retry loop
      // We just want to trigger the first attempt
      connectToRabbitMQ(); 

      // Allow promises to resolve for the first failed attempt
      await Promise.resolve(); // Ensures the catch block in connectWithRetry is entered
      await Promise.resolve(); // Additional tick for safety

      expect(mockLogger.error).toHaveBeenCalledWith('🔥 Falla al conectar con RabbitMQ, reintentando...', connectError);
      expect(setTimeout).toHaveBeenCalledTimes(1);
      expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 5000);
    });

    it('should successfully connect on a retry attempt', async () => {
      const connectError = new Error('Initial connection failed');
      mockAmqplibConnect.mockRejectedValueOnce(connectError) // First attempt fails
                       .mockResolvedValueOnce(mockChannelModel); // Second attempt succeeds

      connectToRabbitMQ(); // Start connection process

      // Allow first attempt to fail and schedule retry
      await Promise.resolve(); 
      await Promise.resolve(); 

      expect(mockAmqplibConnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith('🔥 Falla al conectar con RabbitMQ, reintentando...', connectError);
      expect(setTimeout).toHaveBeenCalledTimes(1);

      // Advance timers to trigger the retry
      jest.advanceTimersByTime(5000);
      
      // Allow retry attempt to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAmqplibConnect).toHaveBeenCalledTimes(2); // Initial + retry
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Conexión con RabbitMQ establecida.');
      expect(getRabbitMQChannel()).toBe(mockChannel);
    });

    it('should handle multiple sequential failures before a successful retry', async () => {
      const error1 = new Error('Failure 1');
      const error2 = new Error('Failure 2');
      mockAmqplibConnect.mockRejectedValueOnce(error1)
                       .mockRejectedValueOnce(error2)
                       .mockResolvedValueOnce(mockChannelModel); // Third attempt succeeds

      connectToRabbitMQ();

      // First failure
      await Promise.resolve(); await Promise.resolve();
      expect(mockAmqplibConnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenLastCalledWith('🔥 Falla al conectar con RabbitMQ, reintentando...', error1);
      expect(setTimeout).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(5000);

      // Second failure
      await Promise.resolve(); await Promise.resolve();
      expect(mockAmqplibConnect).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenLastCalledWith('🔥 Falla al conectar con RabbitMQ, reintentando...', error2);
      expect(setTimeout).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(5000);

      // Third attempt (success)
      await Promise.resolve(); await Promise.resolve();
      expect(mockAmqplibConnect).toHaveBeenCalledTimes(3);
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Conexión con RabbitMQ establecida.');
      expect(getRabbitMQChannel()).toBe(mockChannel);
    });

    it('should not attempt multiple reconnections if isConnecting is true', async () => {
      mockAmqplibConnect.mockImplementation(() => {
        // Simulate a long-running connection attempt
        return new Promise(resolve => setTimeout(() => resolve(mockChannelModel), 100)); 
      });

      // Call connect multiple times in quick succession
      connectToRabbitMQ(); // First call sets isConnecting = true
      connectToRabbitMQ(); // Second call should return due to isConnecting
      connectToRabbitMQ(); // Third call should also return

      // Allow promises and timers to settle for the first actual attempt
      jest.advanceTimersByTime(100); // Let the first connection attempt resolve
      await Promise.resolve();
      await Promise.resolve();

      // amqplib.connect should only have been called once because of the isConnecting flag
      expect(mockAmqplibConnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Conexión con RabbitMQ establecida.');
    });
  });

  describe('Connection Event Handlers', () => {
    let errorCallback: (err: Error) => void;
    let closeCallback: () => void;

    beforeEach(async () => {
      // Capture the event handlers during a successful connection
      mockConnectionObj.on.mockImplementation((event: string, callback: any) => {
        if (event === 'error') {
          errorCallback = callback;
        }
        if (event === 'close') {
          closeCallback = callback;
        }
        return mockConnectionObj; // Return the mock connection for chaining or other purposes
      });
      await connectToRabbitMQ(); // Establish connection to set up handlers
    });

    it("should log an error when 'error' event is emitted", () => {
      const testError = new Error('Test connection error');
      expect(errorCallback).toBeDefined();
      if (errorCallback) {
        errorCallback(testError);
      }
      expect(mockLogger.error).toHaveBeenCalledWith('❌ Error de conexión con RabbitMQ:', testError.message);
    });

    it("should log warning, reset state, and schedule retry when 'close' event is emitted", async () => {
      expect(closeCallback).toBeDefined();
      if (closeCallback) {
        closeCallback();
      }

      expect(mockLogger.warn).toHaveBeenCalledWith('🚪 Conexión con RabbitMQ cerrada. Reintentando...');
      
      // Verify state is reset (channel and connection should be null internally)
      // We can test this by trying to get them and expecting an error
      expect(() => getRabbitMQChannel()).toThrow('El canal de RabbitMQ no ha sido inicializado.');
      expect(() => getRabbitMQConnection()).toThrow('La conexión de RabbitMQ no ha sido inicializada.');

      // Verify retry is scheduled
      expect(setTimeout).toHaveBeenCalledTimes(1); // It might be >1 if other tests also used setTimeout for retries
      expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 5000);

      // Optional: Test that a subsequent connection attempt works after advancing timer
      mockAmqplibConnect.mockResolvedValueOnce(mockChannelModel); // Setup for successful reconnect
      jest.advanceTimersByTime(5000);
      await Promise.resolve(); await Promise.resolve(); // Allow retry to complete
      expect(mockAmqplibConnect).toHaveBeenCalledTimes(2); // Initial connect + retry from close handler
      expect(getRabbitMQChannel()).toBe(mockChannel); // Should be re-established
    });
  });
});
