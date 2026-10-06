# Rigor API — Backend Services

Backend API for the **rigor.design** platform. Serverless functions on Vercel.

## Structure

```
rigor-api/
├── api/
│   ├── _middleware/
│   │   ├── auth.js          # Firebase token verification
│   │   └── rateLimit.js     # In-memory rate limiter
│   ├── payment/
│   │   ├── create-session.js          # Stripe Checkout redirect
│   │   ├── create-embedded-session.js # Stripe Embedded Checkout
│   │   ├── webhook.js                 # Stripe webhook → Firestore sync
│   │   └── portal.js                  # Customer billing portal
│   └── lib/
│       └── firebase.js      # Firebase Admin SDK singleton
├── .env.example             # All secret env vars documented
├── package.json
└── vercel.json              # Routes, webhook raw body config, security headers
```

## Setup

```bash
cp .env.example .env.local
# Fill in Firebase Admin credentials, Stripe SECRET keys, and other API keys
vercel --prod
```

## Security

- Firebase token verification on all protected routes via `requireAuth` middleware
- Rate limiting on free tier endpoints
- Stripe webhook signature verification
- All secrets server-side only — never in frontend code
- Security headers (CSP, HSTS, X-Frame-Options) applied globally

## Stripe Webhook

Register `https://your-api.vercel.app/api/payment/webhook` in your Stripe Dashboard.
Events handled: `checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

### Via the MDO3D stripe-hub

`POST /api/payment/webhook-forwarded` accepts `{ "eventId": "evt_..." }` from
`projects/mdo3d/stripe-hub`. It re-fetches the event with `STRIPE_SECRET_KEY`, handles
it only if it belongs to rigor (`metadata.serviceName === "rigor"`, set on new checkout
sessions and subscriptions, or a price id in `STRIPE_PRO_PRICE_IDS` /
`STRIPE_TEAM_PRICE_IDS`), and runs the same handler as the direct webhook
(`api/lib/stripeEvents.js`). Once the hub is verified, the per-app endpoint above can be
removed from the Stripe dashboard.
