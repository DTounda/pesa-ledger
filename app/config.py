"""App settings, read from environment variables."""
import os

# Local default is SQLite so the app runs with zero setup.
# With Docker (or in production) this points at PostgreSQL.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./pesa.db")

# Currencies the wallet supports. Amounts are always whole numbers in the
# smallest unit of the currency (e.g. cents for USD), never floats.
SUPPORTED_CURRENCIES = ["RWF", "KES", "XAF", "NGN", "USD"]
