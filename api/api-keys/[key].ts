import express from "express"
import { getAuth } from "firebase-admin/auth"
import { connectToDatabase } from "../../lib/mongodb"

const router = express.Router()

router.delete("/:key", async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const token = authHeader.split("Bearer ")[1]
    let decodedToken
    try {
      decodedToken = await getAuth().verifyIdToken(token)
    } catch (error) {
      console.error("Error verifying Firebase ID token:", error)
      return res.status(401).json({ error: "Invalid token" })
    }

    const userId = decodedToken.uid
    const db = await connectToDatabase()
    const apiKeys = db.collection("apiKeys")
    
    const result = await apiKeys.deleteOne({ key: req.params.key, userId })
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "API key not found" })
    }

    return res.json({ message: "API key deleted successfully" })

  } catch (error) {
    console.error("Failed to delete API key:", error)
    return res.status(500).json({ error: "Failed to delete API key" })
  }
})

export default router