import { normalizePhone, pickMatch, describeCaller, matchedPhoneField, chooseAddress, type LookupCustomer } from "@/lib/retell/caller-context";

let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// Retell sends E.164. HousecallPro stores bare 10-digit numbers and returns
// ZERO results for the E.164 form, so this conversion is load-bearing.
check("E.164 -> 10 digits", normalizePhone("+16189240485"), "6189240485");
check("already 10 digits", normalizePhone("6189240485"), "6189240485");
check("formatted", normalizePhone("(618) 924-0485"), "6189240485");
check("leading 1", normalizePhone("16189240485"), "6189240485");
check("empty", normalizePhone(""), "");
check("garbage", normalizePhone("unknown"), "");

const beau: LookupCustomer = {
  id: "cus_1", first_name: "Beau", last_name: "Marlow", mobile_number: "6189240485",
  addresses: [{ street: "8415 IL-160", city: "New Baden", state: "IL" }],
};
const other: LookupCustomer = { id: "cus_2", first_name: "Ray", last_name: "Kesterson", mobile_number: "6180000000" };
const spouse: LookupCustomer = { id: "cus_3", first_name: "Dana", last_name: "Marlow", home_number: "(618) 924-0485" };

// HCP's q search is fuzzy — it matches name/email/address too — so a non-empty
// result set is not a match.
check("exact match among fuzzy results", pickMatch([other, beau], "6189240485").match?.id, "cus_1");
check("no phone match despite results", pickMatch([other], "6189240485").match, null);
check("matches on home_number too", pickMatch([spouse], "6189240485").match?.id, "cus_3");
check("empty result set", pickMatch([], "6189240485"), { match: null, count: 0 });

// Two people on one number is a household or a business. Picking one and
// greeting them by name is worse than greeting nobody.
check("shared number -> unknown", pickMatch([beau, spouse], "6189240485").match, null);
check("shared number -> count reported", pickMatch([beau, spouse], "6189240485").count, 2);
check("same customer twice is not ambiguous", pickMatch([beau, beau], "6189240485").match?.id, "cus_1");

const described = describeCaller(beau);
check("names the customer", described.contextSentence.includes("Beau Marlow"), true);
check("includes the address", described.contextSentence.includes("8415 IL-160, New Baden"), true);
check("says it is a hint, not identity", described.contextSentence.includes("HINT"), true);
check("forbids asserting it", described.contextSentence.includes("Do NOT state the name, address or email as fact"), true);
check("no flags on a normal customer", "flagsSentence" in (described as any), false);

// do_not_service is read and logged but deliberately NEVER shown to the model
// (Justin 2026-08-27): Chloe does not make do-not-service decisions, so a
// flagged customer must be described to her identically to any other.
const flaggedSentence = describeCaller({ ...beau, do_not_service: true }).contextSentence;
check("flagged customer reads identically to unflagged", flaggedSentence, described.contextSentence);
check("nothing model-facing mentions service refusal", /do not service|do not book|flagged/i.test(flaggedSentence), false);

const noAddress = describeCaller({ id: "cus_9", first_name: "Pat", last_name: "Quinn" });
check("no address -> still coherent", noAddress.contextSentence.includes("Pat Quinn"), true);
check("no address -> no dangling comma", noAddress.contextSentence.includes(", at ."), false);


// ---------------------------------------------------------------------------
// Enrichment added 2026-08-28. Spelling an email aloud was the slowest part of
// an estimate call; HCP already returned the email on the same request and the
// type simply discarded it. Same for the unit number, the state, and which of
// the three phone fields the caller dialled from.
// ---------------------------------------------------------------------------

check("matched mobile", matchedPhoneField(beau, "6189240485"), "mobile");
check("matched home", matchedPhoneField(spouse, "6189240485"), "home");
check("matched work", matchedPhoneField({ id: "c", work_number: "618-924-0485" }, "6189240485"), "work");
check("no phone match -> empty", matchedPhoneField(other, "6189240485"), "");

// A billing address is not where the work happens. 13 of 200 sampled customers
// list one first, so taking addresses[0] confirmed the wrong address for ~1 in 15.
const billingFirst: LookupCustomer = {
  id: "cus_b", first_name: "Toni", last_name: "Wojcik", mobile_number: "6185816063",
  email: "tlwojcik49@gmail.com",
  addresses: [
    { type: "billing", street: "PO Box 12", city: "Edwardsville", state: "IL" },
    { type: "service", street: "1611 Prairie View Dr", city: "Edwardsville", state: "IL" },
  ],
};
check("prefers the service address over billing", chooseAddress(billingFirst).spoken, "1611 Prairie View Dr, Edwardsville");
check("falls back to first when no service type", chooseAddress(beau).spoken, "8415 IL-160, New Baden");
check("full address carries the state", chooseAddress(beau).full, "8415 IL-160, New Baden, IL");
check("spoken address omits the state", chooseAddress(beau).spoken, "8415 IL-160, New Baden");

// Dropping street_line_2 sends a crew to a building with no unit number.
const withUnit: LookupCustomer = {
  id: "cus_u", first_name: "Dee", last_name: "Vance",
  addresses: [{ type: "service", street: "400 Main St", street_line_2: "Apt 4B", city: "Alton", state: "IL" }],
};
check("keeps the unit number", chooseAddress(withUnit).spoken, "400 Main St Apt 4B, Alton");

// Email is the point of the change, but it belongs to a PERSON, not the
// property — a new owner on the old number must not hear it.
const withEmail = describeCaller(billingFirst, "6185816063").contextSentence;
check("offers the email", withEmail.includes("tlwojcik49@gmail.com"), true);
check("gates the email on name confirmation", /until the caller has confirmed they are Toni/.test(withEmail), true);
check("tells it not to make them spell it", withEmail.includes("rather than making them spell it out"), true);
check("says never say it aloud unconfirmed", withEmail.includes("never say the one above aloud"), true);
check("no email on file -> no email sentence", describeCaller(beau).contextSentence.includes("We also hold an email"), false);

// Which line they rang from answers "is this a good mobile contact" for us.
check("reports the matched phone field", withEmail.includes("is the mobile number on that record"), true);
check("home caller reported as home", describeCaller(spouse, "6189240485").contextSentence.includes("is the home number on that record"), true);
check("no digits passed -> no phone claim", describeCaller(billingFirst).contextSentence.includes("number on that record"), false);

// Several properties: proposing one and having them agree out of politeness
// books the wrong address. 4 of 200 sampled customers own more than one.
const multi: LookupCustomer = {
  id: "cus_m", first_name: "Kathy", last_name: "Whitworth", mobile_number: "4178603003",
  addresses: [
    { type: "service", street: "1003 Hickory Point", city: "Collinsville", state: "IL" },
    { type: "service", street: "220 S Main St", city: "Edwardsville", state: "IL" },
  ],
};
const multiSentence = describeCaller(multi, "4178603003").contextSentence;
check("multi-address -> asks which property", multiSentence.includes("Ask which property this call is about"), true);
check("multi-address -> states neither address", /Hickory Point|220 S Main/.test(multiSentence), false);
check("multi-address -> no address confirm example", multiSentence.includes("is this for the"), false);
check("multi-address -> still confirms the name", multiSentence.includes("am I speaking with Kathy?"), true);
check("single address -> still offers the address example", withEmail.includes("is this for the 1611 Prairie View Dr, Edwardsville address?"), true);

// The do-not-service rule must survive the enrichment untouched.
const flaggedRich = describeCaller({ ...billingFirst, do_not_service: true }, "6185816063").contextSentence;
check("enriched flagged caller still reads identically", flaggedRich, withEmail);


// ---------------------------------------------------------------------------
// 2026-08-28, second pass. Two sentences were handing the model a FACT and then
// relying on the prompt to keep it quiet. That does not hold: graded on the
// v114 draft, Chloe volunteered "we have more than one address on file for you"
// in 6 of 6 calls, and on a caller with no email she said "I have your email as
// the one we have on file". Both are now emitted as directives with no fact to
// leak and no absence to infer.
// ---------------------------------------------------------------------------

const multiSentence2 = describeCaller(multi, "4178603003").contextSentence;
check("multi: still says do not propose", multiSentence2.includes("Do NOT propose or name an address"), true);
check("multi: never states how many", /\b2\b|two |more than one|several/i.test(multiSentence2), false);
check("multi: never says 'on this record' about addresses", /addresses on this record/i.test(multiSentence2), false);
check("multi: still names neither address", /Hickory Point|220 S Main/.test(multiSentence2), false);
check("multi: still confirms the name", multiSentence2.includes("am I speaking with Kathy?"), true);

// A caller with no email must be described as HAVING none, not left silent.
const noEmailSentence = describeCaller(beau, "6189240485").contextSentence;
check("no email: states the absence explicitly", noEmailSentence.includes("We do NOT hold an email address for this caller"), true);
check("no email: tells it to ask normally", noEmailSentence.includes("as you would ask any caller"), true);
check("no email: forbids implying we have one", noEmailSentence.includes("never suggest that we already have one"), true);
check("no email: still no email sentence", noEmailSentence.includes("We also hold an email"), false);

// A caller WITH an email must not get the absence line.
const withEmail2 = describeCaller(billingFirst, "6185816063").contextSentence;
check("has email: no absence line", withEmail2.includes("We do NOT hold an email address"), false);
check("has email: still offers it", withEmail2.includes("tlwojcik49@gmail.com"), true);
check("has email: still gated on the name", withEmail2.includes("until the caller has confirmed they are Toni"), true);

// The two must never both appear.
for (const [label, sent] of [["no-email", noEmailSentence], ["has-email", withEmail2], ["multi", multiSentence2]] as const) {
  const both = sent.includes("We do NOT hold an email address") && sent.includes("We also hold an email for them");
  check(`${label}: not both email states at once`, both, false);
}

// do_not_service invisibility survives this pass too.
const flagged2 = describeCaller({ ...beau, do_not_service: true }, "6189240485").contextSentence;
check("flagged still identical after rewrite", flagged2, noEmailSentence);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
