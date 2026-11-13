"""Stress test: fire many payments at the same time and prove nothing breaks.

Run the API first, then:  python scripts/stress_test.py
Works with SQLite or PostgreSQL. PostgreSQL (docker compose up) is the
realistic setup and the one CI uses.
"""
import random
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
client = httpx.Client(base_url=BASE_URL, timeout=30)


def key():
    return str(uuid.uuid4())


def make_account(name):
    r = client.post("/accounts", json={"owner_name": name, "phone": "+250788000111",
                                       "currency": "RWF"})
    r.raise_for_status()
    return r.json()["id"]


def deposit(account_id, amount):
    client.post("/deposits", json={"account_id": account_id, "amount": amount},
                headers={"Idempotency-Key": key()}).raise_for_status()


def transfer(from_id, to_id, amount, idem_key):
    r = client.post("/transfers", json={"from_account_id": from_id,
                                        "to_account_id": to_id, "amount": amount},
                    headers={"Idempotency-Key": idem_key})
    return r.status_code


def balance(account_id):
    return client.get(f"/accounts/{account_id}").json()["balance"]


def test_double_spending():
    """50 people try to spend the same 1,000 at once. Exactly 10 can succeed."""
    print("\n1) Double-spending test: 50 simultaneous transfers of 100 from a 1,000 balance")
    sender, receiver = make_account("Sender"), make_account("Receiver")
    deposit(sender, 1000)
    with ThreadPoolExecutor(max_workers=50) as pool:
        codes = list(pool.map(lambda _: transfer(sender, receiver, 100, key()), range(50)))
    ok, refused = codes.count(201), codes.count(422)
    print(f"   succeeded: {ok}, refused for insufficient funds: {refused}")
    print(f"   sender balance: {balance(sender)}, receiver balance: {balance(receiver)}")
    assert ok == 10 and refused == 40, codes
    assert balance(sender) == 0 and balance(receiver) == 1000
    print("   PASS: no money was spent twice")


def test_retries():
    """The same payment is sent 20 times at once (a phone retrying). It must happen once."""
    print("\n2) Retry test: the same transfer sent 20 times at once with one Idempotency-Key")
    a, b = make_account("Amina"), make_account("Brian")
    deposit(a, 5000)
    same_key = key()
    with ThreadPoolExecutor(max_workers=20) as pool:
        codes = list(pool.map(lambda _: transfer(a, b, 1000, same_key), range(20)))
    print(f"   201 Created: {codes.count(201)}, 200 Replayed: {codes.count(200)}")
    print(f"   Amina: {balance(a)}, Brian: {balance(b)}")
    assert codes.count(201) == 1 and codes.count(200) == 19, codes
    assert balance(a) == 4000 and balance(b) == 1000
    print("   PASS: money moved exactly once")


def test_load(accounts=20, transfers=1000):
    """1,000 random transfers between 20 accounts, 50 at a time."""
    print(f"\n3) Load test: {transfers} random transfers between {accounts} accounts")
    ids = [make_account(f"User {i}") for i in range(accounts)]
    for account_id in ids:
        deposit(account_id, 100_000)
    expected_total = accounts * 100_000

    def random_transfer(_):
        a, b = random.sample(ids, 2)
        return transfer(a, b, random.randint(1, 20_000), key())

    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=50) as pool:
        codes = list(pool.map(random_transfer, range(transfers)))
    seconds = time.perf_counter() - start

    total = sum(balance(i) for i in ids)
    print(f"   done in {seconds:.1f}s ({transfers / seconds:.0f} requests/second)")
    print(f"   succeeded: {codes.count(201)}, refused (insufficient funds): {codes.count(422)}, "
          f"other errors: {len(codes) - codes.count(201) - codes.count(422)}")
    print(f"   total money before: {expected_total}, after: {total}")
    assert total == expected_total, "money was created or lost!"
    assert codes.count(201) + codes.count(422) == transfers, codes
    print("   PASS: total money unchanged")


if __name__ == "__main__":
    print(f"Stress testing {BASE_URL}")
    test_double_spending()
    test_retries()
    test_load()
    report = client.get("/reconciliation").json()
    print(f"\nReconciliation: {report}")
    assert report["balanced"], "books do not balance!"
    print("\nALL CHECKS PASSED: the books balance.")
