# Koin — personal money tracker

A small Tauri desktop app for tracking your money in **LKR**. Data is stored as a
plain JSON file on your machine (no cloud, no account).

## What it tracks

- **Loans to friends** — who owes you, how much is repaid, outstanding balance, a repayment button, and a progress bar. Marks loans open / partial / settled.
- **Project income** — earnings from assignments, with received vs. pending status.
- **Bank accounts** — current balances across accounts.
- **Unit trusts** — track funds by the rupee amount you invest; units are auto-calculated from the NAV. Shows invested vs. current value and gain/loss per fund.
- **Overview** — net worth (cash + investments + money owed to you), pending income, and a snapshot of open loans.

All inputs are validated (no negative amounts, no zero NAV, required names, repaid/received can't exceed totals) with inline error messages.

## Requirements

- [Node.js](https://nodejs.org) 20+ (22 recommended)
- [Rust](https://rustup.rs) (stable) — needed by Tauri
- Tauri OS prerequisites: https://tauri.app/start/prerequisites/

## Run it

```bash
npm install
npm run tauri dev      # live dev window
```

## Testing

The financial math, data migrations, and input validation live in pure, dependency-free
modules (`compute.js`, `validation.js`) so they can be tested fast and deterministically.
DOM-level tests cover the modal's save/cancel/validation behavior.

```bash
npm test          # run the full suite once
npm run test:watch  # re-run on change
npm run coverage    # coverage report for the pure modules
```

The suite includes regression tests for two bugs found during development: dead
save/cancel buttons, and a crash when opening an "Add" modal with no existing record.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Test & build frontend** — syntax check, full test suite, coverage, Vite build, and a non-blocking security audit.
2. **Tauri build** — compiles the native app on Linux, macOS, and Windows to catch platform issues early.

Commit `package-lock.json` so CI's `npm ci` has a lockfile to install from.

## Build a distributable app

```bash
npm run tauri build    # produces an installer in src-tauri/target/release/bundle
```

## Where is my data?

The app shows the exact path in the bottom-left of the sidebar. It's a file named
`koin-data.json` inside the OS app-data directory, e.g.:

- macOS: `~/Library/Application Support/com.koin.money/`
- Windows: `%APPDATA%\com.koin.money\`
- Linux: `~/.local/share/com.koin.money/`

Back it up by copying that file. Editing it by hand works too — it's readable JSON.

## Notes

- The icons in `src-tauri/icons` are plain solid-color placeholders. Drop in your own
  PNG/ICNS/ICO and update `src-tauri/tauri.conf.json` if you want a real icon.
- Running just `npm run dev` (browser, no Tauri) works for previewing the UI — it
  falls back to `localStorage` so you can click around without Rust installed.
