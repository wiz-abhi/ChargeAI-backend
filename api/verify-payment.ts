// api/verify-payment.ts
import { Router } from "express"
import { AuthenticatedRequest } from "../middleware/auth"
import { verifyToken } from "../middleware/auth"
import { updateWalletBalance } from "../lib/mongodb"

const router = Router()

// Helper function to get PayPal access token
async function getPayPalAccessToken(): Promise<string> {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64')
  
  const response = await fetch(`${process.env.PAYPAL_API_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })

  if (!response.ok) {
    throw new Error('Failed to get PayPal access token')
  }

  const data = await response.json()
  return data.access_token
}

router.post("/", verifyToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.uid
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" })
    }

    const { orderId, amount } = req.body

    if (!orderId || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid request parameters" })
    }

    // Verify PayPal payment
    const accessToken = await getPayPalAccessToken()
    const response = await fetch(`${process.env.PAYPAL_API_URL}/v2/checkout/orders/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    })

    if (!response.ok) {
      console.error('PayPal verification failed:', await response.text())
      return res.status(400).json({ error: "Failed to verify PayPal payment" })
    }

    const paypalOrder = await response.json()

    // Verify payment details
    if (
      paypalOrder.status !== 'COMPLETED' ||
      Number(paypalOrder.purchase_units[0].amount.value) !== amount
    ) {
      return res.status(400).json({ error: "Invalid payment details" })
    }

    // Update wallet balance
    const updatedWallet = await updateWalletBalance(userId, amount)
    if (!updatedWallet) {
      return res.status(500).json({ error: "Failed to update wallet" })
    }

    return res.status(200).json({
      success: true,
      balance: updatedWallet.balance
    })

  } catch (error) {
    console.error("Payment verification error:", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

export default router