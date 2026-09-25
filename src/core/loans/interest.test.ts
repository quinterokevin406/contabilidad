import { describe, expect, it } from "vitest";

import { Money } from "@/core/money/money";

import {
  computePeriodInterest,
  InterestError,
  projectSimpleInterest,
  resolveInterestBasis,
  reviewRate,
  type MoneyRule,
  type PeriodInterestInput,
} from "./interest";

/** Whole pesos, HALF_UP — the organization default. */
const COP: MoneyRule = { roundingMode: "HALF_UP", moneyQuantum: "1" };

describe("resolveInterestBasis is the whole difference between the two methods", () => {
  const state = {
    currentPrincipalBase: "1000000",
    outstandingPrincipal: "600000",
  };

  it("uses the original base, ignoring principal paid down", () => {
    expect(
      resolveInterestBasis("SIMPLE_ON_ORIGINAL_PRINCIPAL", state).toString(),
    ).toBe("1000000");
  });

  it("uses the current balance", () => {
    expect(
      resolveInterestBasis("SIMPLE_ON_OUTSTANDING_PRINCIPAL", state).toString(),
    ).toBe("600000");
  });
});

describe("the worked example from point 4 of the specification", () => {
  // Juan Pérez, $1.000.000, 20% monthly, simple interest on original principal.
  const input: PeriodInterestInput = {
    method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    principal: {
      currentPrincipalBase: "1000000",
      outstandingPrincipal: "1000000",
    },
    ratePercent: "20",
    money: COP,
  };

  it("charges $200.000 for one period", () => {
    const result = computePeriodInterest(input);
    expect(result.basis.toString()).toBe("1000000");
    expect(result.interest.toString()).toBe("200000");
  });

  it("accumulates linearly and never compounds", () => {
    // After 1, 2 and 3 unpaid periods the interest owed is 200k, 400k, 600k.
    // Compounding would give 200k, 440k, 728k -- which this must never produce.
    expect(projectSimpleInterest(input, 1).toString()).toBe("200000");
    expect(projectSimpleInterest(input, 2).toString()).toBe("400000");
    expect(projectSimpleInterest(input, 3).toString()).toBe("600000");
  });

  it("keeps the principal untouched across unpaid periods", () => {
    const principal = Money.of("1000000");
    expect(principal.plus(projectSimpleInterest(input, 1)).toString()).toBe("1200000");
    expect(principal.plus(projectSimpleInterest(input, 2)).toString()).toBe("1400000");
    expect(principal.plus(projectSimpleInterest(input, 3)).toString()).toBe("1600000");
  });

  it("does not change the periodic interest after a principal payment", () => {
    // $400.000 paid against capital. Under this method the next period still
    // charges 20% of the ORIGINAL base.
    const afterPrincipalPayment: PeriodInterestInput = {
      ...input,
      principal: {
        currentPrincipalBase: "1000000",
        outstandingPrincipal: "600000",
      },
    };
    expect(computePeriodInterest(afterPrincipalPayment).interest.toString()).toBe(
      "200000",
    );
  });
});

describe("interest on the outstanding balance (point 5B and point 15)", () => {
  const base: PeriodInterestInput = {
    method: "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
    principal: {
      currentPrincipalBase: "1000000",
      outstandingPrincipal: "1000000",
    },
    ratePercent: "20",
    money: COP,
  };

  it("charges the full balance while nothing has been paid down", () => {
    expect(computePeriodInterest(base).interest.toString()).toBe("200000");
  });

  it("charges the reduced balance after a $400.000 principal payment", () => {
    // Point 15: capital drops to $600.000, so the next period is 20% of that.
    const reduced: PeriodInterestInput = {
      ...base,
      principal: {
        currentPrincipalBase: "1000000",
        outstandingPrincipal: "600000",
      },
    };
    expect(computePeriodInterest(reduced).interest.toString()).toBe("120000");
  });

  it("charges nothing once the balance reaches zero", () => {
    const settled: PeriodInterestInput = {
      ...base,
      principal: { currentPrincipalBase: "1000000", outstandingPrincipal: "0" },
    };
    expect(computePeriodInterest(settled).interest.isZero()).toBe(true);
  });
});

describe("rounding is applied by the loan's own frozen rule", () => {
  const awkward: PeriodInterestInput = {
    method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    principal: {
      currentPrincipalBase: "1333333",
      outstandingPrincipal: "1333333",
    },
    ratePercent: "20",
    money: COP,
  };

  it("keeps the unrounded figure available for transparency", () => {
    const result = computePeriodInterest(awkward);
    expect(result.rawInterest.toString()).toBe("266666.6");
    expect(result.interest.toString()).toBe("266667");
  });

  it("honours a different rounding mode on a different loan", () => {
    const down = computePeriodInterest({
      ...awkward,
      money: { roundingMode: "DOWN", moneyQuantum: "1" },
    });
    expect(down.interest.toString()).toBe("266666");

    const banker = computePeriodInterest({
      ...awkward,
      money: { roundingMode: "HALF_EVEN", moneyQuantum: "1" },
    });
    // 266666.6 is not a tie, so HALF_EVEN rounds to nearest: 266667.
    expect(banker.interest.toString()).toBe("266667");
  });

  it("supports a centavo quantum if a deployment ever needs one", () => {
    const cents = computePeriodInterest({
      ...awkward,
      money: { roundingMode: "HALF_UP", moneyQuantum: "0.01" },
    });
    expect(cents.interest.toString()).toBe("266666.6");
  });
});

describe("fractional and small rates", () => {
  it("handles a weekly rate expressed with decimals", () => {
    const result = computePeriodInterest({
      method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
      principal: { currentPrincipalBase: "500000", outstandingPrincipal: "500000" },
      ratePercent: "2.5",
      money: COP,
    });
    expect(result.interest.toString()).toBe("12500");
  });

  it("accepts a zero rate", () => {
    const result = computePeriodInterest({
      method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
      principal: { currentPrincipalBase: "500000", outstandingPrincipal: "500000" },
      ratePercent: "0",
      money: COP,
    });
    expect(result.interest.isZero()).toBe(true);
  });
});

describe("validations from point 51", () => {
  it("refuses a negative rate", () => {
    expect(() =>
      computePeriodInterest({
        method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
        principal: {
          currentPrincipalBase: "1000000",
          outstandingPrincipal: "1000000",
        },
        ratePercent: "-5",
        money: COP,
      }),
    ).toThrow(InterestError);
  });

  it("refuses a negative principal basis", () => {
    expect(() =>
      computePeriodInterest({
        method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
        principal: {
          currentPrincipalBase: "-1000000",
          outstandingPrincipal: "-1000000",
        },
        ratePercent: "20",
        money: COP,
      }),
    ).toThrow(InterestError);
  });

  it("refuses a fractional period count in a projection", () => {
    const input: PeriodInterestInput = {
      method: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
      principal: {
        currentPrincipalBase: "1000000",
        outstandingPrincipal: "1000000",
      },
      ratePercent: "20",
      money: COP,
    };
    expect(() => projectSimpleInterest(input, 1.5)).toThrow(InterestError);
    expect(() => projectSimpleInterest(input, -1)).toThrow(InterestError);
    expect(projectSimpleInterest(input, 0).isZero()).toBe(true);
  });
});

describe("reviewRate is advisory only (point 60)", () => {
  it("stays silent when no threshold is configured", () => {
    const result = reviewRate("20", null, "Revisar límites legales.");
    expect(result.exceedsThreshold).toBe(false);
    expect(result.note).toBeNull();
  });

  it("flags a rate above the administrator's threshold and surfaces their note", () => {
    const result = reviewRate("25", "20", "Revisar límites legales aplicables.");
    expect(result.exceedsThreshold).toBe(true);
    expect(result.note).toBe("Revisar límites legales aplicables.");
  });

  it("does not flag a rate at or below the threshold", () => {
    expect(reviewRate("20", "20").exceedsThreshold).toBe(false);
    expect(reviewRate("19.99", "20").exceedsThreshold).toBe(false);
  });
});
