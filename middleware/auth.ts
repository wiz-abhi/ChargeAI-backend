import { Request, Response, NextFunction } from "express"
import { getAuth } from "firebase-admin/auth"

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string
  }
  apiKey?: string
}

export const verifyToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const token = authHeader.split("Bearer ")[1]
    const decodedToken = await getAuth().verifyIdToken(token)
    req.user = { uid: decodedToken.uid }
    next()
  } catch (error) {
    console.error("Auth error:", error)
    res.status(401).json({ error: "Invalid token" })
  }
}

export const verifyApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const apiKey = req.headers["x-api-key"]
    if (!apiKey) {
      return res.status(401).json({ error: "API key is required" })
    }
    req.apiKey = apiKey as string
    next()
  } catch (error) {
    console.error("API key error:", error)
    res.status(401).json({ error: "Invalid API key" })
  }
}
