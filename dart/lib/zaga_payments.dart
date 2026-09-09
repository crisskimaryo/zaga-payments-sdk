/// Zaga Payments client for Dart / Flutter backends and server-side Dart.
///
/// Never ship a live API key inside a mobile app: call the gateway from your
/// backend. This package exists for Dart servers (dart_frog, shelf) and for
/// Flutter apps that only use test keys during development.
///
/// ```dart
/// final payments = ZagaPayments(baseUrl: 'https://payments.zaga.co.tz', apiKey: 'zp_live_…');
/// final charge = await payments.createCharge(method: 'mpesa', amountMinor: 5000, currency: 'TZS', msisdn: '+255712345678', idempotencyKey: orderId);
/// final settled = await payments.waitForSettlement(charge['id']);
/// ```
library zaga_payments;

import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

class ZagaPaymentsException implements Exception {
  final int status;
  final String code;
  final String message;
  ZagaPaymentsException(this.status, this.code, this.message);
  @override
  String toString() => 'ZagaPaymentsException($status $code: $message)';
}

class ZagaPayments {
  final String baseUrl;
  final String apiKey;
  final HttpClient _client = HttpClient();

  ZagaPayments({required String baseUrl, required this.apiKey}) : baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), '');

  Future<Map<String, dynamic>> _request(String method, String path, {Map<String, dynamic>? body, Map<String, String>? headers}) async {
    final request = await _client.openUrl(method, Uri.parse('$baseUrl$path'));
    request.headers.set('authorization', 'Bearer $apiKey');
    request.headers.set('content-type', 'application/json');
    request.headers.set('accept', 'application/json');
    headers?.forEach(request.headers.set);
    if (body != null) request.write(jsonEncode(body));
    final response = await request.close();
    final text = await response.transform(utf8.decoder).join();
    final Map<String, dynamic> parsed = text.isEmpty ? {} : jsonDecode(text) as Map<String, dynamic>;
    if (parsed['success'] != true) {
      throw ZagaPaymentsException(response.statusCode, (parsed['code'] ?? 'ERROR').toString(), (parsed['message'] ?? 'Request failed').toString());
    }
    return parsed;
  }

  /// Methods the buyer can pick right now.
  Future<List<Map<String, dynamic>>> listMethods({String? platform}) async {
    final r = await _request('GET', '/v1/methods${platform == null ? '' : '?platform=$platform'}');
    return List<Map<String, dynamic>>.from(r['data']['methods'] as List);
  }

  Future<List<Map<String, dynamic>>> listProducts() async {
    final r = await _request('GET', '/v1/products');
    return List<Map<String, dynamic>>.from(r['data']['products'] as List);
  }

  /// Starts a payment. Pass [idempotencyKey] (your order id) so retries never double-charge.
  Future<Map<String, dynamic>> createCharge({
    required String method,
    int? amountMinor,
    String? currency,
    String? productCode,
    String? msisdn,
    String? email,
    String? name,
    String? description,
    Map<String, dynamic>? metadata,
    String? externalReference,
    String? returnUrl,
    String? idempotencyKey,
  }) async {
    final r = await _request('POST', '/v1/charges', body: {
      'method': method,
      if (amountMinor != null) 'amount_minor': amountMinor,
      if (currency != null) 'currency': currency,
      if (productCode != null) 'product_code': productCode,
      'customer': {if (msisdn != null) 'msisdn': msisdn, if (email != null) 'email': email, if (name != null) 'name': name},
      if (description != null) 'description': description,
      if (metadata != null) 'metadata': metadata,
      if (externalReference != null) 'external_reference': externalReference,
      if (returnUrl != null) 'return_url': returnUrl,
    }, headers: idempotencyKey == null ? null : {'idempotency-key': idempotencyKey});
    return r['data'] as Map<String, dynamic>;
  }

  /// By id, provider reference or your external reference. [sync] asks the provider directly.
  Future<Map<String, dynamic>> getCharge(String idOrReference, {bool sync = false}) async {
    final r = await _request('GET', '/v1/charges/${Uri.encodeComponent(idOrReference)}${sync ? '?sync=1' : ''}');
    return r['data'] as Map<String, dynamic>;
  }

  /// Polls until the charge leaves `pending` or [timeout] passes. Asks the provider every [syncEvery] polls.
  Future<Map<String, dynamic>?> waitForSettlement(String idOrReference, {Duration interval = const Duration(seconds: 4), Duration timeout = const Duration(minutes: 3), int syncEvery = 5, void Function(Map<String, dynamic> charge, int attempt)? onPoll}) async {
    final deadline = DateTime.now().add(timeout);
    var attempt = 0;
    Map<String, dynamic>? last;
    while (DateTime.now().isBefore(deadline)) {
      attempt++;
      final charge = await getCharge(idOrReference, sync: attempt % syncEvery == 0);
      last = charge;
      onPoll?.call(charge, attempt);
      if (charge['status'] != 'pending') return charge;
      await Future<void>.delayed(interval);
    }
    return last;
  }

  Future<Map<String, dynamic>> refund(String chargeId, {int? amountMinor, String? reason}) async {
    final r = await _request('POST', '/v1/charges/${Uri.encodeComponent(chargeId)}/refunds', body: {if (amountMinor != null) 'amount_minor': amountMinor, if (reason != null) 'reason': reason});
    return r['data'] as Map<String, dynamic>;
  }

  /// Apple/Google in-app purchase, verified server-side and recorded once.
  Future<Map<String, dynamic>> claimStoreTransaction({required String provider, required String transactionId, String? productCode}) async {
    final r = await _request('POST', '/v1/store/claims', body: {'provider': provider, 'transaction_id': transactionId, if (productCode != null) 'product_code': productCode});
    return r['data'] as Map<String, dynamic>;
  }

  void close() => _client.close();
}

/// Verifies a webhook the gateway sent to your backend. Use the raw body bytes.
bool verifyWebhookSignature({required String secret, required String? timestamp, required String? signature, required String body, int toleranceSec = 300}) {
  if (timestamp == null || signature == null) return false;
  final ts = int.tryParse(timestamp);
  if (ts == null) return false;
  if ((DateTime.now().millisecondsSinceEpoch ~/ 1000 - ts).abs() > toleranceSec) return false;
  final expected = _hmacSha256Hex(secret, '$timestamp.$body');
  final received = signature.replaceFirst(RegExp(r'^v1='), '');
  if (expected.length != received.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.codeUnitAt(i) ^ received.codeUnitAt(i);
  }
  return diff == 0;
}

String _hmacSha256Hex(String key, String message) => Hmac(sha256, utf8.encode(key)).convert(utf8.encode(message)).toString();

/// Exposed for tests and for callers that sign their own requests; same primitive the gateway uses.
String hmacSha256HexForTest(String key, String message) => _hmacSha256Hex(key, message);
