import { projectPeriod } from "@/core/loans/accrual";
import {
  planSettlement,
  quoteSettlement,
  type OpenPeriodPolicy,
  type SettlementQuote,
} from "@/core/loans/settlement";
import { Money, type MoneyInput } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { fromDb, rateFromDb, rateToDb, toDb } from "@/infra/db/money";

import {
  defaultCashAccountId,
  findIdempotentResult,
  nextSequenceNumber,
  recordAudit,
  recordCashMovement,
  recordIdempotencyKey,
  ServiceError,
  type Actor,
  type Tx,
} from "../shared";
import { accrueLoan, refreshLoanState, type ComplianceSettings } from "./accrue";

/**
 * Loan settlement (point 16).
 *
 * Two kinds:
 *
 * FULL_PAYMENT — the client pays the quoted total and the loan reaches zero.
 *
 * WRITE_OFF — the loan is closed for less than it owes, by decision of the
 * business. The uncollected PRINCIPAL is recorded as a bad-debt operating
 * expense, which is the treatment the owner chose and the one that keeps the
 * equity figure honest: equity is contributions + profit - withdrawals, so a
 * loss that never reached profit would leave equity overstating reality forever.
 *
 * That expense carries `affectsCash: false`. The money left the till when the
 * loan was disbursed; counting it again would understate the drawer.
 *
 * Uncollected INTEREST is waived on its period rows and costs nothing: profit
 * recognises interest when it is collected, so interest that never arrived never
 * entered profit and removing it changes no result.
 */

export interface SettlementQuoteInput {
  organizationId: string;
  loanId: string;
  asOf: CalendarDate;
  /** Overrides the policy frozen on the loan, for a negotiated settlement. */
  openPeriodPolicyOverride?: OpenPeriodPolicy | null;
  additionalCharges?: readonly { concept: string; amount: MoneyInput }[];
}

export interface LoanSettlementQuote {
  quote: SettlementQuote;
  loanCode: string;
  clientName: string;
  /** The open period that the quote charges for, when it charges for one. */
  openPeriod: {
    periodIndex: number;
    startsOn: CalendarDate;
    dueOn: CalendarDate;
    fullInterest: Money;
    principalBasis: Money;
    rateApplied: string;
  } | null;
}

/**
 * Prices a settlement without writing anything.
 *
 * Reads the loan's own frozen policy by default. An override is accepted for a
 * negotiated case, and whichever policy is actually applied is recorded on the
 * Settlement row so the quote can be reconstructed exactly as the client saw it.
 */
export async function quoteLoanSettlement(
  tx: Tx,
  input: SettlementQuoteInput,
): Promise<LoanSettlementQuote> {
  // Accrue first: a period that came due today is owed today, and quoting
  // without it would undercharge.
  await accrueLoan(tx, input.loanId, input.asOf);

  const loan = await tx.loan.findFirst({
    where: {
      id: input.loanId,
      organizationId: input.organizationId,
      lifecycle: "ACTIVE",
      archivedAt: null,
    },
    select: {
      id: true,
      code: true,
      outstandingPrincipal: true,
      currentPrincipalBase: true,
      ratePercent: true,
      periodicity: true,
      periodAnchor: true,
      customPeriodDays: true,
      interestMethod: true,
      roundingMode: true,
      moneyQuantum: true,
      openPeriodPolicy: true,
      scheduleAnchorOn: true,
      scheduleAnchorIndex: true,
      lastPeriodIndex: true,
      client: { select: { fullName: true } },
      periods: {
        where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
        select: {
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
        },
      },
    },
  });

  if (!loan) {
    throw new ServiceError("El préstamo no existe o ya está cerrado.");
  }

  const accruedInterestOutstanding = loan.periods.reduce(
    (acc, p) =>
      acc.plus(
        fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      ),
    Money.zero(),
  );

  const money = {
    roundingMode: loan.roundingMode,
    moneyQuantum: fromDb(loan.moneyQuantum),
  };

  const outstandingPrincipal = fromDb(loan.outstandingPrincipal);

  // The period in progress: a projection, never a stored row — until the
  // settlement decides to charge for it.
  const projection = projectPeriod(
    {
      anchorDueOn: fromPrismaDate(loan.scheduleAnchorOn),
      anchorIndex: loan.scheduleAnchorIndex,
      lastPeriodIndex: loan.lastPeriodIndex,
      schedule: {
        periodicity: loan.periodicity,
        anchor: loan.periodAnchor,
        customPeriodDays: loan.customPeriodDays,
      },
      interestMethod: loan.interestMethod,
      ratePercent: rateFromDb(loan.ratePercent),
      money,
      principal: {
        currentPrincipalBase: fromDb(loan.currentPrincipalBase),
        outstandingPrincipal,
      },
    },
    loan.lastPeriodIndex + 1,
  );

  const policy = input.openPeriodPolicyOverride ?? loan.openPeriodPolicy;

  const quote = quoteSettlement({
    principalOutstanding: outstandingPrincipal,
    accruedInterestOutstanding,
    openPeriod: {
      startsOn: projection.startsOn,
      dueOn: projection.dueOn,
      fullPeriodInterest: projection.interest,
    },
    openPeriodPolicy: policy,
    asOf: input.asOf,
    additionalCharges: input.additionalCharges,
    money,
  });

  return {
    quote,
    loanCode: loan.code,
    clientName: loan.client.fullName,
    openPeriod: quote.openPeriodCharge.isPositive()
      ? {
          periodIndex: loan.lastPeriodIndex + 1,
          startsOn: projection.startsOn,
          dueOn: projection.dueOn,
          fullInterest: projection.interest,
          principalBasis: projection.basis,
          rateApplied: loan.ratePercent.toFixed(),
        }
      : null,
  };
}

export interface SettleLoanInput extends SettlementQuoteInput {
  kind: "FULL_PAYMENT" | "WRITE_OFF";
  /** Cash actually received. Must equal the quoted total for a FULL_PAYMENT. */
  amountReceived: MoneyInput;
  /** Mandatory for a WRITE_OFF. */
  reason?: string | null;
  paymentMethodId?: string | null;
  notes?: string | null;
  actor: Actor;
  idempotencyKey?: string | null;
  cashAccountId?: string | null;
  settings: ComplianceSettings;
}

export interface SettleLoanResult {
  settlementId: string;
  /** Null when a write-off received no money at all. */
  paymentId: string | null;
  receiptNumber: string | null;
  total: Money;
  principalWrittenOff: Money;
  interestWaived: Money;
}

/**
 * Closes a loan that is being paid in full, atomically.
 *
 * When the quote charges for the period in progress, that period is materialized
 * here with the charge as its accrued interest. Creating the row is what gives
 * the money a destination: the interest allocation points at a real period, and
 * the settlement can be reconstructed line by line afterwards. Accruing it early
 * is a contractual event, not a restatement — the client chose to close, and the
 * loan's own frozen policy says the running period is charged.
 */
export async function settleLoan(
  tx: Tx,
  input: SettleLoanInput,
): Promise<SettleLoanResult> {
  const existing = await findIdempotentResult(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    throw new ServiceError(
      "Esta liquidación ya fue registrada. Actualizá el préstamo para verla.",
    );
  }

  const { quote, openPeriod } = await quoteLoanSettlement(tx, input);

  const received = Money.of(input.amountReceived);

  const plan = planSettlement({
    quote,
    amountReceived: received,
    kind: input.kind,
    reason: input.reason,
    settledOn: input.asOf,
  });

  const loan = await tx.loan.findFirstOrThrow({
    where: { id: input.loanId, organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      clientId: true,
      lastPeriodIndex: true,
      openPeriodPolicy: true,
      client: { select: { fullName: true } },
    },
  });

  // Materialize the running period when the settlement charges for it, so the
  // interest has a period row to be allocated against.
  let openPeriodId: string | null = null;

  if (openPeriod && quote.openPeriodCharge.isPositive()) {
    const created = await tx.loanPeriod.create({
      data: {
        organizationId: input.organizationId,
        loanId: loan.id,
        periodIndex: openPeriod.periodIndex,
        startsOn: toPrismaDate(openPeriod.startsOn),
        dueOn: toPrismaDate(openPeriod.dueOn),
        principalBasis: toDb(openPeriod.principalBasis),
        rateApplied: rateToDb(openPeriod.rateApplied),
        // The CHARGE, which under a prorated policy is less than a full period.
        interestAccrued: toDb(quote.openPeriodCharge),
        interestPaid: toDb(Money.zero()),
        interestWaived: toDb(Money.zero()),
        status: "PENDING",
        accruedAt: new Date(),
      },
      select: { id: true },
    });
    openPeriodId = created.id;

    await tx.loan.update({
      where: { id: loan.id },
      data: {
        lastPeriodIndex: openPeriod.periodIndex,
        lastAccruedAt: new Date(),
      },
    });
  }

  const openPeriods = await tx.loanPeriod.findMany({
    where: { loanId: loan.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    orderBy: { periodIndex: "asc" },
    select: {
      id: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
    },
  });

  // A write-off may receive nothing at all, and a payment of zero is not a
  // payment. The receipt is only created when money actually changed hands.
  let paymentId: string | null = null;
  let receiptNumber: string | null = null;

  if (received.isPositive()) {
    const receipt = await nextSequenceNumber(
      tx,
      input.organizationId,
      "PAYMENT",
      "REC",
    );
    receiptNumber = receipt.formatted;

    const payment = await tx.payment.create({
      data: {
        organizationId: input.organizationId,
        loanId: loan.id,
        clientId: loan.clientId,
        receiptNumber,
        amount: toDb(received),
        paidOn: toPrismaDate(input.asOf),
        paymentMethodId: input.paymentMethodId ?? null,
        manualAllocation: true,
        strategyApplied: "MANUAL_ONLY",
        status: "POSTED",
        notes:
          input.notes ??
          (input.kind === "WRITE_OFF" ? "Cierre con castigo" : "Liquidación total"),
        createdById: input.actor.userId,
      },
      select: { id: true },
    });
    paymentId = payment.id;
  }

  // Interest first, oldest period first — the same order the engine used to
  // build the plan, so the rows agree with the totals.
  let remainingInterest = plan.interestCollected;

  for (const period of openPeriods) {
    if (!remainingInterest.isPositive()) break;

    const owed = fromDb(period.interestAccrued)
      .minus(fromDb(period.interestPaid))
      .minus(fromDb(period.interestWaived));
    if (!owed.isPositive()) continue;

    const applied = Money.min(owed, remainingInterest);

    await tx.paymentAllocation.create({
      data: {
        organizationId: input.organizationId,
        paymentId: paymentId!,
        kind: "INTEREST",
        amount: toDb(applied),
        loanPeriodId: period.id,
      },
    });

    await tx.loanPeriod.update({
      where: { id: period.id },
      data: {
        interestPaid: { increment: applied.toDatabaseString() },
        status: applied.equals(owed) ? "PAID" : "PARTIALLY_PAID",
        settledAt: applied.equals(owed) ? new Date() : null,
      },
    });

    remainingInterest = remainingInterest.minus(applied);
  }

  if (remainingInterest.isPositive()) {
    throw new ServiceError(
      `La liquidación no pudo asignar ${remainingInterest.toString()} de interés ` +
        "a ningún período. Esto es un error del motor de liquidación.",
    );
  }

  if (plan.principalCollected.isPositive()) {
    await tx.paymentAllocation.create({
      data: {
        organizationId: input.organizationId,
        paymentId: paymentId!,
        kind: "PRINCIPAL",
        amount: toDb(plan.principalCollected),
      },
    });
  }

  if (plan.chargesCollected.isPositive()) {
    await tx.paymentAllocation.create({
      data: {
        organizationId: input.organizationId,
        paymentId: paymentId!,
        kind: "FEE",
        amount: toDb(plan.chargesCollected),
        concept: quote.additionalCharges.map((c) => c.concept).join(", ") || null,
      },
    });
  }

  // --- Write-off: close what was not collected ----------------------------

  let interestWaived = Money.zero();
  let principalWrittenOff = Money.zero();

  if (input.kind === "WRITE_OFF") {
    // Interest that will never arrive is waived on its period rows. It costs
    // nothing: profit recognises interest on collection, so this interest never
    // entered a result and removing it changes none.
    const stillOpen = await tx.loanPeriod.findMany({
      where: { loanId: loan.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
      select: {
        id: true,
        interestAccrued: true,
        interestPaid: true,
        interestWaived: true,
      },
    });

    for (const period of stillOpen) {
      const owed = fromDb(period.interestAccrued)
        .minus(fromDb(period.interestPaid))
        .minus(fromDb(period.interestWaived));
      if (!owed.isPositive()) continue;

      interestWaived = interestWaived.plus(owed);

      await tx.loanPeriod.update({
        where: { id: period.id },
        data: {
          interestWaived: { increment: owed.toDatabaseString() },
          status: "WAIVED",
          settledAt: new Date(),
        },
      });
    }

    principalWrittenOff = Money.of(quote.principalOutstanding).minus(
      plan.principalCollected,
    );
  }

  await tx.loan.update({
    where: { id: loan.id },
    data: {
      outstandingPrincipal: toDb(
        Money.of(quote.principalOutstanding)
          .minus(plan.principalCollected)
          .minus(principalWrittenOff),
      ),
      // Set BEFORE refreshLoanState: deriveLifecycle never revisits a terminal
      // state, so this is what stops a written-off loan being labelled "Pagado".
      ...(input.kind === "WRITE_OFF" ? { lifecycle: "CANCELLED" as const } : {}),
    },
  });

  const settlement = await tx.settlement.create({
    data: {
      organizationId: input.organizationId,
      loanId: loan.id,
      kind: input.kind,
      settledOn: toPrismaDate(input.asOf),
      openPeriodPolicyApplied:
        input.openPeriodPolicyOverride ?? loan.openPeriodPolicy,
      openPeriodCharge: toDb(quote.openPeriodCharge),
      principalOutstandingAtSettlement: toDb(quote.principalOutstanding),
      interestOutstandingAtSettlement: toDb(
        plan.interestOutstandingAtSettlement,
      ),
      principalCollected: toDb(plan.principalCollected),
      interestCollected: toDb(plan.interestCollected),
      amountWrittenOff: toDb(principalWrittenOff.plus(interestWaived)),
      reason: input.reason ?? input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true },
  });

  const cashAccountId =
    input.cashAccountId ?? (await defaultCashAccountId(tx, input.organizationId));

  if (plan.interestCollected.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "INTEREST_COLLECTION",
      direction: "IN",
      amount: plan.interestCollected,
      financialClass: "INTEREST",
      occurredOn: input.asOf,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId,
      note: `Interés en liquidación de ${loan.code}`,
      createdById: input.actor.userId,
    });
  }

  if (plan.principalCollected.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "PRINCIPAL_RECOVERY",
      direction: "IN",
      amount: plan.principalCollected,
      financialClass: "PRINCIPAL",
      occurredOn: input.asOf,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId,
      note: `Capital recuperado en liquidación de ${loan.code}`,
      createdById: input.actor.userId,
    });
  }

  if (plan.chargesCollected.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "FEE_COLLECTION",
      direction: "IN",
      amount: plan.chargesCollected,
      financialClass: "OPERATING_INCOME",
      occurredOn: input.asOf,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId,
      note: `Otros conceptos en liquidación de ${loan.code}`,
      createdById: input.actor.userId,
    });
  }

  // The bad-debt entry. Classified as an operating expense because the loss is
  // real, and flagged affectsCash:false because the money left the till when the
  // loan was disbursed — recording it again would understate the drawer.
  if (principalWrittenOff.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "PRINCIPAL_WRITE_OFF",
      direction: "OUT",
      amount: principalWrittenOff,
      financialClass: "OPERATING_EXPENSE",
      affectsCash: false,
      occurredOn: input.asOf,
      loanId: loan.id,
      clientId: loan.clientId,
      note: `Castigo de capital en ${loan.code}: ${input.reason ?? "sin motivo"}`,
      createdById: input.actor.userId,
    });
  }

  const state = await refreshLoanState(
    tx,
    loan.id,
    input.asOf,
    input.settings,
  );

  const expected = input.kind === "WRITE_OFF" ? "CANCELLED" : "PAID";

  if (state.lifecycle !== expected) {
    throw new ServiceError(
      "La liquidación no dejó el préstamo cerrado. No se registró nada. " +
        `Quedan ${state.outstandingPrincipal.toString()} de capital y ` +
        `${state.outstandingInterest.toString()} de interés.`,
    );
  }

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "UPDATE",
    entity: "Loan",
    entityId: loan.id,
    afterValues: {
      settlementId: settlement.id,
      receiptNumber,
      total: quote.total.toDatabaseString(),
      principalCollected: plan.principalCollected.toDatabaseString(),
      interestCollected: plan.interestCollected.toDatabaseString(),
      openPeriodCharge: quote.openPeriodCharge.toDatabaseString(),
      openPeriodPolicy:
        input.openPeriodPolicyOverride ?? loan.openPeriodPolicy,
    },
    summary:
      `Préstamo ${loan.code} de ${loan.client.fullName} liquidado por ` +
      quote.total.toDatabaseString(),
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "loan.settle",
    settlement.id,
  );

  return {
    settlementId: settlement.id,
    paymentId,
    receiptNumber,
    total: quote.total,
    principalWrittenOff,
    interestWaived,
  };
}
