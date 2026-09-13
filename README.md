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

## 3. PayU
Use PayU hosted checkout with `PAYU_BASE_URL`, `PAYU_KEY`, `PAYU_SALT`, and `PAYU_EMAIL`. Configure these callback URLs in PayU:

    https://YOUR-DOMAIN/payu/success
    https://YOUR-DOMAIN/payu/failure

Set `MOCK_PAYU_PAYMENT=true` for local testing without PayU credentials. Set it to `false` for real PayU test checkout.

## 4. Split settlement
PayU split settlement requires an activated parent merchant account and child merchants. The local `PAYU_MOCK_SPLIT=true` mode uses fake IDs and moves no money. Real split settlement requires PayU-issued child merchant keys and an approved `PAYU_SPLIT_REQUEST`.

## 5. Deploy on Render/Railway
Push this folder to GitHub. Create a Web Service using `npm install` as build command and `npm start` as start command. Add all .env values as service environment variables. Set PUBLIC_BASE_URL to the HTTPS service URL.

SQLite is okay for a single demo instance. Do not use this design for production or multiple replicas.

## 6. Admin
Open https://YOUR-DOMAIN/admin. Browser basic auth defaults to admin/demo123. Change ADMIN_USER and ADMIN_PASSWORD.

## 7. Demo run
1. Send any text to the Meta test WhatsApp number.
2. Tap Book can now.
3. Select cans and enter address.
4. Pay through PayU hosted checkout or local mock mode.
5. PayU callback marks order PAID.
6. WhatsApp confirmation is sent.
7. Admin page shows the order.
=======
# Autoflow-Beta-1.0
>>>>>>> 37975e9035b71c37f8fde467ce7ea70441881740
