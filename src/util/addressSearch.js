/**
 * Finding a street or an address from what someone types: "shotover", "12 shotover st",
 * "Shotover Street 12, Queenstown".
 *
 * The streets come from data/addresses.json (scripts/data/convert-addresses.mjs; Toitū Te Whenua
 * LINZ, NZ Addresses): each with its name, its suburb or town, a point on it, and its numbers as
 * [label, lon, lat, label, lon, lat…]. Typing is forgiving: capitals, long vowels (Wānaka) and
 * punctuation do not matter, the usual short forms are understood (st, rd, ave…), words can be only
 * begun, and the number can come before or after the street.
 *
 * Pure: plain data in and out (src/tools/addressSearch.js is the search box).
 */

/** Road words and their short forms, written the same way on both sides ("saint" too is "st"). */
const SHORT = {
  street: 'st', saint: 'st', road: 'rd', avenue: 'ave', av: 'ave', place: 'pl', crescent: 'cres', cr: 'cres', drive: 'dr', terrace: 'tce', ter: 'tce',
  lane: 'ln', court: 'ct', highway: 'hwy', close: 'cl', parade: 'pde', boulevard: 'blvd', esplanade: 'esp', heights: 'hts', grove: 'gr', square: 'sq', mount: 'mt',
};

/** Lower case, no long vowels or punctuation, road words in their short form: ["12", "shotover", "st"]. */
function words(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ -]+/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => SHORT[word] ?? word);
}

/** "12", "12a", "1/14": a house number as typed. */
const isNumber = (word) => /^\d+[a-z]?(\/\d+[a-z]?)?$/.test(word);
/** The number a label stands at: 14 for "14", "14A", "1/14" and "2/14". */
const baseOf = (label) => /(\d+)[a-z]?$/i.exec(String(label))?.[1];

/**
 * @param {{ streets: { name: string, place: string, at: number[], numbers: (string | number)[] }[] }} data
 * @returns {{ search: (query: string, limit?: number) => { title: string, subtitle: string, at: number[], street: boolean }[] }}
 */
export function createAddressSearch(data) {
  const streets = data.streets.map((street) => ({ street, nameWords: words(street.name), placeWords: words(street.place) }));

  /** How well a street answers the words typed (higher is better), or -1 when it does not. */
  function score({ nameWords, placeWords }, typed) {
    let total = 0;
    for (const [i, word] of typed.entries()) {
      const inName = nameWords.findIndex((candidate) => candidate.startsWith(word));
      if (inName >= 0) total += (inName === i ? 4 : 2) + (nameWords[inName] === word ? 1 : 0); // in its place, and whole, count for more
      else if (placeWords.some((candidate) => candidate.startsWith(word))) total += 1;
      else return -1;
    }
    return total - nameWords.length * 0.1; // of two that match alike, the shorter name
  }

  function search(query, limit = 8) {
    const all = words(query);
    const number = all.find(isNumber);
    const typed = all.filter((word) => word !== number && !['unit', 'flat', 'no'].includes(word));
    if (!typed.length) return [];

    /** The addresses of a street at the number typed; a plain number also brings its units and letters ("14": "1/14", "14A"). */
    function addressesOn(street) {
      if (!number) return [];
      const found = [];
      for (let i = 0; i < street.numbers.length; i += 3) {
        const label = String(street.numbers[i]);
        const same = label.toLowerCase() === number;
        if (same || (!/[a-z/]/.test(number) && baseOf(label) === number)) found.push({ label, same, at: [street.numbers[i + 1], street.numbers[i + 2]] });
      }
      return found.sort((a, b) => Number(b.same) - Number(a.same));
    }

    const matches = streets
      .map((entry) => ({ entry, score: score(entry, typed), found: addressesOn(entry.street) }))
      .filter((match) => match.score >= 0)
      // The street that answers the words best comes first, whether it has the number or not (a street
      // named Shotover before the streets of a suburb named Shotover); of streets that match alike, the
      // one that has the number, then the one with more addresses: the main street before the cul-de-sac.
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.found.length > 0) - Number(a.found.length > 0) ||
          b.entry.street.numbers.length - a.entry.street.numbers.length ||
          a.entry.street.name.localeCompare(b.entry.street.name),
      );

    const results = [];
    for (const { entry, found } of matches) {
      const { street } = entry;
      if (!number) results.push({ title: street.name, subtitle: street.place, at: street.at, street: true });
      else if (!found.length) results.push({ title: street.name, subtitle: `${street.place} – no number ${number.toUpperCase()} on record: the street`, at: street.at, street: true });
      else for (const address of found) results.push({ title: `${address.label} ${street.name}`, subtitle: street.place, at: address.at, street: false });
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  return { search };
}
