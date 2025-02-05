import express from "express"
import { AuthenticatedRequest } from "../middleware/auth"
import { verifyApiKey } from "../middleware/auth"
import axios, { AxiosInstance } from "axios"
import { getWalletByApiKey, updateWalletBalance as updateMongoWalletBalance } from "../lib/mongodb"
import { calculateCost } from "../lib/pricing"
import { Redis } from "ioredis"
import crypto from "crypto"
import { rateLimit } from "../lib/rate-limit"

const router = express.Router()

// Constants
const CACHE_TTL = 3600 // 1 hour
const WALLET_LOCK_TTL = 30 // 30 seconds for lock

// Initialize Redis
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  retryStrategy: (times) => Math.min(times * 50, 2000),
  enableReadyCheck: true,
  maxRetriesPerRequest: 3
})

// Azure Configuration
const AZURE_CONFIG = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  apiVersion: "2023-05-15",
}

// New GPT-4O Configuration
const GPT4O_CONFIG = {
  endpoint: process.env.AZURE_GPT4O_ENDPOINT,
  apiKey: process.env.AZURE_GPT4O_API_KEY,
  apiVersion: "2023-05-15",
}

const MODEL_DEPLOYMENTS = {
  'gpt-4': process.env.AZURE_GPT4_DEPLOYMENT_NAME,
  'gpt-4o-mini': process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  'gpt-3.5-turbo': process.env.AZURE_GPT35_DEPLOYMENT_NAME,
  'gpt-4o': process.env.AZURE_GPT4O_DEPLOYMENT_NAME,
}

// Create optimized axios instance
const axiosInstance: AxiosInstance = axios.create({
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
  httpAgent: new (require('http').Agent)({ keepAlive: true }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true }),
  maxRedirects: 5,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
})

// Helper functions
const generateCacheKey = (messages: any[], model: string, temperature?: number, max_tokens?: number): string => {
  const data = JSON.stringify({ messages, model, temperature, max_tokens })
  return crypto.createHash('md5').update(data).digest('hex')
}

const generateWalletKey = (apiKey: string): string => `wallet:${apiKey}`

async function getWalletFromRedis(apiKey: string) {
  const walletKey = generateWalletKey(apiKey)
  const wallet = await redis.get(walletKey)
  return wallet ? JSON.parse(wallet) : null
}

async function updateWalletBalances(apiKey: string, userId: string, cost: number): Promise<number> {
  const walletKey = generateWalletKey(apiKey)
  let retries = 3
  
  while (retries > 0) {
    try {
      const walletStr = await redis.get(walletKey)
      if (!walletStr) throw new Error("Wallet not found")
      
      const wallet = JSON.parse(walletStr)
      const newBalance = wallet.balance - cost
      
      // Update Redis immediately
      const result = await redis
        .multi()
        .set(walletKey, JSON.stringify({ ...wallet, balance: newBalance }))
        .exec()
      
      if (!result) throw new Error("Redis transaction failed")
      
      // Update MongoDB asynchronously
      updateMongoWalletBalance(userId, -cost).catch(error => {
        console.error('Failed to update MongoDB wallet balance:', error)
        // Implement retry mechanism or alerting system here
      })
      
      return newBalance
    } catch (error) {
      retries--
      if (retries === 0) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  
  throw new Error("Failed to update wallet balance after retries")
}

function parseSSEResponse(chunk: string) {
  const lines = chunk.split('\n')
  const parsedLines = []
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const jsonStr = line.slice(6)
      if (jsonStr === '[DONE]') continue
      try {
        const parsed = JSON.parse(jsonStr)
        parsedLines.push(parsed)
      } catch (e) {
        console.error('Failed to parse SSE data:', e)
      }
    }
  }
  
  return parsedLines
}

async function validateRequest(apiKey: string, model: string) {
  // Try Redis first
  let wallet = await getWalletFromRedis(apiKey)
  
  if (!wallet) {
    // Fallback to MongoDB
    wallet = await getWalletByApiKey(apiKey)
    if (!wallet) throw new Error("Invalid API key")
    
    // Cache in Redis
    await redis.set(generateWalletKey(apiKey), JSON.stringify(wallet))
  }

  const [rateLimitResult, deploymentName] = await Promise.all([
    wallet.userId ? rateLimit(wallet.userId) : { success: true },
    MODEL_DEPLOYMENTS[model]
  ])

  if (!rateLimitResult.success) throw new Error("Rate limit exceeded")
  if (!deploymentName) throw new Error("Invalid model specified")

  return { wallet, deploymentName }
}

function getModelConfig(model: string) {
  return model === 'gpt-4o' ? GPT4O_CONFIG : AZURE_CONFIG
}

// Main route handler
router.post("/", verifyApiKey, async (req: AuthenticatedRequest, res) => {
  const controller = new AbortController()
  const signal = controller.signal

  try {
    const { 
      messages, 
      model = "gpt-4", 
      temperature, 
      max_tokens, 
      stream = false 
    } = req.body
    
    const apiKey = req.apiKey
    if (!apiKey) return res.status(401).json({ error: "API key is required" })

    // Check cache for non-streaming requests
    if (!stream) {
      const cacheKey = generateCacheKey(messages, model, temperature, max_tokens)
      const cachedResponse = await redis.get(cacheKey)
      
      if (cachedResponse) {
        const parsed = JSON.parse(cachedResponse)
        const { wallet } = await validateRequest(apiKey, model)
        const cost = calculateCost(model, parsed.usage.total_tokens)
        
        if (wallet.balance < cost) {
          return res.status(402).json({ error: "Insufficient funds" })
        }

        const newBalance = await updateWalletBalances(apiKey, wallet.userId, cost)
        
        return res.json({
          ...parsed,
          cost,
          remainingBalance: newBalance,
          cached: true
        })
      }
    }

    // Validate request
    const { wallet, deploymentName } = await validateRequest(apiKey, model)
    const modelConfig = getModelConfig(model)

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      const response = await axiosInstance.post(
        `${modelConfig.endpoint}/openai/deployments/${deploymentName}/chat/completions`,
        {
          messages,
          model,
          temperature,
          max_tokens,
          stream: true
        },
        {
          params: { 'api-version': modelConfig.apiVersion },
          headers: { "api-key": modelConfig.apiKey },
          responseType: 'stream',
          signal
        }
      )

      let lastChunk: any = null

      response.data.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        const parsed = parseSSEResponse(text)
        
        for (const item of parsed) {
          lastChunk = item
          res.write(`data: ${JSON.stringify(item)}\n\n`)
        }
      })

      response.data.on('end', async () => {
        if (lastChunk?.usage) {
          const cost = calculateCost(model, lastChunk.usage.total_tokens)
          await updateWalletBalances(apiKey, wallet.userId, cost)
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })

      req.on('close', () => controller.abort())
    } else {
      const response = await axiosInstance.post(
        `${modelConfig.endpoint}/openai/deployments/${deploymentName}/chat/completions`,
        {
          messages,
          model,
          temperature,
          max_tokens,
          stream: false
        },
        {
          params: { 'api-version': modelConfig.apiVersion },
          headers: { "api-key": modelConfig.apiKey },
          signal
        }
      )

      const completionResponse = response.data
      const cost = calculateCost(model, completionResponse.usage.total_tokens)
      
      if (wallet.balance < cost) {
        return res.status(402).json({ error: "Insufficient funds" })
      }

      // Cache the response
      const cacheKey = generateCacheKey(messages, model, temperature, max_tokens)
      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(completionResponse))

      // Update wallet balances - Redis immediately, MongoDB async
      const newBalance = await updateWalletBalances(apiKey, wallet.userId, cost)

      return res.json({
        ...completionResponse,
        cost,
        remainingBalance: newBalance
      })
    }
  } catch (error) {
    controller.abort()
    console.error("Failed to process chat request:", error)
    
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", error.response?.data)
      return res.status(error.response?.status || 500).json({ 
        error: error.response?.data?.error || "Failed to process chat request" 
      })
    }
    
    res.status(500).json({ error: error.message || "An internal error occurred" })
  }
})

export default router
