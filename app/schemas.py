"""Request and response shapes (validated automatically by FastAPI)."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import SUPPORTED_CURRENCIES


class AccountCreate(BaseModel):
    owner_name: str = Field(min_length=1, max_length=100)
    phone: str = Field(pattern=r"^\+?[0-9]{8,15}$")
    currency: str

    @field_validator("currency")
    @classmethod
    def check_currency(cls, value: str) -> str:
        value = value.upper()
        if value not in SUPPORTED_CURRENCIES:
            raise ValueError(f"currency must be one of {SUPPORTED_CURRENCIES}")
        return value


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    owner_name: str
    phone: str
    currency: str
    balance: int
    created_at: datetime


class DepositIn(BaseModel):
    account_id: int
    amount: int = Field(gt=0, description="Whole number in the smallest currency unit")
    description: str = Field(default="", max_length=200)


class WithdrawalIn(DepositIn):
    pass


class TransferIn(BaseModel):
    from_account_id: int
    to_account_id: int
    amount: int = Field(gt=0, description="Whole number in the smallest currency unit")
    description: str = Field(default="", max_length=200)


class EntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    account_id: int
    amount: int


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    amount: int
    currency: str
    from_account_id: int
    to_account_id: int
    description: str
    status: str
    created_at: datetime
    entries: list[EntryOut]
