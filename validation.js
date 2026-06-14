// Pure validation helpers for Koin. No DOM, no side effects — fully unit-testable.

export const toNum = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = parseFloat(v);
  return isNaN(n) ? NaN : n;
};

// Each validator returns null when valid, or an error string when invalid.

export function required(label) {
  return (v) => (v && String(v).trim().length > 0 ? null : `${label} is required.`);
}

export function maxLen(label, max) {
  return (v) => (v && String(v).length > max ? `${label} must be ${max} characters or fewer.` : null);
}

// A money amount: present, numeric, finite, >= 0 (and optionally > 0).
// `allowNegative` opts out of the non-negative check (e.g. an overdrawn opening balance).
export function money(label, { positive = false, allowZero = true, allowNegative = false } = {}) {
  return (v) => {
    const n = toNum(v);
    if (isNaN(n)) return `${label} must be a number.`;
    if (!isFinite(n)) return `${label} is not a valid amount.`;
    if (!allowNegative && n < 0) return `${label} can't be negative.`;
    if (positive && n <= 0) return `${label} must be greater than zero.`;
    if (!allowZero && n === 0) return `${label} must be greater than zero.`;
    if (Math.abs(n) > 1e15) return `${label} is unrealistically large.`;
    return null;
  };
}

// A price/NAV: must be strictly positive (you can't buy units at NAV 0).
export function price(label) {
  return money(label, { positive: true });
}

// An optional ISO date (YYYY-MM-DD). Empty is allowed.
export function optionalDate(label) {
  return (v) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${label} must be a valid date.`;
    const d = new Date(v);
    if (isNaN(d.getTime())) return `${label} must be a valid date.`;
    return null;
  };
}

// Compose several validators; returns first error or null.
export function all(...validators) {
  return (v, ctx) => {
    for (const fn of validators) {
      const err = fn(v, ctx);
      if (err) return err;
    }
    return null;
  };
}

// Cross-field: received/repaid can't exceed the total/principal.
export function notExceeding(label, ofLabel, ofKey) {
  return (v, ctx) => {
    const n = toNum(v);
    const cap = toNum(ctx && ctx[ofKey]);
    if (!isNaN(n) && !isNaN(cap) && n > cap) {
      return `${label} can't be more than ${ofLabel}.`;
    }
    return null;
  };
}

// Cross-field: this field must differ from another (e.g. a transfer's from ≠ to).
export function distinctFrom(label, otherKey) {
  return (v, ctx) => (v && ctx && v === ctx[otherKey] ? `${label} must be a different account.` : null);
}

// Conditional: only apply `validator` when ctx[whenKey] === whenVal.
export function when(whenKey, whenVal, validator) {
  return (v, ctx) => (ctx && ctx[whenKey] === whenVal ? validator(v, ctx) : null);
}

// Validate a whole record against a field spec: { key: validatorFn }.
// Returns a map of key -> error for any invalid fields (empty if all valid).
export function validateRecord(values, spec) {
  const errors = {};
  for (const key of Object.keys(spec)) {
    const err = spec[key](values ? values[key] : undefined, values || {});
    if (err) errors[key] = err;
  }
  return errors;
}

// ---- Field specs for each entity (single source of truth) ----

export const specs = {
  loan: {
    person: all(required("Name"), maxLen("Name", 80)),
    principal: money("Amount", { positive: true }),
    date: optionalDate("Date"),
    due: optionalDate("Due date"),
    note: maxLen("Note", 200),
  },
  income: {
    project: all(required("Project / assignment"), maxLen("Project", 120)),
    source: maxLen("Client / source", 120),
    total: money("Total fee", { positive: true }),
    date: optionalDate("Date agreed"),
    due: optionalDate("Due date"),
    note: maxLen("Note", 200),
  },
  bank: {
    name: all(required("Account name"), maxLen("Account name", 80)),
    bank: maxLen("Bank", 80),
    balance: money("Balance"),
  },
  trust: {
    name: all(required("Fund name"), maxLen("Fund name", 100)),
    currentNav: price("Current NAV per unit"),
  },
  invest: {
    amount: money("Amount invested", { positive: true }),
    nav: price("NAV per unit"),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  payment: {
    amount: money("Amount", { positive: true }),
  },
  navUpdate: {
    currentNav: price("Latest NAV per unit"),
  },
  account: {
    name: all(required("Account name"), maxLen("Account name", 80)),
    type: required("Account type"),
    institution: maxLen("Bank", 80),
    opening: money("Opening balance", { allowNegative: true }),
  },
  expense: {
    amount: money("Amount", { positive: true }),
    account: required("Account"),
    category: all(required("Category"), maxLen("Category", 40)),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  transfer: {
    amount: money("Amount", { positive: true }),
    from: required("From account"),
    to: all(required("To account"), distinctFrom("To account", "from")),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  lend: {
    amount: money("Amount", { positive: true }),
    account: required("From account"),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  borrow: {
    amount: money("Amount", { positive: true }),
    account: required("Into account"),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  // Loan repayment / income payment: an amount landing in a chosen account.
  accountPayment: {
    amount: money("Amount", { positive: true }),
    account: required("Account"),
  },
  // Correcting an existing transaction's amount/date/note (endpoints stay fixed).
  txnEdit: {
    amount: money("Amount", { positive: true }),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  expenseEdit: {
    amount: money("Amount", { positive: true }),
    category: all(required("Category"), maxLen("Category", 40)),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  // Setting an account's balance to a target (records an adjustment); may be negative.
  setBalance: {
    balance: money("Balance", { allowNegative: true }),
    date: optionalDate("Date"),
    note: maxLen("Note", 200),
  },
  category: {
    name: all(required("Category"), maxLen("Category", 40)),
  },
};
