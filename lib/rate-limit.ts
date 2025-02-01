import Redis from 'ioredis'

// Initialize Redis client
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

// Simple rate limit configuration
const RATE_LIMIT = {
  requests: 60,    // 60 requests
  window: 60      // per minute (in seconds)
}

/**
 * Rate limits requests based on user ID
 * @param {string} userId - The user's ID
 * @returns {Promise<{ success: boolean, remaining: number, reset: number }>}
 */
export async function rateLimit(userId: string) {
  try {
    const now = Math.floor(Date.now() / 1000)
    const key = `rate_limit:${userId}`

    // Use Redis pipeline for atomic operations
    const pipeline = redis.pipeline()
    
    // Clean up old requests
    pipeline.zremrangebyscore(key, 0, now - RATE_LIMIT.window)
    
    // Count requests in current window
    pipeline.zcard(key)
    
    // Add current request timestamp
    pipeline.zadd(key, now, `${now}-${Math.random()}`)
    
    // Set expiry on the sorted set
    pipeline.expire(key, RATE_LIMIT.window)

    const results = await pipeline.exec()
    // Need to handle the case where results might be null
    if (!results) {
      throw new Error('Failed to execute Redis pipeline')
    }
    
    // Parse the request count as a number
    const requestCount = results[1][1] as number

    // Calculate time until reset
    const oldestRequest = await redis.zrange(key, 0, 0, 'WITHSCORES')
    const resetTime = oldestRequest.length ? parseInt(oldestRequest[1]) + RATE_LIMIT.window : now + RATE_LIMIT.window

    if (requestCount >= RATE_LIMIT.requests) {
      return {
        success: false,
        remaining: 0,
        reset: resetTime,
        limit: RATE_LIMIT.requests
      }
    }

    return {
      success: true,
      remaining: RATE_LIMIT.requests - Math.floor(requestCount),
      reset: resetTime,
      limit: RATE_LIMIT.requests
    }
  } catch (error) {
    console.error('Rate limiting error:', error)
    
    // Fail open if rate limiting is broken
    return {
      success: true,
      remaining: 1,
      reset: Math.floor(Date.now() / 1000) + 3600,
      limit: RATE_LIMIT.requests,
      error: 'Rate limiting temporarily unavailable'
    }
  }
}

/**
 * Utility function to format rate limit headers
 */
export function getRateLimitHeaders(rateLimitInfo: {
  limit: number;
  remaining: number;
  reset: number;
}) {
  return {
    'X-RateLimit-Limit': rateLimitInfo.limit.toString(),
    'X-RateLimit-Remaining': rateLimitInfo.remaining.toString(),
    'X-RateLimit-Reset': rateLimitInfo.reset.toString(),
  }
}