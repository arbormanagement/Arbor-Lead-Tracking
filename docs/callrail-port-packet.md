# CallRail → Twilio port packet

Everything needed to start the port-out (migration plan Step 4 — the long pole, 1–4
weeks). Assembled 2026-08-04 from the live CallRail API.

**Rule that governs the whole exercise: the CallRail account must stay active and paid
until every port completes.** A cancelled or delinquent account kills in-flight ports and
the numbers can be lost. The monthly fee is the cheapest insurance in this project.

---

## 1. Numbers to port (9)

| # | E.164 | Dialed as | What it tracks | 90d calls |
|---|---|---|---|---|
| 1 | `+16182053094` | (618) 205-3094 | Direct — website default, **in print** | 552 |
| 2 | `+16183669977` | (618) 366-9977 | Google Local Services Ads | 421 |
| 3 | `+16183682902` | (618) 368-2902 | GBP Edwardsville primary | 327 |
| 4 | `+16183504451` | (618) 350-4451 | GBP O'Fallon primary | 82 |
| 5 | `+16182059820` | (618) 205-9820 | Website DNI pool | 53 |
| 6 | `+16186815764` | (618) 681-5764 | Website DNI pool | 51 |
| 7 | `+16183504871` | (618) 350-4871 | Website DNI pool | 43 |
| 8 | `+16183504252` | (618) 350-4252 | Website DNI pool | 37 |
| 9 | `+16183522730` | (618) 352-2730 | Website DNI pool | 34 |

**Not ported — `+16184145907`** (Google Call Only Ads, 72 calls). It lives in one editable
Google Ads asset, so it gets swapped to `+16184278164` instead. Let it lapse with the
account.

All 9 are **local US numbers in the 618 NPA**, all created well over 30 days ago (the pool
dates to 2025-09-10), so none should trip a minimum-age rule.

## 2. CallRail account facts (for the LOA)

| Field | Value |
|---|---|
| Account name | **Arbor Management** |
| Account ID | `ACCbc8f5e5591f44e42bd49924ee68c858f` |
| **Numeric account ID** | **`408466063`** ← the number carriers usually want |
| Company ID | `COM5b472d2f8bb648f4b62ee5095e3af772` |
| Account opened | 2025-01-30 |
| Authorized user (sole admin) | **Justin Hays**, justin@arbor-mgmt.com |
| Billing | Zuora-backed (`has_zuora_account: true`) |

Justin is the only user on the account, so he is the authorized signer.

## 3. What only Justin can supply

The API does not expose these, and a port cannot be filed without them:

1. **Service address on the CallRail account** — must match the LOA exactly, character for
   character. A mismatched suite number is the single most common port rejection.
2. **A recent CallRail invoice** (Twilio asks for a bill or CSR from the losing carrier).
3. **A signature** on the Twilio LOA.

## 4. What to ask CallRail support for

CallRail does not block port-outs, but it will not volunteer the details either. Request:

- Written confirmation all 9 numbers are **portable**, and the **underlying carrier** for
  each (CallRail resells, so the losing carrier of record may be Bandwidth/Twilio/etc. —
  Twilio's port team needs to know).
- The **account number and PIN/passcode** the port team should use.
- The **BTN (Billing Telephone Number)** for the account. Resold tracking-number pools
  often have no conventional BTN; Twilio's form requires one, so get CallRail's answer in
  writing rather than guessing.
- A **CSR (Customer Service Record)** if they will issue one.

Draft email: section 7.

## 5. Twilio side

Twilio port-ins are filed in **Console → Phone Numbers → Porting** (there is a Port-In
API, but it is not exposed through the Arbor MCP, so this step is manual). Submit all 9 in
**one port order** so they share a single LOA and a single completion date — a single
cutover beats nine staggered ones.

Twilio will want: the number list above, the losing-carrier account number + PIN, the BTN,
the service address, and the signed LOA.

**Requested firm order date:** pick a weekday morning. Ports complete during business
hours and each number is briefly unreachable at the moment of cutover, so a Tuesday–
Thursday morning beats a Friday afternoon or a Monday.

## 6. The same-day import rule

> Between a port completing and the number being imported into the app, calls hit a bare
> Twilio number **with no voice URL** — they fail. This is the only step in the entire
> migration that can actually drop a call.

Mitigation, per the plan:

1. **Pre-create the `tracking_numbers` rows before the port date** — source mapping,
   location, forward destination `+16182059924`, recording + consent notice on.
2. The moment a port lands, run the app's **import-number** flow (`importPhoneNumber`) for
   each number so the voice webhook, status callback and fallback attach.
3. Verify with a live test call per number before moving on.

Done this way the exposure is minutes, not hours.

Source mapping to apply on import:

| Number | Source | Static / pool |
|---|---|---|
| `+16182053094` | direct / website default | static |
| `+16183669977` | Google Local Services Ads | static |
| `+16183682902` | GBP Edwardsville | static, location Edwardsville |
| `+16183504451` | GBP O'Fallon | static, location O'Fallon |
| `+16182059820`, `+16186815764`, `+16183504871`, `+16183504252`, `+16183522730` | website DNI pool | **pool** |

## 7. Draft email to CallRail support

> **To:** support@callrail.com
> **Subject:** Port-out request — Arbor Management (account 408466063) — 9 numbers
>
> Hello,
>
> I'd like to begin porting nine tracking numbers off CallRail to another carrier
> (Twilio). The account will remain active and paid until every port completes.
>
> Account: Arbor Management — account ID 408466063
> (`ACCbc8f5e5591f44e42bd49924ee68c858f`)
>
> Numbers to port:
> (618) 205-3094, (618) 366-9977, (618) 368-2902, (618) 350-4451, (618) 205-9820,
> (618) 681-5764, (618) 350-4871, (618) 350-4252, (618) 352-2730
>
> Could you please provide:
> 1. Confirmation that all nine numbers are portable, and the underlying carrier of
>    record for each.
> 2. The account number and PIN/passcode the winning carrier should use.
> 3. The BTN (billing telephone number) associated with the account.
> 4. A CSR (customer service record), if you're able to issue one.
> 5. The service address on file, exactly as it should appear on the LOA.
>
> One number on the account — (618) 414-5907 — is **not** being ported and can lapse
> with the account when we close it later.
>
> Thanks,
> Justin Hays
> Arbor Management — justin@arbor-mgmt.com

## 8. Decommission checklist (things CallRail does that must be rebuilt first)

Pulled live — do not cancel until each is replaced:

| CallRail integration | State | Replacement |
|---|---|---|
| **GoogleAdword** (`2574269`) → customer `8300392986`, strategy `first_time_vs_repeat`, call + form conversions | **active** | The app's own conversion actions — follow `docs/conversion-export.md`. Keep the app's actions secondary until cutover so bidding is never double-fed. |
| **GoogleAnalytics4** (`2662695`) → `G-XYWYEXMG5Z`, call + form + chat conversions | **active** | The app must emit the `phone_call` and `form` GA4 events. |
| GoogleMyBusiness (`2574274`) | **disabled** | Nothing — already off. Explains how GBP got 618-368-2902 as its primary phone. |

**Notifications:** one account-wide email rule for Justin (`USR8ea72dd1…`). Either
re-create the missed-call alert in the app or agree explicitly that the Leads page
replaces it.

**Form capture** is on (`form_capture: true`) — replaced by `track.js`.

## 9. One number that reinforces the pool decision

CallRail's `swap_cookie_duration` is **6 months**. A visitor who lands on arbor-mgmt.com
holds the *same* pool number for half a year, which is exactly how a rotating DNI number
ends up saved in someone's phone. That is the mechanism behind the 18 no-session repeat
calls found in the inventory, and it is why the pool numbers are being ported rather than
dropped.
