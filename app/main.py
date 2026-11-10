"""HTTP API: the routes clients call."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app import ledger
from app.database import Base, engine, get_db
from app.models import Account, Transaction
from app.schemas import (AccountCreate, AccountOut, DepositIn, TransactionOut,
                         TransferIn, WithdrawalIn)


def init_db():
    """Create tables and the system accounts when the server starts."""
    with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            # Several server workers can start at the same moment. This lock
            # makes them set up the database one at a time.
            conn.execute(text("SELECT pg_advisory_xact_lock(724001)"))
        Base.metadata.create_all(bind=conn)
        with Session(bind=conn) as db:
            ledger.ensure_system_accounts(db)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Pesa Ledger API",
    description="A mobile-money wallet API with double-entry bookkeeping, "
                "idempotent payments and provable balances.",
    version="1.0.0",
    lifespan=lifespan,
)

# Every payment request must carry a unique key chosen by the client.
IdempotencyKey = Header(alias="Idempotency-Key", min_length=8, max_length=100)


@app.exception_handler(ledger.LedgerError)
async def ledger_error_handler(_request: Request, exc: ledger.LedgerError):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.message})


def send_transaction(txn: Transaction, created: bool, response: Response):
    """201 for a new payment, 200 (and a header) for a safe retry."""
    response.status_code = 201 if created else 200
    if not created:
        response.headers["Idempotent-Replayed"] = "true"
    return txn


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------- Accounts ----------

@app.post("/accounts", response_model=AccountOut, status_code=201)
def create_account(body: AccountCreate, db: Session = Depends(get_db)):
    account = Account(**body.model_dump())
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


@app.get("/accounts", response_model=list[AccountOut])
def list_accounts(db: Session = Depends(get_db)):
    """All customer wallets (system accounts are hidden)."""
    return db.scalars(
        select(Account).where(Account.is_system.is_(False)).order_by(Account.id)
    ).all()


@app.get("/accounts/{account_id}", response_model=AccountOut)
def read_account(account_id: int, db: Session = Depends(get_db)):
    return ledger.get_account(db, account_id)


@app.get("/accounts/{account_id}/transactions", response_model=list[TransactionOut])
def account_history(account_id: int, limit: int = 50, db: Session = Depends(get_db)):
    ledger.get_account(db, account_id)
    return db.scalars(
        select(Transaction)
        .where(or_(Transaction.from_account_id == account_id,
                   Transaction.to_account_id == account_id))
        .order_by(Transaction.id.desc())
        .limit(min(max(limit, 1), 200))
    ).all()


# ---------- Money movement ----------

@app.post("/deposits", response_model=TransactionOut, status_code=201)
def deposit(body: DepositIn, response: Response,
            key: str = IdempotencyKey, db: Session = Depends(get_db)):
    account = ledger.get_account(db, body.account_id)
    txn, created = ledger.move_money(
        db, kind="deposit", key=key, payload=body.model_dump(),
        from_id=ledger.get_system_account_id(db, account.currency),
        to_id=account.id, amount=body.amount, description=body.description,
    )
    return send_transaction(txn, created, response)


@app.post("/withdrawals", response_model=TransactionOut, status_code=201)
def withdraw(body: WithdrawalIn, response: Response,
             key: str = IdempotencyKey, db: Session = Depends(get_db)):
    account = ledger.get_account(db, body.account_id)
    txn, created = ledger.move_money(
        db, kind="withdrawal", key=key, payload=body.model_dump(),
        from_id=account.id,
        to_id=ledger.get_system_account_id(db, account.currency),
        amount=body.amount, description=body.description,
    )
    return send_transaction(txn, created, response)


@app.post("/transfers", response_model=TransactionOut, status_code=201)
def transfer(body: TransferIn, response: Response,
             key: str = IdempotencyKey, db: Session = Depends(get_db)):
    ledger.get_account(db, body.from_account_id)  # 404 if missing
    ledger.get_account(db, body.to_account_id)
    txn, created = ledger.move_money(
        db, kind="transfer", key=key, payload=body.model_dump(),
        from_id=body.from_account_id, to_id=body.to_account_id,
        amount=body.amount, description=body.description,
    )
    return send_transaction(txn, created, response)


@app.get("/transactions/{transaction_id}", response_model=TransactionOut)
def read_transaction(transaction_id: int, db: Session = Depends(get_db)):
    txn = db.get(Transaction, transaction_id)
    if txn is None:
        raise ledger.NotFound(f"Transaction {transaction_id} not found")
    return txn


# ---------- Audit ----------

@app.get("/reconciliation")
def reconciliation(db: Session = Depends(get_db)):
    """Proves no money was created or lost, and every balance is correct."""
    return ledger.reconcile(db)


# ---------- Web app ----------

# The wallet web app in web/ is served at http://localhost:8000/
# (mounted last, so every API route above takes priority).
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
