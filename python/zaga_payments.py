"""Zaga Payments client for Python backends. Standard library only.

    from zaga_payments import ZagaPayments, verify_webhook_signature

    payments = ZagaPayments("https://payments.zaga.co.tz", "zp_live_...")
    charge = payments.create_charge(method="mpesa", amount_minor=5000, currency="TZS", msisdn="+255712345678", idempotency_key=order_id)
    settled = payments.wait_for_settlement(charge["id"])

    # in your webhook view (raw body!)
    ok = verify_webhook_signature(secret, request.headers.get("x-zaga-timestamp"), request.headers.get("x-zaga-signature"), raw_body)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional


class ZagaPaymentsError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


class ZagaPayments:
    def __init__(self, base_url: str, api_key: str, timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _request(self, method: str, path: str, body: Optional[dict] = None, headers: Optional[dict] = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("authorization", f"Bearer {self.api_key}")
        req.add_header("content-type", "application/json")
        req.add_header("accept", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                text = resp.read().decode()
                status = resp.status
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            status = e.code
        parsed = json.loads(text) if text else {}
        if not parsed.get("success"):
            raise ZagaPaymentsError(status, parsed.get("code", "ERROR"), parsed.get("message", "Request failed"))
        return parsed

    def list_methods(self, platform: Optional[str] = None) -> list[dict]:
        q = f"?platform={platform}" if platform else ""
        return self._request("GET", f"/v1/methods{q}")["data"]["methods"]

    def list_products(self) -> list[dict]:
        return self._request("GET", "/v1/products")["data"]["products"]

    def create_charge(self, method: str, amount_minor: Optional[int] = None, currency: Optional[str] = None, product_code: Optional[str] = None, msisdn: Optional[str] = None, email: Optional[str] = None, name: Optional[str] = None, description: Optional[str] = None, metadata: Optional[dict] = None, external_reference: Optional[str] = None, return_url: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"method": method, "customer": {}}
        if amount_minor is not None: body["amount_minor"] = amount_minor
        if currency: body["currency"] = currency
        if product_code: body["product_code"] = product_code
        if msisdn: body["customer"]["msisdn"] = msisdn
        if email: body["customer"]["email"] = email
        if name: body["customer"]["name"] = name
        if description: body["description"] = description
        if metadata: body["metadata"] = metadata
        if external_reference: body["external_reference"] = external_reference
        if return_url: body["return_url"] = return_url
        headers = {"idempotency-key": idempotency_key} if idempotency_key else None
        return self._request("POST", "/v1/charges", body, headers)["data"]

    def get_charge(self, id_or_reference: str, sync: bool = False) -> dict:
        q = "?sync=1" if sync else ""
        return self._request("GET", f"/v1/charges/{urllib.parse.quote(id_or_reference, safe='')}{q}")["data"]

    def wait_for_settlement(self, id_or_reference: str, interval: float = 4.0, timeout: float = 180.0, sync_every: int = 5, on_poll: Optional[Callable[[dict, int], None]] = None) -> Optional[dict]:
        deadline = time.time() + timeout
        attempt = 0
        last = None
        while time.time() < deadline:
            attempt += 1
            charge = self.get_charge(id_or_reference, sync=attempt % sync_every == 0)
            last = charge
            if on_poll: on_poll(charge, attempt)
            if charge["status"] != "pending": return charge
            time.sleep(interval)
        return last

    def refund(self, charge_id: str, amount_minor: Optional[int] = None, reason: Optional[str] = None) -> dict:
        body: dict[str, Any] = {}
        if amount_minor is not None: body["amount_minor"] = amount_minor
        if reason: body["reason"] = reason
        return self._request("POST", f"/v1/charges/{urllib.parse.quote(charge_id, safe='')}/refunds", body)["data"]

    def claim_store_transaction(self, provider: str, transaction_id: str, product_code: Optional[str] = None) -> dict:
        body = {"provider": provider, "transaction_id": transaction_id}
        if product_code: body["product_code"] = product_code
        return self._request("POST", "/v1/store/claims", body)["data"]


def verify_webhook_signature(secret: str, timestamp: Optional[str], signature: Optional[str], body: str | bytes, tolerance_sec: int = 300) -> bool:
    if not timestamp or not signature: return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs(time.time() - ts) > tolerance_sec: return False
    raw = body.decode() if isinstance(body, bytes) else body
    expected = hmac.new(secret.encode(), f"{timestamp}.{raw}".encode(), hashlib.sha256).hexdigest()
    received = signature[3:] if signature.startswith("v1=") else signature
    return hmac.compare_digest(expected, received)
