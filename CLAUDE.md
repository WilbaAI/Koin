# CLAUDE.md

Context for Claude Code working on **Koin**, a personal money tracker. Read this first;
it captures the architecture and the decisions behind it so you don't have to rediscover
them or accidentally undo them.

## What Koin is

A local-first **Tauri 2** desktop app for tracking personal finances in **LKR (Sri Lankan rupees)**.
No cloud, no accounts, no network calls. All data lives in one JSON file on the user's machine.
The user is a single individual tracking their own money.

Everything is connected through **one transaction ledger** — every move of money has a source
and a destination, so lending, spending, transferring and borrowing all debit/credit real
accounts. It tracks:
- **Accounts** — bank accounts and **cash**, with **derived** balances (`opening + Σ ledger`).
- **Transactions** — the ledger: expense, income, transfer, lend, borrow, repay, invest, redeem, adjust.
- **Expenses** — spending by category, with this-month and per-category breakdowns.
- **Loans & debts** — money lent to friends *and* money you borrowed (`direction: lent|borrowed`);
  outstanding is **derived** from linked repayment transactions.
- **Project income** — freelance/assignment fees; `received` is **derived** from linked income transactions.
- **Unit trusts** — investments in funds (rupee invested vs. current value); investing/redeeming
  also moves cash through a linked ledger leg.

Plus a **dashboard** showing net worth = bank + cash + unit-trust value + money owed to you − money you owe.

## Tech stack

- **Frontend:** vanilla JavaScript (ES modules), no framework. Vite for dev/build.
- **Backend:** Rust via Tauri 2. Its only job is reading/writing the JSON data file.
- **Styling:** a single hand-written `style.css` using CSS variables. Light + dark themes.
- **Tests:** Vitest (unit + jsdom DOM tests).
- **No TypeScript, no React, no Tailwind, no UI library.** Keep it that way unless asked.

## File map

```
main.js              # entire frontend app: state, views, modals, wiring, boot
validation.js        # pure input-validation rules + per-entity field specs (exported)
compute.js           # pure financial math + data migrations (exported)
style.css            # all styling; CSS variables; [data-theme="dark"] block
index.html           # entry point, loads fonts + main.js
vite.config.js       # dev server on port 1420 (Tauri expects this)
vitest.config.js     # test config; node env, jsdom for tests/dom/**
tests/
  validation.test.js # validator + spec coverage
  compute.test.js    # math + migration coverage (incl. idempotency)
  dom/modal.test.js  # modal save/cancel/validation behavior + regression tests
src-tauri/
  src/main.rs        # 3 Tauri commands: load_data, save_data, data_file_location
  tauri.conf.json    # window config, bundle, icons
  Cargo.toml         # Rust deps (tauri, plugin-fs, plugin-dialog) pinned to "2"
  capabilities/default.json  # permissions
.github/workflows/ci.yml     # CI: test+build frontend, then Tauri build on 3 OSes
```

## Architecture & conventions

### main.js is organized into labelled sections
Persistence → State → Money helpers → Render → Views → Modals → Wiring → Utils → Boot.
Keep new code in the matching section.

### Rendering model
- A single global `state` object holds everything. `render()` rebuilds `app.innerHTML`
  from the current `view` string, then `wire()` attaches click handlers.
- After any data change, call `persist()` — it writes the file **and** re-renders.
- Views are functions in the `views` object returning HTML strings. There's one per nav
  item plus the dashboard.

### Pure modules are the single source of truth
- **All financial math goes in `compute.js`**, all **validation in `validation.js`**.
  main.js imports them. Do NOT re-inline math or validation logic in main.js — that
  duplication is exactly what these modules exist to prevent, and the tests target them.
- These modules take data as arguments (no global state, no DOM) so they stay testable.
  main.js wraps them with thin state-bound helpers (e.g. `bankTotal = () => C.bankTotal(state.accounts, state.transactions)`).

### Data model (shapes)
```js
accounts:     [{ id, name, type: "bank"|"cash", institution, opening, archived }]
transactions: [{ id, date, type, amount, from, to, category, note, link: { kind, id } }]
unitTrusts:   [{ id, name, currentNav, investments: [{ id, amount, nav, units, date, note }] }]
incomes:      [{ id, project, source, total, date, due, note }]   // `received` is DERIVED
loans:        [{ id, person, principal, direction: "lent"|"borrowed", date, due, note }] // `repaid` DERIVED
categories:   ["Food", "Transport", ...]
// plus top-level: theme ("light"|"dark"), txnFilter (UI only)
```
`id` is from `uid()` (8-char base36). Money fields are plain numbers (LKR).

**The ledger is the single source of truth for money.** `transaction.amount` is always positive;
direction is encoded by `from`/`to`, each of which is **either** an account `id` **or** an external
token: `ext:income`, `ext:expense`, `ext:opening`, `ext:loan`, `ext:debt`, `ext:trust`. A ref is a
real account iff it does NOT start with `ext:` (`C.isAccount`). Account balances, loan outstanding
and income received are all **derived** from the ledger (never stored) — this keeps them correct when
a transaction is edited or deleted. Transaction TYPES → endpoints: expense (acct→ext:expense),
income (ext:income→acct), lend (acct→ext:loan), loan_repaid (ext:loan→acct), borrow (ext:debt→acct),
debt_repaid (acct→ext:debt), transfer (acct→acct), invest (acct→ext:trust), redeem (ext:trust→acct),
adjust (ext:opening↔acct). `link` joins a cash move to its terms entity (loan/debt/income/trust;
trust legs also carry `invId`).

### Persistence
`readData`/`writeData` in main.js. When running inside Tauri (`window.__TAURI_INTERNALS__`
present), they call the Rust `load_data`/`save_data` commands → JSON file in the OS app-data
dir. In a plain browser (`npm run dev` without Tauri) they fall back to `localStorage`, so
the UI can be previewed without Rust. **Preserve this dual path** — it's how tests and quick
previews work.

### Migrations
`compute.js` holds all migrations, run at boot in order: `migrateIncome`, `migrateTrusts`,
`migrateAccounts` (banks→unified accounts, `balance`→`opening`, seeds a cash account),
`migrateLoans` (adds `direction`, folds old `repaid` into a seed `loan_repaid`/`debt_repaid` txn),
`migrateIncomeReceived` (folds old `received` into a seed `income` txn), `migrateCategories`.
All are **idempotent** (detect by the NEW field; passthrough if present). Migrated repayment/income
seed txns use **`ext:opening`** as their counter-endpoint so they reduce outstanding / register
received **without** fabricating money into a real account (the cash already sits in `opening`).
If you change a shape again, add a migration the same way + an idempotency-and-value test.

## Domain knowledge (important — don't get this wrong)

### Unit trusts
- The user invests a **rupee amount**, not a unit count. Units are derived: `units = amount / nav`.
- **NAV (Net Asset Value)** is the per-unit price, published daily by the fund manager.
- Each fund accumulates **multiple investments over time** at different NAVs.
- `currentNav` values the whole holding today; gain/loss = current value − total invested.
- **NAV can never be 0** (it's a divisor). Validation enforces NAV > 0.
- Logging an investment only adopts its NAV as `currentNav` when it's the **newest-dated** entry
  (`C.newestDate`), so a back-dated entry no longer clobbers the latest price.
- Redeeming appends a **signed-negative** investment row (negative units + average-cost basis out)
  so the existing sum-based unit/value math just works, plus a `redeem` cash-leg txn.

### Installments
Loans and income are paid in parts. **`repaid`/`received` are derived from linked ledger
transactions** (`loanOutstandingOne`, `incomeReceivedOne` in compute.js) — they are NOT stored.
The "Repay"/"Payment" buttons append a transaction (and ask which account the money lands in);
they never mutate a cumulative field. `addCapped` survives for the repay UI's amount clamp.

## Hard-won decisions — do NOT undo these

1. **Modal event handling uses delegation + `closest()`** on the overlay element, not
   per-button `onclick`. Per-button binding caused dead buttons (clicks on inner content
   missed). There are regression tests for this in `tests/dom/modal.test.js`.
2. **Modals guard against null `values`** (`values = values || {}`). Passing null crashed
   the prefill loop and silently killed the button wiring. Regression-tested.
3. **Validation gates every save.** The `modal()` function takes a `spec` from
   `validation.specs`; invalid input shows inline errors and blocks save. Don't bypass it.
4. **esbuild is pinned via `overrides` in package.json**, not by upgrading Vite. Recurring
   dev-only advisories (GHSA-67mh-…, GHSA-gv7w-…) affect esbuild's dev server / Deno path,
   never the shipped Tauri binary. Bump the override version when a new one appears; do NOT
   run `npm audit fix --force` (it installs a broken/old Vite).
5. **Cargo deps use `version = "2"`** (not pinned patch versions) so crate minor versions
   match the npm `@tauri-apps/*` packages and avoid the version-mismatch warning.
6. **Currency is LKR**, formatted as `Rs 1,234.56` via `fmt()`. Single NAV per fund (no
   buy/sell spread) — the user's funds publish one NAV.
7. **Balances are derived from the ledger, never stored.** Accounts hold an `opening`; live balance
   is `opening + Σ ledger`. Same for loan outstanding / income received. Do NOT reintroduce a stored
   `balance`/`repaid`/`received` — that's two sources of truth and it drifts on edit/delete.
8. **`from`/`to` use `ext:` tokens for the outside world** so every flow is one uniform shape.
   `uid()` is base36 and never starts with `ext:`, so `C.isAccount` is safe — keep it that way.
9. **`netWorth` must never fold in `incomeReceived`** (that cash already counts via account balances —
   double-count). It is assets(bank+cash) + trusts + loansReceivable − loansPayable. Comment in compute.js.
10. **Overdraft is allowed, not blocked** (validation is pure and can't see derived balances).
    Negative balances surface in red in the UI. An account with transactions **archives** instead of
    deleting (orphaned `from`/`to` would break history); deleting a loan/income/trust cascades its linked txns.

## Commands

```bash
npm install            # install deps (Node 20+, 22 recommended)
npm run tauri dev      # run the desktop app (first run compiles Rust, slow)
npm run dev            # browser-only preview (localStorage fallback, no Rust)
npm test               # full Vitest suite (102 tests)
npm run test:watch     # tests in watch mode
npm run coverage       # coverage for compute.js + validation.js (currently ~100% lines)
npm run build          # build frontend to dist/
npm run tauri build    # build native installer
```

## When making changes

- **Adding a field to an entity?** Update: the data-model comment in `blank()`, the modal
  `fields` array, the `save` function, the `specs` entry in validation.js, and the view that
  renders it. Add a migration if existing data needs the field.
- **Changing math?** Edit `compute.js` and update/add a test in `tests/compute.test.js`.
- **Always run `npm test` before considering a change done.** CI runs the same suite plus a
  cross-platform Tauri build.
- Keep the visual style consistent: warm "ledger paper" palette, Fraunces display font,
  Spline Sans Mono for numbers, minimal formatting. Both light and dark themes must work —
  use the CSS variables, never hardcode colors.
- Match the existing tone in user-facing copy: plain, direct, sentence case.

## Known limitations / possible next steps (not yet built)

- Editing a transaction only corrects amount/date/note (+category for expenses); to change an
  endpoint you delete and re-add. Full endpoint editing is deliberately out of scope.
- No recurring transactions, no charts/history graphs, no multi-currency, no export.
- Redemption uses average-cost basis (no FIFO/lot selection, no realized-gain reporting).
- Icons in `src-tauri/icons` are solid-color placeholders.
