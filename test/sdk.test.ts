import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { ZagaPayments, ZagaPaymentsError, parseWebhook, verifyWebhookSignature } from '../src/index';

const secret = 'whsec_test_secret';
const sign = (timestamp: string, body: string) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

describe('webhook verification', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'charge.completed', data: { charge: { id: 'ch_1' } } });
  const timestamp = String(Math.floor(Date.now() / 1000));

  test('accepts a fresh, correctly signed delivery', () => {
    expect(verifyWebhookSignature({ secret, timestamp, signature: sign(timestamp, body), body })).toBe(true);
    const event = parseWebhook({ secret, headers: { 'x-zaga-timestamp': timestamp, 'x-zaga-signature': sign(timestamp, body) }, body });
    expect(event.type).toBe('charge.completed');
  });

  test('rejects a tampered body, a wrong secret and a stale timestamp', () => {
    expect(verifyWebhookSignature({ secret, timestamp, signature: sign(timestamp, body), body: body + ' ' })).toBe(false);
    expect(verifyWebhookSignature({ secret: 'other', timestamp, signature: sign(timestamp, body), body })).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyWebhookSignature({ secret, timestamp: old, signature: sign(old, body), body })).toBe(false);
    expect(() => parseWebhook({ secret, headers: {}, body })).toThrow();
  });
});

describe('client', () => {
  test('sends the api key, idempotency key and surfaces gateway errors', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl: typeof fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), headers: (() => { const h: Record<string, string> = {}; new Headers(init.headers).forEach((v, k) => { h[k] = v; }); return h; })(), body: init.body });
      if (seen.length === 1) return new Response(JSON.stringify({ success: true, data: { id: 'ch_1', object: 'charge', status: 'pending' } }), { status: 201, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ success: false, code: 'CHARGE_NOT_FOUND', message: 'Charge not found.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as any;
    const payments = new ZagaPayments({ baseUrl: 'https://payments.example.test/', apiKey: 'zp_test_abc', fetch: fetchImpl });
    const { charge } = await payments.charges.create({ method: 'sandbox', amount_minor: 1000, currency: 'TZS', customer: { msisdn: '+255700000001' } }, { idempotencyKey: 'order-1' });
    expect(charge.id).toBe('ch_1');
    expect(seen[0].url).toBe('https://payments.example.test/v1/charges');
    expect(seen[0].headers['authorization']).toBe('Bearer zp_test_abc');
    expect(seen[0].headers['idempotency-key']).toBe('order-1');
    await expect(payments.charges.get('ch_missing')).rejects.toBeInstanceOf(ZagaPaymentsError);
  });
});
