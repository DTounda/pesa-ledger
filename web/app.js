// Pesa Wallet: a small front-end for the Pesa Ledger API.
// Plain JavaScript, no frameworks. Every number shown comes from the API.

// ---------- Money helpers ----------
// The API stores whole numbers in the smallest unit (cents for USD).
// RWF and XAF have no smaller unit, so 1 means 1 franc.
const DECIMALS = { RWF: 0, XAF: 0, KES: 2, NGN: 2, USD: 2 };
const QUICK_AMOUNTS = { RWF: [1000, 5000, 10000], XAF: [1000, 5000, 10000],
                        KES: [100, 500, 1000], NGN: [1000, 5000, 10000], USD: [5, 20, 50] };

function formatMoney(minor, currency) {
  const d = DECIMALS[currency] ?? 2;
  return new Intl.NumberFormat("en", {
    style: "currency", currency, minimumFractionDigits: d, maximumFractionDigits: d,
  }).format(minor / 10 ** d);
}

// "2,500.50" -> 250050 for USD. Returns null if invalid.
function toMinor(text, currency) {
  const d = DECIMALS[currency] ?? 2;
  const clean = String(text).replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > d) return null;
  const minor = Number(whole) * 10 ** d + Number(frac.padEnd(d, "0") || 0);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function timeAgo(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}

// ---------- Small DOM helper (textContent only, so names can't inject HTML) ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

const $ = (id) => document.getElementById(id);

const ICONS = {
  in: '<svg viewBox="0 0 24 24"><path d="M17 7L7 17M15 17H7V9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------- API ----------
// Two modes, chosen automatically:
// - Live: the Python server is running (uvicorn), so we call the real API.
// - Demo: the site is hosted on its own (e.g. Netlify), so the same rules run
//   in this browser via demo-api.js, with fake money saved locally.
let demoMode = null;

async function detectMode() {
  if (demoMode !== null) return demoMode;
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const data = await response.json();
    demoMode = data.status !== "ok";
  } catch {
    demoMode = true; // no API answered (e.g. a static host returns a 404 page)
  }
  if (demoMode) {
    $("demo-banner").hidden = false;
    $("footer-live").hidden = true;
    $("footer-demo").hidden = false;
  }
  return demoMode;
}

async function api(path, { method = "GET", body, key } = {}) {
  if (await detectMode()) {
    const result = window.PesaDemoApi.request(method, path, body, key);
    if (!result.ok) throw new Error(result.data.error);
    return { data: result.data, replayed: result.replayed };
  }
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  let response;
  try {
    response = await fetch(path, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the server. Is it running?");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Our API returns {"error": "..."}; FastAPI validation returns {"detail": [...]}.
    const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
    throw new Error(data.error || detail || `Request failed (${response.status})`);
  }
  return { data, replayed: response.headers.get("Idempotent-Replayed") === "true" };
}

// ---------- State ----------
const state = { accounts: [], me: null, history: [], hidden: false, highlightId: null };

// Remember the selected wallet. Wrapped in try/catch because private
// browsing can block storage, and the app must still work without it.
function store(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function others() {
  return state.accounts.filter((a) => a.id !== state.me.id && a.currency === state.me.currency);
}

// ---------- Rendering ----------
async function refresh() {
  const { data } = await api("/accounts");
  state.accounts = data;
  if (!data.length) {
    state.me = null;
    $("welcome").hidden = false;
    $("dashboard").hidden = true;
    $("switcher").hidden = true;
  } else {
    const savedId = Number(load("pesa.me"));
    state.me = data.find((a) => a.id === savedId) || data[0];
    const history = await api(`/accounts/${state.me.id}/transactions`);
    state.history = history.data;
    $("welcome").hidden = true;
    $("dashboard").hidden = false;
    $("switcher").hidden = false;
    renderWallet();
  }
  checkBooks();
}

function renderWallet() {
  const me = state.me;
  $("me-avatar").textContent = initials(me.owner_name);
  $("me-name").textContent = me.owner_name;
  $("balance").textContent = state.hidden ? "••••••" : formatMoney(me.balance, me.currency);
  $("owner-line").textContent = `${me.owner_name} · ${me.phone}`;
  $("currency-chip").textContent = me.currency;
  renderContacts();
  renderHistory();
  renderMenu();
}

function renderContacts() {
  const list = others();
  const box = $("contacts");
  box.replaceChildren();
  if (!list.length) {
    box.append(el("p", { class: "muted small", text: `No other ${state.me.currency} wallets yet. Create one from the menu at the top.` }));
    return;
  }
  for (const account of list) {
    box.append(el("button", { class: "contact", type: "button", onclick: () => openSheet("send", account.id) },
      el("span", { class: "avatar lg", text: initials(account.owner_name) }),
      el("span", { text: account.owner_name.split(" ")[0] })));
  }
}

function describe(tx) {
  const name = (id) => state.accounts.find((a) => a.id === id)?.owner_name ?? `Wallet #${id}`;
  if (tx.kind === "deposit") return { title: "Deposit", direction: "in" };
  if (tx.kind === "withdrawal") return { title: "Withdrawal", direction: "out" };
  return tx.to_account_id === state.me.id
    ? { title: `From ${name(tx.from_account_id)}`, direction: "in" }
    : { title: `To ${name(tx.to_account_id)}`, direction: "out" };
}

function renderHistory() {
  const list = $("tx-list");
  list.replaceChildren();
  let moneyIn = 0;
  let moneyOut = 0;
  for (const tx of state.history) {
    const { title, direction } = describe(tx);
    if (direction === "in") moneyIn += tx.amount; else moneyOut += tx.amount;
    const sign = direction === "in" ? "+" : "−";
    const sub = [timeAgo(tx.created_at), tx.description || `#${tx.id}`].join(" · ");
    const icon = el("span", { class: `tx-icon ${direction}` });
    icon.innerHTML = ICONS[direction];
    list.append(el("li", { class: `tx${tx.id === state.highlightId ? " tx-new" : ""}` },
      icon,
      el("div", {}, el("div", { class: "tx-title", text: title }), el("div", { class: "tx-sub", text: sub })),
      el("div", { class: `tx-amount ${direction}`, text: `${sign}${formatMoney(tx.amount, tx.currency)}` })));
  }
  if (!state.history.length) {
    list.append(el("li", { class: "empty", text: "No activity yet. Make a deposit to get started." }));
  }
  const cur = state.me.currency;
  $("stat-in").textContent = formatMoney(moneyIn, cur);
  $("stat-out").textContent = formatMoney(moneyOut, cur);
  $("stat-count").textContent = String(state.history.length);
  state.highlightId = null;
}

function renderMenu() {
  const menu = $("switcher-menu");
  menu.replaceChildren();
  for (const account of state.accounts) {
    menu.append(el("button", {
      type: "button", role: "menuitem", "aria-current": String(account.id === state.me.id),
      onclick: () => { store("pesa.me", account.id); toggleMenu(false); refresh(); },
    },
      el("span", { class: "avatar", text: initials(account.owner_name) }),
      el("span", {}, account.owner_name,
        el("span", { class: "menu-sub", text: `${formatMoney(account.balance, account.currency)} · #${account.id}` }))));
  }
  menu.append(el("hr"));
  menu.append(el("button", { type: "button", role: "menuitem",
    onclick: () => { toggleMenu(false); openSheet("create"); } },
    el("span", { class: "avatar", text: "+" }), "New wallet"));
}

async function checkBooks() {
  const badge = $("books-badge");
  try {
    const { data } = await api("/reconciliation");
    badge.className = `books-badge ${data.balanced ? "is-ok" : "is-bad"}`;
    $("books-text").textContent = data.balanced
      ? `Books balanced · ${data.transactions_checked} txns`
      : "Books DON'T balance";
    badge.title = `Ledger total: ${data.ledger_total} · ${data.accounts_checked} wallets checked`;
  } catch {
    badge.className = "books-badge is-bad";
    $("books-text").textContent = "Server offline";
  }
}

// ---------- Menu ----------
function toggleMenu(open) {
  const menu = $("switcher-menu");
  const willOpen = open ?? menu.hidden;
  menu.hidden = !willOpen;
  $("switcher-btn").setAttribute("aria-expanded", String(willOpen));
}
$("switcher-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener("click", (e) => { if (!$("switcher").contains(e.target)) toggleMenu(false); });

// ---------- Action sheet ----------
const sheet = $("sheet");
let current = null; // { type, key, busy }

function amountField(currency) {
  const input = el("input", { class: "amount-input", id: "f-amount", inputmode: "decimal",
                              autocomplete: "off", placeholder: "0", "aria-label": "Amount" });
  const quick = el("div", { class: "quick-amounts" });
  for (const value of QUICK_AMOUNTS[currency] || []) {
    quick.append(el("button", { type: "button", text: value.toLocaleString("en"),
                                onclick: () => { input.value = value.toLocaleString("en"); input.focus(); } }));
  }
  return el("div", { class: "field" },
    el("span", { class: "field-label", text: "Amount" }),
    el("div", { class: "amount-wrap" }, el("span", { class: "amount-cur", text: currency }), input),
    quick);
}

function textField(label, id, attrs = {}) {
  return el("label", { class: "field" }, el("span", { class: "field-label", text: label }),
    el("input", { class: "input", id, autocomplete: "off", ...attrs }));
}

function openSheet(type, presetRecipient) {
  const me = state.me;
  // A new key each time the form opens. Pressing "Confirm" again after a
  // network error reuses it, so the payment can never happen twice.
  current = { type, key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, busy: false };
  const fields = $("sheet-fields");
  fields.replaceChildren();
  $("sheet-error").hidden = true;
  $("sheet-form").hidden = false;
  $("sheet-success").hidden = true;
  $("key-note").hidden = type === "create";
  $("key-note").textContent = `Safe to retry: protected by idempotency key ${current.key.slice(0, 8)}…`;

  if (type === "create") {
    $("sheet-title").textContent = "New wallet";
    $("sheet-submit").textContent = "Create wallet";
    const currency = el("select", { class: "input", id: "f-currency" });
    for (const c of Object.keys(DECIMALS)) currency.append(el("option", { value: c, text: c }));
    fields.append(
      textField("Full name", "f-name", { placeholder: "e.g. Amina Uwase", maxlength: "100" }),
      textField("Phone number", "f-phone", { placeholder: "+250788000111", inputmode: "tel" }),
      el("label", { class: "field" }, el("span", { class: "field-label", text: "Currency" }), currency));
  } else {
    const titles = { send: "Send money", deposit: "Deposit", withdraw: "Withdraw" };
    $("sheet-title").textContent = titles[type];
    $("sheet-submit").textContent = { send: "Send now", deposit: "Deposit now", withdraw: "Withdraw now" }[type];
    if (type === "send") {
      const recipients = others();
      if (!recipients.length) {
        toast(`Create another ${me.currency} wallet first, then you can send money to it.`);
        return;
      }
      const select = el("select", { class: "input", id: "f-to" });
      for (const a of recipients) select.append(el("option", { value: a.id, text: `${a.owner_name} · ${a.phone}` }));
      if (presetRecipient) select.value = String(presetRecipient);
      fields.append(el("label", { class: "field" }, el("span", { class: "field-label", text: "To" }), select));
    }
    fields.append(amountField(me.currency));
    if (type !== "deposit") {
      fields.append(el("p", { class: "hint", text: `Available: ${formatMoney(me.balance, me.currency)}` }));
    }
    fields.append(textField("Note (optional)", "f-note", { placeholder: "e.g. Lunch, rent, school fees", maxlength: "200" }));
  }
  sheet.showModal();
  setTimeout(() => (sheet.querySelector("#f-name, #f-amount") || sheet.querySelector("input"))?.focus(), 50);
}

function showError(message) {
  $("sheet-error").textContent = message;
  $("sheet-error").hidden = false;
}

$("sheet-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current || current.busy) return;
  $("sheet-error").hidden = true;
  const me = state.me;
  const value = (id) => $(id)?.value.trim() ?? "";
  let request;

  if (current.type === "create") {
    if (!value("f-name")) return showError("Please enter a name.");
    if (!/^\+?[0-9]{8,15}$/.test(value("f-phone").replace(/\s/g, ""))) {
      return showError("Enter a valid phone number, e.g. +250788000111.");
    }
    request = { path: "/accounts", body: { owner_name: value("f-name"),
      phone: value("f-phone").replace(/\s/g, ""), currency: value("f-currency") } };
  } else {
    const amount = toMinor(value("f-amount"), me.currency);
    if (amount === null) {
      return showError(DECIMALS[me.currency] === 0 && value("f-amount").includes(".")
        ? `${me.currency} has no cents. Enter a whole number, like 2500.`
        : "Enter a valid amount greater than zero.");
    }
    const note = value("f-note");
    if (current.type === "send") {
      request = { path: "/transfers", key: current.key, body: { from_account_id: me.id,
        to_account_id: Number(value("f-to")), amount, description: note } };
    } else {
      request = { path: current.type === "deposit" ? "/deposits" : "/withdrawals", key: current.key,
        body: { account_id: me.id, amount, description: note } };
    }
  }

  current.busy = true;
  const button = $("sheet-submit");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Processing…";
  try {
    const { data, replayed } = await api(request.path, { method: "POST", body: request.body, key: request.key });
    if (current.type === "create") {
      store("pesa.me", data.id);
      sheet.close();
      toast(`Wallet created for ${data.owner_name}`);
    } else {
      state.highlightId = data.id;
      showSuccess(data, replayed);
    }
    await refresh();
  } catch (error) {
    // Show the API's "Insufficient funds" error in friendly money format.
    showError(error.message.startsWith("Insufficient funds")
      ? `Not enough money. Your balance is ${formatMoney(state.me.balance, state.me.currency)}.`
      : error.message);
  } finally {
    current.busy = false;
    button.disabled = false;
    button.textContent = label;
  }
});

function showSuccess(tx, replayed) {
  const name = (id) => state.accounts.find((a) => a.id === id)?.owner_name ?? `Wallet #${id}`;
  const money = formatMoney(tx.amount, tx.currency);
  const titles = {
    transfer: `Sent ${money}`,
    deposit: `Deposited ${money}`,
    withdrawal: `Withdrew ${money}`,
  };
  $("success-title").textContent = titles[tx.kind];
  $("success-sub").textContent = tx.kind === "transfer" ? `to ${name(tx.to_account_id)}` : "Your balance is updated.";
  const rows = [
    ["Reference", `#${tx.id}`],
    ["Ledger entries", tx.entries.map((e) => `${e.amount > 0 ? "+" : "−"}${formatMoney(Math.abs(e.amount), tx.currency)}`).join("  ")],
    ["Status", replayed ? "Already processed (safe retry)" : "Completed"],
  ];
  if (tx.description) rows.splice(1, 0, ["Note", tx.description]);
  $("receipt").replaceChildren(...rows.map(([k, v]) => el("div", {}, el("span", { text: k }), el("span", { text: v }))));
  $("sheet-form").hidden = true;
  $("sheet-success").hidden = false;
}

sheet.addEventListener("click", (e) => {
  if (e.target === sheet || e.target.closest("[data-close]")) sheet.close();
});

document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-open]");
  if (opener) openSheet(opener.dataset.open);
});

// ---------- Misc ----------
let toastTimer;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 3500);
}

$("eye-btn").addEventListener("click", () => {
  state.hidden = !state.hidden;
  $("eye-btn").setAttribute("aria-label", state.hidden ? "Show balance" : "Hide balance");
  renderWallet();
});

$("books-badge").addEventListener("click", checkBooks);

$("demo-reset").addEventListener("click", async () => {
  if (!confirm("Delete all demo wallets in this browser and start fresh?")) return;
  window.PesaDemoApi.reset();
  try { localStorage.removeItem("pesa.me"); } catch {}
  await refresh();
  toast("Demo reset. Click \"Load demo wallets\" to try it again.");
});

// Demo data: three wallets and a few payments, created through the real API.
$("demo-btn").addEventListener("click", async () => {
  const button = $("demo-btn");
  button.disabled = true;
  button.textContent = "Creating…";
  const key = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  try {
    const people = [["Amina Uwase", "+250788000111", 250000], ["Brian Mugisha", "+250788000222", 80000],
                    ["Chloé Ineza", "+250788000333", 45000]];
    const ids = [];
    for (const [name, phone, deposit] of people) {
      const { data } = await api("/accounts", { method: "POST", body: { owner_name: name, phone, currency: "RWF" } });
      ids.push(data.id);
      await api("/deposits", { method: "POST", key: key(), body: { account_id: data.id, amount: deposit, description: "Agent cash-in" } });
    }
    const payments = [[0, 1, 15000, "Lunch at Kimironko"], [1, 2, 5000, "Moto fare"], [0, 2, 30000, "School fees"],
                      [2, 0, 2500, "Airtime"]];
    for (const [from, to, amount, description] of payments) {
      await api("/transfers", { method: "POST", key: key(),
        body: { from_account_id: ids[from], to_account_id: ids[to], amount, description } });
    }
    await api("/withdrawals", { method: "POST", key: key(), body: { account_id: ids[0], amount: 20000, description: "Agent cash-out" } });
    store("pesa.me", ids[0]);
    await refresh();
    toast("Demo wallets ready. Try sending money!");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Load demo wallets";
  }
});

refresh().catch((error) => toast(error.message));
