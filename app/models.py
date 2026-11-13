"""Database tables.

Double-entry bookkeeping: every transaction creates two ledger entries that
add up to zero (money leaves one account and enters another). Money is never
created or destroyed, which is what makes the books provable.
"""
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow():
    return datetime.now(timezone.utc)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_name: Mapped[str] = mapped_column(String(100))
    phone: Mapped[str] = mapped_column(String(20))
    currency: Mapped[str] = mapped_column(String(3))
    # Cached balance for fast reads. The ledger is the source of truth, and
    # /reconciliation proves the two always agree.
    balance: Mapped[int] = mapped_column(BigInteger, default=0)
    # System accounts represent money outside the wallet (agents, banks).
    # Deposits come from them, withdrawals go to them.
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))  # deposit | withdrawal | transfer
    # Unique key sent by the client. The same key always means the same
    # payment, so a retried request can never move money twice.
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    amount: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    from_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    to_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    description: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(20), default="completed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    entries: Mapped[list["LedgerEntry"]] = relationship(
        back_populates="transaction", order_by="LedgerEntry.id"
    )


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    # Negative = money leaving the account, positive = money arriving.
    amount: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    transaction: Mapped[Transaction] = relationship(back_populates="entries")
