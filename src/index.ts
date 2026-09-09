/**
 * Zaga Payments SDK: a thin, dependency-free client for the gateway.
 *
 *   const payments = new ZagaPayments({ baseUrl: 'https://payments.zaga.co.tz', apiKey: process.env.ZAGA_PAYMENTS_KEY! });
 *   const charge = await payments.charges.create({ method: 'mpesa', amount_minor: 5000, currency: 'TZS', customer: { msisdn: '+255712345678' } }, { idempotencyKey: orderId });
 *
 * Verify webhooks with `verifyWebhookSignature` before trusting a delivery.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type ChargeStatus = 'pending' | 'completed' | 'failed';

export type Charge = {
  id: string;
  object: 'charge';
  app?: string;
  mode: 'live' | 'test';
  status: ChargeStatus;
  provider: string;
  method: string;
  amount_minor: number;
  currency: string;
  amount_display: string;
  customer: { msisdn: string | null; email: string | null; name: string | null };
  description: string | null;
  metadata: Record<string, unknown>;
  external_reference: string | null;
  product_code: string | null;
  checkout: { mode: 'push' | 'redirect' | 'none' | null; url: string | null };
  provider_reference: string | null;
  environment: 'live' | 'sandbox';
  failure_reason: string | null;
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentMethod = {
  id: string;
  providerId: string;
  kind: 'mobile_money' | 'card' | 'bank' | 'store' | 'sandbox';
  label: string;
  hint?: string;
  currencies: string[];
  countries?: string[];
  platforms?: Array<'ios' | 'android' | 'web'>;
  requires?: Array<'msisdn' | 'email'>;
  priceAdjustmentRate?: number;
  available: boolean;
  reason?: string | null;
};

export type Product = {
  code: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  active: boolean;
  sort_order: number;
  prices: Array<{ currency: string; amount_minor: number; store_product_ids: Record<string, string> }>;
};

export type CreateChargeInput = {
  method: string;
  amount_minor?: number;
  currency?: string;
  product_code?: string;
  customer?: { msisdn?: string; email?: string; name?: string };
  description?: string;
  metadata?: Record<string, unknown>;
  external_reference?: string;
  return_url?: string;
};

export type Refund = {
  id: string;
  charge_id: string;
  amount_minor: number;
  currency: string;
  amount_display: string;
  status: ChargeStatus;
  reason: string | null;
  provider_reference: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookEvent = {
  id: string;
  type: 'charge.completed' | 'charge.failed' | 'charge.pending';
  created_at: string;
  data: { charge: Charge };
};

export class ZagaPaymentsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Envelope<T> = { success: true; data: T; meta?: Record<string, unknown> } | { success: false; code: string; message: string; details?: unknown };

export type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Request timeout in milliseconds (default 20s). */
  timeoutMs?: number;
};

export class ZagaPayments {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.doFetch = options.fetch || fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: T; meta: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: Envelope<T>;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ZagaPaymentsError(response.status, 'BAD_RESPONSE', `Gateway answered ${response.status} with a non-JSON body.`);
      }
      if (!parsed.success) throw new ZagaPaymentsError(response.status, parsed.code, parsed.message, parsed.details);
      return { data: parsed.data, meta: parsed.meta || {} };
    } finally {
      clearTimeout(timer);
    }
  }

  readonly methods = {
    /** Methods the buyer can pick right now (already filtered by provider health). */
    list: async (options: { platform?: 'ios' | 'android' | 'web' } = {}) => {
      const query = options.platform ? `?platform=${options.platform}` : '';
      return (await this.request<{ methods: PaymentMethod[]; checked_at: string }>('GET', `/v1/methods${query}`)).data;
    },
  };

  readonly products = {
    list: async () => (await this.request<{ products: Product[] }>('GET', '/v1/products')).data.products,
  };

  readonly charges = {
    /** Starts a payment. Pass `idempotencyKey` (your order id) so retries never double-charge. */
    create: async (input: CreateChargeInput, options: { idempotencyKey?: string } = {}) => {
      const result = await this.request<Charge>('POST', '/v1/charges', input, options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {});
      return { charge: result.data, deduplicated: Boolean(result.meta.deduplicated) };
    },
    /** By charge id, provider reference or your external_reference. `sync` asks the provider directly. */
    get: async (idOrReference: string, options: { sync?: boolean } = {}) => {
      const result = await this.request<Charge>('GET', `/v1/charges/${encodeURIComponent(idOrReference)}${options.sync ? '?sync=1' : ''}`);
      return { charge: result.data, syncError: (result.meta.sync_error as string | null) ?? null };
    },
    list: async (options: { status?: ChargeStatus; limit?: number; before?: string; search?: string } = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
      const query = params.toString();
      return (await this.request<{ charges: Charge[] }>('GET', `/v1/charges${query ? `?${query}` : ''}`)).data.charges;
    },
    /**
     * Polls until the charge settles or `timeoutMs` passes. Asks the
     * provider directly every `syncEvery` polls, the way Dukuduku's waiting
     * sheet does. Returns the last charge seen.
     */
    waitForSettlement: async (
      idOrReference: string,
      options: { intervalMs?: number; timeoutMs?: number; syncEvery?: number; onPoll?: (charge: Charge, attempt: number) => void; isCancelled?: () => boolean } = {}
    ) => {
      const interval = options.intervalMs ?? 4000;
      const deadline = Date.now() + (options.timeoutMs ?? 3 * 60_000);
      const syncEvery = options.syncEvery ?? 5;
      let attempt = 0;
      let last: Charge | null = null;
      while (Date.now() < deadline && !options.isCancelled?.()) {
        attempt++;
        const { charge } = await this.charges.get(idOrReference, { sync: attempt % syncEvery === 0 });
        last = charge;
        options.onPoll?.(charge, attempt);
        if (charge.status !== 'pending') return charge;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      return last;
    },
  };

  readonly refunds = {
    /** Full refund when `amount_minor` is omitted. `manual` means an operator finishes it at the provider. */
    create: async (chargeId: string, input: { amount_minor?: number; reason?: string } = {}) => {
      const result = await this.request<Refund>('POST', `/v1/charges/${encodeURIComponent(chargeId)}/refunds`, input);
      return { refund: result.data, manual: Boolean(result.meta.manual), note: (result.meta.note as string | null) ?? null };
    },
    list: async (chargeId: string) => (await this.request<{ refunds: Refund[] }>('GET', `/v1/charges/${encodeURIComponent(chargeId)}/refunds`)).data.refunds,
  };

  readonly store = {
    /** Apple/Google in-app purchase: verified with the store, recorded once per transaction. */
    claim: async (input: { provider: 'apple_app_store' | 'google_play' | string; transaction_id: string; product_code?: string; environment?: 'sandbox' | 'live' }) => {
      const result = await this.request<Charge>('POST', '/v1/store/claims', input);
      return { charge: result.data, credited: Boolean(result.meta.credited), duplicate: Boolean(result.meta.duplicate) };
    },
  };
}

/**
 * Verifies an incoming gateway webhook. Read the raw body (not a parsed
 * object), then:
 *
 *   const ok = verifyWebhookSignature({ secret, timestamp: req.headers['x-zaga-timestamp'], signature: req.headers['x-zaga-signature'], body: rawBody });
 */
export const verifyWebhookSignature = (input: { secret: string; timestamp: string | null | undefined; signature: string | null | undefined; body: string; toleranceSec?: number; now?: number }) => {
  if (!input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs((input.now ?? Date.now()) / 1000 - ts) > (input.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(createHmac('sha256', input.secret).update(`${input.timestamp}.${input.body}`).digest('hex'), 'hex');
  const received = Buffer.from(String(input.signature).replace(/^v1=/, ''), 'hex');
  return expected.length === received.length && timingSafeEqual(new Uint8Array(expected), new Uint8Array(received));
};

/** Parses and verifies in one step; throws when the signature is bad. */
export const parseWebhook = (input: { secret: string; headers: Record<string, string | undefined> | Headers; body: string }): WebhookEvent => {
  const get = (name: string) => (input.headers instanceof Headers ? input.headers.get(name) : input.headers[name] ?? input.headers[name.toLowerCase()]) || undefined;
  if (!verifyWebhookSignature({ secret: input.secret, timestamp: get('x-zaga-timestamp'), signature: get('x-zaga-signature'), body: input.body })) {
    throw new ZagaPaymentsError(403, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature did not verify.');
  }
  return JSON.parse(input.body) as WebhookEvent;
};
