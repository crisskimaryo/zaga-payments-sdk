# Zaga Payments SDK

Official clients for the [Zaga Payments](https://github.com/crisskimaryo) gateway:
one API key per app, one contract for every mobile-money and in-app-purchase
provider behind it, signed webhooks when money lands.

| Language | Where | Install |
| --- | --- | --- |
| TypeScript / JavaScript (Bun, Node ≥ 18) | repo root, `src/` | `npm install github:crisskimaryo/zaga-payments-sdk#v0.1.0` |
| Dart (servers, or Flutter with test keys) | `dart/` | pubspec git dependency with `path: dart` (below) |
| Python ≥ 3.9 | `python/` | `pip install "git+https://github.com/crisskimaryo/zaga-payments-sdk.git#subdirectory=python"` |

All three are dependency-free and about 200 lines; read them.

Pin a tag once you are in production, e.g. `github:crisskimaryo/zaga-payments-sdk#v0.1.0`.

## TypeScript

```bash
npm install github:crisskimaryo/zaga-payments-sdk#v0.1.0      # npm / pnpm: git clone, works while the repo is private
bun add zaga-payments@github:crisskimaryo/zaga-payments-sdk#v0.1.0   # bun fetches the GitHub tarball: needs the repo public
```

Bun with a private repo: install with npm (or vendor `src/index.ts`) until the
repository is public; Bun downloads GitHub packages as API tarballs and does not
use your git credentials.

```ts
import { ZagaPayments, parseWebhook } from 'zaga-payments';

const payments = new ZagaPayments({ baseUrl: 'https://payments.zaga.co.tz', apiKey: process.env.ZAGA_PAYMENTS_KEY! });

// 1. start a charge; the buyer confirms on their phone
const charge = await payments.charges.create(
  { method: 'mpesa', amount_minor: 5000, currency: 'TZS', customer: { msisdn: '+255712345678' }, external_reference: order.id },
  { idempotencyKey: order.id } // retries never double-charge
);

// 2a. wait for it (polling), or
const settled = await payments.charges.waitForSettlement(charge.id);

// 2b. receive the signed webhook (raw body!)
app.post('/webhooks/zaga', async (req) => {
  const event = parseWebhook({ secret: process.env.ZAGA_WEBHOOK_SECRET!, headers: req.headers, body: await req.text() });
  if (event.type === 'charge.completed') fulfil(event.data.charge);
  return new Response('ok');
});

// refunds
await payments.refunds.create(charge.id, { amount_minor: 2000, reason: 'partial' });
```

The package ships TypeScript source (`main: src/index.ts`). Bun, tsx, Vite,
Next and esbuild consume it directly. A plain Node `require` needs a
transpiling loader; an npm build with `dist/` comes with the first npm release.

## Dart

```yaml
dependencies:
  zaga_payments:
    git:
      url: https://github.com/crisskimaryo/zaga-payments-sdk.git
      path: dart
      # ref: v0.1.0
```

```dart
final payments = ZagaPayments(baseUrl: 'https://payments.zaga.co.tz', apiKey: 'zp_test_...');
final charge = await payments.createCharge(method: 'mpesa', amountMinor: 5000, currency: 'TZS', msisdn: '+255712345678', idempotencyKey: orderId);
final settled = await payments.waitForSettlement(charge.id);
```

Never embed a **live** key in a mobile app. Apps call their own backend, and
the backend talks to the gateway.

## Python

```bash
pip install "git+https://github.com/crisskimaryo/zaga-payments-sdk.git#subdirectory=python"
```

```python
from zaga_payments import ZagaPayments, verify_webhook_signature

payments = ZagaPayments("https://payments.zaga.co.tz", "zp_live_...")
charge = payments.create_charge(method="mpesa", amount_minor=5000, currency="TZS", msisdn="+255712345678", idempotency_key=order_id)
```

## The contract in one screen

- Money is always in **minor units** (`amount_minor`), currency ISO 4217.
- `POST /v1/charges` → `{ id, status: pending|completed|failed, checkout: { mode, url }, expires_at, ... }`.
- `GET /v1/charges/:id` for status. Test keys (`zp_test_…`) only ever reach sandbox providers.
- Webhooks carry `x-zaga-timestamp` and `x-zaga-signature: v1=<hmac-sha256(timestamp + "." + rawBody)>`. Verify with the SDK, reject anything older than five minutes, answer `2xx`, and treat deliveries as at-least-once (dedupe by event `id`).
- Errors are `{ success: false, code, message }`; the SDKs raise `ZagaPaymentsError` with `status` and `code`.

## Developing

```bash
bun install
bun run typecheck
bun test
```

Versions follow semver; tag releases `vX.Y.Z`. Keep the three clients at the
same surface: a new endpoint lands in all three in the same release.

## License

MIT.
