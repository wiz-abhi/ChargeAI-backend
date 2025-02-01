import express from "express"
import { AuthenticatedRequest, verifyToken } from "../middleware/auth"
import { connectToDatabase } from "../lib/mongodb"
import crypto from "crypto"

const router = express.Router()

router.post("/", verifyToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.uid
    const db = await connectToDatabase()
    const apiKeys = db.collection("apiKeys")

    const existingKeys = await apiKeys.find({ userId }).toArray()
    if (existingKeys.length >= 2) {
      return res.status(400).json({ error: "Maximum number of API keys reached" })
    }

    const key = crypto.randomBytes(32).toString("hex")
    await apiKeys.insertOne({ key, userId, createdAt: new Date() })

    res.json({ apiKey: key })
  } catch (error) {
    console.error("Generate key error:", error)
    res.status(500).json({ error: "Failed to generate API key" })
  }
})

export default router