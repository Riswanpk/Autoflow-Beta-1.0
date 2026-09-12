<<<<<<< HEAD
# Water Can WhatsApp + PayU Demo

Beginner-friendly demo: WhatsApp Cloud API -> booking template -> checkout -> PayU hosted checkout -> PayU callback -> optional split settlement -> WhatsApp confirmation -> admin.

## 1. Local setup
Install Node.js 20+. Then:

    npm install
    cp .env.example .env
    npm start

Open http://localhost:3000/health.

## 2. Meta WhatsApp
Create a Meta app, add WhatsApp, use the test phone number, add your recipient phone under WhatsApp API test recipients, and copy the phone number ID + temporary access token. The webhook must be public HTTPS.

Webhook callback URL: https://YOUR-DOMAIN/webhook
Verify token: same value as WA_VERIFY_TOKEN
Subscribe to messages.

For the one-click "Book can now" URL button, create an approved WhatsApp Message Template named `book_can` with a URL CTA button configured as:
https://YOUR-DOMAIN/checkout?ref={{1}}
The code sends the order reference as the dynamic suffix.

If Meta template approval is not ready, temporarily change the webhook to send a normal text containing https://YOUR-DOMAIN/checkout?ref=ORDERID for testing.

## 3. Decentro
Use the staging environment. Decentro's payment-link endpoint is https://staging.api.decentro.tech/v3/payments/upi/link. It accepts client_id/client_secret headers and consumer_urn, reference_id, amount, purpose_message, expiry_time and redirect_url in the body. Their testbed uses amount 10 for SUCCESS, 20 for FAILURE, 40 for PENDING, and deliberately delays terminal simulation by about 10 seconds.

Configure Decentro's terminal transaction callback to:
https://YOUR-DOMAIN/webhooks/decentro/payment

Important: the sandbox is a simulation. The HTTP/API integration is real, but it does not move real customer money. Do not put production credentials into this demo.

For local testing without a Decentro account, set `MOCK_DECENTRO=true`. The checkout marks the order paid and opens the success page without calling Decentro. Set `MOCK_DECENTRO_STATUS` to `SUCCESS`, `FAILED`, or `PENDING` to test each result. Set it back to `false` before using real Decentro.

## 4. Payout
The optional payout function uses Decentro's staging Direct Payout endpoint and requires module_secret/provider_secret plus a master virtual account. Decentro requires the payout source account to be linked/configured for the provider. Set DECENTRO_MASTER_VIRTUAL_ACCOUNT and DECENTRO_SECOND_UPI to enable it.

For an actual 2% split at collection time, ask Decentro to configure a split-settlement rule and put its URN in DECENTRO_SPLIT_SETTLEMENT_RULE_URN. The collection API supports split_settlement_rule_urn. The customer should pay the base order amount; the split rule must allocate the 2% platform share and Decentro's processing fee from that payment, with the remainder settling to the main account. This is preferable to adding both fees to the customer's amount.

## 5. Deploy on Render/Railway
Push this folder to GitHub. Create a Web Service using `npm install` as build command and `npm start` as start command. Add all .env values as service environment variables. Set PUBLIC_BASE_URL to the HTTPS service URL.

SQLite is okay for a single demo instance. Do not use this design for production or multiple replicas.

## 6. Admin
Open https://YOUR-DOMAIN/admin. Browser basic auth defaults to admin/demo123. Change ADMIN_USER and ADMIN_PASSWORD.

## 7. Demo run
1. Send any text to the Meta test WhatsApp number.
2. Tap Book can now.
3. Select cans and enter address.
4. Pay through Decentro staging test flow.
5. Decentro callback marks order PAID.
6. Optional payout runs.
7. WhatsApp confirmation is sent.
8. Admin page shows the order.
=======
# Autoflow-Beta-1.0
>>>>>>> 37975e9035b71c37f8fde467ce7ea70441881740
