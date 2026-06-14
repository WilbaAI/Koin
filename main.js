import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { specs, validateRecord } from "./validation.js";

/* ---------------- Persistence ---------------- */
// Falls back to localStorage when running in a plain browser (npm run dev without Tauri).
const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function readData() {
  if (inTauri) {
    const raw = await invoke("load_data");
    return raw && raw !== "null" ? JSON.parse(raw) : null;
  }
  const raw = localStorage.getItem("koin-data");
  return raw ? JSON.parse(raw) : null;
}
async function writeData(state) {
  const json = JSON.stringify(state, null, 2);
  if (inTauri) await invoke("save_data", { contents: json });
  else localStorage.setItem("koin-data", json);
}
async function fileLocation() {
  if (inTauri) return await invoke("data_file_location");
  return "browser localStorage (run inside Tauri for a file)";
}

/* ---------------- State ---------------- */
const blank = () => ({
  accounts: [],       // {id,name,type:"bank"|"cash",institution,opening,archived}
  unitTrusts: [],     // {id,name,currentNav,investments:[{id,amount,nav,units,date,note}]}
  incomes: [],        // {id,source,project,total,date,due,note}  — received derived from ledger
  loans: [],          // {id,person,principal,direction:"lent"|"borrowed",date,due,note} — repaid derived
  transactions: [],   // {id,date,type,amount,from,to,category,note,link:{kind,id}}
  categories: [],     // expense categories (seeded at boot)
});

let state = blank();
let view = "dashboard";
let theme = "light";
const uid = () => Math.random().toString(36).slice(2, 10);

function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
}
function toggleTheme() {
  setTheme(theme === "dark" ? "light" : "dark");
}
function setTheme(t) {
  theme = t === "dark" ? "dark" : "light";
  state.theme = theme;
  applyTheme();
  persist();
}

/* ---------------- App lock (macOS Touch ID / password) ---------------- */
let locked = false;
// Returns true when the user authenticates (or when not in Tauri — no native auth in the browser).
async function authenticate(reason) {
  if (!inTauri) return true;
  try {
    return await invoke("authenticate", { reason: reason || "Unlock Koin" });
  } catch {
    return false;
  }
}
async function unlock() {
  if (await authenticate("Unlock Koin")) {
    locked = false;
    render();
  }
}

/* ---------------- Money helpers ---------------- */
import * as C from "./compute.js";

const fmt = (n) =>
  "Rs " +
  Number(n || 0).toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const num = C.num;
const signed = (n) => (n >= 0 ? "+" : "−") + fmt(Math.abs(n)).replace("Rs ", "Rs ");

// Thin wrappers binding the pure compute fns to the live state.
const trustUnits = C.trustUnits;
const trustInvested = C.trustInvested;
const trustValue = C.trustValue;
const accountBalance = (a) => C.accountBalance(a, state.transactions);
const bankTotal = () => C.bankTotal(state.accounts, state.transactions);
const cashTotal = () => C.cashTotal(state.accounts, state.transactions);
const assetTotal = () => C.assetTotal(state.accounts, state.transactions);
const trustTotal = () => C.trustTotal(state.unitTrusts);
const trustInvestedTotal = () => C.trustInvestedTotal(state.unitTrusts);
const incomeReceived = () => C.incomeReceived(state.incomes, state.transactions);
const incomePending = () => C.incomePending(state.incomes, state.transactions);
const loansReceivable = () => C.loansReceivable(state.loans, state.transactions);
const loansPayable = () => C.loansPayable(state.loans, state.transactions);
const loanOutstandingOne = (l) => C.loanOutstandingOne(l, state.transactions);
const incomeReceivedOne = (i) => C.incomeReceivedOne(i, state.transactions);
const expenseTotal = (period) => C.expenseTotal(state.transactions, period);
const netWorth = () => C.netWorth(state);

/* ---------------- Render ---------------- */
const app = document.getElementById("app");

function render() {
  if (locked) {
    app.innerHTML = lockScreen();
    const btn = app.querySelector("[data-unlock]");
    if (btn) btn.onclick = unlock;
    return;
  }
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <h1>Koin<span class="dot">.</span></h1>
      </div>
      <small style="padding:0 8px;color:var(--ink-soft)">Personal ledger · LKR</small>
      <nav class="nav">
        ${navBtn("dashboard", "◴", "Overview")}
        ${navBtn("accounts", "▣", "Accounts")}
        ${navBtn("transactions", "⇄", "Transactions")}
        ${navBtn("expenses", "↓", "Expenses")}
        ${navBtn("loans", "↹", "Loans & debts")}
        ${navBtn("incomes", "✎", "Project income")}
        ${navBtn("trusts", "◈", "Unit trusts")}
        ${navBtn("settings", "⚙", "Settings")}
      </nav>
      <button class="theme-toggle" data-theme-toggle>
        <span class="ic">${theme === "dark" ? "☀" : "☾"}</span>
        ${theme === "dark" ? "Light mode" : "Dark mode"}
      </button>
      <div class="sidebar-foot">
        Auto-saved on every change.
      </div>
    </aside>
    <main class="main">${views[view]()}</main>
  `;
  fileLocation().then((l) => {
    const el = document.getElementById("loc");
    if (el) el.textContent = l;
  });
  wire();
}

const navBtn = (id, ic, label) =>
  `<button data-nav="${id}" class="${view === id ? "active" : ""}">
     <span class="ic">${ic}</span>${label}
   </button>`;

/* ---------------- Views ---------------- */
const views = {
  dashboard() {
    const nw = netWorth();
    const owed = loansReceivable();
    const owe = loansPayable();
    const ym = C.monthOf(today());
    const monthExp = expenseTotal({ from: ym + "-01", to: ym + "-31" });
    const recent = state.transactions.slice().sort(byDateDesc).slice(0, 6);
    const g = trustTotal() - trustInvestedTotal();
    const gp = trustInvestedTotal() > 0 ? (g / trustInvestedTotal()) * 100 : 0;
    return `
      <div class="view-head">
        <div><h2>Overview</h2><p>Where your money stands today.</p></div>
      </div>
      <div class="metrics">
        <div class="metric feature">
          <div class="label">Net worth</div>
          <div class="val">${fmt(nw)}</div>
          <div class="sub">Cash + bank + investments + owed to you − what you owe</div>
        </div>
        <div class="metric">
          <div class="label">Owed to you</div>
          <div class="val ${owed > 0 ? "pos" : ""}">${fmt(owed)}</div>
          <div class="sub">${openLoans("lent").length} open loan(s)</div>
        </div>
        <div class="metric">
          <div class="label">You owe</div>
          <div class="val ${owe > 0 ? "neg" : ""}">${fmt(owe)}</div>
          <div class="sub">${openLoans("borrowed").length} open debt(s)</div>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="label">Cash on hand</div><div class="val ${cashTotal() < 0 ? "neg" : ""}">${fmt(cashTotal())}</div><div class="sub">Physical cash</div></div>
        <div class="metric"><div class="label">Bank balances</div><div class="val ${bankTotal() < 0 ? "neg" : "pos"}">${fmt(bankTotal())}</div><div class="sub">${state.accounts.filter(a => a.type === "bank" && !a.archived).length} account(s)</div></div>
        <div class="metric"><div class="label">Spent this month</div><div class="val ${monthExp > 0 ? "neg" : ""}">${fmt(monthExp)}</div><div class="sub">${monthName(ym)}</div></div>
        <div class="metric"><div class="label">Unit trusts</div><div class="val pos">${fmt(trustTotal())}</div><div class="sub">${g >= 0 ? "+" : ""}${fmt(g).replace("Rs ", "Rs ")} (${gp >= 0 ? "+" : ""}${gp.toFixed(1)}%)</div></div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Recent activity</h3>${state.transactions.length ? `<button class="btn ghost sm" data-nav="transactions">View all</button>` : ""}</div>
        ${txnLedger(recent, true)}
      </div>

      <div class="section">
        <div class="section-head"><h3>Open loans &amp; debts</h3></div>
        ${loanLedger(state.loans.filter((l) => loanOutstandingOne(l) > 0.005).slice(0, 5), true)}
      </div>
    `;
  },

  loans() {
    return `
      <div class="view-head">
        <div><h2>Loans &amp; debts</h2><p>Money you lent to friends, and money you borrowed.</p></div>
        <div class="head-actions">
          <button class="btn" data-add="lend">+ Lend</button>
          <button class="btn ghost" data-add="borrow">+ Borrow</button>
        </div>
      </div>
      ${loanLedger(state.loans, false)}
    `;
  },

  incomes() {
    const cols = "grid-template-columns: 1.8fr 1.4fr 1fr 1fr 220px";
    return `
      <div class="view-head">
        <div><h2>Project income</h2><p>Earnings from assignments — track advances and installments.</p></div>
        <button class="btn" data-add="income">+ Add income</button>
      </div>
      ${
        state.incomes.length === 0
          ? emptyState("No income recorded yet", "Add a project to track what you've billed and received.")
          : `<div class="ledger">
              <div class="row head" style="${cols}">
                <div>Project</div><div>Progress</div><div style="text-align:right">Total</div><div style="text-align:right">Outstanding</div><div></div>
              </div>
              ${state.incomes
                .slice()
                .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
                .map((i) => {
                  const t = num(i.total), r = incomeReceivedOne(i);
                  const out = Math.max(0, t - r);
                  const pct = t > 0 ? Math.min(100, (r / t) * 100) : 0;
                  const status = out < 0.005 ? "paid" : r > 0 ? "partial" : "open";
                  const label = status === "paid" ? "paid in full" : status === "partial" ? "part paid" : "unpaid";
                  return `
                <div class="row" style="${cols}">
                  <div>
                    <div class="name">${esc(i.project) || "Untitled"}</div>
                    <div class="meta">${esc(i.source) || "—"}${i.date ? " · " + i.date : ""}</div>
                  </div>
                  <div>
                    <span class="tag ${status}">${label}</span>
                    <div class="bar"><span style="width:${pct}%"></span></div>
                  </div>
                  <div class="amt">${fmt(t)}</div>
                  <div class="amt ${out > 0.005 ? "neg" : "pos"}">${fmt(out)}</div>
                  <div class="actions">
                    ${out > 0.005 ? `<button data-pay-income="${i.id}">Payment</button>` : ""}
                    <button data-edit-income="${i.id}">Edit</button>
                    <button class="del" data-del-income="${i.id}">Delete</button>
                  </div>
                </div>`;
                })
                .join("")}
            </div>`
      }
    `;
  },

  accounts() {
    const active = state.accounts.filter((a) => !a.archived);
    const archived = state.accounts.filter((a) => a.archived);
    const cols = "grid-template-columns: 1.8fr 1.3fr 0.7fr 1fr 250px";
    const row = (a) => {
      const bal = accountBalance(a);
      const used = state.transactions.some((t) => t.from === a.id || t.to === a.id);
      return `
        <div class="row" style="${cols}">
          <div class="name">${esc(a.name) || "Account"}</div>
          <div class="meta">${esc(a.institution) || (a.type === "cash" ? "Cash" : "—")}</div>
          <div><span class="tag ${a.type === "cash" ? "partial" : "paid"}">${a.type}</span></div>
          <div class="amt ${bal < 0 ? "neg" : "pos"}">${fmt(bal)}</div>
          <div class="actions">
            <button data-set-balance="${a.id}">Set balance</button>
            <button data-edit-account="${a.id}">Edit</button>
            <button class="del" data-del-account="${a.id}">${used ? "Archive" : "Delete"}</button>
          </div>
        </div>`;
    };
    return `
      <div class="view-head">
        <div><h2>Accounts</h2><p>Bank balances and cash on hand. Balances update from your transactions.</p></div>
        <div class="head-actions">
          <button class="btn" data-add="account">+ Add account</button>
          <button class="btn ghost" data-add="transfer">Transfer</button>
        </div>
      </div>
      <div class="metrics" style="margin-bottom:20px">
        <div class="metric"><div class="label">Bank</div><div class="val ${bankTotal() < 0 ? "neg" : "pos"}">${fmt(bankTotal())}</div></div>
        <div class="metric"><div class="label">Cash</div><div class="val ${cashTotal() < 0 ? "neg" : "pos"}">${fmt(cashTotal())}</div></div>
        <div class="metric feature"><div class="label">Total assets</div><div class="val">${fmt(assetTotal())}</div><div class="sub">Bank + cash</div></div>
      </div>
      ${
        active.length === 0
          ? emptyState("No accounts yet", "Add a bank account or cash wallet to start tracking.")
          : `<div class="ledger">
              <div class="row head" style="${cols}">
                <div>Account</div><div>Bank</div><div>Type</div><div style="text-align:right">Balance</div><div></div>
              </div>
              ${active.map(row).join("")}
            </div>`
      }
      ${
        archived.length
          ? `<div class="section"><div class="section-head"><h3>Archived</h3></div>
              <div class="ledger">${archived
                .map(
                  (a) => `<div class="row" style="grid-template-columns: 2fr 1fr 1fr 160px;opacity:.6">
                    <div class="name">${esc(a.name)}</div><div class="meta">${a.type}</div>
                    <div class="amt">${fmt(accountBalance(a))}</div>
                    <div class="actions"><button data-unarchive="${a.id}">Restore</button></div>
                  </div>`
                )
                .join("")}</div></div>`
          : ""
      }
    `;
  },

  transactions() {
    const filter = state.txnFilter || "all";
    const groups = {
      all: () => true,
      expenses: (t) => t.type === "expense",
      transfers: (t) => t.type === "transfer",
      loans: (t) => ["lend", "loan_repaid", "borrow", "debt_repaid"].includes(t.type),
      income: (t) => t.type === "income",
    };
    const list = state.transactions.filter(groups[filter] || groups.all).slice().sort(byDateDesc);
    const chip = (key, label) =>
      `<button class="fchip ${filter === key ? "active" : ""}" data-txn-filter="${key}">${label}</button>`;
    return `
      <div class="view-head">
        <div><h2>Transactions</h2><p>Every move of money, newest first.</p></div>
        <div class="head-actions">
          <button class="btn" data-add="expense">+ Expense</button>
          <button class="btn ghost" data-add="transfer">Transfer</button>
          <button class="btn ghost" data-add="txnIncome">Record income</button>
        </div>
      </div>
      <div class="filters">
        ${chip("all", "All")}${chip("expenses", "Expenses")}${chip("transfers", "Transfers")}${chip("loans", "Loans &amp; debts")}${chip("income", "Income")}
      </div>
      ${txnLedger(list, false)}
    `;
  },

  expenses() {
    const ym = C.monthOf(today());
    const monthRange = { from: ym + "-01", to: ym + "-31" };
    const monthTotal = expenseTotal(monthRange);
    const byCat = C.expenseByCategory(state.transactions, monthRange);
    const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    const maxCat = cats.length ? byCat[cats[0]] : 0;
    const list = state.transactions.filter((t) => t.type === "expense").slice().sort(byDateDesc);
    return `
      <div class="view-head">
        <div><h2>Expenses</h2><p>What you're spending, and where it goes.</p></div>
        <button class="btn" data-add="expense">+ Add expense</button>
      </div>
      <div class="metrics" style="margin-bottom:20px">
        <div class="metric feature"><div class="label">Spent in ${monthName(ym)}</div><div class="val">${fmt(monthTotal)}</div><div class="sub">${list.filter((t) => C.monthOf(t.date) === ym).length} expense(s) this month</div></div>
        <div class="metric"><div class="label">All-time</div><div class="val">${fmt(expenseTotal())}</div><div class="sub">${list.length} expense(s) total</div></div>
      </div>
      ${
        cats.length
          ? `<div class="section"><div class="section-head"><h3>This month by category</h3></div>
             <div class="catbars">${cats
               .map(
                 (c) => `<div class="catbar"><div class="catbar-top"><span>${esc(c)}</span><span class="amt">${fmt(byCat[c])}</span></div><div class="bar"><span style="width:${maxCat > 0 ? (byCat[c] / maxCat) * 100 : 0}%"></span></div></div>`
               )
               .join("")}</div></div>`
          : ""
      }
      <div class="section"><div class="section-head"><h3>All expenses</h3></div>
        ${txnLedger(list, false)}
      </div>
    `;
  },

  trusts() {
    const totalInv = trustInvestedTotal();
    const totalVal = trustTotal();
    const totalGain = totalVal - totalInv;
    const gpct = totalInv > 0 ? (totalGain / totalInv) * 100 : 0;
    return `
      <div class="view-head">
        <div><h2>Unit trusts</h2><p>Track what you invested against what it's worth now.</p></div>
        <button class="btn" data-add="trust">+ Add fund</button>
      </div>
      ${
        state.unitTrusts.length === 0
          ? emptyState("No funds yet", "Add a unit trust fund, then log your investments into it.")
          : `<div class="metrics" style="margin-bottom:24px">
              <div class="metric"><div class="label">Total invested</div><div class="val">${fmt(totalInv)}</div><div class="sub">Across ${state.unitTrusts.length} fund(s)</div></div>
              <div class="metric"><div class="label">Current value</div><div class="val pos">${fmt(totalVal)}</div><div class="sub">At latest NAV</div></div>
              <div class="metric feature"><div class="label">Total gain / loss</div><div class="val">${signed(totalGain)}</div><div class="sub">${gpct >= 0 ? "+" : ""}${gpct.toFixed(2)}% return overall</div></div>
            </div>
            ${state.unitTrusts.map(trustCard).join("")}`
      }
    `;
  },

  settings() {
    const cats = state.categories || [];
    return `
      <div class="view-head"><div><h2>Settings</h2><p>Preferences, security, and your data.</p></div></div>

      <div class="section">
        <div class="section-head"><h3>Appearance</h3></div>
        <div class="set-row">
          <div><div class="set-label">Theme</div><div class="set-sub">Warm ledger paper, light or dark.</div></div>
          <div class="seg">
            <button class="seg-btn ${theme === "light" ? "active" : ""}" data-set-theme="light">☾ Light</button>
            <button class="seg-btn ${theme === "dark" ? "active" : ""}" data-set-theme="dark">☀ Dark</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Security</h3></div>
        <div class="set-row">
          <div><div class="set-label">Lock with Touch ID / password</div><div class="set-sub">Require macOS authentication each time Koin opens.${inTauri ? "" : " Takes effect in the desktop app."}</div></div>
          <button class="seg-btn ${state.appLock ? "active" : ""}" data-toggle-lock>${state.appLock ? "On" : "Off"}</button>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Expense categories</h3><button class="btn ghost sm" data-add="category">+ Add</button></div>
        <div class="ledger" style="padding:16px">
          ${
            cats.length
              ? `<div class="cat-chips">${cats
                  .map((c) => `<span class="cat-chip">${esc(c)}<button data-del-cat="${esc(c)}" title="Remove">×</button></span>`)
                  .join("")}</div>`
              : `<div class="set-sub">No categories yet — add one, or they'll appear as you log expenses.</div>`
          }
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Data</h3></div>
        <div class="set-row">
          <div><div class="set-label">Database file</div><div class="set-sub">Local SQLite. Back it up by copying this file.</div></div>
          <code id="loc" class="loc-code"></code>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>About</h3></div>
        <div class="set-sub">Koin · v1.0.0 · local-first personal money tracker · LKR</div>
      </div>
    `;
  },
};

function trustCard(t) {
  const inv = trustInvested(t);
  const val = trustValue(t);
  const gain = val - inv;
  const gpct = inv > 0 ? (gain / inv) * 100 : 0;
  const units = trustUnits(t);
  const hist = (t.investments || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return `
    <div class="fund">
      <div class="fund-head">
        <div>
          <div class="fund-name">${esc(t.name) || "Fund"}</div>
          <div class="fund-sub">${units.toLocaleString("en-LK", { maximumFractionDigits: 4 })} units · NAV ${fmt(t.currentNav)}</div>
        </div>
        <div class="fund-actions">
          <button class="btn sm" data-invest="${t.id}">+ Invest</button>
          ${val > 0.005 ? `<button class="btn ghost sm" data-redeem="${t.id}">Redeem</button>` : ""}
          <button class="btn ghost sm" data-nav-trust="${t.id}">Update NAV</button>
          <button class="btn ghost sm" data-edit-trust="${t.id}">Edit</button>
          <button class="btn ghost sm danger-text" data-del-trust="${t.id}">Delete</button>
        </div>
      </div>
      <div class="fund-stats">
        <div><span class="k">Invested</span><span class="v">${fmt(inv)}</span></div>
        <div><span class="k">Value now</span><span class="v">${fmt(val)}</span></div>
        <div><span class="k">Gain / loss</span><span class="v ${gain >= 0 ? "up" : "down"}">${signed(gain)} (${gpct >= 0 ? "+" : ""}${gpct.toFixed(2)}%)</span></div>
      </div>
      ${
        hist.length === 0
          ? `<div class="fund-empty">No investments logged yet. Use “+ Invest” to record what you put in.</div>`
          : `<div class="fund-hist">
              <div class="hist-row hist-head"><div>Date</div><div style="text-align:right">Amount</div><div style="text-align:right">NAV</div><div style="text-align:right">Units</div><div></div></div>
              ${hist.map((x) => `
                <div class="hist-row">
                  <div>${x.date || "—"}${x.note ? ` · <span class="muted">${esc(x.note)}</span>` : ""}</div>
                  <div class="amt">${fmt(x.amount)}</div>
                  <div class="amt">${fmt(x.nav)}</div>
                  <div class="amt">${num(x.units).toLocaleString("en-LK", { maximumFractionDigits: 4 })}</div>
                  <div class="actions"><button class="del" data-del-invest="${t.id}:${x.id}">Remove</button></div>
                </div>`).join("")}
            </div>`
      }
    </div>`;
}

function loanLedger(loans, compact) {
  if (loans.length === 0)
    return emptyState(
      compact ? "No open loans or debts" : "Nothing recorded yet",
      compact ? "Everyone's square with you." : "Lent or borrowed something? Record it so you don't forget."
    );
  const cols = "grid-template-columns: 1.7fr 1.4fr 1fr 1fr 210px";
  return `<div class="ledger">
    <div class="row head" style="${cols}">
      <div>Person</div><div>Progress</div><div style="text-align:right">Amount</div><div style="text-align:right">Outstanding</div><div></div>
    </div>
    ${loans
      .map((l) => {
        const p = num(l.principal);
        const out = loanOutstandingOne(l);
        const paid = Math.max(0, p - out);
        const pct = p > 0 ? Math.min(100, (paid / p) * 100) : 0;
        const borrowed = l.direction === "borrowed";
        const status = out < 0.005 ? "paid" : paid > 0 ? "partial" : "open";
        const label = out < 0.005 ? "settled" : paid > 0 ? "partial" : borrowed ? "you owe" : "open";
        return `
        <div class="row" style="${cols}">
          <div>
            <div class="name">${esc(l.person) || (borrowed ? "Lender" : "Friend")}${borrowed ? ` <span class="tag open" style="margin-left:4px">debt</span>` : ""}</div>
            <div class="meta">${borrowed ? "you borrowed" : "you lent"}${l.date ? " · " + l.date : ""}${l.note ? " · " + esc(l.note) : ""}</div>
          </div>
          <div>
            <span class="tag ${status}">${label}</span>
            <div class="bar"><span style="width:${pct}%"></span></div>
          </div>
          <div class="amt">${fmt(p)}</div>
          <div class="amt ${out > 0.005 ? "neg" : "pos"}">${fmt(out)}</div>
          <div class="actions">
            ${out > 0.005 ? `<button data-repay="${l.id}">${borrowed ? "Pay" : "Repay"}</button>` : ""}
            <button data-edit-loan="${l.id}">Edit</button>
            <button class="del" data-del-loan="${l.id}">Delete</button>
          </div>
        </div>`;
      })
      .join("")}
  </div>`;
}

const emptyState = (big, sub) =>
  `<div class="ledger"><div class="empty"><div class="big">${big}</div>${sub}</div></div>`;

const lockScreen = () => `
  <div class="lock">
    <div class="lock-card">
      <h1>Koin<span class="dot">.</span></h1>
      <p>Locked. Authenticate to continue.</p>
      <button class="btn" data-unlock>Unlock</button>
    </div>
  </div>`;

/* ---- Ledger helpers (presentation) ---- */
const byDateDesc = (a, b) => (b.date || "").localeCompare(a.date || "");
const isAccountRef = C.isAccount;
const monthName = (ym) => {
  const [y, m] = (ym || "").split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return m ? `${names[+m - 1]} ${y}` : "";
};
// Open loans/debts, optionally filtered to "lent" or "borrowed".
const openLoans = (which) =>
  state.loans.filter((l) => {
    const borrowed = l.direction === "borrowed";
    const match = which === "borrowed" ? borrowed : which === "lent" ? !borrowed : true;
    return match && loanOutstandingOne(l) > 0.005;
  });
// Account pickers: id-valued options, archived hidden.
const accountOptions = () =>
  state.accounts
    .filter((a) => !a.archived)
    .map((a) => ({ value: a.id, label: `${a.name}${a.type === "cash" ? " · cash" : a.institution ? " · " + a.institution : ""}` }));

const EXT_LABEL = {
  "ext:income": "Income",
  "ext:expense": "Expense",
  "ext:opening": "Opening / adjust",
  "ext:loan": "Loans to friends",
  "ext:debt": "Debts you owe",
  "ext:trust": "Unit trusts",
};
const refLabel = (ref) => {
  if (isAccountRef(ref)) {
    const a = state.accounts.find((x) => x.id === ref);
    return a ? a.name : "(removed)";
  }
  return EXT_LABEL[ref] || ref;
};
const TXN_META = {
  expense: { label: "Expense", chip: "open" },
  income: { label: "Income", chip: "paid" },
  lend: { label: "Loan out", chip: "partial" },
  loan_repaid: { label: "Repayment", chip: "paid" },
  borrow: { label: "Borrowed", chip: "partial" },
  debt_repaid: { label: "Debt paid", chip: "open" },
  transfer: { label: "Transfer", chip: "" },
  invest: { label: "Invest", chip: "partial" },
  redeem: { label: "Redeem", chip: "paid" },
  adjust: { label: "Adjustment", chip: "" },
};
// Net change a transaction makes to your asset accounts (transfers/migrated legs net 0).
const assetEffect = (t) => {
  if (t.type === "transfer") return 0;
  if (isAccountRef(t.to) && !isAccountRef(t.from)) return num(t.amount);
  if (isAccountRef(t.from) && !isAccountRef(t.to)) return -num(t.amount);
  return 0;
};
function txnDetail(t) {
  if (t.type === "expense") return `${esc(t.category || "Uncategorised")}${t.note ? " · " + esc(t.note) : ""}`;
  return `${esc(refLabel(t.from))} → ${esc(refLabel(t.to))}${t.note ? " · " + esc(t.note) : ""}`;
}
function txnLedger(txns, compact) {
  if (!txns.length)
    return emptyState(
      "No transactions yet",
      compact ? "Money moves will show up here." : "Record an expense, transfer or payment to get started."
    );
  const cols = compact
    ? "grid-template-columns: 96px 110px 1fr 130px"
    : "grid-template-columns: 100px 120px 1fr 130px 140px";
  return `<div class="ledger">
    <div class="row head" style="${cols}">
      <div>Date</div><div>Type</div><div>Detail</div><div style="text-align:right">Amount</div>${compact ? "" : "<div></div>"}
    </div>
    ${txns
      .map((t) => {
        const m = TXN_META[t.type] || { label: t.type, chip: "" };
        const eff = assetEffect(t);
        const cls = eff > 0 ? "pos" : eff < 0 ? "neg" : "";
        const sign = eff > 0 ? "+" : eff < 0 ? "−" : "";
        return `
        <div class="row" style="${cols}">
          <div class="meta">${t.date || "—"}</div>
          <div><span class="tag ${m.chip}">${m.label}</span></div>
          <div>${txnDetail(t)}</div>
          <div class="amt ${cls}">${sign}${fmt(t.amount).replace("Rs ", "Rs ")}</div>
          ${compact ? "" : `<div class="actions"><button data-edit-txn="${t.id}">Edit</button><button class="del" data-del-txn="${t.id}">Delete</button></div>`}
        </div>`;
      })
      .join("")}
  </div>`;
}

/* ---------------- Modals ---------------- */
function confirmThen(title, message, onConfirm, { danger = false, okLabel = "Confirm" } = {}) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `
    <div class="modal confirm">
      <h3>${title}</h3>
      <p class="confirm-msg">${message}</p>
      <div class="modal-foot">
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn ${danger ? "danger" : ""}" data-ok>${okLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) { close(); return; }
    if (e.target.closest("[data-ok]")) { close(); onConfirm(); return; }
    if (e.target.closest("[data-cancel]")) { close(); return; }
  });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); close(); onConfirm(); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  scrim.querySelector("[data-ok]").focus();
}

function modal(title, fields, onSave, values = {}, spec = null) {
  values = values || {};
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      ${fields.map(fieldHTML).join("")}
      <div class="modal-foot">
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn" data-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);

  // prefill
  fields.forEach((f) => {
    const el = scrim.querySelector(`[name="${f.key}"]`);
    if (!el) return;
    if (f.type === "checkbox") el.checked = !!values[f.key];
    else if (values[f.key] !== undefined) el.value = values[f.key];
  });

  const collect = () => {
    const out = {};
    fields.forEach((f) => {
      const el = scrim.querySelector(`[name="${f.key}"]`);
      if (!el) return;
      out[f.key] = f.type === "checkbox" ? el.checked : el.value;
    });
    return out;
  };

  const clearErrors = () => {
    scrim.querySelectorAll(".field-error").forEach((e) => e.remove());
    scrim.querySelectorAll(".field input, .field select").forEach((e) => e.classList.remove("invalid"));
  };

  const showErrors = (errors) => {
    clearErrors();
    Object.keys(errors).forEach((key) => {
      const el = scrim.querySelector(`[name="${key}"]`);
      if (!el) return;
      el.classList.add("invalid");
      const msg = document.createElement("div");
      msg.className = "field-error";
      msg.textContent = errors[key];
      el.closest(".field").appendChild(msg);
    });
    const first = scrim.querySelector(".invalid");
    if (first) first.focus();
  };

  const close = () => scrim.remove();
  const doSave = () => {
    const out = collect();
    if (spec) {
      const errors = validateRecord(out, spec);
      if (Object.keys(errors).length > 0) { showErrors(errors); return; }
    }
    onSave(out);
    close();
  };

  // Single delegated handler — robust regardless of render timing.
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) { close(); return; }
    if (e.target.closest("[data-save]")) { e.preventDefault(); doSave(); return; }
    if (e.target.closest("[data-cancel]")) { e.preventDefault(); close(); return; }
  });

  // Clear a field's error as the user corrects it.
  scrim.addEventListener("input", (e) => {
    if (e.target.classList.contains("invalid")) {
      e.target.classList.remove("invalid");
      const err = e.target.closest(".field")?.querySelector(".field-error");
      if (err) err.remove();
    }
  });

  // Enter saves, Escape cancels.
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); doSave(); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  scrim.querySelector("input,select")?.focus();
}

function fieldHTML(f) {
  if (f.type === "checkbox")
    return `<div class="field"><label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0">
      <input type="checkbox" name="${f.key}" style="width:auto"> ${f.label}</label></div>`;
  if (f.type === "select")
    // Options may be plain strings ["a","b"] or { value, label } objects so a picker
    // can submit an id while showing a friendly name.
    return `<div class="field"><label>${f.label}</label>
      <select name="${f.key}">${(f.options || [])
        .map((o) => {
          const val = typeof o === "object" ? o.value : o;
          const lab = typeof o === "object" ? o.label : o;
          return `<option value="${esc(val)}">${esc(lab)}</option>`;
        })
        .join("")}</select></div>`;
  if (f.type === "datalist")
    // A free-text input with autocomplete suggestions — "pick from list or type your own".
    return `<div class="field"><label>${f.label}</label>
      <input name="${f.key}" list="${f.key}-list" placeholder="${f.ph || ""}" autocomplete="off">
      <datalist id="${f.key}-list">${(f.options || []).map((o) => `<option value="${esc(o)}">`).join("")}</datalist></div>`;
  return `<div class="field"><label>${f.label}</label>
    <input type="${f.type || "text"}" name="${f.key}" placeholder="${f.ph || ""}" ${f.type === "number" ? 'step="0.01"' : ""}></div>`;
}

const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- Wiring ---------------- */
function wire() {
  app.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => { view = b.dataset.nav; render(); }));
  const tt = app.querySelector("[data-theme-toggle]");
  if (tt) tt.onclick = toggleTheme;

  bind("[data-add]", (b) => addFlows[b.dataset.add]());
  bind("[data-txn-filter]", (b) => { state.txnFilter = b.dataset.txnFilter; render(); });

  // Settings
  bind("[data-set-theme]", (b) => setTheme(b.dataset.setTheme));
  bind("[data-toggle-lock]", () => toggleAppLock());
  bind("[data-del-cat]", (b) => { state.categories = (state.categories || []).filter((c) => c !== b.dataset.delCat); persist(); });

  // Loans & debts
  bind("[data-repay]", (b) => repayLoan(state.loans.find((x) => x.id === b.dataset.repay)));
  bind("[data-edit-loan]", (b) => editLoan(state.loans.find((x) => x.id === b.dataset.editLoan)));
  bind("[data-del-loan]", (b) => delLoan(state.loans.find((x) => x.id === b.dataset.delLoan)));

  // Income
  bind("[data-pay-income]", (b) => payIncome(state.incomes.find((x) => x.id === b.dataset.payIncome)));
  bind("[data-edit-income]", (b) => editIncome(state.incomes.find((x) => x.id === b.dataset.editIncome)));
  bind("[data-del-income]", (b) => delIncome(state.incomes.find((x) => x.id === b.dataset.delIncome)));

  // Accounts
  bind("[data-edit-account]", (b) => editAccount(state.accounts.find((x) => x.id === b.dataset.editAccount)));
  bind("[data-del-account]", (b) => delAccount(state.accounts.find((x) => x.id === b.dataset.delAccount)));
  bind("[data-set-balance]", (b) => setBalance(state.accounts.find((x) => x.id === b.dataset.setBalance)));
  bind("[data-unarchive]", (b) => { const a = state.accounts.find((x) => x.id === b.dataset.unarchive); a.archived = false; persist(); });

  // Transactions
  bind("[data-edit-txn]", (b) => editTxn(state.transactions.find((x) => x.id === b.dataset.editTxn)));
  bind("[data-del-txn]", (b) => {
    const t = state.transactions.find((x) => x.id === b.dataset.delTxn);
    del("transactions", t.id, (TXN_META[t.type] || {}).label || "transaction");
  });

  // Trust
  bind("[data-invest]", (b) => investInTrust(state.unitTrusts.find((x) => x.id === b.dataset.invest)));
  bind("[data-redeem]", (b) => redeemTrust(state.unitTrusts.find((x) => x.id === b.dataset.redeem)));
  bind("[data-nav-trust]", (b) => updateTrustNav(state.unitTrusts.find((x) => x.id === b.dataset.navTrust)));
  bind("[data-edit-trust]", (b) => editTrust(state.unitTrusts.find((x) => x.id === b.dataset.editTrust)));
  bind("[data-del-trust]", (b) => delTrust(state.unitTrusts.find((x) => x.id === b.dataset.delTrust)));
  bind("[data-del-invest]", (b) => {
    const [tid, iid] = b.dataset.delInvest.split(":");
    const t = state.unitTrusts.find((x) => x.id === tid);
    confirmThen("Remove this investment?", "It will be taken out of this fund's history and totals, along with its linked cash movement.", () => {
      t.investments = (t.investments || []).filter((x) => x.id !== iid);
      state.transactions = state.transactions.filter((x) => !(x.link && x.link.kind === "trust" && x.link.invId === iid));
      persist();
    }, { danger: true, okLabel: "Remove" });
  });
}
function bind(sel, fn) { app.querySelectorAll(sel).forEach((el) => (el.onclick = () => fn(el))); }

function del(key, id, name) {
  const what = name ? `"${esc(name)}"` : "this entry";
  confirmThen(
    "Delete entry?",
    `${what} will be permanently removed. This can't be undone.`,
    () => {
      state[key] = state[key].filter((x) => x.id !== id);
      persist();
    },
    { danger: true, okLabel: "Delete" }
  );
}

// Append a ledger entry (filling defaults). Callers persist() afterwards.
function pushTxn(partial) {
  state.transactions.push({
    id: uid(), date: today(), type: "adjust", amount: 0,
    from: null, to: null, category: "", note: "", link: null,
    ...partial,
  });
}
function addCategory(c) {
  const name = (c || "").trim();
  if (name && !state.categories.includes(name)) state.categories.push(name);
}
const noneOption = (label) => ({ value: "", label });

/* ---- Loans & debts ---- */
// The single funding "disbursement" txn for a loan (the lend/borrow that paid it out), if any.
function loanDisbursement(loanId, borrowed) {
  const type = borrowed ? "borrow" : "lend";
  const kind = borrowed ? "debt" : "loan";
  return state.transactions.find((t) => t.type === type && t.link && t.link.kind === kind && t.link.id === loanId);
}
// Keep the funding account in sync: upsert the disbursement to `accountId` + current principal,
// or remove it when "none" is chosen. Called on both create AND edit so balances stay correct.
function syncLoanDisbursement(l, accountId) {
  const borrowed = l.direction === "borrowed";
  const existing = loanDisbursement(l.id, borrowed);
  if (accountId) {
    const fields = {
      amount: num(l.principal),
      from: borrowed ? "ext:debt" : accountId,
      to: borrowed ? accountId : "ext:loan",
      date: l.date || today(),
    };
    if (existing) Object.assign(existing, fields);
    else pushTxn({ type: borrowed ? "borrow" : "lend", ...fields, link: { kind: borrowed ? "debt" : "loan", id: l.id } });
  } else if (existing) {
    state.transactions = state.transactions.filter((t) => t !== existing);
  }
}

function editLoan(l, presetDirection) {
  const isNew = !l;
  const direction = isNew ? presetDirection || "lent" : l.direction || "lent";
  const borrowed = direction === "borrowed";
  const haveAccounts = state.accounts.some((a) => !a.archived);
  const current = isNew ? null : loanDisbursement(l.id, borrowed);
  const fields = [
    { key: "person", label: borrowed ? "Lender's name" : "Friend's name", ph: borrowed ? "who you owe" : "e.g. Kasun" },
    { key: "principal", label: borrowed ? "Amount borrowed" : "Amount lent", type: "number", ph: "0.00" },
    ...(haveAccounts
      ? [{ key: "account", label: borrowed ? "Received into account" : "Funded from account", type: "select", options: [noneOption("— none (don't move money) —"), ...accountOptions()] }]
      : []),
    { key: "date", label: borrowed ? "Date borrowed" : "Date lent", type: "date" },
    { key: "due", label: "Due date (optional)", type: "date" },
    { key: "note", label: "Note (optional)", ph: "what it was for" },
  ];
  const save = (v) => {
    let loan;
    if (isNew) {
      loan = { id: uid(), person: v.person, principal: num(v.principal), direction, date: v.date, due: v.due, note: v.note };
      state.loans.push(loan);
    } else {
      Object.assign(l, { person: v.person, principal: num(v.principal), date: v.date, due: v.due, note: v.note });
      loan = l;
    }
    if (haveAccounts) syncLoanDisbursement(loan, v.account);
    persist();
  };
  const prefill = isNew
    ? { date: today(), account: "" }
    : { person: l.person, principal: l.principal, date: l.date, due: l.due, note: l.note,
        account: current ? (borrowed ? current.to : current.from) : "" };
  const open = () =>
    modal(
      isNew ? (borrowed ? "Borrow money" : "Lend money") : borrowed ? "Edit debt" : "Edit loan",
      fields, save, prefill, specs.loan
    );
  if (isNew) open();
  else confirmThen(borrowed ? "Edit this debt?" : "Edit this loan?", "You can change its details, including which account funded it.", open);
}

function repayLoan(l) {
  const borrowed = l.direction === "borrowed";
  const out = loanOutstandingOne(l);
  const opts = accountOptions();
  modal(borrowed ? "Pay your debt" : "Record repayment", [
    { key: "amount", label: `${borrowed ? "Amount you paid" : "Amount repaid"} (outstanding ${fmt(out)})`, type: "number", ph: "0.00" },
    { key: "account", label: borrowed ? "Paid from account" : "Received into account", type: "select", options: opts },
    { key: "date", label: "Date", type: "date" },
  ], (v) => {
    const amount = Math.min(out, num(v.amount));
    pushTxn({
      date: v.date || today(),
      type: borrowed ? "debt_repaid" : "loan_repaid",
      amount,
      from: borrowed ? v.account : "ext:loan",
      to: borrowed ? "ext:debt" : v.account,
      link: { kind: borrowed ? "debt" : "loan", id: l.id },
    });
    persist();
  }, { date: today(), account: opts[0] && opts[0].value }, specs.accountPayment);
}

function delLinked(arrayKey, rec, name, kinds) {
  const isLinked = (t) => t.link && kinds.includes(t.link.kind) && t.link.id === rec.id;
  const linked = state.transactions.filter(isLinked);
  const extra = linked.length ? ` and ${linked.length} linked transaction(s)` : "";
  confirmThen("Delete entry?", `"${esc(name)}"${extra} will be permanently removed. This can't be undone.`, () => {
    state[arrayKey] = state[arrayKey].filter((x) => x.id !== rec.id);
    if (linked.length) state.transactions = state.transactions.filter((t) => !isLinked(t));
    persist();
  }, { danger: true, okLabel: "Delete" });
}
const delLoan = (l) => delLinked("loans", l, `${l.direction === "borrowed" ? "Debt to" : "Loan to"} ${l.person || "—"}`, ["loan", "debt"]);
const delIncome = (i) => delLinked("incomes", i, i.project || "income", ["income"]);
const delTrust = (t) => delLinked("unitTrusts", t, t.name || "fund", ["trust"]);

/* ---- Income ---- */
const incomeFields = [
  { key: "project", label: "Project / assignment", ph: "e.g. Logo design for ABC" },
  { key: "source", label: "Client / source", ph: "e.g. Upwork, ABC Ltd" },
  { key: "total", label: "Total fee", type: "number", ph: "0.00" },
  { key: "date", label: "Date agreed", type: "date" },
  { key: "due", label: "Due date (optional)", type: "date" },
  { key: "note", label: "Note (optional)", ph: "milestone terms, etc." },
];
function editIncome(i) {
  const isNew = !i;
  const save = (v) => {
    const rec = { ...(i || { id: uid() }), project: v.project, source: v.source, total: num(v.total), date: v.date, due: v.due, note: v.note };
    if (isNew) state.incomes.push(rec);
    else Object.assign(i, rec);
    persist();
  };
  const open = () => modal(isNew ? "Add income" : "Edit income", incomeFields, save, i || { date: today() }, specs.income);
  if (isNew) open();
  else confirmThen("Edit this income entry?", "You can change any of its details.", open);
}
function payIncome(i) {
  const out = Math.max(0, num(i.total) - incomeReceivedOne(i));
  const opts = accountOptions();
  modal("Record payment", [
    { key: "amount", label: `Payment received (outstanding ${fmt(out)})`, type: "number", ph: "0.00" },
    { key: "account", label: "Received into account", type: "select", options: opts },
    { key: "date", label: "Date", type: "date" },
  ], (v) => {
    pushTxn({ date: v.date || today(), type: "income", amount: num(v.amount), from: "ext:income", to: v.account, link: { kind: "income", id: i.id } });
    persist();
  }, { date: today(), account: opts[0] && opts[0].value }, specs.accountPayment);
}

/* ---- Accounts ---- */
const accountTypeOptions = [{ value: "bank", label: "Bank account" }, { value: "cash", label: "Cash / wallet" }];
function editAccount(a) {
  const isNew = !a;
  const fields = [
    { key: "name", label: "Account name", ph: "e.g. Salary account" },
    { key: "type", label: "Type", type: "select", options: accountTypeOptions },
    { key: "institution", label: "Bank (leave blank for cash)", ph: "e.g. Commercial Bank" },
    { key: "opening", label: "Opening balance", type: "number", ph: "0.00" },
  ];
  const save = (v) => {
    const rec = { ...(a || { id: uid(), archived: false }), name: v.name, type: v.type, institution: v.institution, opening: num(v.opening) };
    if (isNew) state.accounts.push(rec);
    else Object.assign(a, rec);
    persist();
  };
  const open = () => modal(isNew ? "Add account" : "Edit account", fields, save, a || { type: "bank", opening: 0 }, specs.account);
  if (isNew) open();
  else confirmThen("Edit this account?", "Changing the opening balance shifts the running balance. To record a real-world correction, use “Set balance” instead.", open);
}
function setBalance(a) {
  const cur = accountBalance(a);
  modal(`Set balance — ${a.name || "account"}`, [
    { key: "balance", label: `New balance (now ${fmt(cur)})`, type: "number", ph: "0.00" },
    { key: "date", label: "As of date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "e.g. reconciled with statement" },
  ], (v) => {
    const diff = num(v.balance) - cur;
    if (Math.abs(diff) > 0.005) {
      pushTxn({
        date: v.date || today(),
        type: "adjust",
        amount: Math.abs(diff),
        from: diff < 0 ? a.id : "ext:opening",
        to: diff < 0 ? "ext:opening" : a.id,
        note: v.note || "balance adjustment",
      });
    }
    persist();
  }, { date: today(), balance: cur }, specs.setBalance);
}
function delAccount(a) {
  const used = state.transactions.some((t) => t.from === a.id || t.to === a.id);
  if (used)
    confirmThen("Archive this account?", "It has transactions, so it can't be deleted. It'll be hidden from pickers but kept so its history still reads correctly.", () => { a.archived = true; persist(); }, { okLabel: "Archive" });
  else del("accounts", a.id, a.name || "account");
}

/* ---- Transaction flows ---- */
function addExpense() {
  const opts = accountOptions();
  modal("Add expense", [
    { key: "amount", label: "Amount spent", type: "number", ph: "0.00" },
    { key: "account", label: "Paid from", type: "select", options: opts },
    { key: "category", label: "Category", type: "datalist", options: state.categories, ph: "e.g. Food" },
    { key: "date", label: "Date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "what for" },
  ], (v) => {
    addCategory(v.category);
    pushTxn({ date: v.date || today(), type: "expense", amount: num(v.amount), from: v.account, to: "ext:expense", category: (v.category || "").trim(), note: v.note });
    persist();
  }, { date: today(), account: opts[0] && opts[0].value }, specs.expense);
}
function addTransfer() {
  const opts = accountOptions();
  modal("Transfer between accounts", [
    { key: "amount", label: "Amount", type: "number", ph: "0.00" },
    { key: "from", label: "From", type: "select", options: opts },
    { key: "to", label: "To", type: "select", options: opts },
    { key: "date", label: "Date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "e.g. ATM withdrawal" },
  ], (v) => {
    pushTxn({ date: v.date || today(), type: "transfer", amount: num(v.amount), from: v.from, to: v.to, note: v.note });
    persist();
  }, { date: today(), from: opts[0] && opts[0].value, to: opts[1] ? opts[1].value : opts[0] && opts[0].value }, specs.transfer);
}
function addIncomeTxn() {
  const opts = accountOptions();
  const projectOpts = [noneOption("— not tied to a project —"), ...state.incomes.map((i) => ({ value: i.id, label: i.project || "Untitled" }))];
  modal("Record income", [
    { key: "amount", label: "Amount received", type: "number", ph: "0.00" },
    { key: "account", label: "Received into", type: "select", options: opts },
    { key: "link", label: "Project (optional)", type: "select", options: projectOpts },
    { key: "date", label: "Date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "" },
  ], (v) => {
    pushTxn({ date: v.date || today(), type: "income", amount: num(v.amount), from: "ext:income", to: v.account, note: v.note, link: v.link ? { kind: "income", id: v.link } : null });
    persist();
  }, { date: today(), account: opts[0] && opts[0].value, link: "" }, specs.accountPayment);
}
function editTxn(t) {
  const isExp = t.type === "expense";
  const fields = [
    { key: "amount", label: "Amount", type: "number", ph: "0.00" },
    ...(isExp ? [{ key: "category", label: "Category", type: "datalist", options: state.categories, ph: "e.g. Food" }] : []),
    { key: "date", label: "Date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "" },
  ];
  const save = (v) => {
    t.amount = num(v.amount);
    t.date = v.date;
    t.note = v.note;
    if (isExp) { t.category = (v.category || "").trim(); addCategory(v.category); }
    persist();
  };
  confirmThen("Edit this transaction?", "You can correct its amount, date or note. To change accounts, delete and re-add it.", () =>
    modal("Edit transaction", fields, save, { amount: t.amount, category: t.category, date: t.date, note: t.note }, isExp ? specs.expenseEdit : specs.txnEdit)
  );
}

/* ---- Unit trusts ---- */
const trustFields = [
  { key: "name", label: "Fund name", ph: "e.g. NDB Wealth Growth Fund" },
  { key: "currentNav", label: "Current NAV per unit", type: "number", ph: "0.00" },
];
function editTrust(t) {
  const isNew = !t;
  const save = (v) => {
    if (isNew) state.unitTrusts.push({ id: uid(), name: v.name, currentNav: num(v.currentNav), investments: [] });
    else { t.name = v.name; t.currentNav = num(v.currentNav); }
    persist();
  };
  const open = () => modal(isNew ? "Add fund" : "Edit fund", trustFields, save, t || {}, specs.trust);
  if (isNew) open();
  else confirmThen("Edit this fund?", "You can rename it or correct the current NAV.", open);
}
function investInTrust(t) {
  const opts = accountOptions();
  modal(`Invest in ${t.name || "fund"}`, [
    { key: "amount", label: "Amount invested", type: "number", ph: "0.00" },
    { key: "nav", label: "NAV per unit on that day", type: "number", ph: `${num(t.currentNav) || "0.00"}` },
    { key: "account", label: "Fund from account (optional)", type: "select", options: [noneOption("— none (don't move money) —"), ...opts] },
    { key: "date", label: "Date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "e.g. monthly top-up" },
  ], (v) => {
    const amount = num(v.amount), nav = num(v.nav);
    const units = amount / nav;
    const invId = uid();
    t.investments = t.investments || [];
    // Back-dating guard: only adopt this NAV as the latest price if it's the newest entry.
    const adopt = !t.investments.length || (v.date || "") >= C.newestDate(t.investments);
    t.investments.push({ id: invId, amount, nav, units, date: v.date, note: v.note });
    if (adopt) t.currentNav = nav;
    if (v.account) pushTxn({ date: v.date || today(), type: "invest", amount, from: v.account, to: "ext:trust", link: { kind: "trust", id: t.id, invId } });
    persist();
  }, { date: today(), nav: t.currentNav, account: "" }, specs.invest);
}
function redeemTrust(t) {
  const opts = accountOptions();
  const value = trustValue(t);
  const units = trustUnits(t);
  const invested = trustInvested(t);
  modal(`Redeem from ${t.name || "fund"}`, [
    { key: "amount", label: `Amount to redeem (value now ${fmt(value)})`, type: "number", ph: "0.00" },
    { key: "account", label: "Receive into account", type: "select", options: opts },
    { key: "date", label: "Date", type: "date" },
    { key: "note", label: "Note (optional)", ph: "" },
  ], (v) => {
    const nav = num(t.currentNav);
    const amount = Math.min(num(v.amount), value); // can't redeem more than current value
    const unitsSold = nav > 0 ? amount / nav : 0;
    const costRemoved = units > 0 ? invested * (unitsSold / units) : 0; // average-cost basis out
    const invId = uid();
    t.investments = t.investments || [];
    // Signed-negative entry so the existing sum-based unit/cost math just works.
    t.investments.push({ id: invId, amount: -costRemoved, nav, units: -unitsSold, date: v.date, note: v.note || "redemption", redeemed: true });
    pushTxn({ date: v.date || today(), type: "redeem", amount, from: "ext:trust", to: v.account, link: { kind: "trust", id: t.id, invId } });
    persist();
  }, { date: today(), account: opts[0] && opts[0].value }, specs.accountPayment);
}
function updateTrustNav(t) {
  modal(`Update NAV — ${t.name || "fund"}`, [
    { key: "currentNav", label: "Latest NAV per unit", type: "number", ph: "0.00" },
  ], (v) => { t.currentNav = num(v.currentNav); persist(); }, { currentNav: t.currentNav }, specs.navUpdate);
}

function addCategoryFlow() {
  modal("Add category", [
    { key: "name", label: "Category name", ph: "e.g. Groceries" },
  ], (v) => { addCategory(v.name); persist(); }, {}, specs.category);
}

// Enabling requires a successful auth first, so the user can't lock themselves out.
async function toggleAppLock() {
  if (state.appLock) {
    state.appLock = false;
    persist();
  } else if (await authenticate("Enable Koin lock")) {
    state.appLock = true;
    persist();
  }
}

const addFlows = {
  lend: () => editLoan(null, "lent"),
  borrow: () => editLoan(null, "borrowed"),
  income: () => editIncome(null),
  account: () => editAccount(null),
  trust: () => editTrust(null),
  expense: addExpense,
  transfer: addTransfer,
  txnIncome: addIncomeTxn,
  category: addCategoryFlow,
};

/* ---------------- Utils ---------------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
async function persist() { await writeData(state); render(); }

/* ---------------- Boot ---------------- */
(async () => {
  const loaded = await readData();
  if (loaded) state = { ...blank(), ...loaded };
  // Order matters: normalise old shapes first, then fold cumulative fields into the ledger.
  state.incomes = C.migrateIncome(state.incomes, uid);
  state.unitTrusts = C.migrateTrusts(state.unitTrusts, uid);
  state.accounts = C.migrateAccounts(state.bankAccounts, state.accounts, uid);
  delete state.bankAccounts;
  state.transactions = Array.isArray(state.transactions) ? state.transactions : [];
  const ml = C.migrateLoans(state.loans, uid);
  state.loans = ml.loans;
  const mi = C.migrateIncomeReceived(state.incomes, uid);
  state.incomes = mi.incomes;
  state.transactions = state.transactions.concat(ml.txns, mi.txns);
  state.categories = C.migrateCategories(state.categories);
  theme = state.theme === "dark" ? "dark" : "light";
  applyTheme();
  // App lock: in the desktop app, gate the UI behind Touch ID / password on launch.
  if (inTauri && state.appLock) {
    locked = true;
    render();
    unlock();
  } else {
    render();
  }
})();
