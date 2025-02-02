import express from "express"
import { AuthenticatedRequest } from "../middleware/auth"
import { verifyApiKey } from "../middleware/auth"
import axios, { AxiosInstance } from "axios"
import { getWalletByApiKey } from "../lib/mongodb"
import { calculateCost } from "../lib/pricing"
import { Redis } from "ioredis"
import crypto from "crypto"
import { rateLimit, getRateLimitHeaders } from "../lib/rate-limit"
import cors from 'cors';

const router = express.Router()
router.use(cors());

// Constants
const CACHE_TTL = 3600 // 1 hour
const WALLET_CACHE_TTL = 300 // 5 minutes

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

const MODEL_DEPLOYMENTS = {
  'gpt-4': process.env.AZURE_GPT4_DEPLOYMENT_NAME,
  'gpt-4o': process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  'gpt-3.5-turbo': process.env.AZURE_GPT35_DEPLOYMENT_NAME,
}

// Create optimized axios instance
const axiosInstance: AxiosInstance = axios.create({
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
  // Using proper Axios configuration options
  httpAgent: new (require('http').Agent)({ keepAlive: true }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true }),
  maxRedirects: 5,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
})

// Cache implementation
const walletCache = new Map()

// Helper functions
const generateCacheKey = (messages: any[], model: string, temperature?: number, max_tokens?: number): string => {
  const data = JSON.stringify({ messages, model, temperature, max_tokens })
  return crypto.createHash('md5').update(data).digest('hex')
}

async function getCachedWallet(apiKey: string) {
  const cachedWallet = walletCache.get(apiKey)
  if (cachedWallet && Date.now() - cachedWallet.timestamp < WALLET_CACHE_TTL * 1000) {
    return cachedWallet.data
  }
  
  const wallet = await getWalletByApiKey(apiKey)
  if (wallet) {
    walletCache.set(apiKey, {
      data: wallet,
      timestamp: Date.now()
    })
  }
  return wallet
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
  const wallet = await getCachedWallet(apiKey)
  if (!wallet) {
    throw new Error("Invalid API key")
  }

  const [rateLimitResult, deploymentName] = await Promise.all([
    wallet.userId ? rateLimit(wallet.userId) : { success: true },
    MODEL_DEPLOYMENTS[model]
  ])

  if (!rateLimitResult.success) {
    throw new Error("Rate limit exceeded")
  }

  if (!deploymentName) {
    throw new Error("Invalid model specified")
  }

  return { wallet, deploymentName }
}

// Main route handler
router.post("/", verifyApiKey, async (req: AuthenticatedRequest, res) => {
  const controller = new AbortController()
  const signal = controller.signal

  try {
    const { 
      messages, 
      model = "gpt-4o", 
      temperature, 
      max_tokens, 
      stream = false 
    } = req.body
    
    const apiKey = req.apiKey

    if (!apiKey) {
      return res.status(401).json({ error: "API key is required" })
    }

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

        return res.json({
          ...parsed,
          cost,
          remainingBalance: wallet.balance - cost,
          cached: true
        })
      }
    }

    // Validate request
    const { wallet, deploymentName } = await validateRequest(apiKey, model)

    if (stream) {
      // Set up streaming response
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      const response = await axiosInstance.post(
        `${AZURE_CONFIG.endpoint}/openai/deployments/${deploymentName}/chat/completions`,
        {
          messages,
          model,
          temperature,
          max_tokens,
          stream: true
        },
        {
          params: { 'api-version': AZURE_CONFIG.apiVersion },
          headers: { "api-key": AZURE_CONFIG.apiKey },
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
          // Update wallet balance in cache
          const updatedBalance = wallet.balance - cost
          await redis.setex(`wallet:${apiKey}`, WALLET_CACHE_TTL, JSON.stringify({ ...wallet, balance: updatedBalance }))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })

      // Handle client disconnect
      req.on('close', () => {
        controller.abort()
      })
    } else {
      const response = await axiosInstance.post(
        `${AZURE_CONFIG.endpoint}/openai/deployments/${deploymentName}/chat/completions`,
        {
          messages,
          model,
          temperature,
          max_tokens,
          stream: false
        },
        {
          params: { 'api-version': AZURE_CONFIG.apiVersion },
          headers: { "api-key": AZURE_CONFIG.apiKey },
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

      // Update wallet cache
      const updatedBalance = wallet.balance - cost
      await redis.setex(`wallet:${apiKey}`, WALLET_CACHE_TTL, JSON.stringify({ ...wallet, balance: updatedBalance }))
      walletCache.set(apiKey, {
        data: { ...wallet, balance: updatedBalance },
        timestamp: Date.now()
      });

      return res.json({
        ...completionResponse,
        cost,
        remainingBalance: updatedBalance
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
