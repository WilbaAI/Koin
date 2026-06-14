import { describe, it, expect } from "vitest";
import {
  toNum, required, maxLen, money, price, optionalDate, all,
  notExceeding, distinctFrom, when, validateRecord, specs,
} from "../validation.js";

describe("toNum", () => {
  it("parses numbers and number-strings", () => {
    expect(toNum("42")).toBe(42);
    expect(toNum("3.14")).toBeCloseTo(3.14);
    expect(toNum(10)).toBe(10);
  });
  it("returns NaN for empty / null / garbage", () => {
    expect(toNum("")).toBeNaN();
    expect(toNum(null)).toBeNaN();
    expect(toNum(undefined)).toBeNaN();
    expect(toNum("abc")).toBeNaN();
  });
});

describe("required", () => {
  const r = required("Name");
  it("passes non-empty", () => expect(r("Kasun")).toBeNull());
  it("fails empty / whitespace", () => {
    expect(r("")).toMatch(/required/);
    expect(r("   ")).toMatch(/required/);
    expect(r(undefined)).toMatch(/required/);
  });
});

describe("maxLen", () => {
  const m = maxLen("Note", 5);
  it("passes short", () => expect(m("abc")).toBeNull());
  it("passes empty (optional)", () => expect(m("")).toBeNull());
  it("fails long", () => expect(m("abcdef")).toMatch(/5 characters/));
});

describe("money", () => {
  it("rejects non-numbers", () => {
    expect(money("Amount")("abc")).toMatch(/must be a number/);
    expect(money("Amount")("")).toMatch(/must be a number/);
  });
  it("rejects negatives", () => {
    expect(money("Amount")("-5")).toMatch(/can't be negative/);
  });
  it("allows zero by default", () => {
    expect(money("Balance")("0")).toBeNull();
  });
  it("rejects zero when positive required", () => {
    expect(money("Amount", { positive: true })("0")).toMatch(/greater than zero/);
  });
  it("accepts valid positive", () => {
    expect(money("Amount", { positive: true })("100")).toBeNull();
  });
  it("rejects absurdly large values", () => {
    expect(money("Amount")("1e20")).toMatch(/unrealistically large/);
  });
});

describe("price", () => {
  it("must be strictly positive (NAV 0 is invalid)", () => {
    expect(price("NAV")("0")).toMatch(/greater than zero/);
    expect(price("NAV")("43")).toBeNull();
    expect(price("NAV")("-1")).toMatch(/negative/);
  });
});

describe("optionalDate", () => {
  it("allows empty", () => expect(optionalDate("Date")("")).toBeNull());
  it("accepts ISO date", () => expect(optionalDate("Date")("2026-06-14")).toBeNull());
  it("rejects malformed", () => {
    expect(optionalDate("Date")("14/06/2026")).toMatch(/valid date/);
    expect(optionalDate("Date")("2026-13-40")).toMatch(/valid date/);
  });
});

describe("all (composition)", () => {
  const v = all(required("X"), maxLen("X", 3));
  it("returns first failing rule", () => {
    expect(v("")).toMatch(/required/);
    expect(v("abcd")).toMatch(/3 characters/);
    expect(v("ab")).toBeNull();
  });
});

describe("notExceeding (cross-field)", () => {
  const v = notExceeding("Repaid", "amount lent", "principal");
  it("passes when within cap", () => {
    expect(v("50", { principal: "100" })).toBeNull();
    expect(v("100", { principal: "100" })).toBeNull();
  });
  it("fails when over cap", () => {
    expect(v("150", { principal: "100" })).toMatch(/can't be more than/);
  });
  it("ignores when cap missing", () => {
    expect(v("150", {})).toBeNull();
  });
});

describe("validateRecord with real specs", () => {
  it("valid loan passes", () => {
    const errs = validateRecord(
      { person: "Kasun", principal: "25000", repaid: "10000", date: "2026-04-02", due: "", note: "" },
      specs.loan
    );
    expect(errs).toEqual({});
  });
  it("loan with empty person fails on person", () => {
    const errs = validateRecord({ person: "", principal: "100" }, specs.loan);
    expect(errs.person).toMatch(/required/);
  });
  it("loan with empty name and zero principal fails both", () => {
    const errs = validateRecord({ person: "", principal: "0", repaid: "0" }, specs.loan);
    expect(errs.person).toMatch(/required/);
    expect(errs.principal).toMatch(/greater than zero/);
  });
  it("valid income passes", () => {
    const errs = validateRecord(
      { project: "Logo", source: "ABC", total: "65000", received: "0" },
      specs.income
    );
    expect(errs).toEqual({});
  });
  it("income with zero total fails", () => {
    const errs = validateRecord({ project: "P", total: "0" }, specs.income);
    expect(errs.total).toMatch(/greater than zero/);
  });
  it("valid bank passes; negative balance allowed (overdraft)", () => {
    expect(validateRecord({ name: "Salary", bank: "ComBank", balance: "100000" }, specs.bank)).toEqual({});
    // balance uses money() without positive, but still no negatives:
    expect(validateRecord({ name: "X", balance: "-5" }, specs.bank).balance).toMatch(/negative/);
  });
  it("valid trust passes; NAV 0 fails", () => {
    expect(validateRecord({ name: "CAL", currentNav: "43" }, specs.trust)).toEqual({});
    expect(validateRecord({ name: "CAL", currentNav: "0" }, specs.trust).currentNav).toMatch(/greater than zero/);
  });
  it("valid investment passes; NAV 0 fails (would divide by zero)", () => {
    expect(validateRecord({ amount: "86000", nav: "43", date: "2026-06-14" }, specs.invest)).toEqual({});
    expect(validateRecord({ amount: "86000", nav: "0" }, specs.invest).nav).toMatch(/greater than zero/);
  });
  it("payment must be positive", () => {
    expect(validateRecord({ amount: "0" }, specs.payment).amount).toMatch(/greater than zero/);
    expect(validateRecord({ amount: "500" }, specs.payment)).toEqual({});
  });
});

describe("distinctFrom (cross-field)", () => {
  const v = distinctFrom("To account", "from");
  it("passes when different", () => expect(v("b", { from: "a" })).toBeNull());
  it("fails when equal", () => expect(v("a", { from: "a" })).toMatch(/different account/));
  it("passes when either side missing", () => {
    expect(v("", { from: "a" })).toBeNull();
    expect(v("a", {})).toBeNull();
  });
});

describe("when (conditional rule)", () => {
  const v = when("type", "bank", required("Institution"));
  it("applies inner validator when condition matches", () =>
    expect(v("", { type: "bank" })).toMatch(/required/));
  it("skips inner validator otherwise", () => expect(v("", { type: "cash" })).toBeNull());
});

describe("ledger specs", () => {
  it("valid account passes; negative opening allowed (overdraft)", () => {
    expect(validateRecord({ name: "Wallet", type: "cash", institution: "", opening: "0" }, specs.account)).toEqual({});
    expect(validateRecord({ name: "Overdrawn", type: "bank", opening: "-5000" }, specs.account)).toEqual({});
  });
  it("account requires name and type", () => {
    const errs = validateRecord({ name: "", type: "", opening: "0" }, specs.account);
    expect(errs.name).toMatch(/required/);
    expect(errs.type).toMatch(/required/);
  });
  it("valid expense passes; missing category and account fail", () => {
    expect(validateRecord({ amount: "500", account: "boc", category: "Food" }, specs.expense)).toEqual({});
    const errs = validateRecord({ amount: "500", account: "", category: "" }, specs.expense);
    expect(errs.category).toMatch(/required/);
    expect(errs.account).toMatch(/required/);
  });
  it("transfer blocks from === to", () => {
    expect(validateRecord({ amount: "500", from: "a", to: "a" }, specs.transfer).to).toMatch(/different account/);
    expect(validateRecord({ amount: "500", from: "a", to: "b" }, specs.transfer)).toEqual({});
  });
  it("accountPayment needs a positive amount and an account", () => {
    expect(validateRecord({ amount: "0", account: "boc" }, specs.accountPayment).amount).toMatch(/greater than zero/);
    expect(validateRecord({ amount: "500", account: "" }, specs.accountPayment).account).toMatch(/required/);
    expect(validateRecord({ amount: "500", account: "boc" }, specs.accountPayment)).toEqual({});
  });
});
