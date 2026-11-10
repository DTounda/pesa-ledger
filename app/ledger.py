"""The heart of the app: moving money safely.

Three guarantees:
1. Double-entry: every transaction writes two entries that sum to zero.
2. Idempotency: the same Idempotency-Key never moves money twice.
3. No race conditions: accounts are locked (SELECT ... FOR UPDATE) while
   their balance changes, so two transfers can't spend the same money.
"""
import hashlib
import json
import threading
from contextlib import nullcontext

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import SUPPORTED_CURRENCIES
from app.models import Account, LedgerEntry, Transaction


# SQLite ignores SELECT ... FOR UPDATE, so when running on SQLite (local
# development) money movements are made one at a time with this lock instead.
# PostgreSQL uses real row locks and doesn't need it.
_sqlite_lock = threading.Lock()


class LedgerError(Exception):
    status_code = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class NotFound(LedgerError):
    status_code = 404


class InsufficientFunds(LedgerError):
    status_code = 422


class IdempotencyConflict(LedgerError):
    status_code = 409


def ensure_system_accounts(db: Session) -> None:
    """Create one system account per currency (runs at startup)."""
    for currency in SUPPORTED_CURRENCIES:
        exists = db.scalar(
            select(Account).where(Account.is_system, Account.currency == currency)
        )
        if not exists:
            db.add(Account(owner_name=f"SYSTEM {currency}", phone="0000000000",
                           currency=currency, is_system=True))
    db.commit()


def get_system_account_id(db: Session, currency: str) -> int:
    return db.scalar(
        select(Account.id).where(Account.is_system, Account.currency == currency)
    )


def get_account(db: Session, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None or account.is_system:
        raise NotFound(f"Account {account_id} not found")
    return account


def hash_request(kind: str, payload: dict) -> str:
    """Fingerprint of a request, to detect a key reused for a different payment."""
    raw = json.dumps({"kind": kind, **payload}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def find_by_key(db: Session, key: str, request_hash: str):
    """Return the earlier transaction for this key, or None if the key is new."""
    txn = db.scalar(select(Transaction).where(Transaction.idempotency_key == key))
    if txn is not None and txn.request_hash != request_hash:
        raise IdempotencyConflict(
            "This Idempotency-Key was already used for a different request"
        )
    return txn


def move_money(db: Session, **kwargs):
    """Move money from one account to another, exactly once.

    Returns (transaction, created). `created` is False when this was a retry
    of an earlier request with the same Idempotency-Key.
    """
    is_sqlite = db.get_bind().dialect.name == "sqlite"
    with _sqlite_lock if is_sqlite else nullcontext():
        return _move_money(db, **kwargs)


def _move_money(db: Session, *, kind: str, key: str, payload: dict,
                from_id: int, to_id: int, amount: int, description: str = ""):
    request_hash = hash_request(kind, payload)

    # 1. Retry of a request we already processed? Return the original result.
    existing = find_by_key(db, key, request_hash)
    if existing:
        return existing, False

    if from_id == to_id:
        raise LedgerError("Cannot transfer to the same account")

    # 2. Lock both accounts. Locking in id order means two opposite transfers
    #    (A->B and B->A) can't wait on each other forever (a deadlock).
    accounts = db.scalars(
        select(Account)
        .where(Account.id.in_([from_id, to_id]))
        .order_by(Account.id)
        .with_for_update()
        # Re-read the balance from the database after locking, even if the
        # account was already loaded earlier in this request.
        .execution_options(populate_existing=True)
    ).all()
    by_id = {a.id: a for a in accounts}
    source, destination = by_id.get(from_id), by_id.get(to_id)
    if source is None or destination is None:
        db.rollback()
        missing = from_id if source is None else to_id
        raise NotFound(f"Account {missing} not found")

    # 3. Business rules.
    if source.currency != destination.currency:
        db.rollback()
        raise LedgerError("Both accounts must use the same currency")
    if not source.is_system and source.balance < amount:
        db.rollback()
        raise InsufficientFunds(
            f"Insufficient funds: balance is {source.balance}, tried to move {amount}"
        )

    # 4. Write the transaction and its two ledger entries, then update balances.
    txn = Transaction(kind=kind, idempotency_key=key, request_hash=request_hash,
                      amount=amount, currency=source.currency,
                      from_account_id=source.id, to_account_id=destination.id,
                      description=description)
    try:
        db.add(txn)
        # flush() sends the INSERT now (giving txn an id). If another request
        # with the same key got there first, the database refuses it here.
        db.flush()
        db.add_all([
            LedgerEntry(transaction_id=txn.id, account_id=source.id, amount=-amount),
            LedgerEntry(transaction_id=txn.id, account_id=destination.id, amount=amount),
        ])
        source.balance -= amount
        destination.balance += amount
        db.commit()
    except IntegrityError:
        # Two identical requests arrived at the same moment and the other one
        # won. Undo ours and return theirs: the money still moved only once.
        db.rollback()
        existing = find_by_key(db, key, request_hash)
        if existing is None:
            raise
        return existing, False

    db.refresh(txn)
    return txn, True


def reconcile(db: Session) -> dict:
    """Prove the books balance.

    - All ledger entries must sum to zero (no money created or lost).
    - Every account's cached balance must equal the sum of its entries.
    """
    ledger_total = db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)))
    rows = db.execute(
        select(Account.id, Account.is_system, Account.balance,
               func.coalesce(func.sum(LedgerEntry.amount), 0))
        .outerjoin(LedgerEntry, LedgerEntry.account_id == Account.id)
        .group_by(Account.id, Account.is_system, Account.balance)
    ).all()
    mismatches = [
        {"account_id": acc_id, "cached_balance": balance, "ledger_balance": int(total)}
        for acc_id, _is_system, balance, total in rows
        if balance != total
    ]
    customer_rows = [r for r in rows if not r[1]]
    transactions = db.scalar(select(func.count(Transaction.id)))
    return {
        "balanced": int(ledger_total) == 0 and not mismatches,
        "ledger_total": int(ledger_total),
        "accounts_checked": len(customer_rows),
        "transactions_checked": transactions,
        "mismatches": mismatches,
    }
