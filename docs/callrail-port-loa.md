# Letter of Authorization (LOA) — CallRail → Twilio

The LOA is the document that actually authorizes the port. Twilio will not submit a
port-in without one, and **the overwhelming majority of port rejections are LOA data
mismatches, not technical problems** — a wrong suite number or a company name that reads
"Inc" on one record and nothing on the other is enough to bounce the whole order.

Fill this out, sign it, and attach it to the Twilio port-in request. Companion to
`callrail-port-packet.md` (the number list and CallRail account facts).

---

## ✅ The name trap — RESOLVED 2026-08-04

Arbor has three name variants in circulation and they are not interchangeable on a port.
**Invoice `INV03003062` (billed 2026-07-28) settles it** — the bill-to reads:

```
Arbor Management
Account 408466063
Justin Hays
Edwardsville Illinois 62025
United States
```

| Variant | Verdict |
|---|---|
| **Arbor Management** | ✅ **Use this.** It is what the invoice bills to. |
| Arbor Management Specialist, Inc | ❌ The legal entity name — do NOT use, it does not match the bill |
| Arbor Management LLC. | ❌ A different, sibling entity — never use |

The LOA must carry the name **exactly as the losing carrier has it**, not the name that is
legally correct. Confirmed: **"Arbor Management"**.

The same invoice confirms the **account number is `408466063`** — the account ID, not the
company ID `190471331`. Use `408466063`.

⚠️ **The invoice bill-to has NO street line** — it goes straight from "Justin Hays" to
"Edwardsville Illinois 62025". So the street address still has to come from CallRail, and
it is worth telling Twilio's port team that the billing record is street-less, since they
will otherwise expect the LOA address to match a street that CallRail may not hold.

---

## The form

Copy into Twilio's LOA template (Console → Phone Numbers → Porting supplies a PDF), or
send this to CallRail if they accept a free-form LOA.

### Losing carrier

| Field | Value |
|---|---|
| Current provider | **CallRail** *(⬜ confirm the underlying carrier of record — CallRail resells, so the port team may need Bandwidth / Twilio / etc. instead)* |
| Account number | **`408466063`** ✅ — confirmed on invoice `INV03003062`. (Not `190471331`, which is the *company* ID from the swap.js URL.) |
| Account PIN / passcode | ⬜ **from CallRail** |
| BTN (billing telephone number) | **Likely `+1 618 920 7917`** — CallRail's Business Profile lists it as the *Primary phone number*, and it is Arbor's real business line rather than a tracking number. ⬜ confirm with CallRail before submitting. |

### Account holder

| Field | Value |
|---|---|
| Company name (exactly as on the CallRail bill) | **Arbor Management** ✅ — confirmed on invoice `INV03003062` |
| Service address — street | ⬜ **the last missing field.** The invoice bill-to carries no street line — get it from CallRail support. |
| Service address — suite/unit | ⬜ *(a missing or extra suite number is the single most common rejection)* |
| City / State / ZIP | **Edwardsville, Illinois 62025, United States** ✅ — from the invoice |
| Authorized signer | **Justin Hays** — sole admin on the CallRail account |
| Title | ⬜ (Owner) |
| Contact email | justin@arbor-mgmt.com |
| Contact phone | **+1 618 920 7917** ✅ — Arbor's real business line, and confirmed **not** one of the 10 numbers being ported, so it stays reachable through cutover |

### Numbers to port (10)

| # | Number |
|---|---|
| 1 | (618) 205-3094 |
| 2 | (618) 366-9977 |
| 3 | (618) 368-2902 |
| 4 | (618) 350-4451 |
| 5 | (618) 205-9820 |
| 6 | (618) 681-5764 |
| 7 | (618) 350-4871 |
| 8 | (618) 350-4252 |
| 9 | (618) 352-2730 |
| 10 | (618) 414-5907 |

**Full port.** All 10 numbers on the CallRail account are being ported (revised
2026-08-04 — 618-414-5907 was added; see `callrail-port-packet.md`). No partial-port
marking is needed, which removes one rejection risk. **But the CallRail account must
still stay open and paid** until every port completes and the Google Ads / GA4
integrations are rebuilt — do not let "full port" be read as an instruction to close the
account early.

### Authorization statement

> I, the undersigned, am authorized to act on behalf of the account holder named above.
> I authorize Twilio and its underlying carriers to act as my agent to transfer the
> telephone numbers listed above from the current provider to Twilio. I certify the
> information above is accurate and matches the current provider's records.

| | |
|---|---|
| Signature | ⬜ |
| Printed name | Justin Hays |
| Title | ⬜ |
| Date | ⬜ |

### Requested firm order date

⬜ — pick a **Tuesday–Thursday morning**. Each number is briefly unreachable at the moment
of cutover, and ports process during business hours; a Friday afternoon date means any
problem sits unresolved over the weekend.

---

## Worksheet — capture CallRail's reply here

Fill in as CallRail responds, then transfer to the LOA above.

| Question asked | CallRail's answer | Date |
|---|---|---|
| All 10 numbers portable? | ⬜ | |
| Underlying carrier of record | ⬜ | |
| Account number for port team | **`408466063`** ✅ (invoice `INV03003062`) | 2026-08-04 |
| Account PIN / passcode | ⬜ | |
| BTN | Business Profile says **+1 618 920 7917** — ⬜ confirm | 2026-08-04 |
| CSR issued? | ⬜ | |
| **Service address — STREET** | ⬜ **the one blocking field** | |
| Company name as on file | **Arbor Management** ✅ (invoice bill-to) | 2026-08-04 |

**Sources so far.** Business Profile screen (2026-08-04): company ID `190471331`, primary
phone `+1 618 920 7917`. Invoice `INV03003062`, billed 2026-07-28 (2026-08-04): bill-to
name, account number, and city/state/ZIP.

**Only the street address is still missing.** Everything else on the LOA is either filled
or is Justin's own (title, signature, date, requested port date).

## Cost of keeping CallRail alive during the port

Invoice `INV03003062` (2026-07-28) totals **$281.66/mo** — $240.00 platform + $41.66
activity, due on receipt and paid same day. So the "keep the account paid until every port
completes" rule costs roughly **$282–$563** across a 1–4 week port window.

That is the correct trade: one lost saved-number caller costs more than a month of
CallRail, and a delinquent account can kill an in-flight port outright. Do not let the
subscription lapse to save the fee — and note the account must stay paid **past** the last
port completion, until the Google Ads and GA4 integrations are rebuilt.

*Aside, not port-relevant:* the profile's Timezone is unset while the API reports
`America/Indiana/Knox`. That is US Central, the same offset and DST rules as
`America/Chicago`, so it does **not** shift day boundaries when comparing CallRail's daily
counts against the app's during the Step 3 validation window. Worth setting for tidiness;
not a blocker.

---

## Rejection checklist — verify before submitting

- [ ] Company name matches the CallRail invoice **character for character**
- [ ] Service address matches, including suite/unit
- [ ] Account number and PIN came from CallRail in writing, not guessed
- [ ] All 10 numbers typed correctly — re-read digit by digit against the packet
- [ ] Contact details confirm the **account is to remain active** until all ports finish
- [ ] Contact phone is **not** one of the 10 numbers being ported
- [ ] Signature is Justin's (sole authorized admin on the account)
- [ ] CallRail account is **paid and current** — an unpaid account fails the port

## After submission

- Ports take **1–4 weeks**. The numbers keep working in CallRail the entire time.
- **Do not disable or delete any tracker in CallRail while its port is pending** — a
  released number cannot be ported, it is simply gone.
- **Do not cancel CallRail** until every port completes *and* the two active
  integrations (Google Ads conversions, GA4) are rebuilt — see `callrail-port-packet.md`.
- The moment a port lands, run the app's import-number flow for that number the same day.
  Between port completion and import, calls hit a bare Twilio number with no voice URL.
  This is the only step in the migration that can actually drop a call.
