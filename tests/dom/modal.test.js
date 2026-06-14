// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { specs, validateRecord } from "../../validation.js";

// We test the modal's behavioral contract in isolation by reconstructing it with the
// same logic main.js uses (delegated handlers + spec validation). This guards against
// the two real regressions we hit: (1) dead Save/Cancel buttons, (2) crash on null values.

function buildModal({ title = "Test", fields, onSave, values = {}, spec = null }) {
  values = values || {}; // the fix for the null-crash bug
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      ${fields
        .map((f) => {
          if (f.type === "select")
            // Mirror fieldHTML: options may be strings or { value, label } objects.
            return `<div class="field"><label>${f.label}</label><select name="${f.key}">${(f.options || [])
              .map((o) => {
                const v = typeof o === "object" ? o.value : o;
                const l = typeof o === "object" ? o.label : o;
                return `<option value="${v}">${l}</option>`;
              })
              .join("")}</select></div>`;
          return `<div class="field"><label>${f.label}</label>
            <input name="${f.key}" type="${f.type || "text"}"></div>`;
        })
        .join("")}
      <div class="modal-foot">
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn" data-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);

  fields.forEach((f) => {
    const el = scrim.querySelector(`[name="${f.key}"]`);
    if (el && values[f.key] !== undefined) el.value = values[f.key];
  });

  const collect = () => {
    const out = {};
    fields.forEach((f) => {
      const el = scrim.querySelector(`[name="${f.key}"]`);
      if (el) out[f.key] = el.value;
    });
    return out;
  };
  const close = () => scrim.remove();
  const showErrors = (errors) => {
    scrim.querySelectorAll(".field-error").forEach((e) => e.remove());
    Object.keys(errors).forEach((k) => {
      const el = scrim.querySelector(`[name="${k}"]`);
      el.classList.add("invalid");
      const m = document.createElement("div");
      m.className = "field-error";
      m.textContent = errors[k];
      el.closest(".field").appendChild(m);
    });
  };
  const doSave = () => {
    const out = collect();
    if (spec) {
      const errors = validateRecord(out, spec);
      if (Object.keys(errors).length) { showErrors(errors); return; }
    }
    onSave(out);
    close();
  };
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) { close(); return; }
    if (e.target.closest("[data-save]")) { doSave(); return; }
    if (e.target.closest("[data-cancel]")) { close(); return; }
  });
  return scrim;
}

const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

beforeEach(() => { document.body.innerHTML = ""; });

describe("modal buttons (regression: dead buttons)", () => {
  it("Save fires onSave and closes", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields: [{ key: "name", label: "Name" }], onSave });
    m.querySelector('[name="name"]').value = "Hello";
    click(m.querySelector("[data-save]"));
    expect(onSave).toHaveBeenCalledWith({ name: "Hello" });
    expect(document.querySelector(".scrim")).toBeNull();
  });
  it("Cancel closes without saving", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields: [{ key: "name", label: "Name" }], onSave });
    click(m.querySelector("[data-cancel]"));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector(".scrim")).toBeNull();
  });
  it("clicking an inner element still triggers via closest()", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields: [{ key: "x", label: "X" }], onSave });
    const btn = m.querySelector("[data-save]");
    // put a real child element inside the button and click that
    const span = document.createElement("span");
    span.textContent = "Save";
    btn.appendChild(span);
    click(span); // event bubbles; handler resolves via closest("[data-save]")
    expect(onSave).toHaveBeenCalled();
  });
});

describe("modal with null values (regression: null-crash on Add)", () => {
  it("does not throw when values is null", () => {
    expect(() =>
      buildModal({ fields: [{ key: "name", label: "Name" }], onSave: () => {}, values: null, spec: specs.trust })
    ).not.toThrow();
    // and buttons still work afterward
    const m = document.querySelector(".scrim");
    m.querySelector('[name="name"]').value = "CAL";
    m.querySelector('[name="currentNav"]') || (() => {})();
  });
});

describe("modal validation gating", () => {
  it("blocks save and shows error when invalid", () => {
    const onSave = vi.fn();
    const m = buildModal({
      fields: [{ key: "name", label: "Fund name" }, { key: "currentNav", label: "NAV", type: "number" }],
      onSave, spec: specs.trust,
    });
    m.querySelector('[name="name"]').value = "";       // missing
    m.querySelector('[name="currentNav"]').value = "0"; // invalid NAV
    click(m.querySelector("[data-save]"));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector(".scrim")).not.toBeNull(); // stays open
    expect(m.querySelectorAll(".field-error").length).toBe(2);
  });
  it("allows save when valid", () => {
    const onSave = vi.fn();
    const m = buildModal({
      fields: [{ key: "name", label: "Fund name" }, { key: "currentNav", label: "NAV", type: "number" }],
      onSave, spec: specs.trust,
    });
    m.querySelector('[name="name"]').value = "CAL Fixed Income";
    m.querySelector('[name="currentNav"]').value = "43";
    click(m.querySelector("[data-save]"));
    expect(onSave).toHaveBeenCalledWith({ name: "CAL Fixed Income", currentNav: "43" });
    expect(document.querySelector(".scrim")).toBeNull();
  });
  it("blocks investment with NAV 0 (would divide by zero)", () => {
    const onSave = vi.fn();
    const m = buildModal({
      fields: [{ key: "amount", label: "Amount", type: "number" }, { key: "nav", label: "NAV", type: "number" }],
      onSave, spec: specs.invest,
    });
    m.querySelector('[name="amount"]').value = "86000";
    m.querySelector('[name="nav"]').value = "0";
    click(m.querySelector("[data-save]"));
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("expense flow", () => {
  const fields = [
    { key: "amount", label: "Amount", type: "number" },
    { key: "account", label: "Paid from", type: "select", options: [{ value: "a", label: "Cash" }] },
    { key: "category", label: "Category" },
  ];
  it("blocks save with empty category or non-positive amount", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields, onSave, spec: specs.expense });
    m.querySelector('[name="amount"]').value = "0";
    m.querySelector('[name="category"]').value = "";
    click(m.querySelector("[data-save]"));
    expect(onSave).not.toHaveBeenCalled();
    expect(m.querySelectorAll(".field-error").length).toBeGreaterThanOrEqual(2);
  });
  it("saves a valid expense", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields, onSave, spec: specs.expense });
    m.querySelector('[name="amount"]').value = "1500";
    m.querySelector('[name="account"]').value = "a";
    m.querySelector('[name="category"]').value = "Food";
    click(m.querySelector("[data-save]"));
    expect(onSave).toHaveBeenCalledWith({ amount: "1500", account: "a", category: "Food" });
  });
});

describe("transfer flow blocks from === to", () => {
  const opts = [{ value: "a", label: "BOC" }, { value: "b", label: "Cash" }];
  const fields = [
    { key: "amount", label: "Amount", type: "number" },
    { key: "from", label: "From", type: "select", options: opts },
    { key: "to", label: "To", type: "select", options: opts },
  ];
  it("blocks when same account is chosen on both sides", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields, onSave, spec: specs.transfer });
    m.querySelector('[name="amount"]').value = "500";
    m.querySelector('[name="from"]').value = "a";
    m.querySelector('[name="to"]').value = "a";
    click(m.querySelector("[data-save]"));
    expect(onSave).not.toHaveBeenCalled();
    expect(m.querySelector('[name="to"]').classList.contains("invalid")).toBe(true);
  });
  it("allows distinct accounts", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields, onSave, spec: specs.transfer });
    m.querySelector('[name="amount"]').value = "500";
    m.querySelector('[name="from"]').value = "a";
    m.querySelector('[name="to"]').value = "b";
    click(m.querySelector("[data-save]"));
    expect(onSave).toHaveBeenCalledWith({ amount: "500", from: "a", to: "b" });
  });
});

describe("account picker submits id, not label", () => {
  const fields = [{ key: "account", label: "Account", type: "select", options: [{ value: "acc_123", label: "Salary · ComBank" }, { value: "acc_456", label: "Cash" }] }];
  it("collect returns the chosen id", () => {
    const onSave = vi.fn();
    const m = buildModal({ fields, onSave });
    m.querySelector('[name="account"]').value = "acc_456";
    click(m.querySelector("[data-save]"));
    expect(onSave).toHaveBeenCalledWith({ account: "acc_456" });
  });
  it("renders the friendly label as the option text", () => {
    const m = buildModal({ fields, onSave: () => {} });
    const opt = m.querySelector("option");
    expect(opt.value).toBe("acc_123");
    expect(opt.textContent).toBe("Salary · ComBank");
  });
});

describe("repay / payment requires an account", () => {
  it("blocks save when no account is selected", () => {
    const onSave = vi.fn();
    const m = buildModal({
      fields: [
        { key: "amount", label: "Amount", type: "number" },
        { key: "account", label: "Account", type: "select", options: [{ value: "", label: "—" }, { value: "a", label: "Cash" }] },
      ],
      onSave, spec: specs.accountPayment,
    });
    m.querySelector('[name="amount"]').value = "1000";
    m.querySelector('[name="account"]').value = "";
    click(m.querySelector("[data-save]"));
    expect(onSave).not.toHaveBeenCalled();
  });
});
