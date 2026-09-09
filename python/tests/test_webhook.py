import hashlib
import hmac
import time

from zaga_payments import verify_webhook_signature


def _sign(secret: str, ts: str, body: str) -> str:
    return "v1=" + hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()


def test_verify_accepts_fresh_and_rejects_bad():
    secret, body = "whsec_test", '{"id":"evt_1"}'
    ts = str(int(time.time()))
    assert verify_webhook_signature(secret, ts, _sign(secret, ts, body), body)
    assert not verify_webhook_signature(secret, ts, _sign(secret, ts, body), body + " ")
    assert not verify_webhook_signature("other", ts, _sign(secret, ts, body), body)
    stale = str(int(time.time()) - 3600)
    assert not verify_webhook_signature(secret, stale, _sign(secret, stale, body), body)
    assert not verify_webhook_signature(secret, None, None, body)
