import express from "express"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import chatRoute from "../api/chat"
import generateKeyRoute from "../api/generate-key"
import apiKeysRoute from "../api/api-keys"
import walletRoute from "../api/wallet"
import deleteKey from "../api/api-key/[key]"
import useAI from "../v1/chat/completions"
import verifyPayment from "../api/verify-payment"

const app = express()

// Initialize Firebase Admin SDK only if not already initialized
if (!getApps().length) {
  try {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    })
  } catch (error) {
    console.error("Firebase initialization error:", error)
  }
}

// Global middleware for CORS
const FRONTEND_ORIGIN = process.env.FRONTEND_URL

app.use((req, res, next) => {
  const origin = req.headers.origin

  // Allow all origins for /api/chat
  if (req.path.startsWith("/api/chat") || req.path.startsWith("/v1/chat/completions") ) {
    res.setHeader("Access-Control-Allow-Origin", "*")
  } else if (origin === FRONTEND_ORIGIN) {
    // Allow only frontend for other routes
    res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN)
  }

  // Set CORS headers for methods and credentials
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key")
  res.setHeader("Access-Control-Allow-Credentials", "true")

  // Handle preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  next()
})

// Middleware for JSON parsing
app.use(express.json())

// API routes
app.use("/api/chat", chatRoute)
app.use("/api/generate-key", generateKeyRoute)
app.use("/api/api-keys", apiKeysRoute)
app.use("/api/api-key", deleteKey)
app.use("/api/wallet", walletRoute)
app.use("/v1/chat/completions",useAI)
app.use("/api/verify-payment",verifyPayment)

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack)
  res.status(500).json({ error: "Something broke!" })
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" })
})

// Development server
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3001
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`)
  })
}

export default app
