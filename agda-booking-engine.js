/**
 * agda-booking-engine.js — the deterministic, offline booking + make-up-credit engine
 * for the AGDA demo (build item DEMO-2, fixtured mode).
 *
 * WHY it exists: the Mon 31 Aug demo runs self-contained — no live n8n webhook, no live Sheet,
 * no network (Keenan's fixtured ruling, 29 Aug). This is the INFRA-3/4/5 bridge/ledger LOGIC
 * ported into the browser so a WhatsApp option-tap behaves exactly like the real thing:
 *   - idempotency by wamid — a redelivered event credits ONCE (R1),
 *   - one make-up credit per (child, session) — a cancel AND a coach-absence for the same class
 *     still yield ONE credit, never two,
 *   - a last-slot collision — two parents racing the final seat yield one Confirmed + one
 *     "next three slots", and the loser's credit is NOT consumed,
 *   - off-menu / free text — routed to a staff view with context, never a bot-composed reply,
 *   - balance = SUM over an append-only ledger (never a stored cell), replies stamped "as of <time>".
 * The SAME functions are the seed for the at-engagement real build (INFRA-3/4/5) against AGDA's
 * own Sheet + n8n — only the transport changes (in-page handle() -> a signed doPost).
 *
 * HOW to run:
 *   node agda-booking-engine.js         # runs the self-check (asserts); exits non-zero on fail
 *   <script src="agda-booking-engine.js"></script>   # exposes window.AgdaBooking in the browser
 *
 * INPUTS:  fixture children/coaches/slots (see FIXTURES) — pure demo data, no PII, no secrets.
 * OUTPUTS: handle(store, msg) -> a deterministic result envelope; balanceOf() -> integer credits.
 *
 * PORTS (patterns only, no client data), per build-plans.html #i3/#i4/#i5:
 *   - LockService + wamid dedup (return the prior result on redelivery): attendance-bot ingestion.
 *   - Append-only ledger, one-credit-per-(child,session), correction = append REVOKE never edit:
 *     ZHLA guardrails + payroll GantiLogSync FIFO.
 *   - Deterministic classify (no AI ever composes a parent reply): reminder DailySender classify.
 *   - Fail-CLOSED to a staff view on a missing mapping / off-menu text: ReminderConfig ||'Online' scar.
 *
 * NOTE: GST / invoicing is a SEPARATE engine (agda-invoice-engine.js, INFRA-6) — this file does
 * not touch money. DEMO-3 drives both from the demo page.
 */

(function (root) {
  'use strict';

  // ---- deterministic demo clock -------------------------------------------------------------
  // The demo is scripted to "as of 3:15pm" (the beat spine). A fixed clock makes every balance
  // stamp reproducible across rehearsals — no wall-clock drift between the two run-throughs.
  var DEMO_CLOCK = '2026-08-29T15:15:00';
  function fmtClock(iso) {
    var d = new Date(iso);
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'pm' : 'am';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + String(m).padStart(2, '0') + ap;
  }

  // ---- fixtures (pure demo data — no PII, no secrets) ----------------------------------------
  // Family/contact ids line up with agda-invoice-engine.js so the two demos tell one story.
  // "New Outlet" is never named (the 29-Aug landmine): outlet id OUT-NEW, label "Your New Outlet".
  var FIXTURES = {
    outlets: [
      { id: 'OUT-YISHUN', label: 'Yishun (Orchid Country Club)' },
      { id: 'OUT-NEW', label: 'Your New Outlet' }
    ],
    coaches: [
      { id: 'COACH-WEI', name: 'Coach Wei', outletId: 'OUT-YISHUN' },
      { id: 'COACH-MEI', name: 'Coach Mei', outletId: 'OUT-NEW' }
    ],
    children: [
      { id: 'EMMA', name: 'Emma Tan', parent: 'Mrs Tan', contactId: 'CID-TAN-8842', outletId: 'OUT-YISHUN',
        regular: { sessionKey: 'EMMA|2026-08-30|SAT-GYM-1000', label: 'Sat 30 Aug · 10:00 Gymnastics (Yishun)' } },
      { id: 'RYAN', name: 'Ryan Lim', parent: 'Mr Lim', contactId: 'CID-LIM-2093', outletId: 'OUT-YISHUN',
        regular: { sessionKey: 'RYAN|2026-08-30|SAT-GYM-1000', label: 'Sat 30 Aug · 10:00 Gymnastics (Yishun)' } }
    ],
    // Make-up class slots a credit can be REDEEMed into. capacity is the real seat count.
    // MU-THU is the single-seat slot the two-parent collision races for.
    slots: [
      { id: 'MU-WED', label: 'Wed 3 Sep · 15:00 Gymnastics', coachId: 'COACH-WEI', outletId: 'OUT-YISHUN', capacity: 2 },
      { id: 'MU-THU', label: 'Thu 4 Sep · 16:00 Gymnastics', coachId: 'COACH-WEI', outletId: 'OUT-YISHUN', capacity: 1 },
      { id: 'MU-SAT', label: 'Sat 6 Sep · 09:00 Gymnastics', coachId: 'COACH-MEI', outletId: 'OUT-NEW', capacity: 3 },
      { id: 'MU-SUN', label: 'Sun 7 Sep · 10:00 Gymnastics', coachId: 'COACH-MEI', outletId: 'OUT-NEW', capacity: 2 }
    ]
  };

  // ---- a fresh, append-only store ------------------------------------------------------------
  // Everything the engine writes is an append (ledger, bookings, staffQueue). Nothing is edited
  // in place — a correction appends a REVOKE. seen{} is the wamid idempotency cache (the in-page
  // stand-in for the Sheet's wamid column + LockService).
  function createStore() {
    return {
      clock: DEMO_CLOCK,
      ledger: [],          // {childId, sessionKey, event:'EARN'|'REDEEM'|'REVOKE', delta, wamid, ts, note}
      bookings: [],        // {id, childId, slotId, slotLabel, wamid, ts}
      staffQueue: [],      // {childId, childName, text, context, ts}
      seen: {},            // wamid -> the exact prior result envelope (return it verbatim on redelivery)
      _seq: 0,
      slotBooked: FIXTURES.slots.reduce(function (m, s) { m[s.id] = 0; return m; }, {})
    };
  }

  function child(id) { return FIXTURES.children.filter(function (c) { return c.id === id; })[0]; }
  function slot(id) { return FIXTURES.slots.filter(function (s) { return s.id === id; })[0]; }

  // balance = SUM of signed deltas over the append-only ledger, resolved by child_id ACROSS
  // outlets (a credit earned at Yishun is redeemable at the new outlet). Never a stored cell.
  function balanceOf(store, childId) {
    return store.ledger.reduce(function (b, r) {
      return r.childId === childId ? b + r.delta : b;
    }, 0);
  }

  // an EARN is "active" for a (child, session) if its EARNs outnumber its REVOKEs. This is what
  // makes a cancel AND a coach-absence for the SAME class yield ONE credit (two different wamids,
  // same session_key) — distinct from wamid dedup, which stops the SAME message crediting twice.
  function hasActiveEarn(store, childId, sessionKey) {
    var n = 0;
    store.ledger.forEach(function (r) {
      if (r.childId === childId && r.sessionKey === sessionKey) {
        if (r.event === 'EARN') n++; else if (r.event === 'REVOKE') n--;
      }
    });
    return n > 0;
  }

  // the next N make-up slots that still have a seat (a real availability read, not a canned list)
  function availableSlots(store, n) {
    return FIXTURES.slots
      .filter(function (s) { return store.slotBooked[s.id] < s.capacity; })
      .slice(0, n || 3);
  }

  // a child's still-active (not cancelled) make-up bookings — powers the "cancel this make-up" flow
  function activeBookingsFor(store, childId) {
    return store.bookings.filter(function (b) { return b.childId === childId && !b.cancelled; });
  }

  function stamp(store) { return fmtClock(store.clock); }

  // ---- the single entry point: handle(store, msg) -------------------------------------------
  // msg = { op, wamid, ts?, ...opFields }. Returns a deterministic envelope {ok, kind, ...}.
  // Every write op is idempotent by wamid: a redelivered event returns the ORIGINAL envelope and
  // mutates nothing (R1). ts defaults to the demo clock.
  function handle(store, msg) {
    var wamid = msg.wamid;
    if (wamid && Object.prototype.hasOwnProperty.call(store.seen, wamid)) {
      return store.seen[wamid];            // redelivery: prior result, no second write
    }
    var ts = msg.ts || store.clock;
    var res;
    switch (msg.op) {
      case 'cancel':   res = opCancel(store, msg, ts); break;
      case 'book':     res = opBook(store, msg, ts); break;
      case 'unbook':   res = opUnbook(store, msg, ts); break;
      case 'balance':  res = opBalanceFor(store, msg.childId); break;
      case 'attend':   res = opAttend(store, msg, ts); break;
      case 'revoke':   res = opRevoke(store, msg, ts); break;
      case 'text':     res = opText(store, msg, ts); break;
      default:
        // an unknown op fails CLOSED to staff, never a bot guess (R: fail-closed on missing mapping)
        res = toStaff(store, msg, ts, msg.text || '(unrecognised request)');
    }
    if (wamid) store.seen[wamid] = res;
    return res;
  }

  // cancel a regular class -> EARN one make-up credit (once per child/session)
  function opCancel(store, msg, ts) {
    var c = child(msg.childId);
    if (!c) return toStaff(store, msg, ts, 'cancel for unknown child');
    var sessionKey = msg.sessionKey || (c.regular && c.regular.sessionKey);
    var label = msg.sessionLabel || (c.regular && c.regular.label) || sessionKey;
    var already = hasActiveEarn(store, c.id, sessionKey);
    if (!already) {
      store.ledger.push({ childId: c.id, sessionKey: sessionKey, event: 'EARN', delta: 1,
        wamid: msg.wamid, ts: ts, note: 'cancel: ' + label });
    }
    return { ok: true, kind: 'credit', childId: c.id, childName: c.name,
      creditedNow: !already, balance: balanceOf(store, c.id), stampedAt: stamp(store),
      sessionLabel: label,
      reply: (already ? 'That class was already credited. ' : 'Cancelled ' + label + '. A make-up credit is on your account. ')
        + 'You have ' + balanceOf(store, c.id) + ' make-up lesson' + (balanceOf(store, c.id) === 1 ? '' : 's')
        + ' left, as of ' + stamp(store) + '.' };
  }

  // coach marks attendance -> an ABSENT child EARNs one credit (same one-per-session rule)
  function opAttend(store, msg, ts) {
    var c = child(msg.childId);
    if (!c) return toStaff(store, msg, ts, 'attendance for unknown child');
    if (msg.status !== 'ABSENT') {
      return { ok: true, kind: 'attend', childId: c.id, childName: c.name, credited: false,
        balance: balanceOf(store, c.id), stampedAt: stamp(store),
        reply: 'Marked ' + c.name + ' present. No make-up needed.' };
    }
    var sessionKey = msg.sessionKey || (c.regular && c.regular.sessionKey);
    var label = msg.sessionLabel || (c.regular && c.regular.label) || sessionKey;
    var already = hasActiveEarn(store, c.id, sessionKey);   // the cancel may have credited this already
    if (!already) {
      store.ledger.push({ childId: c.id, sessionKey: sessionKey, event: 'EARN', delta: 1,
        wamid: msg.wamid, ts: ts, note: 'coach-absent: ' + label });
    }
    return { ok: true, kind: 'attend', childId: c.id, childName: c.name,
      credited: !already, balance: balanceOf(store, c.id), stampedAt: stamp(store), sessionLabel: label,
      // the parent-offer that follows an auto-credit: the next three make-up slots
      offer: availableSlots(store, 3),
      reply: (already
        ? c.name + ' was absent — already credited (you cancelled earlier), so no double credit. '
        : c.name + ' was absent for ' + label + '. A make-up credit is on your account. ')
        + 'Balance ' + balanceOf(store, c.id) + ', as of ' + stamp(store) + '.' };
  }

  // book a make-up into a slot -> REDEEM one credit, unless the slot is full (then next-three)
  function opBook(store, msg, ts) {
    var c = child(msg.childId);
    if (!c) return toStaff(store, msg, ts, 'booking for unknown child');
    var s = slot(msg.slotId);
    if (!s) return toStaff(store, msg, ts, 'booking for unknown slot ' + msg.slotId);

    if (balanceOf(store, c.id) <= 0) {
      // no credit to spend — a deterministic dead-end-free reply, not a bot improvisation
      return { ok: false, kind: 'no-credit', childId: c.id, childName: c.name,
        balance: 0, stampedAt: stamp(store),
        reply: 'You have no make-up lessons left as of ' + stamp(store) + '. Reply MENU to see options or a coach can help.' };
    }
    // availability read + seat take happen together (in-page single-thread == the bridge lock):
    // a full slot never consumes a credit; it returns the next three open slots.
    if (store.slotBooked[s.id] >= s.capacity) {
      var next = availableSlots(store, 3).filter(function (x) { return x.id !== s.id; }).slice(0, 3);
      return { ok: false, kind: 'full', childId: c.id, childName: c.name, requested: s.id, requestedLabel: s.label,
        nextThree: next, balance: balanceOf(store, c.id), stampedAt: stamp(store),
        reply: s.label + ' just filled. Here are the next three make-up slots — tap one:\n'
          + next.map(function (x, i) { return (i + 1) + ') ' + x.label; }).join('\n') };
    }
    store.slotBooked[s.id] += 1;
    var bId = 'BK-' + (++store._seq);
    store.bookings.push({ id: bId, childId: c.id, slotId: s.id, slotLabel: s.label, wamid: msg.wamid, ts: ts });
    store.ledger.push({ childId: c.id, sessionKey: 'REDEEM|' + s.id + '|' + c.id, event: 'REDEEM', delta: -1,
      wamid: msg.wamid, ts: ts, note: 'booked ' + s.label });
    return { ok: true, kind: 'booked', childId: c.id, childName: c.name, bookingId: bId,
      slotId: s.id, slotLabel: s.label, balance: balanceOf(store, c.id), stampedAt: stamp(store),
      reply: 'Confirmed: ' + c.name + ' → ' + s.label + '. Booking ' + bId + '. '
        + balanceOf(store, c.id) + ' make-up lesson' + (balanceOf(store, c.id) === 1 ? '' : 's') + ' left, as of ' + stamp(store) + '.' };
  }

  // cancel a booked make-up -> release the seat, RETURN the credit (append +1), mark the booking cancelled.
  // The credit becomes spendable again and the freed seat is bookable again — the redeem-reversal case.
  function opUnbook(store, msg, ts) {
    var c = child(msg.childId);
    if (!c) return toStaff(store, msg, ts, 'unbook for unknown child');
    var bk = store.bookings.filter(function (b) {
      return !b.cancelled && (msg.bookingId ? b.id === msg.bookingId : (b.childId === c.id && b.slotId === msg.slotId));
    })[0];
    if (!bk) {
      return { ok: false, kind: 'no-booking', childId: c.id, childName: c.name,
        balance: balanceOf(store, c.id), stampedAt: stamp(store),
        reply: 'No active make-up booking found to cancel, as of ' + stamp(store) + '. Reply MENU for options.' };
    }
    if (store.slotBooked[bk.slotId] > 0) store.slotBooked[bk.slotId] -= 1;   // free the seat
    bk.cancelled = true; bk.cancelledTs = ts;                                 // booking status flips
    store.ledger.push({ childId: c.id, sessionKey: 'RETURN|' + bk.slotId + '|' + c.id, event: 'RETURN', delta: 1,
      wamid: msg.wamid, ts: ts, note: 'booking cancelled: ' + bk.slotLabel });
    return { ok: true, kind: 'unbooked', childId: c.id, childName: c.name, bookingId: bk.id, slotLabel: bk.slotLabel,
      balance: balanceOf(store, c.id), stampedAt: stamp(store),
      reply: 'Cancelled ' + c.name + '’s make-up on ' + bk.slotLabel + '. Your credit is back — '
        + balanceOf(store, c.id) + ' make-up lesson' + (balanceOf(store, c.id) === 1 ? '' : 's')
        + ' left, as of ' + stamp(store) + '. That seat is open again.' };
  }

  // correction (staff edits the Sheet) -> append a REVOKE, never edit/delete a row
  function opRevoke(store, msg, ts) {
    var c = child(msg.childId);
    if (!c) return toStaff(store, msg, ts, 'revoke for unknown child');
    store.ledger.push({ childId: c.id, sessionKey: msg.sessionKey, event: 'REVOKE', delta: -1,
      wamid: msg.wamid, ts: ts, note: msg.note || 'staff correction' });
    return { ok: true, kind: 'revoke', childId: c.id, childName: c.name,
      balance: balanceOf(store, c.id), stampedAt: stamp(store),
      reply: 'Correction applied. Balance is now ' + balanceOf(store, c.id) + ', as of ' + stamp(store) + '.' };
  }

  // off-menu / free text -> a STAFF handoff with context; the engine NEVER answers the content
  function opText(store, msg, ts) {
    return toStaff(store, msg, ts, msg.text);
  }

  function toStaff(store, msg, ts, text) {
    var c = child(msg.childId);
    var context = c ? {
      childName: c.name, parent: c.parent, outletId: c.outletId,
      balance: balanceOf(store, c.id), stampedAt: stamp(store),
      nextSlots: availableSlots(store, 3).map(function (s) { return s.label; })
    } : { note: 'no child mapping — fail closed to staff' };
    store.staffQueue.push({ childId: c ? c.id : null, childName: c ? c.name : '(unknown)',
      text: text, context: context, ts: ts });
    return { ok: true, kind: 'staff', childId: c ? c.id : null, childName: c ? c.name : '(unknown)',
      context: context,
      // a fixed acknowledgement — deterministic, never an AI-composed answer to what they typed
      reply: 'Thanks — a coach will reply to you here personally. (Passed to the team with your details.)' };
  }

  // opBalance needs the childId; wire it through handle() cleanly:
  function opBalanceFor(store, childId) {
    var c = child(childId);
    if (!c) return { ok: false, kind: 'balance', reply: 'No account found.' };
    return { ok: true, kind: 'balance', childId: c.id, childName: c.name,
      balance: balanceOf(store, c.id), stampedAt: stamp(store),
      reply: c.name + ' has ' + balanceOf(store, c.id) + ' make-up lesson'
        + (balanceOf(store, c.id) === 1 ? '' : 's') + ' left, as of ' + stamp(store) + '.' };
  }

  var API = {
    FIXTURES: FIXTURES, DEMO_CLOCK: DEMO_CLOCK, fmtClock: fmtClock,
    createStore: createStore, handle: handle, balanceOf: balanceOf,
    availableSlots: availableSlots, child: child, slot: slot, opBalanceFor: opBalanceFor,
    activeBookingsFor: activeBookingsFor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AgdaBooking = API;

  // ---- self-check (node agda-booking-engine.js) ----------------------------------------------
  // The ONE runnable check the booking path leaves behind. Proves every DEMO-2 done-check
  // behaviour: credit, wamid idempotency, two-path one-credit, book, last-slot collision,
  // off-menu->staff, balance stamp, append-only correction.
  function selfCheck() {
    var assert = require('assert');

    // 1. cancel -> ONE credit, stamped "as of 3:15pm"
    var s1 = createStore();
    var r1 = handle(s1, { op: 'cancel', childId: 'EMMA', wamid: 'wa-cancel-1' });
    assert.strictEqual(r1.kind, 'credit');
    assert.strictEqual(balanceOf(s1, 'EMMA'), 1, 'cancel earns one credit');
    assert.ok(/as of 3:15pm/.test(r1.reply), 'balance is stamped');

    // 2. double-tap: the SAME event redelivered -> still ONE credit (wamid idempotency, R1)
    var r2 = handle(s1, { op: 'cancel', childId: 'EMMA', wamid: 'wa-cancel-1' });
    assert.deepStrictEqual(r2, r1, 'redelivery returns the identical envelope');
    assert.strictEqual(balanceOf(s1, 'EMMA'), 1, 'double-tap yields ONE credit, not two');
    assert.strictEqual(s1.ledger.length, 1, 'no second ledger row written on redelivery');

    // 3. two DIFFERENT paths for the SAME session -> still ONE credit (child,session uniqueness)
    var s3 = createStore();
    handle(s3, { op: 'cancel', childId: 'EMMA', wamid: 'wa-c' });                 // parent cancels
    handle(s3, { op: 'attend', childId: 'EMMA', status: 'ABSENT', wamid: 'wa-a' }); // coach also marks absent
    assert.strictEqual(balanceOf(s3, 'EMMA'), 1, 'cancel + coach-absent same session = ONE credit');

    // 4. book a make-up into a free slot -> Confirmed, credit spent, booking row lands
    var r4 = handle(s3, { op: 'book', childId: 'EMMA', slotId: 'MU-WED', wamid: 'wa-b1' });
    assert.strictEqual(r4.kind, 'booked');
    assert.strictEqual(balanceOf(s3, 'EMMA'), 0, 'booking redeems the credit');
    assert.strictEqual(s3.bookings.length, 1, 'a booking row landed');

    // 4b. cancel that booking -> seat freed, credit returned, no active booking left
    var r4b = handle(s3, { op: 'unbook', childId: 'EMMA', bookingId: r4.bookingId, wamid: 'wa-ub1' });
    assert.strictEqual(r4b.kind, 'unbooked');
    assert.strictEqual(balanceOf(s3, 'EMMA'), 1, 'cancelling the booking returns the credit');
    assert.strictEqual(activeBookingsFor(s3, 'EMMA').length, 0, 'no active booking after cancel');
    assert.strictEqual(s3.slotBooked['MU-WED'], 0, 'the freed seat is released');

    // 5. last-slot collision: two parents race MU-THU (capacity 1)
    var s5 = createStore();
    handle(s5, { op: 'cancel', childId: 'EMMA', wamid: 'e-c' });
    handle(s5, { op: 'cancel', childId: 'RYAN', wamid: 'r-c' });
    var winner = handle(s5, { op: 'book', childId: 'EMMA', slotId: 'MU-THU', wamid: 'e-b' });
    var loser = handle(s5, { op: 'book', childId: 'RYAN', slotId: 'MU-THU', wamid: 'r-b' });
    assert.strictEqual(winner.kind, 'booked', 'first parent Confirmed');
    assert.strictEqual(loser.kind, 'full', 'second parent gets full, not an error');
    assert.strictEqual(loser.nextThree.length, 3, 'exactly next three slots offered');
    assert.strictEqual(balanceOf(s5, 'RYAN'), 1, "loser's credit is NOT consumed");

    // 6. off-menu free text -> staff handoff with context; NO bot answer to the content
    var s6 = createStore();
    handle(s6, { op: 'cancel', childId: 'EMMA', wamid: 'x-c' });
    var r6 = handle(s6, { op: 'text', childId: 'EMMA', text: 'is coach wei nice? my daughter is shy', wamid: 'x-t' });
    assert.strictEqual(r6.kind, 'staff', 'off-menu routes to staff');
    assert.strictEqual(s6.staffQueue.length, 1, 'staff queue got the message');
    assert.ok(r6.context.balance === 1, 'staff sees the balance context');
    assert.ok(!/coach wei/i.test(r6.reply), 'the engine does NOT answer the question — fixed handoff only');

    // 7. append-only correction: a REVOKE is appended, no row edited/deleted
    var before = s6.ledger.length;
    var r7 = handle(s6, { op: 'revoke', childId: 'EMMA', sessionKey: 'EMMA|2026-08-30|SAT-GYM-1000', wamid: 'x-r' });
    assert.strictEqual(r7.kind, 'revoke');
    assert.strictEqual(s6.ledger.length, before + 1, 'correction APPENDS (never edits)');
    assert.strictEqual(balanceOf(s6, 'EMMA'), 0, 'revoke nets the credit back out');

    // 8. balance query is always stamped
    var rb = opBalanceFor(s3, 'EMMA');
    assert.ok(/as of 3:15pm/.test(rb.reply), 'balance query stamped');

    console.log('agda-booking-engine self-check: PASS (8 groups)');
    console.log('  collision: EMMA ' + winner.kind + ' MU-THU · RYAN ' + loser.kind
      + ' -> next three [' + loser.nextThree.map(function (x) { return x.id; }).join(', ') + ']');
  }

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    selfCheck();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
