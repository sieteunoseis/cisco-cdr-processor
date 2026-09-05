// Parser for NANPA's public Central Office Code Assignment report
// (tab-delimited, one row per NPA-NXX). Source:
// https://www.nanpa.com/reports/co-code-reports/cocodes_assign

const NPANXX_RE = /^\d{3}-\d{3}$/;
const ASSIGN_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function parseAssignDate(value) {
  const m = ASSIGN_DATE_RE.exec((value || "").trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function parseNpanxxLine(line) {
  const fields = line.split("\t").map((f) => f.trim());
  const [state, npaNxx, ocn, companyRaw, rateCenter, , use, assignDate] =
    fields;

  if (!npaNxx || !NPANXX_RE.test(npaNxx)) return null;

  const company = (companyRaw || "").replace(/^"|"$/g, "").trim();

  return {
    prefix: npaNxx.replace("-", ""),
    state: state || null,
    rateCenter: rateCenter || null,
    company: company || null,
    ocn: ocn || null,
    assignDate: parseAssignDate(assignDate),
    use: use || null,
  };
}

function parseNpanxxFile(text) {
  return text
    .split(/\r?\n/)
    .map(parseNpanxxLine)
    .filter((record) => record && record.use === "AS");
}

module.exports = { parseNpanxxLine, parseNpanxxFile, parseAssignDate };
