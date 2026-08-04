# Letter of Authorization (LOA) — CallRail → Twilio

The LOA is the document that actually authorizes the port. Twilio will not submit a
port-in without one, and **the overwhelming majority of port rejections are LOA data
mismatches, not technical problems** — a wrong suite number or a company name that reads
"Inc" on one record and nothing on the other is enough to bounce the whole order.

Fill this out, sign it, and attach it to the Twilio port-in request. Companion to
`callrail-port-packet.md` (the number list and CallRail account facts).

---

## ⚠️ The name trap — read this first

Arbor has **at least three** name variants in circulation, and they are not
interchangeable on a port:

| Variant | Where it appears |
|---|---|
| **Arbor Management** | The CallRail account name (via API) |
| **Arbor Management Specialist, Inc** | The company's full legal entity name |
| Arbor Management LLC. | A **different, sibling entity** — never use this |

The LOA must carry the name **exactly as CallRail has it on the billing record**, not the
name that is legally correct. If CallRail's invoice says "Arbor Management" and the LOA
says "Arbor Management Specialist, Inc", the port is rejected for name mismatch.

**Confirm against a CallRail invoice before signing.** That is why the draft support
email asks CallRail for the service address exactly as it should appear.

---

## The form

Copy into Twilio's LOA template (Console → Phone Numbers → Porting supplies a PDF), or
send this to CallRail if they accept a free-form LOA.

### Losing carrier

| Field | Value |
|---|---|
| Current provider | **CallRail** *(⬜ confirm the underlying carrier of record — CallRail resells, so the port team may need Bandwidth / Twilio / etc. instead)* |
| Account number | ⬜ **from CallRail** — CallRail's own numeric account ID is `408466063`; confirm this is the number the port team should use |
| Account PIN / passcode | ⬜ **from CallRail** |
| BTN (billing telephone number) | ⬜ **from CallRail** — resold tracking-number pools often have no conventional BTN; get their answer in writing |

### Account holder

| Field | Value |
|---|---|
| Company name (exactly as on the CallRail bill) | ⬜ **verify against an invoice** — see the name trap above |
| Service address — street | ⬜ |
| Service address — suite/unit | ⬜ *(a missing or extra suite number is the single most common rejection)* |
| City / State / ZIP | ⬜ |
| Authorized signer | **Justin Hays** — sole admin on the CallRail account |
| Title | ⬜ (Owner) |
| Contact email | justin@arbor-mgmt.com |
| Contact phone | ⬜ *(use a number **not** on the port list — a ported number can be unreachable at cutover, which is exactly when the port team may need to call)* |

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
| Account number for port team | ⬜ | |
| Account PIN / passcode | ⬜ | |
| BTN | ⬜ | |
| CSR issued? | ⬜ | |
| Service address as on file | ⬜ | |
| Company name as on file | ⬜ | |

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
