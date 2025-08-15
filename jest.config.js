// Updated jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],

  // 🔥 UPDATED: New test patterns for our structure
  testMatch: [
    '<rootDir>/tests/**/*.test.ts', // Unit tests
    '<rootDir>/tests/**/*.api.test.ts', // API tests
    '<rootDir>/tests/**/*.workflow.test.ts', // Workflow tests
  ],

  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**',
    '!src/scripts/**',
    '!src/config/**',
    '!src/app.ts',
    '!src/server.ts',
  ],

  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],

  // 🔥 NEW: Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    // Higher thresholds for critical services
    'src/services/dashboard/': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    'src/services/pos-sync/': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },

  setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
  },

  // 🔥 NEW: Test configuration
  testTimeout: 10000,
  verbose: true,
  detectOpenHandles: true,
  forceExit: true,

  // 🔥 NEW: Project-based configuration for better organization
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
      },
    },
    {
      displayName: 'api-tests',
      testMatch: ['<rootDir>/tests/api-tests/**/*.api.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
      },
      // API tests might need longer timeout. If so, use jest.setTimeout() in test files.
    },
    {
      displayName: 'workflows',
      testMatch: ['<rootDir>/tests/workflows/**/*.workflow.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
      },
      // Workflow tests typically take longer. If so, use jest.setTimeout() in test files.
    },
  ],

  // 🔥 NEW: Better error handling and reporting
  errorOnDeprecated: true,

  // 🔥 NEW: Performance and memory settings
  maxWorkers: '50%',
  cache: true,
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
}
