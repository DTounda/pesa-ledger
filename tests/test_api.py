import uuid

import pytest

from app.main import WEB_DIR


def new_key():
    return str(uuid.uuid4())


def create_account(client, name="Amina", currency="RWF"):
    r = client.post("/accounts", json={"owner_name": name, "phone": "+250788000111",
                                       "currency": currency})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def deposit(client, account_id, amount, key=None):
    return client.post("/deposits", json={"account_id": account_id, "amount": amount},
                       headers={"Idempotency-Key": key or new_key()})


def balance(client, account_id):
    return client.get(f"/accounts/{account_id}").json()["balance"]


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_create_and_read_account(client):
    account_id = create_account(client)
    r = client.get(f"/accounts/{account_id}")
    assert r.status_code == 200
    assert r.json()["balance"] == 0
    assert r.json()["currency"] == "RWF"


def test_rejects_unsupported_currency(client):
    r = client.post("/accounts", json={"owner_name": "X", "phone": "+250788000111",
                                       "currency": "ABC"})
    assert r.status_code == 422


def test_deposit_creates_two_balanced_entries(client):
    account_id = create_account(client)
    r = deposit(client, account_id, 5000)
    assert r.status_code == 201
    entries = r.json()["entries"]
    assert len(entries) == 2
    assert sum(e["amount"] for e in entries) == 0
    assert balance(client, account_id) == 5000


def test_transfer_moves_money(client):
    a, b = create_account(client, "Amina"), create_account(client, "Brian")
    deposit(client, a, 10000)
    r = client.post("/transfers", json={"from_account_id": a, "to_account_id": b,
                                        "amount": 2500},
                    headers={"Idempotency-Key": new_key()})
    assert r.status_code == 201
    assert balance(client, a) == 7500
    assert balance(client, b) == 2500


def test_insufficient_funds(client):
    a, b = create_account(client, "Amina"), create_account(client, "Brian")
    deposit(client, a, 1000)
    r = client.post("/transfers", json={"from_account_id": a, "to_account_id": b,
                                        "amount": 5000},
                    headers={"Idempotency-Key": new_key()})
    assert r.status_code == 422
    assert "Insufficient funds" in r.json()["error"]
    assert balance(client, a) == 1000


def test_withdrawal(client):
    a = create_account(client)
    deposit(client, a, 3000)
    r = client.post("/withdrawals", json={"account_id": a, "amount": 1000},
                    headers={"Idempotency-Key": new_key()})
    assert r.status_code == 201
    assert balance(client, a) == 2000


def test_retry_with_same_key_moves_money_once(client):
    a = create_account(client)
    key = new_key()
    first = deposit(client, a, 4000, key=key)
    retry = deposit(client, a, 4000, key=key)
    assert first.status_code == 201
    assert retry.status_code == 200
    assert retry.headers["Idempotent-Replayed"] == "true"
    assert retry.json()["id"] == first.json()["id"]
    assert balance(client, a) == 4000  # not 8000


def test_same_key_different_request_is_rejected(client):
    a = create_account(client)
    key = new_key()
    deposit(client, a, 4000, key=key)
    r = deposit(client, a, 9999, key=key)
    assert r.status_code == 409


def test_missing_idempotency_key_is_rejected(client):
    a = create_account(client)
    r = client.post("/deposits", json={"account_id": a, "amount": 100})
    assert r.status_code == 422


def test_currency_mismatch(client):
    a = create_account(client, currency="RWF")
    b = create_account(client, currency="KES")
    deposit(client, a, 1000)
    r = client.post("/transfers", json={"from_account_id": a, "to_account_id": b,
                                        "amount": 100},
                    headers={"Idempotency-Key": new_key()})
    assert r.status_code == 400


def test_cannot_transfer_to_self(client):
    a = create_account(client)
    deposit(client, a, 1000)
    r = client.post("/transfers", json={"from_account_id": a, "to_account_id": a,
                                        "amount": 100},
                    headers={"Idempotency-Key": new_key()})
    assert r.status_code == 400


def test_unknown_account_returns_404(client):
    assert client.get("/accounts/9999").status_code == 404
    assert deposit(client, 9999, 100).status_code == 404


def test_amount_must_be_positive(client):
    a = create_account(client)
    assert deposit(client, a, 0).status_code == 422
    assert deposit(client, a, -50).status_code == 422


def test_history_and_reconciliation(client):
    a, b = create_account(client, "Amina"), create_account(client, "Brian")
    deposit(client, a, 10000)
    client.post("/transfers", json={"from_account_id": a, "to_account_id": b,
                                    "amount": 3000},
                headers={"Idempotency-Key": new_key()})
    history = client.get(f"/accounts/{a}/transactions").json()
    assert [t["kind"] for t in history] == ["transfer", "deposit"]

    report = client.get("/reconciliation").json()
    assert report["balanced"] is True
    assert report["ledger_total"] == 0
    assert report["mismatches"] == []


def test_list_accounts_hides_system_accounts(client):
    create_account(client, "Amina")
    create_account(client, "Brian")
    names = [a["owner_name"] for a in client.get("/accounts").json()]
    assert names == ["Amina", "Brian"]


@pytest.mark.skipif(not WEB_DIR.is_dir(), reason="web app not added yet")
def test_web_app_is_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Pesa Wallet" in r.text
