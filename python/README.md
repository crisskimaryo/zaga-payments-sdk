# zaga-payments (Python)

```bash
pip install "git+https://github.com/crisskimaryo/zaga-payments-sdk.git#subdirectory=python"
```

```python
from zaga_payments import ZagaPayments, verify_webhook_signature

payments = ZagaPayments("https://payments.zaga.co.tz", "zp_live_...")
charge = payments.create_charge(method="mpesa", amount_minor=5000, currency="TZS", msisdn="+255712345678", idempotency_key=order_id)
settled = payments.wait_for_settlement(charge["id"])
```

See the repository README for the full contract.
