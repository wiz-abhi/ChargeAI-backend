import express from "express"
import cors from "cors"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import chatRoute from "../api/chat"
import generateKeyRoute from "../api/generate-key"
import apiKeysRoute from "../api/api-keys"
import walletRoute from "../api/wallet"
import deleteKey from "../api/api-key/[key]"

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

// Global middleware
app.use(express.json())
app.use(
  cors({
    origin: process.env.FRONTEND_URL ,
    credentials: true,
  })
)

app.use(
  "/api/chat",
  cors({
    origin: "*", // Allow all origins for this route
    credentials: true,
  }),
  chatRoute
)

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack)
  res.status(500).json({ error: "Something broke!" })
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" })
})

// API routes
app.use("/api/generate-key", generateKeyRoute)
app.use("/api/api-keys", apiKeysRoute)
app.use("/api/api-key", deleteKey)
app.use("/api/wallet", walletRoute)

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" })
})

// Development server
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3001
  app.listen(port, () => {
    console.log(Server is running on port ${port})
  })
}

export default app
