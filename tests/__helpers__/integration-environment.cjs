const { TestEnvironment } = require('jest-environment-node')

class IntegrationEnvironment extends TestEnvironment {
  async handleTestEvent(event) {
    if (event.name === 'run_finish' && this.global.disposeIntegrationClients) {
      await this.global.disposeIntegrationClients()
    }
  }
}

module.exports = IntegrationEnvironment
