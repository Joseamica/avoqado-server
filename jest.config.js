// Updated jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

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

  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
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

  verbose: true,
  detectOpenHandles: true,
  forceExit: true,

  // Project-based configuration — each project defines its own
  // setupFilesAfterEnv, moduleNameMapper, and testMatch
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      transform: {
        '^.+\\.(ts|tsx|js|jsx|mjs)$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
      },
    },
    {
      displayName: 'api-tests',
      testMatch: ['<rootDir>/tests/api-tests/**/*.api.test.ts'],
      transform: {
        '^.+\\.(ts|tsx|js|jsx|mjs)$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
      },
    },
    {
      displayName: 'workflows',
      testMatch: ['<rootDir>/tests/workflows/**/*.workflow.test.ts'],
      transform: {
        '^.+\\.(ts|tsx|js|jsx|mjs)$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
      },
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      transform: {
        '^.+\\.(ts|tsx|js|jsx|mjs)$': 'ts-jest',
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/integration-setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
      },
    },
  ],

  // 🔥 NEW: Better error handling and reporting
  errorOnDeprecated: true,

  // 🔥 NEW: Performance and memory settings
  maxWorkers: '50%',
  cache: true,
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
}
