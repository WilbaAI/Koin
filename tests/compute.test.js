import { describe, it, expect } from "vitest";
import * as C from "../compute.js";

describe("unitsFor", () => {
  it("computes units = amount / nav", () => {
    expect(C.unitsFor(50000, 25)).toBe(2000);
    expect(C.unitsFor(86000, 43)).toBe(2000);
  });
  it("returns 0 when nav is 0 (no divide-by-zero)", () => {
    expect(C.unitsFor(1000, 0)).toBe(0);
    expect(C.unitsFor(1000, "")).toBe(0);
  });
});

describe("unit trust computations", () => {
  const fund = {
    currentNav: 32,
    investments: [
      { amount: 50000, nav: 25, units: 2000 },
      { amount: 30000, nav: 30, units: 1000 },
    ],
  };
  it("totals units and invested across investments", () => {
    expect(C.trustUnits(fund)).toBe(3000);
    expect(C.trustInvested(fund)).toBe(80000);
  });
  it("values holdings at current NAV", () => {
    expect(C.trustValue(fund)).toBe(96000); // 3000 * 32
  });
  it("computes gain and percentage", () => {
    expect(C.trustGain(fund)).toBe(16000);
    expect(C.trustGainPct(fund)).toBeCloseTo(20);
  });
  it("handles a loss", () => {
    const down = { ...fund, currentNav: 22 };
    expect(C.trustGain(down)).toBe(-14000); // 3000*22 - 80000
    expect(C.trustGainPct(down)).toBeCloseTo(-17.5);
  });
  it("empty fund has zero everything, no NaN", () => {
    const empty = { currentNav: 10, investments: [] };
    expect(C.trustValue(empty)).toBe(0);
    expect(C.trustGainPct(empty)).toBe(0);
  });
});

describe("ledger account balances", () => {
  it("isAccount distinguishes ext: tokens from real account ids", () => {
    expect(C.isAccount("boc123")).toBe(true);
    expect(C.isAccount("ext:loan")).toBe(false);
    expect(C.isAccount("")).toBe(false);
  });
  it("txnDelta is +in / −out / 0 otherwise", () => {
    const t = { amount: 100, from: "a", to: "b" };
    expect(C.txnDelta(t, "b")).toBe(100);
    expect(C.txnDelta(t, "a")).toBe(-100);
    expect(C.txnDelta(t, "c")).toBe(0);
  });
  it("accountBalance = opening + in − out", () => {
    const acct = { id: "a", opening: 1000 };
    const txns = [
      { amount: 500, from: "x", to: "a" },
      { amount: 200, from: "a", to: "y" },
    ];
    expect(C.accountBalance(acct, txns)).toBe(1300);
  });
  it("account with no txns is just its opening", () => {
    expect(C.accountBalance({ id: "a", opening: 750 }, [])).toBe(750);
  });
  it("a transfer conserves total assets (double-entry invariant)", () => {
    const accts = [{ id: "a", type: "bank", opening: 100 }, { id: "b", type: "cash", opening: 0 }];
    const before = C.assetTotal(accts, []);
    const after = C.assetTotal(accts, [{ type: "transfer", amount: 40, from: "a", to: "b" }]);
    expect(after).toBe(before);
  });
});

describe("expenses", () => {
  const txns = [
    { type: "expense", amount: 2000, category: "Food", date: "2026-06-02", from: "cash", to: "ext:expense" },
    { type: "expense", amount: 3000, category: "Food", date: "2026-05-15", from: "cash", to: "ext:expense" },
    { type: "expense", amount: 1500, category: "Transport", date: "2026-06-10", from: "cash", to: "ext:expense" },
    { type: "transfer", amount: 9999, from: "a", to: "b", date: "2026-06-01" },
  ];
  it("expenseTotal sums only expense rows", () => expect(C.expenseTotal(txns)).toBe(6500));
  it("expenseTotal filters by period", () =>
    expect(C.expenseTotal(txns, { from: "2026-06-01", to: "2026-06-30" })).toBe(3500));
  it("expenseByCategory groups by category", () =>
    expect(C.expenseByCategory(txns)).toEqual({ Food: 5000, Transport: 1500 }));
  it("monthOf slices YYYY-MM", () => expect(C.monthOf("2026-06-14")).toBe("2026-06"));
});

describe("newestDate (NAV back-dating guard)", () => {
  it("returns the max date string", () =>
    expect(C.newestDate([{ date: "2026-01-01" }, { date: "2026-03-01" }, { date: "2026-02-01" }])).toBe("2026-03-01"));
  it("empty -> ''", () => expect(C.newestDate([])).toBe(""));
});

describe("aggregates (ledger model)", () => {
  const accounts = [
    { id: "boc", type: "bank", opening: 100000 },
    { id: "cash", type: "cash", opening: 5000 },
  ];
  const transactions = [
    { type: "expense", amount: 2000, from: "cash", to: "ext:expense", category: "Food", date: "2026-06-02" },
    { type: "transfer", amount: 10000, from: "boc", to: "cash", date: "2026-06-03" },
    { type: "income", amount: 65000, from: "ext:income", to: "boc", date: "2026-06-04", link: { kind: "income", id: "i1" } },
    { type: "lend", amount: 25000, from: "boc", to: "ext:loan", date: "2026-06-05", link: { kind: "loan", id: "l1" } },
    { type: "loan_repaid", amount: 10000, from: "ext:loan", to: "boc", date: "2026-06-06", link: { kind: "loan", id: "l1" } },
    { type: "borrow", amount: 8000, from: "ext:debt", to: "cash", date: "2026-06-07", link: { kind: "debt", id: "d1" } },
  ];
  const unitTrusts = [{ currentNav: 30, investments: [{ amount: 60000, nav: 30, units: 2000 }] }];
  const incomes = [{ id: "i1", total: 80000 }];
  const loans = [
    { id: "l1", principal: 25000, direction: "lent" },
    { id: "d1", principal: 8000, direction: "borrowed" },
  ];
  const state = { accounts, transactions, unitTrusts, incomes, loans };

  it("bankTotal = opening + net flow", () => expect(C.bankTotal(accounts, transactions)).toBe(140000));
  it("cashTotal", () => expect(C.cashTotal(accounts, transactions)).toBe(21000));
  it("assetTotal = bank + cash", () => expect(C.assetTotal(accounts, transactions)).toBe(161000));
  it("trustTotal at current NAV", () => expect(C.trustTotal(unitTrusts)).toBe(60000));
  it("loansReceivable counts only money owed TO you", () =>
    expect(C.loansReceivable(loans, transactions)).toBe(15000));
  it("loansPayable counts only what YOU owe", () =>
    expect(C.loansPayable(loans, transactions)).toBe(8000));
  it("incomeReceived from linked ledger, capped at total", () =>
    expect(C.incomeReceived(incomes, transactions)).toBe(65000));
  it("incomePending is the remainder", () =>
    expect(C.incomePending(incomes, transactions)).toBe(15000));
  it("netWorth = assets + trusts + receivable − payable", () =>
    expect(C.netWorth(state)).toBe(161000 + 60000 + 15000 - 8000));
});

describe("incomeReceived edge cases", () => {
  it("received over total still caps at total", () => {
    const txns = [{ type: "income", amount: 500, link: { kind: "income", id: "x" } }];
    expect(C.incomeReceived([{ id: "x", total: 100 }], txns)).toBe(100);
  });
});

describe("addCapped", () => {
  it("adds but never exceeds cap", () => {
    expect(C.addCapped(300, 400, 500)).toBe(500);
    expect(C.addCapped(300, 100, 500)).toBe(400);
  });
});

describe("migrateIncome", () => {
  const idGen = () => "fixedid";
  it("converts old amount + received:true to fully paid", () => {
    const out = C.migrateIncome([{ id: "a", project: "P", amount: 1000, received: true }], idGen);
    expect(out[0].total).toBe(1000);
    expect(out[0].received).toBe(1000);
    expect(out[0].amount).toBeUndefined();
  });
  it("converts old amount + received:false to unpaid", () => {
    const out = C.migrateIncome([{ id: "b", amount: 800, received: false }], idGen);
    expect(out[0].total).toBe(800);
    expect(out[0].received).toBe(0);
  });
  it("leaves already-migrated records untouched (idempotent)", () => {
    const modern = [{ id: "c", project: "P", total: 500, received: 250 }];
    expect(C.migrateIncome(modern, idGen)).toEqual(modern);
  });
  it("handles empty / undefined", () => {
    expect(C.migrateIncome(undefined)).toEqual([]);
    expect(C.migrateIncome([])).toEqual([]);
  });
});

describe("migrateTrusts", () => {
  const idGen = () => "fixedid";
  it("converts old units + navPerUnit to a fund with one investment", () => {
    const out = C.migrateTrusts([{ id: "x", name: "F", units: 100, navPerUnit: 50 }], idGen);
    expect(out[0].currentNav).toBe(50);
    expect(out[0].investments).toHaveLength(1);
    expect(out[0].investments[0].amount).toBe(5000);
    expect(out[0].investments[0].units).toBe(100);
    // no phantom gain immediately after migration
    expect(C.trustGain(out[0])).toBe(0);
  });
  it("old fund with zero units becomes empty investments", () => {
    const out = C.migrateTrusts([{ id: "y", name: "F", units: 0, navPerUnit: 50 }], idGen);
    expect(out[0].investments).toEqual([]);
  });
  it("leaves already-migrated funds untouched (idempotent)", () => {
    const modern = [{ id: "z", name: "F", currentNav: 30, investments: [{ amount: 100, nav: 30, units: 100 / 30 }] }];
    expect(C.migrateTrusts(modern, idGen)).toEqual(modern);
  });
  it("handles empty / undefined", () => {
    expect(C.migrateTrusts(undefined)).toEqual([]);
  });
});

describe("migrateAccounts", () => {
  const idGen = () => "fixedid";
  it("converts bankAccounts to accounts (balance -> opening) and seeds cash", () => {
    const out = C.migrateAccounts([{ id: "x", name: "Salary", bank: "ComBank", balance: 5000 }], undefined, idGen);
    const bank = out.find((a) => a.type === "bank");
    expect(bank).toMatchObject({ id: "x", name: "Salary", institution: "ComBank", opening: 5000, archived: false });
    expect(out.some((a) => a.type === "cash")).toBe(true);
  });
  it("seeds a cash account for a fresh empty app", () => {
    const out = C.migrateAccounts([], [], idGen);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("cash");
  });
  it("idempotent: keeps existing accounts, no duplicate cash", () => {
    const existing = [
      { id: "x", name: "Salary", type: "bank", institution: "ComBank", opening: 5000, archived: false },
      { id: "c", name: "Cash in hand", type: "cash", institution: "", opening: 0, archived: false },
    ];
    expect(C.migrateAccounts([], existing, idGen)).toEqual(existing);
  });
});

describe("migrateLoans", () => {
  const idGen = () => "fixedid";
  it("adds direction (default lent) and folds repaid into a seed txn", () => {
    const { loans, txns } = C.migrateLoans(
      [{ id: "l1", person: "K", principal: 25000, repaid: 10000, date: "2026-01-01" }],
      idGen
    );
    expect(loans[0].direction).toBe("lent");
    expect(loans[0].repaid).toBeUndefined();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      type: "loan_repaid", amount: 10000, from: "ext:loan", to: "ext:opening",
      link: { kind: "loan", id: "l1" },
    });
    // outstanding after migration == before (25000 − 10000)
    expect(C.loanOutstandingOne(loans[0], txns)).toBe(15000);
  });
  it("no seed txn when repaid is 0", () => {
    expect(C.migrateLoans([{ id: "l2", principal: 5000, repaid: 0 }], idGen).txns).toHaveLength(0);
  });
  it("migrates a borrowed loan's repaid into a debt_repaid txn", () => {
    const { loans, txns } = C.migrateLoans(
      [{ id: "d1", person: "N", principal: 30000, repaid: 5000, direction: "borrowed", date: "2026-01-01" }],
      idGen
    );
    expect(loans[0].direction).toBe("borrowed");
    expect(loans[0].repaid).toBeUndefined();
    expect(txns[0]).toMatchObject({
      type: "debt_repaid", amount: 5000, from: "ext:opening", to: "ext:debt",
      link: { kind: "debt", id: "d1" },
    });
    expect(C.loanOutstandingOne(loans[0], txns)).toBe(25000);
  });
  it("idempotent: re-running migrated loans emits no new txns", () => {
    const once = C.migrateLoans([{ id: "l1", principal: 25000, repaid: 10000 }], idGen);
    const twice = C.migrateLoans(once.loans, idGen);
    expect(twice.txns).toHaveLength(0);
    expect(twice.loans).toEqual(once.loans);
  });
});

describe("migrateIncomeReceived", () => {
  const idGen = () => "fixedid";
  it("folds received into a seed income txn and strips received", () => {
    const { incomes, txns } = C.migrateIncomeReceived(
      [{ id: "i1", project: "P", total: 80000, received: 65000, date: "2026-02-01" }],
      idGen
    );
    expect(incomes[0].received).toBeUndefined();
    expect(txns[0]).toMatchObject({
      type: "income", amount: 65000, from: "ext:income", to: "ext:opening",
      link: { kind: "income", id: "i1" },
    });
    expect(C.incomeReceivedOne(incomes[0], txns)).toBe(65000);
  });
  it("caps the seed amount at total", () => {
    expect(C.migrateIncomeReceived([{ id: "i2", total: 100, received: 500 }], idGen).txns[0].amount).toBe(100);
  });
  it("idempotent: re-running emits nothing", () => {
    const once = C.migrateIncomeReceived([{ id: "i1", total: 80000, received: 65000 }], idGen);
    const twice = C.migrateIncomeReceived(once.incomes, idGen);
    expect(twice.txns).toHaveLength(0);
    expect(twice.incomes).toEqual(once.incomes);
  });
});

describe("migrateCategories", () => {
  it("seeds defaults when empty/undefined", () => {
    expect(C.migrateCategories(undefined)).toEqual(C.DEFAULT_CATEGORIES);
    expect(C.migrateCategories([])).toEqual(C.DEFAULT_CATEGORIES);
  });
  it("keeps existing categories", () => {
    expect(C.migrateCategories(["Food", "Custom"])).toEqual(["Food", "Custom"]);
  });
});

describe("reports / trends", () => {
  const accounts = [
    { id: "boc", type: "bank", opening: 1000 },
    { id: "cash", type: "cash", opening: 0 },
  ];
  const txns = [
    { date: "2026-01-15", type: "income", amount: 500, from: "ext:income", to: "boc" },
    { date: "2026-01-20", type: "expense", amount: 200, from: "boc", to: "ext:expense" },
    { date: "2026-02-10", type: "income", amount: 300, from: "ext:income", to: "boc" },
    { date: "2026-02-15", type: "lend", amount: 400, from: "boc", to: "ext:loan", link: { kind: "loan", id: "l1" } },
    { date: "2026-02-20", type: "transfer", amount: 100, from: "boc", to: "cash" },
    { date: "2026-03-05", type: "expense", amount: 100, from: "cash", to: "ext:expense" },
  ];
  const months = C.monthsBetween("2026-01", "2026-03");

  it("monthsBetween: span, year boundary, single, inverted, empty", () => {
    expect(C.monthsBetween("2026-01", "2026-03")).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(C.monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(C.monthsBetween("2026-05", "2026-05")).toEqual(["2026-05"]);
    expect(C.monthsBetween("2026-05", "2026-01")).toEqual(["2026-05"]); // inverted → graceful
    expect(C.monthsBetween(null, "2026-01")).toEqual([]);
  });
  it("monthlyTotals zero-fills, respects predicate + order", () => {
    expect(C.monthlyTotals(txns, (t) => t.type === "income", months)).toEqual([
      { month: "2026-01", total: 500 }, { month: "2026-02", total: 300 }, { month: "2026-03", total: 0 },
    ]);
  });
  it("incomeVsExpenseByMonth aligns the two series", () => {
    expect(C.incomeVsExpenseByMonth(txns, months)).toEqual([
      { month: "2026-01", income: 500, expense: 200 },
      { month: "2026-02", income: 300, expense: 0 },
      { month: "2026-03", income: 0, expense: 100 },
    ]);
  });
  it("assetsAsOf applies a date ceiling", () => {
    expect(C.assetsAsOf(accounts, txns, "2026-01-31")).toBe(1300);
    expect(C.assetsAsOf(accounts, txns, "2026-12-31")).toBe(C.assetTotal(accounts, txns));
  });
  it("assetsTrend = running month-end net assets (final == live total)", () => {
    expect(C.assetsTrend(accounts, txns, months)).toEqual([
      { month: "2026-01", assets: 1300 },
      { month: "2026-02", assets: 1200 },
      { month: "2026-03", assets: 1100 },
    ]);
  });
  it("cashFlow = income − expense, excludes lend/transfer, respects period", () => {
    expect(C.cashFlow(txns)).toEqual({ inflow: 800, outflow: 300, net: 500 });
    expect(C.cashFlow(txns, { from: "2026-02-01", to: "2026-02-28" })).toEqual({ inflow: 300, outflow: 0, net: 300 });
  });
});
