import express from "express"
import { getAuth } from "firebase-admin/auth"
import { getWallet, createWallet } from "../lib/mongodb"
import { initializeApp, getApps, cert } from "firebase-admin/app"

const router = express.Router()

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    }),
  })
}

router.get("/", async (req, res) => {
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

    let wallet = await getWallet(userId)
    if (!wallet) {
      wallet = await createWallet(userId)
    }

    console.log("Wallet response:", JSON.stringify(wallet))
    return res.json(wallet)
  } catch (error) {
    console.error("Failed to retrieve wallet:", error)
    return res.status(500).json({ error: "Failed to retrieve wallet" })
  }
})

export default router