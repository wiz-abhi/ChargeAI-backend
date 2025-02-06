// api/webhooks/paypal.ts
import { Router } from "express"
import { updateWalletBalance } from "../lib/mongodb"

const router = Router()

router.post("/", async (req, res) => {
  try {
    const webhookEvent = req.body

    // Verify webhook signature (recommended)
    // const isValid = verifyWebhookSignature(req)
    // if (!isValid) return res.status(401).send()

    switch (webhookEvent.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        const payment = webhookEvent.resource
        const userId = payment.custom_id // You'll need to pass this in your frontend
        const amount = Number(payment.amount.value)

        // Update wallet
        await updateWalletBalance(userId, amount)
        break

      case 'PAYMENT.CAPTURE.DENIED':
        // Handle denied payment
        console.log('Payment denied:', webhookEvent)
        break

      case 'PAYMENT.CAPTURE.REFUNDED':
        // Handle refund
        const refund = webhookEvent.resource
        const refundUserId = refund.custom_id
        const refundAmount = -Number(refund.amount.value)
        
        // Deduct refunded amount
        await updateWalletBalance(refundUserId, refundAmount)
        break
    }

    res.status(200).send()
  } catch (error) {
    console.error('Webhook error:', error)
    res.status(500).send()
  }
})

export default router
