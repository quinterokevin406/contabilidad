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
    expect(plan.nominalInterest.toString()).toBe("960000");
  });

  it("deja la cuota redonda que el prestamista dice en voz alta", () => {
    // 1.960.000 ÷ 6 = 326.666,67 → 326.700 hacia ARRIBA, al cien.
    expect(plan.installment.toString()).toBe("326700");
  });

  it("todas las cuotas son iguales, también la última", () => {
    for (const cuota of plan.schedule) {
      expect(cuota.amount.toString()).toBe("326700");
    }
  });

  it("el total es lo que suman las seis cuotas", () => {
    expect(plan.totalRepaid.toString()).toBe("1960200");
    const total = plan.schedule.reduce(
      (sum, cuota) => sum.plus(cuota.amount),
      Money.zero(),
    );
    expect(total.toString()).toBe("1960200");
  });

  it("muestra cuánto agregó el redondeo, sin esconderlo", () => {
    // Seis cuotas de 326.700 recogen 200 más que los 960.000 de la tasa sola.
    expect(plan.roundingGain.toString()).toBe("200");
    expect(plan.totalInterest.toString()).toBe("960200");
  });

  it("nunca redondea para abajo", () => {
    const exacta = 1960000 / 6;
    expect(Number(plan.installment.toString())).toBeGreaterThanOrEqual(exacta);
  });

  it("entrega seis cuotas", () => {
    expect(plan.schedule).toHaveLength(6);
  });
});

describe("cómo se reparte cada cuota", () => {
  const plan = planFixedInstallments(caso);

  it("el capital de cada cuota es parejo", () => {
    // 1.000.000 ÷ 6 = 166.666,67 → 166.600 al cien, y la última absorbe.
    expect(plan.schedule[0]!.principal.toString()).toBe("166600");
    expect(plan.schedule[3]!.principal.toString()).toBe("166600");
  });

  it("el interés de cada cuota es lo que sobra del pago", () => {
    expect(plan.schedule[0]!.interest.toString()).toBe("160100");
  });

  it("la suma de los intereses da el interés realmente cobrado", () => {
    const interes = plan.schedule.reduce(
      (sum, c) => sum.plus(c.interest),
      Money.zero(),
    );
    expect(interes.toString()).toBe("960200");
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
  it("al peso sube apenas lo necesario", () => {
    const plan = planFixedInstallments({ ...caso, installmentQuantum: "1" });
    expect(plan.installment.toString()).toBe("326667");
    expect(plan.roundingGain.toString()).toBe("2");
  });

  it("al mil sube más", () => {
    const plan = planFixedInstallments({ ...caso, installmentQuantum: "1000" });
    expect(plan.installment.toString()).toBe("327000");
    expect(plan.roundingGain.toString()).toBe("2000");
  });

  it("ningún redondeo cobra menos que la tasa pactada", () => {
    for (const quantum of ["1", "100", "1000", "10000"]) {
      const plan = planFixedInstallments({ ...caso, installmentQuantum: quantum });
      expect(plan.roundingGain.isNegative()).toBe(false);
      expect(plan.totalRepaid.lessThan("1960000")).toBe(false);
    }
  });

  it("el capital devuelto es siempre el prestado, no importa el redondeo", () => {
    for (const quantum of ["1", "100", "1000", "10000"]) {
      const plan = planFixedInstallments({ ...caso, installmentQuantum: quantum });
      const capital = plan.schedule.reduce(
        (sum, c) => sum.plus(c.principal),
        Money.zero(),
      );
      expect(capital.toString()).toBe("1000000");
    }
  });
});

describe("casos de borde", () => {
  it("una sola cuota paga todo de una vez", () => {
    const plan = planFixedInstallments({ ...caso, periods: 1 });
    expect(plan.schedule).toHaveLength(1);
    expect(plan.schedule[0]!.amount.toString()).toBe("1160000");
    expect(plan.schedule[0]!.principal.toString()).toBe("1000000");
    expect(plan.schedule[0]!.interest.toString()).toBe("160000");
  });

  it("sin tasa, lo único que se cobra de más es el redondeo", () => {
    // 1.000.000 ÷ 6 = 166.666,67 → 166.700 al cien. Seis de esas recogen 200
    // más que el capital. Con "hacia arriba, nunca hacia abajo" eso es
    // inevitable, y por eso el plan lo muestra en vez de esconderlo.
    const plan = planFixedInstallments({ ...caso, ratePercent: "0" });
    expect(plan.nominalInterest.toString()).toBe("0");
    expect(plan.roundingGain.toString()).toBe("200");
    expect(plan.totalRepaid.toString()).toBe("1000200");
  });

  it("al peso, sin tasa, casi no hay diferencia", () => {
    const plan = planFixedInstallments({
      ...caso,
      ratePercent: "0",
      installmentQuantum: "1",
    });
    expect(plan.roundingGain.toString()).toBe("2");
  });

  it("rechaza un monto de cero", () => {
    expect(() => planFixedInstallments({ ...caso, principal: "0" })).toThrow();
  });

  it("rechaza un plazo de cero cuotas", () => {
    expect(() => planFixedInstallments({ ...caso, periods: 0 })).toThrow();
  });

  it("rechaza un redondeo más grande que la cuota", () => {
    // Redondear al millón convertiría una cuota de 326.667 en 1.000.000, y el
    // cliente terminaría pagando seis millones por un préstamo de uno.
    expect(() =>
      planFixedInstallments({ ...caso, installmentQuantum: "1000000" }),
    ).toThrow(/más grande que la cuota/);
  });

  it("acepta un redondeo apenas por debajo de la cuota", () => {
    const plan = planFixedInstallments({ ...caso, installmentQuantum: "100000" });
    expect(plan.installment.toString()).toBe("400000");
  });
});

describe("saldo según el contrato", () => {
  const plan = planFixedInstallments(caso);

  it("arranca en el total pactado", () => {
    expect(outstandingByContract(plan, "0").toString()).toBe("1960200");
  });

  it("baja con cada pago", () => {
    expect(outstandingByContract(plan, "326700").toString()).toBe("1633500");
  });

  it("nunca queda en negativo si pagan de más", () => {
    expect(outstandingByContract(plan, "2000000").toString()).toBe("0");
  });
});
