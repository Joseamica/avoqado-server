# AI Feedback Testing Scenarios

## Scenario 1: Positive Feedback Loop

1. Ask: "What were our sales this week?"
2. Click 👍 on response
3. Ask similar question: "Show me weekly sales data"
4. Verify confidence improves over time

## Scenario 2: Negative Feedback Learning

1. Ask: "How many staff worked today?"
2. Click 👎 on response
3. Ask same question again later
4. Check if AI adjusts approach

## Scenario 3: Mixed Feedback Pattern

1. Ask 5 different questions
2. Give 3 positive, 2 negative feedback
3. Monitor learning patterns in database

## Scenario 4: Edge Cases

1. Test feedback without trainingDataId (should show error)
2. Test rapid clicking (should handle gracefully)
3. Test offline feedback (should queue/retry)

## Expected Learning Behaviors

- Positive feedback → Increased confidence for similar queries
- Negative feedback → Pattern analysis and adjustment
- Repeated negative feedback → Template updates
- Mixed feedback → Nuanced learning adjustments

## Monitoring Points

- ChatTrainingData table growth
- ChatFeedback correlation
- LearnedPatterns updates
- Confidence score changes
- Response quality improvements
