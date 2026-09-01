/**
 * agda-invoice-engine.js — the deterministic, offline invoice + GST + reconciliation engine
 * for the AGDA demo (build item INFRA-6, fixtured mode).
 *
 * WHY it exists: the Mon 31 Aug demo runs self-contained — no live Xero, no live Sheet, no
 * network. This is the booking-adjacent MONEY logic ported into the browser so the mock Xero
 * panel behaves like the real thing: per-line 9% GST rounded to the cent then summed (never
 * total-then-tax), rate derived from the invoice date, a real ACCREC/ACCRECCREDIT shape, and an
 * independent-recompute reconciler that never trusts a stored total. The SAME functions are the
 * seed for the at-engagement real build against AGDA's own Xero — only the transport changes.
 *
 * HOW to run:
 *   node agda-invoice-engine.js          # runs the self-check (asserts); exits non-zero on fail
 *   <script src="agda-invoice-engine.js"></script>  # exposes window.AgdaInvoice in the browser
 *
 * INPUTS:  fixture families/lines (see FIXTURES below) — pure data, no secrets, no client PII.
 * OUTPUTS: buildInvoice() -> a computed invoice (cents-exact); reconcile() -> exceptions list.
 *
 * PORTS (patterns only, no client data), per build-plans.html #i6:
 *   - Fraction-exact money, recompute-never-trust-a-stored-total: CPID Money.gs / InvoiceBuilder.gs.
 *   - Position-derived idempotent numbering: CPID Main.gs (invoice no. by row, so parallel/retry agree).
 *   - Independent-recompute reconciler (never reads the sheet's own formula cell): math-munchies Verify.gs.
 *
 * GROUNDING (deals/asia-gymnastics/xero-grounded-spec.html): Xero taxes each line, rounds to 2dp,
 * then sums; rate is prevailing-at-time-of-supply (9% from 2024-01-01, 8% in 2023); TaxType is
 * shown as the rate NAME, never a fabricated API code; a non-GST-registered variant exists;
 * make-up refund is a real credit note (ACCRECCREDIT). The panel is a MOCK of HIS Xero.
 */

(function (root) {
  'use strict';

  // ---- money: integer cents, so no binary-float drift ever reaches a payable amount ----------
  // Every amount inside the engine is an integer number of cents. Dollars only appear at the
  // display edge (fmt). This is the cents form of Money.gs's "always land on a payable amount".
  function centsOf(dollars) { return roundCents(dollars * 100); }
  function fmt(cents) {
    var sign = cents < 0 ? '-' : '';
    var a = Math.abs(cents);
    return sign + (a / 100).toFixed(2);
  }
  // Round half away from zero — symmetric for credit lines. Math.round alone rounds -12.5 -> -12
  // (toward +inf), which would under-round a refund's GST by a cent.
  function roundCents(x) { return x >= 0 ? Math.round(x) : -Math.round(-x); }

  // ---- GST rate: derived from the invoice date, never hardcoded ------------------------------
  // The single most-tested IRAS rule: prevailing rate at time of supply. Blindly stamping 9% on a
  // 2023 supply is wrong (it was 8%). Returns the rate AND its display name (never an API code —
  // SG TaxTypes are org-specific TAX00x read from GET /TaxRates at engagement, not inventable here).
  function gstRateForDate(isoDate) {
    var y = new Date(isoDate + 'T00:00:00').getUTCFullYear();
    var rate = y >= 2024 ? 0.09 : (y === 2023 ? 0.08 : 0.07);
    return { rate: rate, name: 'Standard-Rated Supplies (' + Math.round(rate * 100) + '%)' };
  }

  // ---- one line: net = qty x unit, tax = round(net x rate) — PER LINE, to the cent -----------
  function computeLine(line, rate) {
    var unitCents = centsOf(line.unit);
    var netCents = roundCents(line.qty * unitCents);          // recomputed, never read from a fixture total
    var taxCents = rate > 0 ? roundCents(netCents * rate) : 0; // round THIS line, before any sum
    return {
      description: line.description,
      qty: line.qty,
      unitCents: unitCents,
      accountCode: line.accountCode || '200',
      netCents: netCents,
      taxCents: taxCents
    };
  }

  // ---- build one invoice from raw lines ------------------------------------------------------
  // subTotal / totalTax / total are SUMMED here from the per-line figures. Nothing reads a
  // stored total — that is the whole point (Benza's stale "to be paid" cell, InvoiceBuilder.gs).
  // gstRegistered=false renders the below-S$1M-threshold variant: no tax, total = subTotal.
  function buildInvoice(family, opts) {
    opts = opts || {};
    var date = family.date;
    var gstRegistered = family.gstRegistered !== false;
    var rateInfo = gstRateForDate(date);
    var rate = gstRegistered ? rateInfo.rate : 0;

    var lines = family.lines.map(function (l) { return computeLine(l, rate); });
    var subTotalCents = lines.reduce(function (s, l) { return s + l.netCents; }, 0);
    var totalTaxCents = lines.reduce(function (s, l) { return s + l.taxCents; }, 0);
    var totalCents = subTotalCents + totalTaxCents;

    return {
      number: invoiceNumber(family, opts.position || 0),
      contactId: family.contactId,
      familyName: family.name,
      date: date,
      dueDate: family.dueDate,
      gstRegistered: gstRegistered,
      taxName: gstRegistered ? rateInfo.name : 'Not GST-registered',
      lines: lines,
      subTotalCents: subTotalCents,
      totalTaxCents: totalTaxCents,
      totalCents: totalCents
    };
  }

  // ---- position-derived invoice number -------------------------------------------------------
  // Number follows the family's ROW position, not creation order. Two parallel runs (or a retry
  // after a crash) issue the SAME number for the same family — no double-billing, no restarted
  // counter clashing at ...0001 (Main.gs's seqById rationale).
  function invoiceNumber(family, position) {
    var ym = family.date.slice(0, 7).replace('-', '');        // 2026-09-01 -> 202609
    return 'AGDA-' + ym + '-' + String(position).padStart(4, '0');
  }

  // ---- make-up refund = a real credit note (ACCRECCREDIT), GST included ----------------------
  function buildCreditNote(family, refundLine, position) {
    var rateInfo = gstRateForDate(family.date);
    var rate = family.gstRegistered !== false ? rateInfo.rate : 0;
    var line = computeLine(refundLine, rate);
    var totalCents = line.netCents + line.taxCents;
    return {
      type: 'ACCRECCREDIT',
      number: 'AGDA-CN-' + family.date.slice(0, 7).replace('-', '') + '-' + String(position).padStart(4, '0'),
      contactId: family.contactId,
      familyName: family.name,
      date: family.date,
      taxName: rate > 0 ? rateInfo.name : 'Not GST-registered',
      line: line,
      subTotalCents: line.netCents,
      totalTaxCents: line.taxCents,
      totalCents: totalCents
    };
  }

  // ---- the real ACCREC shape the mock renders to (grounded spec §1) --------------------------
  // A copy-paste-credible Xero API body, so a Xero-running owner recognises it. ContactID only
  // (never a nested contact), LineAmountTypes Exclusive, Status AUTHORISED, TaxType as the NAME.
  function accrecShape(inv) {
    return {
      Type: 'ACCREC',
      Contact: { ContactID: inv.contactId },
      Date: inv.date,
      DueDate: inv.dueDate,
      Reference: monthLabel(inv.date) + ' — ' + inv.familyName,
      LineAmountTypes: 'Exclusive',
      Status: 'AUTHORISED',
      LineItems: inv.lines.map(function (l) {
        return {
          Description: l.description,
          Quantity: String(l.qty),
          UnitAmount: (l.unitCents / 100).toFixed(2),
          AccountCode: l.accountCode,
          TaxType: inv.gstRegistered ? '<' + inv.taxName + ' — org code from GET /TaxRates>' : 'NONE'
        };
      })
    };
  }

  // ---- independent-recompute reconciler ------------------------------------------------------
  // For each family, recompute the invoice FROM ITS RAW LINES and compare to what "Xero" holds.
  // It never reads a stored total on either side of the comparison it is auditing — a drifted
  // Xero figure (or a total-then-tax bug) surfaces as an exception. Fail-closed: any mismatch is
  // an exception, the screen is only "clean" when the exceptions list is empty.
  function reconcile(sheetFamilies, xeroFigures) {
    var exceptions = [];
    var sheet = { subTotalCents: 0, totalTaxCents: 0, totalCents: 0 };
    var xero = { subTotalCents: 0, totalTaxCents: 0, totalCents: 0 };
    var rows = [];

    sheetFamilies.forEach(function (fam, i) {
      var inv = buildInvoice(fam, { position: i + 1 });        // recomputed, authoritative
      var x = xeroFigures[fam.contactId] || { subTotalCents: 0, totalTaxCents: 0, totalCents: 0 };
      sheet.subTotalCents += inv.subTotalCents;
      sheet.totalTaxCents += inv.totalTaxCents;
      sheet.totalCents += inv.totalCents;
      xero.subTotalCents += x.subTotalCents;
      xero.totalTaxCents += x.totalTaxCents;
      xero.totalCents += x.totalCents;

      var deltaCents = inv.totalCents - x.totalCents;
      var taxDeltaCents = inv.totalTaxCents - x.totalTaxCents;
      if (deltaCents !== 0 || taxDeltaCents !== 0) {
        exceptions.push({
          familyName: fam.name,
          contactId: fam.contactId,
          sheetTotalCents: inv.totalCents,
          xeroTotalCents: x.totalCents,
          deltaCents: deltaCents,
          taxDeltaCents: taxDeltaCents
        });
      }
      rows.push({ inv: inv, xero: x, ok: deltaCents === 0 && taxDeltaCents === 0 });
    });

    return { exceptions: exceptions, sheet: sheet, xero: xero, rows: rows };
  }

  function monthLabel(iso) {
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var d = new Date(iso + 'T00:00:00');
    return M[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // ---- fixtures (pure demo data — no PII, no secrets) -----------------------------------------
  // Coaches/slots/children live in the booking engine; here we only need families + billing lines.
  // The Tan family carries the four contract cases in one invoice: a plain block, a sibling block,
  // one PRORATED line (odd cent), and a make-up credit applied. The others make the term recon
  // total meaningful. All GST-registered except the Chua family (the below-threshold variant).
  var FIXTURES = {
    invoiceFamily: {
      name: 'Tan family',
      contactId: 'CID-TAN-8842',
      date: '2026-09-01',
      dueDate: '2026-09-15',
      gstRegistered: true,
      lines: [
        { description: 'Gymnastics — 4 lessons (Sep)', qty: 4, unit: 60.00 },
        { description: 'Ballet — 4 lessons (Sep)', qty: 4, unit: 55.00 },
        { description: 'Ballet — prorate, joined 15 Sep (2.5 lessons)', qty: 2.5, unit: 55.00 }, // -> 137.50, GST 12.375 -> 12.38
        { description: 'Make-up credit applied (Aug absence)', qty: 1, unit: -60.00 }
      ]
    },
    // A standalone ACCRECCREDIT is a POSITIVE credit document (it reduces the family's balance) —
    // the negative sign belongs on the credit line APPLIED inside an invoice, not on the note itself.
    creditRefund: { description: 'Make-up refund — Aug absence not rebooked', qty: 1, unit: 60.00 },
    // Term reconciliation set (Sep 2026). Each family's Xero-held figures are seeded in xeroLedger.
    termFamilies: [
      {
        name: 'Tan family', contactId: 'CID-TAN-8842', date: '2026-09-01', dueDate: '2026-09-15', gstRegistered: true,
        lines: [
          { description: 'Gymnastics — 4 lessons (Sep)', qty: 4, unit: 60.00 },
          { description: 'Ballet — 4 lessons (Sep)', qty: 4, unit: 55.00 },
          { description: 'Ballet — prorate, joined 15 Sep (2.5 lessons)', qty: 2.5, unit: 55.00 },
          { description: 'Make-up credit applied (Aug absence)', qty: 1, unit: -60.00 }
        ]
      },
      {
        name: 'Lim family', contactId: 'CID-LIM-2093', date: '2026-09-01', dueDate: '2026-09-15', gstRegistered: true,
        lines: [{ description: 'Gymnastics — 4 lessons (Sep)', qty: 4, unit: 60.00 }]
      },
      {
        name: 'Ng family', contactId: 'CID-NG-5517', date: '2026-09-01', dueDate: '2026-09-15', gstRegistered: true,
        lines: [
          { description: 'Ballet — 4 lessons (Sep)', qty: 4, unit: 55.00 },
          { description: 'Gymnastics — 4 lessons (Sep, sibling)', qty: 4, unit: 60.00 }
        ]
      },
      {
        name: 'Chua family', contactId: 'CID-CHUA-7731', date: '2026-09-01', dueDate: '2026-09-15', gstRegistered: false,
        lines: [{ description: 'Gymnastics — 4 lessons (Sep)', qty: 4, unit: 60.00 }]
      }
    ]
  };

  // Xero-held term figures, seeded by RECOMPUTING the fixtures once — so a clean run shows zero
  // exceptions. The panel's "inject drift" control perturbs one figure to prove the reconciler
  // is a real audit, not a hardcoded green light.
  function seedXeroLedger(families) {
    var out = {};
    families.forEach(function (fam, i) {
      var inv = buildInvoice(fam, { position: i + 1 });
      out[fam.contactId] = {
        subTotalCents: inv.subTotalCents, totalTaxCents: inv.totalTaxCents, totalCents: inv.totalCents
      };
    });
    return out;
  }

  var API = {
    centsOf: centsOf, fmt: fmt, roundCents: roundCents, gstRateForDate: gstRateForDate,
    computeLine: computeLine, buildInvoice: buildInvoice, invoiceNumber: invoiceNumber,
    buildCreditNote: buildCreditNote, accrecShape: accrecShape, reconcile: reconcile,
    monthLabel: monthLabel, seedXeroLedger: seedXeroLedger, FIXTURES: FIXTURES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AgdaInvoice = API;

  // ---- self-check (node agda-invoice-engine.js) ----------------------------------------------
  // The ONE runnable check the money path leaves behind. Proves: the worked example to the cent,
  // per-line rounding on a prorated line, per-line != total-then-tax (the fidelity tell), the
  // non-GST variant, date-derived rate, and reconcile clean/drift.
  function selfCheck() {
    var assert = require('assert');

    // 1. Grounded worked example: 240.00 net + (-60.00) credit @ 9% -> 21.60 / -5.40, total 196.20.
    var wk = buildInvoice({
      name: 'X', contactId: 'C', date: '2026-09-01', dueDate: '2026-09-15',
      lines: [
        { description: 'Gym', qty: 4, unit: 60.00 },
        { description: 'Make-up credit', qty: 1, unit: -60.00 }
      ]
    }, {});
    assert.strictEqual(wk.lines[0].taxCents, 2160, 'line1 GST 21.60');
    assert.strictEqual(wk.lines[1].taxCents, -540, 'credit GST -5.40');
    assert.strictEqual(wk.subTotalCents, 18000, 'subtotal 180.00');
    assert.strictEqual(wk.totalTaxCents, 1620, 'GST 16.20');
    assert.strictEqual(wk.totalCents, 19620, 'total 196.20');

    // 2. Prorated line to the cent: 2.5 x 55.00 = 137.50, GST 12.375 -> 12.38.
    var pl = computeLine({ description: 'p', qty: 2.5, unit: 55.00 }, 0.09);
    assert.strictEqual(pl.netCents, 13750, 'prorate net 137.50');
    assert.strictEqual(pl.taxCents, 1238, 'prorate GST 12.38 (round to the cent)');

    // 3. Per-line != total-then-tax (why Xero rounds per line): two lines of 5.61.
    var div = buildInvoice({
      name: 'D', contactId: 'C', date: '2026-09-01', dueDate: '2026-09-15',
      lines: [{ description: 'a', qty: 1, unit: 5.61 }, { description: 'b', qty: 1, unit: 5.61 }]
    }, {});
    var perLine = div.totalTaxCents;                        // 50 + 50 = 100
    var totalThenTax = roundCents(div.subTotalCents * 0.09); // round(1122*0.09=100.98) = 101
    assert.strictEqual(perLine, 100, 'per-line GST = 1.00');
    assert.strictEqual(totalThenTax, 101, 'total-then-tax = 1.01');
    assert.notStrictEqual(perLine, totalThenTax, 'the two methods MUST differ here');

    // 4. Non-GST variant: no tax, total = subtotal.
    var ng = buildInvoice({
      name: 'N', contactId: 'C', date: '2026-09-01', dueDate: '2026-09-15', gstRegistered: false,
      lines: [{ description: 'Gym', qty: 4, unit: 60.00 }]
    }, {});
    assert.strictEqual(ng.totalTaxCents, 0, 'non-GST has no tax');
    assert.strictEqual(ng.totalCents, ng.subTotalCents, 'non-GST total = subtotal');

    // 5. Rate derived from date: 2023 = 8%, 2024+ = 9%.
    assert.strictEqual(gstRateForDate('2023-06-01').rate, 0.08, '2023 -> 8%');
    assert.strictEqual(gstRateForDate('2026-09-01').rate, 0.09, '2026 -> 9%');

    // 6. Reconcile: clean fixtures -> zero exceptions; a drifted Xero figure -> exactly one.
    var xero = seedXeroLedger(FIXTURES.termFamilies);
    var clean = reconcile(FIXTURES.termFamilies, xero);
    assert.strictEqual(clean.exceptions.length, 0, 'clean reconcile has zero exceptions');
    assert.strictEqual(clean.sheet.totalCents, clean.xero.totalCents, 'term totals agree');
    var drifted = JSON.parse(JSON.stringify(xero));
    drifted['CID-LIM-2093'].totalCents += 100;              // Xero says +1.00
    var withDrift = reconcile(FIXTURES.termFamilies, drifted);
    assert.strictEqual(withDrift.exceptions.length, 1, 'one drifted figure -> one exception');
    assert.strictEqual(withDrift.exceptions[0].deltaCents, -100, 'exception delta is -1.00');

    console.log('agda-invoice-engine self-check: PASS (6 groups)');
    console.log('  Tan-family invoice: sub ' + fmt(buildInvoice(FIXTURES.invoiceFamily, { position: 1 }).subTotalCents) +
      ' · GST ' + fmt(buildInvoice(FIXTURES.invoiceFamily, { position: 1 }).totalTaxCents) +
      ' · total ' + fmt(buildInvoice(FIXTURES.invoiceFamily, { position: 1 }).totalCents));
  }

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    selfCheck();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
