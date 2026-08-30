import { computeOfficeStatus, holidaysForYear } from "@/lib/retell/office-hours";

// Build a real instant from a Central wall-clock time. CDT = UTC-5 (Mar-Nov),
// CST = UTC-6. Passed explicitly per case so the test asserts the zone math.
const at = (iso: string) => new Date(iso);

const cases: Array<[string, string, boolean]> = [
  ["Thu 2026-08-27 10:15 CDT (mid-morning)", "2026-08-27T15:15:00Z", true],
  ["Thu 2026-08-27 06:59 CDT (before open)", "2026-08-27T11:59:00Z", false],
  ["Thu 2026-08-27 07:00 CDT (opening)", "2026-08-27T12:00:00Z", true],
  ["Thu 2026-08-27 16:59 CDT (last minute)", "2026-08-27T21:59:00Z", true],
  ["Thu 2026-08-27 17:00 CDT (closing)", "2026-08-27T22:00:00Z", false],
  ["Thu 2026-08-27 19:30 CDT (evening)", "2026-08-28T00:30:00Z", false],
  ["Sat 2026-08-29 10:00 CDT (weekend)", "2026-08-29T15:00:00Z", false],
  ["Sun 2026-08-30 10:00 CDT (weekend)", "2026-08-30T15:00:00Z", false],
  ["Mon 2026-09-07 10:00 CDT (LABOR DAY)", "2026-09-07T15:00:00Z", false],
  ["Mon 2026-05-25 10:00 CDT (MEMORIAL DAY)", "2026-05-25T15:00:00Z", false],
  ["Thu 2026-11-26 10:00 CST (THANKSGIVING)", "2026-11-26T16:00:00Z", false],
  // July 4 2026 fell on a SATURDAY, so it was federally observed Friday the 3rd.
  ["Fri 2026-07-03 10:00 CDT (OBSERVED 4th, Sat holiday)", "2026-07-03T15:00:00Z", false],
  ["Thu 2026-07-02 10:00 CDT (day before observance)", "2026-07-02T15:00:00Z", true],
  // July 4 2027 falls on a SUNDAY -> observed Monday the 5th.
  ["Mon 2027-07-05 10:00 CDT (OBSERVED 4th, Sun holiday)", "2027-07-05T15:00:00Z", false],
  ["Fri 2027-07-02 10:00 CDT (Friday before)", "2027-07-02T15:00:00Z", true],
  // Winter closure: Dec 24 through Jan 1 inclusive, every day, every year.
  ["Sat 2027-12-25 10:00 CST (inside closure)", "2027-12-25T16:00:00Z", false],
  ["Mon 2027-12-27 10:00 CST (inside closure, a MONDAY)", "2027-12-27T16:00:00Z", false],
  ["Wed 2027-12-29 10:00 CST (inside closure, midweek)", "2027-12-29T16:00:00Z", false],
  ["Thu 2027-12-30 10:00 CST (inside closure)", "2027-12-30T16:00:00Z", false],
  ["Thu 2027-12-23 10:00 CST (last day before closure)", "2027-12-23T16:00:00Z", true],
  ["Mon 2028-01-03 10:00 CST (first day back)", "2028-01-03T16:00:00Z", true],
  // 2029-30: closure ends Tue Jan 1, so the team is back Wed Jan 2.
  ["Tue 2030-01-01 10:00 CST (New Year's Day)", "2030-01-01T16:00:00Z", false],
  ["Wed 2030-01-02 10:00 CST (back to work)", "2030-01-02T16:00:00Z", true],
  // Jan 1 2034 is a SUNDAY -> federally observed Monday Jan 2, just outside
  // the closure block, so Monday is closed too.
  ["Mon 2034-01-02 10:00 CST (observed New Year)", "2034-01-02T16:00:00Z", false],
  ["Tue 2034-01-03 10:00 CST (back to work)", "2034-01-03T16:00:00Z", true],
  ["Thu 2026-12-24 10:00 CST (closure begins)", "2026-12-24T16:00:00Z", false],
  ["Wed 2026-12-23 10:00 CST (last day before closure)", "2026-12-23T16:00:00Z", true],
  ["Thu 2026-12-31 10:00 CST (inside closure)", "2026-12-31T16:00:00Z", false],
  ["Fri 2027-01-01 10:00 CST (closure ends)", "2027-01-01T16:00:00Z", false],
  ["Wed 2026-01-14 23:30 CST (late night)", "2026-01-15T05:30:00Z", false],
];

let failed = 0;
for (const [label, iso, expectOpen] of cases) {
  const s = computeOfficeStatus(at(iso));
  const ok = s.open === expectOpen;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      open=${s.open} (expected ${expectOpen})${s.holiday ? ` holiday=${s.holiday}` : ""}\n      next: ${s.nextOpenSentence}`);
}

console.log("\n--- observed closure dates ---");
for (const y of [2026, 2027, 2028, 2029]) {
  const h = [...holidaysForYear(y).entries()].sort();
  console.log(y, h.map(([d, n]) => `${d} ${n}`).join(" | "));
}

console.log("\n--- sample injected values (after hours Friday) ---");
console.log(JSON.stringify(computeOfficeStatus(at("2026-08-28T23:10:00Z")), null, 2));

console.log("\n--- sample injected values (mid-closure, Dec 28 2026) ---");
console.log(JSON.stringify(computeOfficeStatus(at("2026-12-28T16:00:00Z")), null, 2));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
