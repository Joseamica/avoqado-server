#!/usr/bin/env node

/**
 * 🔄 LIVE TRAINING DATA COLLECTOR
 *
 * This script continuously monitors chat interactions
 * and collects training data for system improvement.
 */

const axios = require('axios')
const colors = require('colors')

class LiveTrainingCollector {
  constructor() {
    this.baseURL = 'http://localhost:3000/api'
    this.collectedData = []
    this.token = null
    this.trainingMetrics = {
      totalInteractions: 0,
      successfulResponses: 0,
      failedResponses: 0,
      lowConfidenceResponses: 0,
      averageConfidence: 0,
    }
  }

  /**
   * Simulate real user interactions for training
   */
  async simulateUserInteractions() {
    console.log('\n🔄 LIVE TRAINING DATA COLLECTION'.green.bold)
    console.log('=================================\n')

    const realUserQuestions = [
      // Preguntas que usuarios reales hacen
      'cuanto vendimos hoy',
      'quien es el mejor mesero',
      'que producto se vende mas',
      'cuales son las ventas de esta semana',
      'promedio de propinas',
      'horario del restaurante',
      'cuantos clientes atendimos',
      'cual fue nuestro mejor dia',
      'comparar ventas del mes pasado',
      'productos mas populares',
      'eficiencia del equipo',
      'ingresos totales del mes',
      'tendencias de ventas',
      'analisis de temporadas altas',
      'rendimiento por categoria',
    ]

    console.log('📊 COLLECTING TRAINING DATA FROM REAL SCENARIOS...'.cyan)
    console.log(`Testing ${realUserQuestions.length} common user questions\n`)

    for (let i = 0; i < realUserQuestions.length; i++) {
      const question = realUserQuestions[i]
      console.log(`${i + 1}. Testing: "${question}"`.yellow)

      try {
        const response = await this.testQuestion(question)

        this.processTrainingData(question, response)

        // Show real-time results
        const confidence = (response.data?.confidence || response.confidence || 0) * 100
        const confidenceColor = confidence >= 80 ? 'green' : confidence >= 60 ? 'yellow' : 'red'
        console.log(`   ✅ Confidence: ${confidence.toFixed(1)}%`[confidenceColor])

        if (response.sqlQuery || response.data?.sqlQuery) {
          const sqlQuery = response.sqlQuery || response.data?.sqlQuery
          console.log(`   📋 SQL Generated: ${sqlQuery.substring(0, 50)}...`.gray)
        }

        await this.sleep(1000) // Realistic delay between questions
      } catch (error) {
        console.log(`   ❌ Error: ${error.message}`.red)
        this.trainingMetrics.failedResponses++
      }

      this.trainingMetrics.totalInteractions++
    }

    this.generateTrainingReport()
  }

  /**
   * Generate authentication token
   */
  async generateToken() {
    if (this.token) return this.token

    const tokenPayload = {
      sub: 'test-user-123',
      orgId: 'test-org-456',
      venueId: 'cmeniwgjm01qo9k32da7wcmhu',
      role: 'ADMIN',
      expiresIn: '1h',
    }

    const response = await axios.post(`${this.baseURL}/dev/generate-token`, tokenPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    })

    this.token = response.data.token
    return this.token
  }

  /**
   * Test a single question and collect metrics
   */
  async testQuestion(question) {
    const token = await this.generateToken()

    const payload = {
      message: question,
      venueId: 'cmeniwgjm01qo9k32da7wcmhu', // Your test venue
      conversationHistory: [],
    }

    const response = await axios.post(`${this.baseURL}/v1/dashboard/assistant/text-to-sql`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 30000,
    })

    return response.data
  }

  /**
   * Process and analyze training data
   */
  processTrainingData(question, response) {
    const data = response.data || response
    const trainingPoint = {
      question,
      response: data.response,
      confidence: data.confidence || 0,
      sqlGenerated: data.metadata?.queryGenerated || false,
      executionTime: data.metadata?.executionTime || 0,
      rowsReturned: data.metadata?.rowsReturned || 0,
      timestamp: new Date(),
      category: this.categorizeQuestion(question),
    }

    this.collectedData.push(trainingPoint)

    // Update metrics
    const confidence = data.confidence || 0
    if (confidence >= 0.8) {
      this.trainingMetrics.successfulResponses++
    } else if (confidence < 0.6) {
      this.trainingMetrics.lowConfidenceResponses++
    }

    this.trainingMetrics.averageConfidence =
      (this.trainingMetrics.averageConfidence * (this.collectedData.length - 1) + confidence) / this.collectedData.length
  }

  /**
   * Categorize questions for training analysis
   */
  categorizeQuestion(question) {
    const categories = {
      sales: ['vendi', 'ventas', 'ingresos', 'ganancias'],
      staff: ['mesero', 'empleado', 'equipo', 'trabajador'],
      products: ['producto', 'plato', 'menu', 'categoria'],
      financial: ['propinas', 'pagos', 'dinero', 'total'],
      temporal: ['hoy', 'ayer', 'semana', 'mes', 'dia'],
      analytics: ['mejor', 'promedio', 'analisis', 'tendencia', 'comparar'],
    }

    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => question.toLowerCase().includes(keyword))) {
        return category
      }
    }

    return 'general'
  }

  /**
   * Generate comprehensive training report
   */
  generateTrainingReport() {
    console.log('\n📊 TRAINING DATA COLLECTION REPORT'.rainbow.bold)
    console.log('===================================\n')

    console.log('📈 OVERALL METRICS:'.green.bold)
    console.log(`• Total Interactions: ${this.trainingMetrics.totalInteractions}`)
    console.log(`• Successful Responses: ${this.trainingMetrics.successfulResponses}`)
    console.log(`• Failed Responses: ${this.trainingMetrics.failedResponses}`)
    console.log(`• Low Confidence: ${this.trainingMetrics.lowConfidenceResponses}`)
    console.log(`• Average Confidence: ${(this.trainingMetrics.averageConfidence * 100).toFixed(1)}%\n`)

    // Category analysis
    const categoryStats = this.collectedData.reduce((stats, point) => {
      if (!stats[point.category]) {
        stats[point.category] = { count: 0, avgConfidence: 0 }
      }
      stats[point.category].count++
      stats[point.category].avgConfidence =
        (stats[point.category].avgConfidence * (stats[point.category].count - 1) + point.confidence) / stats[point.category].count
      return stats
    }, {})

    console.log('📋 CATEGORY PERFORMANCE:'.cyan.bold)
    Object.entries(categoryStats).forEach(([category, stats]) => {
      const confidence = (stats.avgConfidence * 100).toFixed(1)
      console.log(`• ${category.charAt(0).toUpperCase() + category.slice(1)}: ${stats.count} questions, ${confidence}% avg confidence`)
    })

    console.log('\n🎯 TRAINING RECOMMENDATIONS:'.yellow.bold)

    // Find areas needing improvement
    const lowPerformance = Object.entries(categoryStats)
      .filter(([_, stats]) => stats.avgConfidence < 0.7)
      .map(([category, _]) => category)

    if (lowPerformance.length > 0) {
      console.log(`• Focus training on: ${lowPerformance.join(', ')}`)
      console.log('• Add more context examples for these categories')
      console.log('• Improve SQL generation for complex queries')
    } else {
      console.log('• ✅ All categories performing well!')
      console.log('• Continue monitoring for edge cases')
      console.log('• Consider adding more complex scenarios')
    }

    console.log('\n🚀 NEXT STEPS:'.magenta.bold)
    console.log('1. Implement user feedback collection')
    console.log('2. Set up automatic retraining pipeline')
    console.log('3. Add real-time confidence monitoring')
    console.log('4. Create category-specific improvements')

    console.log(`\n✅ Training data collected: ${this.collectedData.length} interactions`.green.bold)
  }

  /**
   * Helper function for delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Run the live training collector
   */
  async run() {
    console.log('🔄 BULLETPROOF CHAT TRAINING COLLECTOR'.rainbow.bold)
    console.log('=====================================\n')

    try {
      await this.simulateUserInteractions()
    } catch (error) {
      console.error('❌ Training collection failed:', error.message)
      console.log('\n💡 Make sure the server is running: npm run dev')
    }
  }
}

// Run the collector
if (require.main === module) {
  const collector = new LiveTrainingCollector()
  collector.run().catch(console.error)
}

module.exports = LiveTrainingCollector
