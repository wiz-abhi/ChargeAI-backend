import express from "express"
import { AuthenticatedRequest } from "../middleware/auth"
import { verifyApiKey } from "../middleware/auth"
import axios from "axios"
import { getWalletByApiKey, updateWalletBalance } from "../lib/mongodb"
import { calculateCost } from "../lib/pricing"

const router = express.Router()

router.post("/", verifyApiKey, async (req: AuthenticatedRequest, res) => {
  try {
    const { messages, model = "gpt-3.5-turbo" } = req.body
    const apiKey = req.apiKey

    const wallet = await getWalletByApiKey(apiKey!)
    if (!wallet) {
      return res.status(401).json({ error: "Invalid API key" })
    }

    if (!process.env.AZURE_OPENAI_ENDPOINT ||
        !process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
        !process.env.AZURE_OPENAI_API_KEY) {
      return res.status(500).json({ error: "Server configuration error" })
    }

    const response = await axios.post(
      `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}/chat/completions?api-version=2023-05-15`,
      { messages, model },
      {
        headers: {
          "Content-Type": "application/json",
          "api-key": process.env.AZURE_OPENAI_API_KEY,
        },
      }
    )

    const tokensUsed = response.data.usage.total_tokens
    const cost = calculateCost(model, tokensUsed)

    if (wallet.balance < cost) {
      return res.status(402).json({ error: "Insufficient funds" })
    }

    await updateWalletBalance(wallet.userId, -cost)

    res.json({
      ...response.data,
      cost,
      remainingBalance: wallet.balance - cost,
    })
  } catch (error) {
    console.error("Chat error:", error)
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", error.response?.data)
    }
    res.status(500).json({ error: "Failed to process chat request" })
  }
})

export default router