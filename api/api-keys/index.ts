import express from "express"
import { AuthenticatedRequest, verifyToken } from "../../middleware/auth"
import { connectToDatabase } from "../../lib/mongodb"

const router = express.Router()

router.get("/", verifyToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.uid
    const db = await connectToDatabase()
    const apiKeys = db.collection("apiKeys")

    const keys = await apiKeys
      .find({ userId }, { projection: { key: 1, createdAt: 1 } })
      .toArray()

    res.json(keys)
  } catch (error) {
    console.error("API keys error:", error)
    res.status(500).json({ error: "Failed to retrieve API keys" })
  }
})

export default router
