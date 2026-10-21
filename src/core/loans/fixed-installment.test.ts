import { describe, expect, it } from "vitest";

import { Money } from "@/core/money/money";

import {
  outstandingByContract,
  planFixedInstallments,
  type FixedInstallmentTerms,
} from "./fixed-installment";

/** The case the lender described, in their own numbers. */
const caso: FixedInstallmentTerms = {
  principal: "1000000",
  ratePercent: "16",
  periods: 6,
  installmentQuantum: "100",
  roundingMode: "HALF_UP",
};

describe("el ejemplo del prestamista", () => {
  const plan = planFixedInstallments(caso);

  it("calcula el interés sobre el capital original, no sobre el saldo", () => {
    // 1.000.000 × 16% × 6 = 960.000. Abonar capital no lo reduce: se fijó el
    // día que se escribió el préstamo.
    expect(plan.totalInterest.toString()).toBe("960000");
  });

  it("suma capital e interés para el total a pagar", () => {
    expect(plan.totalRepaid.toString()).toBe("1960000");
  });

  it("deja una cuota redondeada al cien", () => {
    // 1.960.000 ÷ 6 = 326.666,67 → 326.600 hacia abajo, al cien.
    expect(plan.installment.toString()).toBe("326600");
  });

  it("acomoda el resto en la última cuota, sin cobrar de más", () => {
    // Cinco de 326.600 son 1.633.000; la última completa los 1.960.000.
    expect(plan.lastInstallment.toString()).toBe("327000");
  });

  it("las seis cuotas suman EXACTAMENTE lo pactado", () => {
    const total = plan.schedule.reduce(
      (sum, cuota) => sum.plus(cuota.amount),
      Money.zero(),
    );
    expect(total.toString()).toBe("1960000");
  });

  it("entrega seis cuotas", () => {
    expect(plan.schedule).toHaveLength(6);
  });
});

describe("cómo se reparte cada cuota", () => {
  const plan = planFixedInstallments(caso);

  it("el interés de cada cuota es parejo", () => {
    // 160.000 por período, porque la tasa nunca miró el saldo.
    expect(plan.schedule[0]!.interest.toString()).toBe("160000");
    expect(plan.schedule[3]!.interest.toString()).toBe("160000");
  });

  it("el capital de cada cuota es lo que queda del pago", () => {
    expect(plan.schedule[0]!.principal.toString()).toBe("166600");
  });

  it("la suma de los intereses da el interés pactado", () => {
    const interes = plan.schedule.reduce(
      (sum, c) => sum.plus(c.interest),
      Money.zero(),
    );
    expect(interes.toString()).toBe("960000");
  });

  it("la suma de los capitales devuelve el préstamo completo", () => {
    // Si esto no diera exacto, el prestamista recuperaría más o menos capital
    // del que entregó, y la cartera quedaría mal para siempre.
    const capital = plan.schedule.reduce(
      (sum, c) => sum.plus(c.principal),
      Money.zero(),
    );
    expect(capital.toString()).toBe("1000000");
  });

  it("el saldo de capital llega a cero en la última cuota", () => {
    expect(plan.schedule[5]!.principalRemaining.toString()).toBe("0");
  });

  it("el saldo de capital baja parejo y nunca sube", () => {
    let anterior = Money.of("1000000");
    for (const cuota of plan.schedule) {
      expect(cuota.principalRemaining.lessThan(anterior)).toBe(true);
      anterior = cuota.principalRemaining;
    }
  });
});

describe("otros redondeos del mismo préstamo", () => {
  it("al peso reparte casi parejo", () => {
    const plan = planFixedInstallments({ ...caso, installmentQuantum: "1" });
    expect(plan.installment.toString()).toBe("326666");
    expect(plan.lastInstallment.toString()).toBe("326670");
  });

  it("al mil deja una última cuota más alta", () => {
    const plan = planFixedInstallments({ ...caso, installmentQuantum: "1000" });
    expect(plan.installment.toString()).toBe("326000");
    expect(plan.lastInstallment.toString()).toBe("330000");
  });

  it("cualquiera sea el redondeo, el total pactado no se mueve", () => {
    for (const quantum of ["1", "100", "1000", "10000"]) {
      const plan = planFixedInstallments({ ...caso, installmentQuantum: quantum });
      const total = plan.schedule.reduce(
        (sum, c) => sum.plus(c.amount),
        Money.zero(),
      );
      expect(total.toString()).toBe("1960000");
    }
  });
});

describe("casos de borde", () => {
  it("una sola cuota paga todo de una vez", () => {
    const plan = planFixedInstallments({ ...caso, periods: 1 });
    expect(plan.schedule).toHaveLength(1);
    expect(plan.schedule[0]!.amount.toString()).toBe("1160000");
    expect(plan.schedule[0]!.interest.toString()).toBe("160000");
    expect(plan.schedule[0]!.principal.toString()).toBe("1000000");
  });

  it("sin interés, las cuotas solo devuelven el capital", () => {
    const plan = planFixedInstallments({ ...caso, ratePercent: "0" });
    expect(plan.totalInterest.toString()).toBe("0");
    expect(plan.totalRepaid.toString()).toBe("1000000");
  });

  it("rechaza un monto de cero", () => {
    expect(() => planFixedInstallments({ ...caso, principal: "0" })).toThrow();
  });

  it("rechaza un plazo de cero cuotas", () => {
    expect(() => planFixedInstallments({ ...caso, periods: 0 })).toThrow();
  });

  it("rechaza un redondeo que haga desaparecer la cuota", () => {
    expect(() =>
      planFixedInstallments({ ...caso, installmentQuantum: "10000000" }),
    ).toThrow();
  });
});

describe("saldo según el contrato", () => {
  const plan = planFixedInstallments(caso);

  it("arranca en el total pactado", () => {
    expect(outstandingByContract(plan, "0").toString()).toBe("1960000");
  });

  it("baja con cada pago", () => {
    expect(outstandingByContract(plan, "326600").toString()).toBe("1633400");
  });

  it("nunca queda en negativo si pagan de más", () => {
    expect(outstandingByContract(plan, "2000000").toString()).toBe("0");
  });
});
