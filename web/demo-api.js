// demo-api.js
// An in-browser copy of the Pesa Ledger API, used when the wallet is hosted
// as a static site (e.g. on Netlify) without the Python server.
//
// It follows the same rules as app/ledger.py:
//   - double-entry: every transaction writes two entries that sum to zero
//   - idempotency: the same Idempotency-Key never moves money twice
//   - reconciliation: balances are checked against the ledger
// Data is fake and lives only in this visitor's browser (localStorage).
(function () {
  const STORAGE_KEY = "pesa.demo.v1";
  const CURRENCIES = ["RWF", "KES", "XAF", "NGN", "USD"];

  const now = () => new Date().toISOString();

  function freshDb() {
    const db = { accounts: [], transactions: [], entries: [], nextId: { account: 1, tx: 1 } };
    // One system account per currency: money outside the wallet (agents, banks).
    for (const currency of CURRENCIES) {
      db.accounts.push({ id: db.nextId.account++, owner_name: `SYSTEM ${currency}`, phone: "0000000000",
                         currency, balance: 0, is_system: true, created_at: now() });
    }
    return db;
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return freshDb();
  }

  let db = loadDb();
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch {}
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  const publicAccount = ({ is_system, ...rest }) => rest;

  function transactionOut(tx) {
    const { idempotency_key, request_hash, ...rest } = tx;
    const entries = db.entries.filter((e) => e.transaction_id === tx.id)
      .map(({ account_id, amount }) => ({ account_id, amount }));
    return { ...rest, entries };
  }

  function getAccount(id) {
    const account = db.accounts.find((a) => a.id === Number(id));
    if (!account || account.is_system) throw new ApiError(404, `Account ${id} not found`);
    return account;
  }

  function systemAccount(currency) {
    return db.accounts.find((a) => a.is_system && a.currency === currency);
  }

  function requireAmount(body) {
    if (!Number.isSafeInteger(body.amount) || body.amount <= 0) {
      throw new ApiError(422, "Amount must be a whole number greater than 0");
    }
  }

  function requireKey(key) {
    if (!key || key.length < 8 || key.length > 100) {
      throw new ApiError(422, "Idempotency-Key header is required (8-100 characters)");
    }
  }

  // Same steps as move_money() in app/ledger.py.
  function moveMoney({ kind, key, payload, fromId, toId, amount, description = "" }) {
    const requestHash = JSON.stringify({ kind, ...payload });

    // 1. A retry of a request we already processed? Return the original.
    const existing = db.transactions.find((t) => t.idempotency_key === key);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(409, "This Idempotency-Key was already used for a different request");
      }
      return { tx: existing, created: false };
    }

    if (fromId === toId) throw new ApiError(400, "Cannot transfer to the same account");
    const source = db.accounts.find((a) => a.id === fromId);
    const destination = db.accounts.find((a) => a.id === toId);

    // 2. Business rules.
    if (source.currency !== destination.currency) {
      throw new ApiError(400, "Both accounts must use the same currency");
    }
    if (!source.is_system && source.balance < amount) {
      throw new ApiError(422, `Insufficient funds: balance is ${source.balance}, tried to move ${amount}`);
    }

    // 3. One transaction, two entries that sum to zero, updated balances.
    const tx = { id: db.nextId.tx++, kind, idempotency_key: key, request_hash: requestHash, amount,
                 currency: source.currency, from_account_id: source.id, to_account_id: destination.id,
                 description, status: "completed", created_at: now() };
    db.transactions.push(tx);
    db.entries.push({ transaction_id: tx.id, account_id: source.id, amount: -amount, created_at: tx.created_at });
    db.entries.push({ transaction_id: tx.id, account_id: destination.id, amount, created_at: tx.created_at });
    source.balance -= amount;
    destination.balance += amount;
    save();
    return { tx, created: true };
  }

  function reconcile() {
    const ledgerTotal = db.entries.reduce((sum, e) => sum + e.amount, 0);
    const mismatches = [];
    for (const account of db.accounts) {
      const fromLedger = db.entries.filter((e) => e.account_id === account.id)
        .reduce((sum, e) => sum + e.amount, 0);
      if (fromLedger !== account.balance) {
        mismatches.push({ account_id: account.id, cached_balance: account.balance, ledger_balance: fromLedger });
      }
    }
    return {
      balanced: ledgerTotal === 0 && mismatches.length === 0,
      ledger_total: ledgerTotal,
      accounts_checked: db.accounts.filter((a) => !a.is_system).length,
      transactions_checked: db.transactions.length,
      mismatches,
    };
  }

  function route(method, path, body = {}, key) {
    const url = new URL(path, "http://demo");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && url.pathname === "/health") return { status: 200, data: { status: "ok" } };

    if (parts[0] === "accounts") {
      if (method === "GET" && parts.length === 1) {
        return { status: 200, data: db.accounts.filter((a) => !a.is_system).map(publicAccount) };
      }
      if (method === "POST" && parts.length === 1) {
        const name = String(body.owner_name ?? "").trim();
        const currency = String(body.currency ?? "").toUpperCase();
        if (!name || name.length > 100) throw new ApiError(422, "Name must be 1-100 characters");
        if (!/^\+?[0-9]{8,15}$/.test(String(body.phone ?? ""))) throw new ApiError(422, "Invalid phone number");
        if (!CURRENCIES.includes(currency)) throw new ApiError(422, `currency must be one of ${CURRENCIES.join(", ")}`);
        const account = { id: db.nextId.account++, owner_name: name, phone: body.phone, currency,
                          balance: 0, is_system: false, created_at: now() };
        db.accounts.push(account);
        save();
        return { status: 201, data: publicAccount(account) };
      }
      if (method === "GET" && parts.length === 2) return { status: 200, data: publicAccount(getAccount(parts[1])) };
      if (method === "GET" && parts[2] === "transactions") {
        const id = getAccount(parts[1]).id;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
        const list = db.transactions.filter((t) => t.from_account_id === id || t.to_account_id === id)
          .sort((a, b) => b.id - a.id).slice(0, limit).map(transactionOut);
        return { status: 200, data: list };
      }
    }

    if (method === "POST" && ["/deposits", "/withdrawals", "/transfers"].includes(url.pathname)) {
      requireKey(key);
      requireAmount(body);
      const description = String(body.description ?? "").slice(0, 200);
      let move;
      if (url.pathname === "/transfers") {
        const from = getAccount(body.from_account_id);
        const to = getAccount(body.to_account_id);
        move = { kind: "transfer", fromId: from.id, toId: to.id };
      } else {
        const account = getAccount(body.account_id);
        const system = systemAccount(account.currency);
        move = url.pathname === "/deposits"
          ? { kind: "deposit", fromId: system.id, toId: account.id }
          : { kind: "withdrawal", fromId: account.id, toId: system.id };
      }
      const { tx, created } = moveMoney({ ...move, key, payload: body, amount: body.amount, description });
      return { status: created ? 201 : 200, data: transactionOut(tx), replayed: !created };
    }

    if (method === "GET" && parts[0] === "transactions" && parts.length === 2) {
      const tx = db.transactions.find((t) => t.id === Number(parts[1]));
      if (!tx) throw new ApiError(404, `Transaction ${parts[1]} not found`);
      return { status: 200, data: transactionOut(tx) };
    }

    if (method === "GET" && url.pathname === "/reconciliation") return { status: 200, data: reconcile() };

    throw new ApiError(404, "Not found");
  }

  window.PesaDemoApi = {
    // Same result shape as a real HTTP call: { ok, status, data, replayed }.
    request(method, path, body, key) {
      try {
        const result = route(method, path, body, key);
        // Copy the data so the page can never change the stored ledger by accident.
        return { ok: true, replayed: false, ...result, data: JSON.parse(JSON.stringify(result.data)) };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { ok: false, status: error.status, data: { error: error.message }, replayed: false };
      }
    },
    reset() {
      db = freshDb();
      save();
    },
  };
})();
