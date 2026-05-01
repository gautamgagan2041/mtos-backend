// ═══════════════════════════════════════════════════════════════════
// jest.config.js — Test configuration
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/__tests__/**/*.test.js', '**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  
  // Coverage
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',         // Entry point — not unit testable
    '!src/jobs/worker.js',   // Worker process
    '!src/**/__tests__/**',
  ],
  coverageThreshold: {
    global: {
      branches:   60,
      functions:  70,
      lines:      70,
      statements: 70,
    },
    // PayrollEngine must have higher coverage — it's the core
    './src/modules/payroll/engines/PayrollEngine.js': {
      branches:   85,
      functions:  90,
      lines:      90,
      statements: 90,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],

  // Timeout for async tests
  testTimeout: 30000,

  // Module name mapper (if using path aliases)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Setup files
  setupFilesAfterEnv: ['./jest.setup.js'],
};
