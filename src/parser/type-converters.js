function epochToDate(epoch) {
  return new Date(Number(epoch) * 1000);
}

function epochToDateNullable(epoch) {
  const val = Number(epoch);
  if (!val || val === 0) return null;
  return new Date(val * 1000);
}

function intToIp(num) {
  const val = Number(num);
  if (!val || val === 0) return null;
  return [
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff,
  ].join(".");
}

function stringToIp(str) {
  if (!str || str.trim() === "") return null;
  return str.trim();
}

function secondsToInterval(seconds) {
  const val = Number(seconds);
  if (!val || val === 0) return null;
  return `${val} seconds`;
}

function emptyToNull(str) {
  if (str === "" || str === null || str === undefined) return null;
  return str;
}

// CUCM writes some integer fields as unsigned 32-bit (e.g. numberPacketsLost
// = 4294967295 for -1), but the cdr/cmr columns are signed int4. Reinterpret
// out-of-range values as two's-complement so they fit instead of failing
// the whole file's insert.
function parseInt32(str) {
  const n = parseInt(str, 10);
  if (isNaN(n)) return null;
  if (n > 0x7fffffff && n <= 0xffffffff) return n - 0x100000000;
  return n;
}

function parseVarVQMetrics(str) {
  if (!str || str.trim() === "") return {};
  const result = {};
  for (const pair of str.split(";")) {
    const [key, value] = pair.split("=");
    if (key && value !== undefined) {
      result[key.trim()] = parseFloat(value);
    }
  }
  return result;
}

module.exports = {
  epochToDate,
  epochToDateNullable,
  intToIp,
  stringToIp,
  secondsToInterval,
  emptyToNull,
  parseInt32,
  parseVarVQMetrics,
};
