// Pure financial computations and data migrations for Koin.
// Every function takes its data as arguments — no global state, no DOM — so it's
// directly unit-testable and shared with main.js (single source of truth for math).

export const num = (v) => (isNaN(parseFloat(v)) ? 0 : parseFloat(v));
const sum = (arr, f) => (arr || []).reduce((a, x) => a + f(x), 0);

// ---- Unit trusts ----
export const trustUnits = (t) => sum(t && t.investments, (x) => num(x.units));
export const trustInvested = (t) => sum(t && t.investments, (x) => num(x.amount));
export const trustValue = (t) => trustUnits(t) * num(t && t.currentNav);
export const trustGain = (t) => trustValue(t) - trustInvested(t);
export const trustGainPct = (t) => {
  const inv = trustInvested(t);
  return inv > 0 ? (trustGain(t) / inv) * 100 : 0;
};

// Units allotted when investing `amount` at a given `nav`.
export const unitsFor = (amount, nav) => {
  const a = num(amount), n = num(nav);
  return n > 0 ? a / n : 0;
};

// ---- Ledger: accounts & transactions ----
// A money location is a real account unless its ref is an external "ext:" token.
export const isAccount = (ref) => !!ref && !String(ref).startsWith("ext:");
// Signed amount a single transaction applies to one account: +in, −out.
export const txnDelta = (t, acctId) =>
  (t.to === acctId ? num(t.amount) : 0) - (t.from === acctId ? num(t.amount) : 0);
// Live balance is DERIVED, never stored: opening + net of all ledger entries.
export const accountBalance = (acct, txns) =>
  num(acct && acct.opening) + sum(txns, (t) => txnDelta(t, acct && acct.id));
export const accountsTotal = (accounts, txns, type) =>
  sum(accounts, (a) => (!type || a.type === type ? accountBalance(a, txns) : 0));
export const bankTotal = (accounts, txns) => accountsTotal(accounts, txns, "bank");
export const cashTotal = (accounts, txns) => accountsTotal(accounts, txns, "cash");
export const assetTotal = (accounts, txns) => accountsTotal(accounts, txns); // bank + cash

// ---- Expenses ----
export const isExpense = (t) => t.type === "expense";
export const inPeriod = (d, from, to) => (!from || (d || "") >= from) && (!to || (d || "") <= to);
export const monthOf = (d) => (d || "").slice(0, 7); // "YYYY-MM"
export const expenseTotal = (txns, { from, to } = {}) =>
  sum((txns || []).filter((t) => isExpense(t) && inPeriod(t.date, from, to)), (t) => num(t.amount));
export const expenseByCategory = (txns, { from, to } = {}) =>
  (txns || [])
    .filter((t) => isExpense(t) && inPeriod(t.date, from, to))
    .reduce((m, t) => {
      const k = t.category || "Uncategorised";
      m[k] = (m[k] || 0) + num(t.amount);
      return m;
    }, {});

// ---- Reports / trends ----
// Inclusive list of "YYYY-MM" buckets from fromYM..toYM (ISO strings compare lexically).
export const monthsBetween = (fromYM, toYM) => {
  if (!fromYM) return [];
  if (!toYM || fromYM > toYM) return [fromYM];
  const out = [];
  let [y, m] = fromYM.split("-").map(Number);
  const [ty, tm] = toYM.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
};
// Bucket a txn filter by month, zero-filled, in `months` order: [{month,total}].
export const monthlyTotals = (txns, predicate, months) => {
  const acc = {};
  (txns || []).filter(predicate).forEach((t) => {
    const k = monthOf(t.date);
    acc[k] = (acc[k] || 0) + num(t.amount);
  });
  return (months || []).map((month) => ({ month, total: acc[month] || 0 }));
};
// Income vs expense per month, aligned + zero-filled, ready for grouped bars.
export const incomeVsExpenseByMonth = (txns, months) => {
  const inc = monthlyTotals(txns, (t) => t.type === "income", months);
  const exp = monthlyTotals(txns, (t) => t.type === "expense", months);
  return (months || []).map((m, i) => ({ month: m, income: inc[i].total, expense: exp[i].total }));
};
// Net liquid assets (bank + cash) counting only ledger entries dated <= dateMax ("YYYY-MM-DD").
export const assetsAsOf = (accounts, txns, dateMax) =>
  assetTotal(accounts, (txns || []).filter((t) => inPeriod(t.date, null, dateMax)));
// Month-end net-asset trend (wealth over time): [{month,assets}]. "-31" ceiling is safe (lexical ISO).
export const assetsTrend = (accounts, txns, months) =>
  (months || []).map((m) => ({ month: m, assets: assetsAsOf(accounts, txns, m + "-31") }));
// Clean P&L cash flow for the period. inflow=income, outflow=expense; lend/borrow/invest/transfer
// are excluded — they move money you still own or owe, not money earned or spent.
export const cashFlow = (txns, { from, to } = {}) => {
  const inflow = sum((txns || []).filter((t) => t.type === "income" && inPeriod(t.date, from, to)), (t) => num(t.amount));
  const outflow = sum((txns || []).filter((t) => t.type === "expense" && inPeriod(t.date, from, to)), (t) => num(t.amount));
  return { inflow, outflow, net: inflow - outflow };
};

// ---- Trusts (aggregates unchanged) ----
export const trustTotal = (trusts) => sum(trusts, (t) => trustValue(t));
export const trustInvestedTotal = (trusts) => sum(trusts, (t) => trustInvested(t));
// Newest investment date in a fund (for the NAV back-dating guard). "" if none.
export const newestDate = (rows) =>
  (rows || []).reduce((m, x) => ((x.date || "") > m ? x.date || "" : m), "");

// ---- Loans & income derived from the ledger ----
const linkedSum = (txns, kind, id, types) =>
  sum(
    (txns || []).filter(
      (t) => t.link && t.link.kind === kind && t.link.id === id && types.includes(t.type)
    ),
    (t) => num(t.amount)
  );
export const loanPaid = (loanId, txns) => linkedSum(txns, "loan", loanId, ["loan_repaid"]);
export const debtPaid = (debtId, txns) => linkedSum(txns, "debt", debtId, ["debt_repaid"]);
// Outstanding works for either direction (paid via loan_repaid OR debt_repaid).
export const loanOutstandingOne = (l, txns) => {
  const paid = l.direction === "borrowed" ? debtPaid(l.id, txns) : loanPaid(l.id, txns);
  return Math.max(0, num(l.principal) - paid);
};
export const loansReceivable = (loans, txns) => // friends owe you
  sum((loans || []).filter((l) => l.direction !== "borrowed"), (l) => loanOutstandingOne(l, txns));
export const loansPayable = (loans, txns) => // you owe friends
  sum((loans || []).filter((l) => l.direction === "borrowed"), (l) => loanOutstandingOne(l, txns));

export const incomeReceivedOne = (i, txns) =>
  Math.min(num(i.total), linkedSum(txns, "income", i.id, ["income"]));
export const incomeReceived = (incomes, txns) =>
  sum(incomes, (i) => incomeReceivedOne(i, txns));
export const incomePending = (incomes, txns) =>
  sum(incomes, (i) => Math.max(0, num(i.total) - incomeReceivedOne(i, txns)));

// Net worth = liquid assets (bank + cash) + investments at value
//   + money owed TO you − money YOU owe.
// NOTE: never add incomeReceived here — that cash already lives in account balances
// (income arrives as a balance-raising transaction), so adding it double-counts.
export const netWorth = (state) =>
  assetTotal(state.accounts, state.transactions) +
  trustTotal(state.unitTrusts) +
  loansReceivable(state.loans, state.transactions) -
  loansPayable(state.loans, state.transactions);

// Clamp a cumulative payment so it never exceeds the cap (loan principal / income total).
export const addCapped = (current, addition, cap) =>
  Math.min(num(cap), num(current) + num(addition));

// ---- Migrations (idempotent: running twice is safe) ----
const newId = () => Math.random().toString(36).slice(2, 10);

export function migrateIncome(incomes, idGen = newId) {
  return (incomes || []).map((i) => {
    if (i.total === undefined && i.amount !== undefined) {
      const total = num(i.amount);
      return {
        id: i.id || idGen(),
        project: i.project,
        source: i.source,
        total,
        received: i.received === true ? total : 0,
        date: i.date,
        due: i.due,
        note: i.note,
      };
    }
    return i;
  });
}

export function migrateTrusts(trusts, idGen = newId) {
  return (trusts || []).map((t) => {
    if (t.investments === undefined && (t.units !== undefined || t.navPerUnit !== undefined)) {
      const units = num(t.units), nav = num(t.navPerUnit);
      const amount = units * nav; // best-effort cost basis
      return {
        id: t.id || idGen(),
        name: t.name,
        currentNav: nav,
        investments: units > 0 ? [{ id: idGen(), amount, nav, units, date: t.date || "", note: "migrated" }] : [],
      };
    }
    return t;
  });
}

// Banks -> unified accounts (type bank|cash). Old `balance` becomes `opening`.
// Always ensures one cash account exists. Idempotent: once `accounts` holds data
// it's used as-is; converting from `bankAccounts` only happens while it's empty.
export function migrateAccounts(bankAccounts, accounts, idGen = newId) {
  const accts =
    Array.isArray(accounts) && accounts.length
      ? accounts.slice()
      : (bankAccounts || []).map((a) => ({
          id: a.id || idGen(),
          name: a.name,
          type: "bank",
          institution: a.bank || "",
          opening: num(a.balance),
          archived: false,
        }));
  if (!accts.some((a) => a.type === "cash")) {
    accts.push({ id: idGen(), name: "Cash in hand", type: "cash", institution: "", opening: 0, archived: false });
  }
  return accts;
}

// Add `direction` (default "lent") and convert any prior cumulative `repaid` into a
// seed repayment txn. Counter-endpoint is ext:opening — the cash already sits in the
// migrated opening balances, so we must NOT credit a real account. Returns { loans, txns }.
export function migrateLoans(loans, idGen = newId) {
  const txns = [];
  const migrated = (loans || []).map((l) => {
    const direction = l.direction || "lent";
    const out = { ...l, direction };
    if (l.repaid !== undefined) {
      const repaid = num(l.repaid);
      if (repaid > 0) {
        txns.push({
          id: idGen(),
          date: l.date || "",
          type: direction === "borrowed" ? "debt_repaid" : "loan_repaid",
          amount: repaid,
          from: direction === "borrowed" ? "ext:opening" : "ext:loan",
          to: direction === "borrowed" ? "ext:debt" : "ext:opening",
          category: "",
          note: "migrated repayment",
          link: { kind: direction === "borrowed" ? "debt" : "loan", id: l.id },
        });
      }
      delete out.repaid;
    }
    return out;
  });
  return { loans: migrated, txns };
}

// Convert prior cumulative income `received` into seed income txns (counter ext:opening).
// Run AFTER migrateIncome (which normalises old amount->total). Returns { incomes, txns }.
export function migrateIncomeReceived(incomes, idGen = newId) {
  const txns = [];
  const migrated = (incomes || []).map((i) => {
    if (i.received === undefined) return i;
    const out = { ...i };
    delete out.received;
    const received = num(i.received);
    if (received > 0) {
      txns.push({
        id: idGen(),
        date: i.date || "",
        type: "income",
        amount: Math.min(num(i.total), received),
        from: "ext:income",
        to: "ext:opening",
        category: "",
        note: "migrated payment",
        link: { kind: "income", id: i.id },
      });
    }
    return out;
  });
  return { incomes: migrated, txns };
}

export const DEFAULT_CATEGORIES = ["Food", "Transport", "Bills", "Rent", "Health", "Shopping", "Other"];
export function migrateCategories(categories) {
  return Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES.slice();
}
