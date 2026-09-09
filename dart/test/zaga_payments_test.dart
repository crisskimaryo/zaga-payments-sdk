import 'package:test/test.dart';
import 'package:zaga_payments/zaga_payments.dart';

void main() {
  // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog") from RFC-style reference vectors.
  const secret = 'key';
  const body = 'The quick brown fox jumps over the lazy dog';

  test('verifies a fresh signature and rejects tampering', () {
    final ts = (DateTime.now().millisecondsSinceEpoch ~/ 1000).toString();
    // Compute the expected value with the same primitive the gateway uses.
    final sig = 'v1=${hmacSha256HexForTest(secret, '$ts.$body')}';
    expect(verifyWebhookSignature(secret: secret, timestamp: ts, signature: sig, body: body), isTrue);
    expect(verifyWebhookSignature(secret: secret, timestamp: ts, signature: sig, body: '$body '), isFalse);
    expect(verifyWebhookSignature(secret: 'other', timestamp: ts, signature: sig, body: body), isFalse);
    final stale = ((DateTime.now().millisecondsSinceEpoch ~/ 1000) - 3600).toString();
    expect(verifyWebhookSignature(secret: secret, timestamp: stale, signature: sig, body: body), isFalse);
  });

  test('hmac matches the published vector', () {
    expect(hmacSha256HexForTest(secret, body), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
}
