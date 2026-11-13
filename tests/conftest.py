import os

# Use a separate test database. CI sets DATABASE_URL to a real PostgreSQL.
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def client():
    # Fresh, empty tables for every test.
    Base.metadata.drop_all(bind=engine)
    with TestClient(app) as test_client:  # runs startup (creates tables)
        yield test_client
    Base.metadata.drop_all(bind=engine)
