/**
 * Chatbot Configuration Module
 *
 * Configuration-driven schema system for the text-to-SQL chatbot.
 * Follows the industry-config pattern for multi-vertical support.
 *
 * @module config/chatbot
 */

// Core types
export * from './types'

// Schema Registry
export { SchemaRegistry, getSchemaRegistry, resetSchemaRegistry } from './schema.registry'

// Schema Context Generator
export {
  SchemaContextGenerator,
  getSchemaContextGenerator,
  resetSchemaContextGenerator,
  buildSchemaContextFromRegistry,
} from './schema-context-generator'

// Table definitions
export { default as ALL_TABLES } from './tables'

// Industry configurations
export { RESTAURANT_CONFIG, TELECOM_CONFIG } from './industries'

// Intent definitions
export { default as DEFAULT_INTENTS } from './intents'
