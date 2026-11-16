/**
 * "Stop the flow": what it takes to work on a sewer, read off the network of the district
 * (data/wastewater-stop.json, put together by src/util/sewerNetwork.js). The design, with every sentence
 * these answers are for, is docs/designs/2026-11-15-shut-the-sewer.md.
 *
 * A GRAVITY SEWER has no valves: the flow is held back with a plug in a manhole above the work and
 * pumped round to a manhole below it (`stopGravity`).
 *   - Above the work: the manhole at the upper end of the pipe, when it can take a plug; otherwise up
 *     every pipe that drains into that point, branch by branch, to the first manhole that can, saying
 *     what was passed. A branch with nothing above it needs no plug. Only what the council records as a
 *     manhole in use can take one (`usable`); a manhole the crew "can't use" is walked past.
 *   - Below the work: down the way the sewage takes to the first manhole that can be used – the place
 *     to pump round to. Every branch that joins on the way gets its own plug. A pump station or the
 *     treatment plant first: there is no manhole to pump round to.
 *   - The stretch is what lies between: its length, the property connections on it (they keep
 *     discharging into it), the pumps that discharge into it (to stop or allow for).
 *   - What keeps arriving is everything the record lets arrive: what is above the plugs and – until
 *     nothing is added – every pump station or pump that discharges into that, with everything that
 *     drains to it; what pumps deliver into the stretch itself, which no plug holds back; and, where a
 *     manhole upstream has two ways out, what is above it on the way the tool does not follow too (it
 *     may come either way: counted, and said). From the number of connections that drain to the work –
 *     those on the stretch included – an estimate of the flow: labelled as one, with its assumption.
 *   - Where it drains to: the way down to the first pump station or the plant, then pump after pump to
 *     the plant, out of the mapped area, or to where the map shows no way on, with the reason.
 *
 * A PUMPED MAIN is taken out by stopping the pumps that feed it, and only then by valves
 * (`stopPressure`).
 *   - The stretch: from the tapped point along the pumped pipes, each way to the first line valve (one
 *     that "won't close" is passed), a pump station, the place the main discharges, or a dead end.
 *   - The pumps to stop: every station on the pressure system – first those whose way to their
 *     discharge runs through the tapped pipe – the pumps the map has no station for, and the sewers that
 *     join the main, with the stations that pump into them. What the council records of a valve's
 *     position never shortens that list.
 *   - Each valve round the stretch with its side: towards the pumps, towards the discharge, or on a
 *     branch. The properties that pump into the stretch, and those behind its valves, which lose their
 *     way out while they are closed. Where it discharges and the way on from there. What arrives at each
 *     station while it is stopped.
 *
 * Every doubt the data holds about an answer – a break in the drawing, a main recorded as removed, a
 * pipe taken against its record or with none, a pump with no outline – comes back in `doubts`, each with
 * its place, so that the panel can say it and the map can mark it.
 *
 * Pure: plain data in and out; the only import is how the build measures along a pipe, so that the page
 * measures the same. Everything is approximate: a proposal to check on site, never an instruction.
 */
import { PIECE_MARK, SEWER_DEFAULTS, measureLine, pointAt, projectOnLine, projector } from './sewerNetwork.js';

/** What the answers are worked out with (the page gives its own in CONFIG.sewerStop). */
export const STOP_DEFAULTS = {
  maxPlugs: 40, // the search for places to plug gives up beyond this many…
  maxStretchPipes: 1500, // …or when the stretch has grown to this many pipes with no manhole to stop at
  litresPerConnectionDay: 750, // QLDC's design figures: 250 litres a person a day, 3 people a dwelling
  peakFactor: 2.5, // the daily peak over the average of a dry day
  bigPipeMm: 300, // other councils treat plugging a pipe larger than this as high-risk work
  wideLampholeMm: 600, // a "lamphole" recorded this wide may be a manhole
  blockProperties: 50, // QLDC's standard: the most properties behind the valves of one block of a pressure sewer
  nearValveM: 15, // a valve on no pipe, this close to the stretch, is shown with it
};

// A piece of main as the file holds it: [main, fromM, toM, a, b, dir, system, run, mark].
const MAIN = 0;
const FROM = 1;
const TO = 2;
const A = 3;
const B = 4;
const DIR = 5;
const SYSTEM = 6;
const RUN = 7;
const MARK = 8;

const round1 = (value) => Math.round(value * 10) / 10;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

// ---- Finding one's way in the network ------------------------------------------------------------

// What is looked up again and again, worked out once for each network: the first answer pays for it.
const prepared = new WeakMap();

function prepare(network) {
  const known = prepared.get(network);
  if (known) return known;
  const { mains, pieces, junctions, links, valves, connections, stations, outlets, systems, splits } = network;
  const piecesAt = junctions.map(() => []);
  const piecesOfMain = mains.map(() => []);
  pieces.forEach((piece, i) => {
    piecesAt[piece[A]].push(i);
    if (piece[B] !== piece[A]) piecesAt[piece[B]].push(i);
    piecesOfMain[piece[MAIN]].push(i);
  });
  const linksAt = junctions.map(() => []);
  links.forEach((link, k) => {
    linksAt[link.a].push(k);
    linksAt[link.b].push(k);
  });
  /** The junction the way down of a junction leads to next. */
  const below = (j) => {
    const { down } = junctions[j];
    if (down === undefined) return undefined;
    if (down < 0) return links[-down - 1].a === j ? links[-down - 1].b : links[-down - 1].a;
    return pieces[down][A] === j ? pieces[down][B] : pieces[down][A];
  };
  // Which junctions drain straight into each junction, by the one way down each of them has.
  const above = junctions.map(() => []);
  junctions.forEach((_, j) => {
    const to = below(j);
    if (to !== undefined) above[to].push(j);
  });
  // A main in several parts has several entries under one id; a pipe recorded twice has two ids.
  const mainsById = new Map();
  const idsOf = mains.map((main) => [main.id]);
  mains.forEach((main, m) => {
    mainsById.set(main.id, [...(mainsById.get(main.id) ?? []), m]);
    if (main.twin !== undefined) idsOf[main.twin].push(main.id);
  });
  const connectionsOf = pieces.map(() => []);
  connections.forEach((connection, c) => connectionsOf[connection[0]].push(c));
  const valvesOf = pieces.map(() => []);
  valves.forEach((valve, v) => {
    if (valve.piece >= 0) valvesOf[valve.piece].push(v);
  });
  // Where each pressure system lets go, and what discharges at each junction: each pump at the one
  // discharge chosen for it – and the system itself wherever else its mains are recorded as ending on a
  // sewer or in the well of a station (a second main beside the first; a system with no pump on the map,
  // fed by the pumps of the properties on it). What the system brings may arrive there too.
  // A dead end that a branch is recorded as running into ("the map does not show where it discharges") is
  // where a system lets go only when the map shows no other place: beside a real discharge it is a dead end.
  const ends = systems.map((system) => !system.discharges.some((discharge) => discharge.kind !== 'nowhere'));
  const letsGoAt = (discharge) => discharge.kind !== 'nowhere' || ends[discharge.system];
  const dischargesOf = systems.map((system, x) => new Map(system.discharges.filter((discharge) => letsGoAt({ ...discharge, system: x })).map((discharge) => [discharge.junction, discharge])));
  const dischargingAt = new Map();
  const feeds = (junction, source) => dischargingAt.set(junction, [...(dischargingAt.get(junction) ?? []), source]);
  const placeOfDischarge = ({ kind, station, junction }) => (kind === 'station' ? `station ${station}` : `junction ${junction}`);
  const chosen = new Set(); // 'system, place': a pump's own discharge is there
  const pumpsTo = (discharge, source) => {
    if (!discharge) return;
    feeds(discharge.junction, source);
    chosen.add(`${discharge.system}, ${placeOfDischarge(discharge)}`);
    if (discharge.system >= 0 && letsGoAt(discharge) && !dischargesOf[discharge.system].has(discharge.junction)) dischargesOf[discharge.system].set(discharge.junction, discharge);
  };
  stations.forEach((station, s) => pumpsTo(station.discharge, { station: s }));
  outlets.forEach((outlet, k) => pumpsTo(outlet.discharge, { outlet: k }));
  systems.forEach((system, x) => {
    for (const discharge of system.discharges) if ((discharge.kind === 'gravity' || discharge.kind === 'station') && !chosen.has(`${x}, ${placeOfDischarge(discharge)}`)) feeds(discharge.junction, { system: x });
  });
  // Where the pumped main of a pump with no record starts.
  const startsAt = systems.map(() => new Map());
  outlets.forEach((outlet, k) => {
    if (outlet.kind === 'pump' || outlet.kind === 'joins') startsAt[outlet.system].set(outlet.from ?? outlet.junction, k);
  });
  const index = { piecesAt, piecesOfMain, linksAt, above, mainsById, idsOf, connectionsOf, valvesOf, dischargesOf, dischargingAt, startsAt, splitAt: new Map(splits.map((split) => [split.junction, split])), measured: new Map() };
  prepared.set(network, index);
  return index;
}

/** A main measured as the build measured it: metres along it are the metres of its pieces, valves and connections. */
function measuredMain(network, m) {
  const { measured } = prepare(network);
  if (!measured.has(m)) {
    const { line } = network.mains[m];
    const projection = projector(line[0]);
    measured.set(m, { projection, ...measureLine(line, projection) });
  }
  return measured.get(m);
}

/** The place [lon, lat] at a distance along a main. */
function placeOn(network, m, alongM) {
  const measured = measuredMain(network, m);
  return measured.projection.toLonLat(pointAt(measured, alongM)).map(round6);
}

/** Where a junction is, as [lon, lat]: the end of one of its pipes. */
export function junctionPlace(network, j) {
  const { piecesAt, linksAt } = prepare(network);
  const [i] = piecesAt[j];
  if (i !== undefined) return placeOn(network, network.pieces[i][MAIN], network.pieces[i][A] === j ? network.pieces[i][FROM] : network.pieces[i][TO]);
  const [k] = linksAt[j];
  return k === undefined ? undefined : network.links[k].at;
}

/** The place in the middle of a piece. */
const middleOf = (network, i) => placeOn(network, network.pieces[i][MAIN], (network.pieces[i][FROM] + network.pieces[i][TO]) / 2);

const isSewer = (piece) => piece[SYSTEM] < 0 && piece[MARK] === 0 && piece[A] !== piece[B];
/** The junction a piece runs from and the one it runs to, as the tool takes it (undefined: cannot be told). */
const upperOf = (piece) => (piece[RUN] === 1 ? piece[A] : piece[RUN] === -1 ? piece[B] : undefined);
const lowerOf = (piece) => (piece[RUN] === 1 ? piece[B] : piece[RUN] === -1 ? piece[A] : undefined);
const otherEnd = (ends, j) => (ends.a === j ? ends.b : ends.a);
/** How the way a pipe is taken to run stands to the council's record of it. */
const directionOf = (piece) => (piece[RUN] === 0 ? 'unknown' : piece[DIR] === 0 ? 'inferred' : piece[RUN] === piece[DIR] ? 'record' : 'against');

/** The street of a junction: of a manhole on it, else of a pipe at it. */
function streetAt(network, j) {
  const { piecesAt } = prepare(network);
  for (const h of network.junctions[j].manholes ?? []) if (network.manholes[h].street) return network.manholes[h].street;
  for (const i of piecesAt[j]) if (network.mains[network.pieces[i][MAIN]].street) return network.mains[network.pieces[i][MAIN]].street;
  return undefined;
}

/** What the panel says of the tapped pipe itself. */
function pipeOf(network, i) {
  const { idsOf } = prepare(network);
  const m = network.pieces[i][MAIN];
  const { id, type, diameter, street, owner, small, link } = network.mains[m];
  return { main: m, id, type, diameter, street, owner, small, link, stub: network.pieces[i][MARK] === PIECE_MARK.stub || undefined, recordedTwice: idsOf[m].length > 1 ? idsOf[m] : undefined };
}

/**
 * Whose pipework a piece is: { station } or { plant }. Most pipework lies between two junctions of the
 * place; a pipe that leaves a station and comes back to it by a point just outside has an end that is
 * nobody's, so the pipework is followed to the place.
 */
function placeOfPipework(network, i) {
  const { pieces, junctions } = network;
  const { piecesAt } = prepare(network);
  const seen = new Set([i]);
  for (const waiting = [i]; waiting.length; ) {
    const piece = pieces[waiting.shift()];
    for (const j of [piece[A], piece[B]]) {
      if (junctions[j].station !== undefined) return { station: junctions[j].station };
      if (junctions[j].plant !== undefined) return { plant: junctions[j].plant };
      for (const next of piecesAt[j]) {
        if (seen.has(next) || pieces[next][MARK] !== PIECE_MARK.pipework) continue;
        seen.add(next);
        waiting.push(next);
      }
    }
  }
  return {};
}

/**
 * The piece of a main at a place (a tap on the map), or in its middle without one – the counterpart of
 * `segmentAt` of the water tool.
 * @param {object} network  data/wastewater-stop.json, read with `unpackSewerNetwork`
 * @param {number|string} pipeId  the council's id of the main
 * @param {number[]} [lonLat]
 * @returns {{ piece: number, main: number, alongM: number, kind: 'gravity' | 'pumped' | 'pipework' | 'leavesStation',
 *   station?: number, plant?: number, recordedTwice?: number[] } | undefined}
 *   undefined: the main is not in the network (a pipe newer than the official data; a vent or overflow
 *   pipe, which the tool does not follow). kind: 'gravity' is for `stopGravity`, 'pumped' for
 *   `stopPressure`; 'pipework' is a pipe of that station or plant itself and 'leavesStation' one recorded as
 *   leaving that station by gravity (an overflow, a bypass): the tool follows neither. recordedTwice: the
 *   ids the council records this one pipe under.
 */
export function pieceAt(network, pipeId, lonLat) {
  const { mainsById, piecesOfMain, idsOf } = prepare(network);
  let best;
  for (const given of mainsById.get(pipeId) ?? []) {
    const m = network.mains[given].twin ?? given; // a second record has no pieces of its own
    const measured = measuredMain(network, m);
    const near = lonLat ? projectOnLine(measured, measured.projection.toXY(lonLat)) : { alongM: measured.length / 2, distance: 0 };
    for (const i of piecesOfMain[m]) {
      const [, from, to] = network.pieces[i];
      const off = near.distance + (near.alongM < from ? from - near.alongM : near.alongM > to ? near.alongM - to : 0);
      if (!best || off < best.off) best = { piece: i, main: m, alongM: round1(Math.min(to, Math.max(from, near.alongM))), off };
    }
  }
  if (!best) return undefined;
  const piece = network.pieces[best.piece];
  const [a, b] = [network.junctions[piece[A]], network.junctions[piece[B]]];
  const found = { piece: best.piece, main: best.main, alongM: best.alongM, kind: 'gravity' };
  if (piece[MARK] === PIECE_MARK.pipework) Object.assign(found, { kind: 'pipework' }, placeOfPipework(network, best.piece));
  else if (piece[MARK] === PIECE_MARK.leavesStation) Object.assign(found, { kind: 'leavesStation', station: (piece[DIR] === 1 ? a : b).station });
  else if (piece[SYSTEM] >= 0) found.kind = 'pumped';
  if (idsOf[best.main].length > 1) found.recordedTwice = idsOf[best.main];
  return found;
}

// ---- Doubts --------------------------------------------------------------------------------------

/** A link the map does not draw, crossed by an answer: a break in the drawing, a main recorded as removed… */
const linkDoubt = (network, k, where) => ({ kind: 'link', where, link: k, at: network.links[k].at });
/** A main taken against the council's record of it. */
const againstDoubt = (network, i, where) => ({ kind: 'against', where, piece: i, id: network.mains[network.pieces[i][MAIN]].id, at: middleOf(network, i) });
/** Pipes with no direction in the council's record, taken to run on. */
const noDirectionDoubt = (network, list, where) => ({ kind: 'noDirection', where, pieces: list, ids: [...new Set(list.map((i) => network.mains[network.pieces[i][MAIN]].id))], at: middleOf(network, list[0]) });

/** Each doubt once: three stations that pump through one break in the drawing meet the same one. */
function distinct(doubts) {
  const seen = new Set();
  return doubts.filter(({ kind, link, id, ids, junction, station, outlet }) => {
    const key = [kind, link, id, ids, junction, station, outlet].join('|');
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

/** The doubts of a pumped way from a pump to where it discharges. */
function dischargeDoubts(network, discharge, where) {
  const doubts = [];
  const unknown = [];
  for (const step of discharge.via) {
    if (step < 0) doubts.push(linkDoubt(network, -step - 1, where));
    else if (network.pieces[step][DIR] === 0) unknown.push(step);
    else if (network.pieces[step][RUN] === -network.pieces[step][DIR]) doubts.push(againstDoubt(network, step, where));
  }
  if (unknown.length) doubts.push(noDirectionDoubt(network, unknown, where));
  // The map shows no way to this discharge but past a valve recorded closed: the record of a valve is not proof.
  for (const v of discharge.closed ?? []) doubts.push({ kind: 'closedValve', where, valve: v, id: network.valves[v].id, at: network.valves[v].at });
  return doubts;
}

// ---- The way on ----------------------------------------------------------------------------------

/** Where a pumped main lets go, as the panel names it. */
function describeDischarge(network, discharge) {
  const { junction, kind, station, plant, beyond, lengthM, via, system, closed } = discharge;
  return { kind, junction, manholes: network.junctions[junction].manholes ?? [], street: streetAt(network, junction), station, plant, beyond, lengthM, via, system, closed };
}

/**
 * The way on from a junction: by gravity to where the sewers first stop, then pump after pump.
 * @returns {{ from: number, steps: object[], end: 'plant' | 'leaves' | 'none', plant?: number, beyond?: object, why?: object, doubts: object[] }}
 *   steps, in order:
 *     { kind: 'sewer', from, to, lengthM, by } – by gravity between two junctions; by: the pieces, a link as -(index + 1)
 *     { kind: 'station', station, junction, inferred?, discharge } – pumped on by that station
 *     { kind: 'pump', outlet, junction, manholes, gapM?, discharge } – by a pump that is not on the map
 *     { kind: 'joins', outlet, junction, street, discharge } – the sewers end on a pumped main, which carries it on
 *     discharge: { kind: 'gravity' | 'station' | 'plant' | 'leaves' | 'nowhere', junction, manholes, street, station?, plant?, beyond?, lengthM, via }
 *   end: the treatment plant; 'leaves' the mapped area (beyond: { id, diameter, lengthM } of the council's
 *     main that carries on, when one does); or 'none' – no way on, with why: { reason, junction, manholes, … }
 *     reason: 'nothing' (nothing is recorded beyond), 'near' (it ends nearM from another main), 'inside'
 *     (a place out of use: name), 'private' (a private network), 'noMain' (a station with no pumped main in
 *     use), 'mainEnds' (the pumped main just ends: street), 'noDischarge', 'loop' (back to a pump already
 *     passed), 'noWayDown' (a pipe on no way down)
 */
function wayOn(network, from) {
  const where = 'way';
  const { junctions, pieces, links, stations, outlets } = network;
  const { splitAt } = prepare(network);
  const steps = [];
  const doubts = [];
  const finish = (end, more = {}) => ({ from, steps, end, ...more, doubts });
  const noWay = (reason, junction, more = {}) => finish('none', { why: { reason, junction, manholes: junctions[junction].manholes ?? [], ...more } });
  const passed = new Set();
  let j = from;
  for (;;) {
    // By gravity, as far as the sewers go.
    const by = [];
    const unknown = [];
    let lengthM = 0;
    let at = j;
    for (let guard = 0; guard <= junctions.length && junctions[at].down !== undefined; guard += 1) {
      const { down } = junctions[at];
      const split = splitAt.get(at);
      if (split?.followed === down) doubts.push({ kind: 'split', where, junction: at, manholes: junctions[at].manholes ?? [], followed: down, other: split.other, diameter: network.mains[pieces[down][MAIN]].diameter, at: junctionPlace(network, at) });
      by.push(down);
      if (down < 0) {
        doubts.push(linkDoubt(network, -down - 1, where));
        lengthM += links[-down - 1].lengthM;
        at = otherEnd(links[-down - 1], at);
      } else {
        const piece = pieces[down];
        if (piece[DIR] === 0) unknown.push(down);
        else if (piece[RUN] === -piece[DIR]) doubts.push(againstDoubt(network, down, where));
        lengthM += piece[TO] - piece[FROM];
        at = piece[A] === at ? piece[B] : piece[A];
      }
    }
    if (unknown.length) doubts.push(noDirectionDoubt(network, unknown, where));
    if (by.length) steps.push({ kind: 'sewer', from: j, to: at, lengthM: round1(lengthM), by });
    const end = junctions[at];
    if (end.plant !== undefined) return finish('plant', { plant: end.plant });

    // Then the pump that takes it on, if there is one.
    let pump; // as the network holds it
    let step; // what is said of it
    let key;
    if (end.station !== undefined) {
      pump = stations[end.station];
      if (end.beside !== undefined) doubts.push({ kind: 'beside', where, junction: at, manholes: end.manholes ?? [], station: end.station, metres: end.beside, at: junctionPlace(network, at) });
      if (pump.noMain) return noWay('noMain', at, { station: end.station });
      if (pump.inferred) doubts.push({ kind: 'inferredPump', where, station: end.station, how: pump.inferred, at: pump.at });
      key = `S${end.station}`;
      step = { kind: 'station', station: end.station, junction: at, inferred: pump.inferred };
    } else if (end.outlet !== undefined) {
      pump = outlets[end.outlet];
      if (pump.kind === 'leaves') return finish('leaves', { beyond: pump.id === undefined ? undefined : { id: pump.id, diameter: pump.diameter, lengthM: pump.lengthM } });
      if (pump.kind === 'end') return noWay(pump.reason, at, { nearM: pump.nearM, name: pump.name, note: pump.note });
      if (pump.kind === 'pump') doubts.push({ kind: 'pumpNotOnMap', where, outlet: end.outlet, junction: at, manholes: end.manholes ?? [], gapM: pump.gapM, at: junctionPlace(network, at) });
      key = `O${end.outlet}`;
      step = { kind: pump.kind, outlet: end.outlet, junction: at, manholes: end.manholes ?? [], street: streetAt(network, at), gapM: pump.gapM };
    } else return noWay('noWayDown', at);
    if (passed.has(key)) return noWay('loop', at);
    passed.add(key);
    if (!pump.discharge) {
      steps.push(step);
      return noWay('noDischarge', at);
    }
    const discharge = describeDischarge(network, pump.discharge);
    steps.push({ ...step, discharge });
    doubts.push(...dischargeDoubts(network, pump.discharge, where));
    if (discharge.kind === 'leaves') return finish('leaves', { beyond: discharge.beyond });
    if (discharge.kind === 'nowhere') return noWay('mainEnds', discharge.junction, { street: discharge.street });
    // Into a sewer, the well of another station or the plant: on from there.
    j = discharge.junction;
  }
}

// ---- What is upstream of a place -----------------------------------------------------------------

/**
 * Everything that may end up at some junctions: the junctions that drain to them, the pump stations and
 * the pumps with no record that discharge into those, with what drains to them, until nothing is added.
 *
 * Every junction has one way down, but the record lets sewage leave some by a second pipe too (110
 * manholes of the district, and a few pipes with no record). What is above such a junction is counted
 * for both ways: the tool cannot tell how the flow divides, and the side to err on is more arriving. It
 * comes back in `otherWays`, to be said.
 * @param {number[]} starts  junctions
 * @param {{ except?: number[], skip?: Set<number> }} [options]  except: pressure systems not to count (those a
 *   station itself pumps into are not upstream of it); skip: pieces not to count (the stretch itself)
 * @returns {object} sewerM, pumpedM (the pumped mains on the way), connections (all), pumpedConnections,
 *   stations and pumps (outlets: pumps that are not on the map) in the order met, inflow (junctions where a
 *   pumped main comes in from outside the mapped area: what it brings is not counted), otherWays (junctions
 *   the record lets sewage leave by a pipe that runs here, though their way down is another: what is above
 *   them is counted here all the same, and may not come this way) – and `own`: the same for what arrives
 *   without passing a pump, with the stations and pumps that discharge straight into it.
 */
function catchment(network, starts, { except = [], skip } = {}) {
  const { junctions, pieces, connections, stations, outlets, systems } = network;
  const { above, piecesAt, connectionsOf, dischargingAt } = prepare(network);
  const excepted = new Set(except);
  /** The junction the way down of a junction leads to next. */
  const below = (j) => {
    const { down } = junctions[j];
    if (down === undefined) return undefined;
    return down < 0 ? otherEnd(network.links[-down - 1], j) : pieces[down][A] === j ? pieces[down][B] : pieces[down][A];
  };
  /** Whether the way down of a junction passes another: then a pipe recorded from that one back to it closes a ring. */
  const drainsThrough = (j, other) => {
    for (let at = j, guard = 0; at !== undefined && guard <= junctions.length; at = below(at), guard += 1) if (at === other) return true;
    return false;
  };
  /**
   * Grows a set of junctions up the ways down, and up every other pipe that is taken to run into it;
   * `met` is told of every pump that discharges into it.
   */
  const grow = (set, waiting, met) => {
    while (waiting.length) {
      const j = waiting.pop();
      if (set.has(j)) continue;
      set.add(j);
      for (const up of above[j]) waiting.push(up);
      for (const i of piecesAt[j]) {
        const piece = pieces[i];
        if (!isSewer(piece) || skip?.has(i) || lowerOf(piece) !== j) continue;
        const from = upperOf(piece);
        // (Its own way down is in `above`. A pipe recorded as running back up from below would close a ring: not followed.)
        if (junctions[from].down !== i && !drainsThrough(j, from)) waiting.push(from);
      }
      for (const source of dischargingAt.get(j) ?? []) met(source, waiting);
    }
  };
  /** The lengths and connections of a set of junctions and pressure systems. */
  const sums = (set, pumped) => {
    const total = { sewerM: 0, pumpedM: 0, connections: 0, pumpedConnections: 0 };
    const unsure = new Set(); // pipes whose direction cannot be told: counted once, from either end
    for (const j of set) {
      for (const i of piecesAt[j]) {
        const piece = pieces[i];
        if (!isSewer(piece) || skip?.has(i)) continue;
        // A sewer is upstream when it runs into the set.
        const lower = lowerOf(piece);
        if (lower === undefined ? unsure.has(i) : lower !== j) continue;
        unsure.add(i);
        total.sewerM += piece[TO] - piece[FROM];
        for (const c of connectionsOf[i]) {
          total.connections += 1;
          if (connections[c][2]) total.pumpedConnections += 1;
        }
      }
    }
    for (const x of pumped) {
      if (excepted.has(x)) continue;
      total.pumpedM += systems[x].lengthM;
      total.connections += systems[x].connections; // on a pumped main every connection is a pumped one
      total.pumpedConnections += systems[x].connections;
    }
    return { ...total, sewerM: round1(total.sewerM) };
  };

  /**
   * Takes note of what discharges into the set: a pump station, a pump with no record, or a pressure
   * system at a place no pump's own discharge was chosen – then whatever pumps into that system may come
   * out there too (not the system of the pump asked about: its own main is not upstream of it).
   * `deep`: with everything that drains to each pump.
   */
  const noting = (found, deep) =>
    function met(source, waiting) {
      if (source.station !== undefined) {
        if (found.stations.includes(source.station)) return;
        found.stations.push(source.station);
        if (!deep) return;
        for (const x of stations[source.station].pumpsInto) found.systems.add(x);
        waiting.push(...stations[source.station].junctions);
      } else if (source.outlet !== undefined) {
        if (found.pumps.includes(source.outlet)) return;
        found.pumps.push(source.outlet);
        if (!deep) return;
        found.systems.add(outlets[source.outlet].system);
        waiting.push(outlets[source.outlet].junction);
      } else if (!found.fed.has(source.system)) {
        found.fed.add(source.system);
        found.systems.add(source.system);
        if (!excepted.has(source.system)) for (const pump of systems[source.system].sources) met(pump, waiting);
      }
    };
  // What arrives without passing a pump, and the pumps that discharge straight into it.
  const ownJunctions = new Set();
  const feeders = { stations: [], pumps: [], systems: new Set(), fed: new Set() };
  grow(ownJunctions, [...starts], noting(feeders, false));
  // Everything: pump after pump.
  const all = new Set();
  const found = { stations: [], pumps: [], systems: new Set(), fed: new Set() };
  grow(all, [...starts], noting(found, true));
  // The junctions that are in it by a second way out only: their own way down leads elsewhere.
  const given = new Set(starts);
  const otherWays = [...all].filter((j) => !given.has(j) && junctions[j].down !== undefined && !all.has(below(j)));
  const notOnMap = (list) => list.filter((k) => outlets[k].kind === 'pump');
  return {
    ...sums(all, found.systems),
    stations: found.stations,
    pumps: notOnMap(found.pumps),
    inflow: [...found.systems].filter((x) => !excepted.has(x)).flatMap((x) => systems[x].inflow ?? []),
    otherWays,
    own: { ...sums(ownJunctions, feeders.systems), stations: feeders.stations, pumps: notOnMap(feeders.pumps) },
  };
}

/** The doubts of what is counted upstream of a place: what the map cannot count, and what is counted for two ways. */
function upstreamDoubts(network, up) {
  return [
    ...up.inflow.map((junction) => ({ kind: 'inflow', where: 'upstream', junction, at: junctionPlace(network, junction) })),
    ...up.otherWays.map((junction) => ({ kind: 'otherWayAbove', where: 'upstream', junction, manholes: network.junctions[junction].manholes ?? [], at: junctionPlace(network, junction) })),
  ];
}

/** What arrives at a pump station (or at a pump that is not on the map) while it is stopped. */
function arrivesAt(network, source) {
  if (source.station !== undefined) return catchment(network, network.stations[source.station].junctions, { except: network.stations[source.station].pumpsInto });
  return catchment(network, [network.outlets[source.outlet].junction], { except: [network.outlets[source.outlet].system] });
}

// ---- A gravity sewer -----------------------------------------------------------------------------

/**
 * Where to plug a gravity sewer and where to pump round to, what keeps arriving and where it drains to.
 * @param {object} network  data/wastewater-stop.json, read with `unpackSewerNetwork`
 * @param {number} piece  from `pieceAt` (kind 'gravity')
 * @param {Set<number>} [cannotUse]  manholes (index in network.manholes) that cannot be found, opened or plugged
 * @param {object} [options]  any of STOP_DEFAULTS, and alongM: where on the piece the work is (from `pieceAt`;
 *   its middle without)
 * @returns {object}
 *   kind: 'gravity'; piece; alongM; pipe: { main, id, type, diameter, street, owner?, recordedTwice? }
 *   direction: 'record' (it runs as the council records), 'against' (taken against its record – check),
 *     'inferred' (no direction recorded: taken from the pipes round it) or 'unknown' – then only `ends` is
 *     given besides: [{ junction, manholes }] the usable manholes at its two ends
 *   upper, lower: the junctions it runs from and to
 *   plugs: [{ junction, manholes (one, or the two recorded at that spot), pipe (the piece that runs on
 *     towards the work: the one to plug) or link, diameter?, distanceM (along the pipes above the work; for a
 *     branch, from where it joins), branch?: { joinsM } (it joins the stretch that far below the work),
 *     otherWay? (the record lets sewage leave that manhole by another pipe too – this piece, its way down:
 *     what arrives there need not come towards the work), passed: [point] (what was walked past on the way
 *     to it) }] – above the work first, nearest first
 *   pumpTo: { junction, distanceM, passed } and manholes (the place to pump round to – with station or plant
 *     when it is the inlet manhole of one), or only station or plant (the stretch runs straight into it: no
 *     manhole to pump round to), or none: true (no manhole below the work on the map)
 *   passed: every point walked past, [{ junction, manhole?, cannotUse?, mayBeManhole? }] – no manhole: a pipe
 *     junction with none; cannotUse: a manhole the crew cannot use; mayBeManhole: a wide "lamphole"
 *   heads: the junctions where a branch ends with nothing above it – no plug is needed there
 *   cannotUse: the manholes of `cannotUse` that were come to
 *   limited: the search stopped (very many branches)
 *   stretch: { pieces (the tapped one first), links, lengthM, connections, pumpedConnections, connectionsAt
 *     ([lon, lat] of each), valves (recorded on these sewers: one may hold the flow) }
 *   pumps: what pumps into the stretch: [{ station | outlet | system, junction, receives? (what arrives at
 *     that pump: see `stopPressure`), connections? (the properties on that pressure system) }] – system: a
 *     pressure system that ends on the stretch where no pump's own discharge is (a second main beside the
 *     first; a pressure sewer with no pump station): what pumps into it is in network.systems[system].sources
 *   arriving: what keeps arriving – above the plugs, and through what pumps into the stretch itself: {
 *     sewerM, pumpedM, connections, pumpedConnections, above and into (those four figures for what is above
 *     the plugs, and for what is pumped into the stretch: no plug holds that back),
 *     stations, pumps (not on the map), inflow, otherWays, own (without what pumps bring), atLeast (part of
 *     what is upstream is not counted: a pumped main from outside the mapped area), bothWays (part of it is
 *     counted though it may go another way: a manhole upstream has two ways out), nothing (nothing joins
 *     above on the map) } – where a plug has another way out, what arrives at it is counted all the same
 *   estimate: { connections, litresPerDay, averageLps, peakLps } – an estimate, never a measurement, for all
 *     that drains to the work: what keeps arriving and the connections on the stretch itself
 *   way: where it drains to from the place to pump round to (see `wayOn`)
 *   flags: { bigPipe, pumpStationUpstream } – what other councils treat as high-risk plugging
 *   doubts: [{ kind, where: 'pipe' | 'stretch' | 'upstream' | 'way', at: [lon, lat], … }] – kind: 'link'
 *     (link: index in network.links), 'against' (id), 'noDirection' (ids), 'split' (junction, manholes,
 *     diameter of the pipe followed), 'beside' (a manhole taken as the inlet of a station: metres),
 *     'pumpNotOnMap' (outlet, manholes, gapM), 'inferredPump' (station, how: taken as the pump of a main with
 *     no recorded direction – 'noDirection' – or of one recorded as running into it – 'againstRecord'), 'otherWay' (a junction of the stretch has another way out: by), 'inflow' (a pumped
 *     main comes in from outside the mapped area: what it brings is not counted), 'otherWayAbove' (the
 *     record lets sewage leave that junction two ways, and its way down leads elsewhere: what is above it
 *     is counted as arriving here all the same),
 *     'closedValve' (id: the only way from a pump to its discharge passes a valve recorded closed)
 */
export function stopGravity(network, piece, cannotUse = new Set(), options = {}) {
  const o = { ...STOP_DEFAULTS, ...options };
  const { pieces, junctions, mains, manholes, links, valves, connections } = network;
  const { piecesAt, above, dischargingAt, connectionsOf, valvesOf } = prepare(network);
  const tapped = pieces[piece];
  const alongM = Math.min(tapped[TO], Math.max(tapped[FROM], options.alongM ?? (tapped[FROM] + tapped[TO]) / 2));
  const answer = { kind: 'gravity', piece, alongM, pipe: pipeOf(network, piece), direction: directionOf(tapped) };
  const met = new Set(); // manholes of `cannotUse` that were come to
  /** The manholes of a junction that can take a plug. */
  const usable = (j) => {
    const holes = junctions[j].manholes ?? [];
    for (const h of holes) if (cannotUse.has(h)) met.add(h);
    return holes.filter((h) => manholes[h].usable && !cannotUse.has(h));
  };
  if (answer.direction === 'unknown') {
    // On no way down and with no record: all that can be shown is the manholes at its two ends.
    return { ...answer, ends: [tapped[A], tapped[B]].map((junction) => ({ junction, manholes: usable(junction) })), doubts: [] };
  }
  const upper = upperOf(tapped);
  const lower = lowerOf(tapped);
  const doubts = [];
  if (answer.direction === 'against') doubts.push(againstDoubt(network, piece, 'pipe'));

  const stretch = new Set([piece]);
  const stretchLinks = new Set();
  const inside = new Set(); // the junctions of the stretch that are passed: nothing is plugged there
  const plugs = [];
  const pumps = [];
  const heads = new Set();
  const passedAbove = [];
  let limited = false;

  /** What stands at a junction that cannot take a plug. */
  const cannotPlug = (j) => {
    const holes = junctions[j].manholes ?? [];
    if (!holes.length) return [{ junction: j }];
    return holes
      .filter((h) => !manholes[h].usable || cannotUse.has(h))
      .map((h) => {
        const point = { junction: j, manhole: h };
        if (manholes[h].usable) point.cannotUse = true;
        else if (/^Lamphole/.test(manholes[h].type) && manholes[h].diameter >= o.wideLampholeMm) point.mayBeManhole = true;
        return point;
      });
  };
  /** The pumps that discharge at a junction inside the stretch: to stop, or to allow for. */
  const pumpsInto = (j) => {
    for (const source of dischargingAt.get(j) ?? []) {
      if (source.system !== undefined) pumps.push({ system: source.system, junction: j, connections: network.systems[source.system].connections });
      else pumps.push({ ...source, junction: j, receives: arrivesAt(network, source) });
    }
  };
  /** What brings sewage to a junction, the pipe `not` apart: the sewers that run into it, the links that lead to it. */
  const arrivals = (j, not) => [
    ...piecesAt[j].filter((i) => i !== not && isSewer(pieces[i]) && lowerOf(pieces[i]) === j).map((i) => ({ by: i, from: upperOf(pieces[i]), lengthM: pieces[i][TO] - pieces[i][FROM] })),
    ...above[j].filter((up) => junctions[up].down < 0 && junctions[up].down !== not).map((up) => ({ by: junctions[up].down, from: up, lengthM: links[-junctions[up].down - 1].lengthM })),
  ];
  const take = (by) => {
    if (by < 0) {
      stretchLinks.add(-by - 1);
      doubts.push(linkDoubt(network, -by - 1, 'stretch'));
    } else stretch.add(by);
  };
  const taken = (by) => (by < 0 ? stretchLinks.has(-by - 1) : stretch.has(by));

  // Below the work first: down the way down to the first manhole that can be used. What is passed on the
  // way is inside the stretch, so that a pipe drawn from there back up to the stretch (the record holds a
  // few such loops) is not climbed out of it again.
  let pumpTo;
  const below = []; // the junctions passed: { junction, distanceM, cameBy }
  const passedBelow = [];
  for (let at = lower, cameBy = piece, belowM = tapped[RUN] === 1 ? tapped[TO] - alongM : alongM - tapped[FROM], guard = 0; guard <= junctions.length; guard += 1) {
    const junction = junctions[at];
    const place = { junction: at, distanceM: round1(belowM), passed: [...passedBelow] };
    // A manhole first, also the inlet manhole of a pump station or one inside the plant: it is a place to
    // pump round to. With none there, the stretch runs straight into the station or the plant.
    const free = usable(at);
    const facility = junction.station !== undefined ? { station: junction.station } : junction.plant !== undefined ? { plant: junction.plant } : undefined;
    if (free.length) pumpTo = { ...place, manholes: free, ...facility };
    else if (facility) pumpTo = { ...place, ...facility };
    if (pumpTo) break;
    inside.add(at);
    below.push({ junction: at, distanceM: round1(belowM), cameBy });
    passedBelow.push(...cannotPlug(at));
    const { down } = junction;
    if (down === undefined || taken(down)) {
      pumpTo = { ...place, passed: [...passedBelow], none: true };
      break;
    }
    take(down);
    cameBy = down;
    belowM += down < 0 ? links[-down - 1].lengthM : pieces[down][TO] - pieces[down][FROM];
    at = down < 0 ? otherEnd(links[-down - 1], at) : pieces[down][A] === at ? pieces[down][B] : pieces[down][A];
  }

  /** Up from a junction, branch by branch, to the first manhole that can take a plug on each. */
  function climb(first) {
    const waiting = [first];
    while (waiting.length) {
      if (plugs.length >= o.maxPlugs || stretch.size > o.maxStretchPipes) {
        limited = true;
        return;
      }
      const { junction: j, via, distanceM, passed, branch } = waiting.pop();
      if (inside.has(j)) continue; // back inside the stretch: a loop, or a second pipe to a junction already passed
      if (junctions[j].station !== undefined || junctions[j].plant !== undefined) continue; // nothing to plug inside a station
      const arriving = arrivals(j, via).filter((arrival) => !taken(arrival.by));
      if (!arriving.length && !dischargingAt.has(j)) {
        heads.add(j); // nothing above: no plug needed
        continue;
      }
      // The record lets sewage leave this junction by another pipe too, and that one is its way down:
      // what arrives here need not come towards the work. It is still counted as arriving (the safe side).
      const otherWay = junctions[j].down !== undefined && junctions[j].down !== via ? junctions[j].down : undefined;
      if (otherWay !== undefined) doubts.push({ kind: 'otherWay', where: 'stretch', junction: j, manholes: junctions[j].manholes ?? [], by: otherWay, at: junctionPlace(network, j) });
      const free = usable(j);
      if (free.length) {
        plugs.push({ junction: j, manholes: free, ...(via < 0 ? { link: -via - 1 } : { pipe: via, diameter: mains[pieces[via][MAIN]].diameter }), distanceM: round1(distanceM), ...(branch && { branch }), ...(otherWay !== undefined && { otherWay }), passed });
        continue;
      }
      inside.add(j);
      const here = cannotPlug(j);
      passedAbove.push(...here);
      pumpsInto(j);
      for (const arrival of arriving) {
        take(arrival.by);
        waiting.push({ junction: arrival.from, via: arrival.by, distanceM: distanceM + arrival.lengthM, passed: [...passed, ...here], branch });
      }
    }
  }

  // Above the work; then every branch that joins below it, climbed in the same way.
  climb({ junction: upper, via: piece, distanceM: tapped[RUN] === 1 ? alongM - tapped[FROM] : tapped[TO] - alongM, passed: [] });
  for (const { junction: j, distanceM, cameBy } of below) {
    pumpsInto(j);
    for (const arrival of arrivals(j, cameBy)) {
      if (taken(arrival.by) || limited) continue;
      take(arrival.by);
      climb({ junction: arrival.from, via: arrival.by, distanceM: arrival.lengthM, passed: [], branch: { joinsM: distanceM } });
    }
  }
  plugs.sort((p, q) => (p.branch ? 1 : 0) - (q.branch ? 1 : 0) || (p.branch?.joinsM ?? 0) - (q.branch?.joinsM ?? 0) || p.distanceM - q.distanceM);

  // The stretch: what lies between the plugs and the place to pump round to.
  const onStretch = [...stretch].flatMap((i) => connectionsOf[i]);
  const stretchValves = [...stretch].flatMap((i) => valvesOf[i]).filter((v) => !valves[v].onConnection);
  const lengthM = [...stretch].reduce((total, i) => total + pieces[i][TO] - pieces[i][FROM], 0) + [...stretchLinks].reduce((total, k) => total + links[k].lengthM, 0);

  // What keeps arriving: everything above the plugs – and what is pumped into the stretch itself, which no
  // plug holds back. Counted in one go from every junction of the stretch, so that nothing is counted twice:
  // what is above the plugs is one part of it, what is pumped into the stretch the rest.
  const plugged = plugs.map((plug) => plug.junction);
  const abovePlugs = catchment(network, plugged, { skip: stretch });
  const up = pumps.length ? catchment(network, [...plugged, ...inside], { skip: stretch }) : abovePlugs;
  doubts.push(...upstreamDoubts(network, up));
  const part = (of, less) => Object.fromEntries(['sewerM', 'pumpedM', 'connections', 'pumpedConnections'].map((key) => [key, round1(Math.max(0, of[key] - (less?.[key] ?? 0)))]));
  const arriving = { ...up, above: part(abovePlugs), into: part(up, abovePlugs), atLeast: up.inflow.length > 0, bothWays: up.otherWays.length > 0, nothing: !pumps.length && !up.sewerM && !up.pumpedM && !up.connections && !up.stations.length && !up.pumps.length };
  // The flow to allow for at the work: of everything that drains to it, the connections on the stretch too.
  const draining = arriving.connections + onStretch.length;
  const litresPerDay = draining * o.litresPerConnectionDay;

  const way = wayOn(network, pumpTo.junction);
  doubts.push(...way.doubts);
  return {
    ...answer,
    upper,
    lower,
    plugs,
    pumpTo,
    passed: [...passedAbove, ...passedBelow],
    heads: [...heads],
    cannotUse: [...met],
    limited,
    stretch: {
      pieces: [...stretch],
      links: [...stretchLinks],
      lengthM: round1(lengthM),
      connections: onStretch.length,
      pumpedConnections: onStretch.filter((c) => connections[c][2]).length,
      connectionsAt: onStretch.map((c) => placeOn(network, pieces[connections[c][0]][MAIN], connections[c][1])),
      valves: stretchValves,
    },
    pumps,
    arriving,
    estimate: { connections: draining, litresPerDay, averageLps: litresPerDay / 86400, peakLps: (litresPerDay * o.peakFactor) / 86400 },
    way,
    flags: { bigPipe: mains[tapped[MAIN]].diameter > o.bigPipeMm, pumpStationUpstream: arriving.stations.length > 0 || pumps.some((pump) => pump.station !== undefined) },
    doubts: distinct(doubts),
  };
}

// ---- A pumped main -------------------------------------------------------------------------------

/**
 * Which pumps to stop to work on a pumped main, the valves either side, where it discharges.
 * @param {object} network  data/wastewater-stop.json, read with `unpackSewerNetwork`
 * @param {number} piece  from `pieceAt` (kind 'pumped')
 * @param {Set<number>} [wontClose]  line valves (index in network.valves) that will not close
 * @param {object} [options]  any of STOP_DEFAULTS, and alongM: where on the piece the work is
 * @returns {object}
 *   kind: 'pumped'; piece; alongM; pipe: { main, id, type, diameter, street, owner?, small? (its material: a
 *     "gravity sewer" taken as a pumped pipe by its size), link?, stub? (a short pipe off a pumped main,
 *     answered as that main), recordedTwice? }
 *   direction: as for `stopGravity`
 *   system (index in network.systems); systemKind: 'stations' | 'lowPressure' (each property has its own
 *     pump) | 'pump' (only a pump that is not on the map) | 'unknown'
 *   stations: the pump stations to stop: [{ station, how, inferred?, street?, valves (recorded at it),
 *     receives (what arrives at it while it is stopped: sewerM, connections, stations… and `own`, without
 *     what other pumps bring; inflow and otherWays: what is not counted in it, and what is counted though
 *     it may go another way – each also a doubt, where: 'upstream'), discharge? }] – how: 'through' (it pumps through the tapped pipe),
 *     'sameSystem' (its pressure reaches this pipe) or 'mayPump' (which way this pipe runs cannot be told);
 *     those that pump through it first
 *   pumps: pumps that are not on the map: [{ outlet, how, junction, manholes, street?, gapM?, nowhere? (its
 *     main leads nowhere on the map), receives, discharge? }]
 *   joins: where sewers end on a main of this system and it carries them on: [{ outlet, how, junction,
 *     manholes, street?, receives }] – what they bring keeps coming, and the pump stations that pump into
 *     those sewers (receives.own.stations) are to stop or allow for like the pumps of the main
 *   stretch: { parts: [[piece, fromM, toM]], links, lengthM, connections, kits (boundary kits recorded),
 *     connectionsAt }
 *   bounds: what the stretch ends at: [{ valve, side, needed, distanceM, beyond } | { station, role: 'pumps' |
 *     'receives', junction, distanceM } | { plant, junction, distanceM } | { discharge: { kind, junction, … },
 *     junction, distanceM } | { end: junction, pump? (outlet: a pump with no record starts here), stub?, distanceM }]
 *   valves: the line valves among them, nearest first: [{ valve, side: 'pumps' | 'discharge' | 'branch',
 *     needed, distanceM, beyond: { lengthM, connections, kits, pumps, discharge } }] – beyond: what lies
 *     behind that valve; needed: something does (a pump, the discharge, a property)
 *   inside: line valves that do not bound the stretch – the mains are joined round them
 *   noLineValve: { pumps, discharge } – a pump, or the discharge, is reached with no line valve on the way
 *   wontClose: the valves of `wontClose` that were passed
 *   behind: { connections, kits, lengthM, cannotBeTold? } – the properties behind the valves, which have no
 *     other way out while they are closed
 *   block: { properties, limit, over } – the properties on the stretch and behind it, against QLDC's standard
 *   onSystem: { connections, kits } – every property that pumps into this pressure system
 *   drains (scour and flushing valves), air, nonReturn, others: valves on the stretch that cut nothing;
 *     atJoints: hand valves on the stretch that stand where pipes of different sizes meet and have no size
 *     of their own – which pipe each is on cannot be told, so none ended the stretch;
 *     nearby: valves on the map near the stretch but on no pipe
 *   discharges: [{ kind, junction, manholes, street, station?, plant?, beyond?, way }] – where the sewage in
 *     the tapped pipe leaves the pressure system, each with the way on (kind 'nowhere': the map does not
 *     show where – the main just ends, and the system lets go nowhere else)
 *   inflow: junctions where a pumped main of this system comes in from outside the mapped area
 *   doubts: as for `stopGravity` (where: 'pipe' | 'stretch' | 'main' | 'way'), and 'nowhere' (a pump whose
 *     main leads nowhere on the map), 'deadEnd' (by the record the tapped pipe runs to a dead end, on a main
 *     that discharges elsewhere: the discharge given is that of the main)
 */
export function stopPressure(network, piece, wontClose = new Set(), options = {}) {
  const o = { ...STOP_DEFAULTS, ...options };
  const { pieces, junctions, valves, links, stations, outlets, systems, connections } = network;
  const { piecesAt, linksAt, connectionsOf, valvesOf, dischargesOf, startsAt } = prepare(network);
  const tapped = pieces[piece];
  const x = tapped[SYSTEM];
  const system = systems[x];
  // A valve recorded at the very end of a main is put a little in from it, so that it shuts that pipe.
  // The work is on the pipe side of such a valve: a tap on the end itself is moved in with it.
  const mainM = measuredMain(network, tapped[MAIN]).length;
  const inset = Math.min(SEWER_DEFAULTS.valveInsetM, mainM / 2);
  const tappedM = Math.min(mainM - inset, Math.max(inset, options.alongM ?? (tapped[FROM] + tapped[TO]) / 2));
  const alongM = Math.min(tapped[TO], Math.max(tapped[FROM], tappedM));
  const inSystem = (i) => pieces[i][SYSTEM] === x && pieces[i][A] !== pieces[i][B];
  const isStubPiece = (i) => pieces[i][MARK] === PIECE_MARK.stub;
  const isKit = (v) => valves[v].onConnection || /^Boundary kit/.test(valves[v].type) || valves[v].role === 'boundary';
  const nearestTo = (atM) => (p, q) => Math.abs(valves[p].alongM - atM) - Math.abs(valves[q].alongM - atM);
  const doubts = [];
  if (directionOf(tapped) === 'against') doubts.push(againstDoubt(network, piece, 'pipe'));

  // ---- The stretch: outwards from the tapped point, each way to the first line valve that closes.
  const parts = new Map(); // piece -> [[fromM, toM]]
  const crossed = new Set(); // links
  let bounds = [];
  const boundValves = new Map(); // valve -> its bound
  const passedValves = new Set(); // of `wontClose`
  const noLineValve = { pumps: false, discharge: false };
  const add = (store, i, from, to) => store.set(i, [...(store.get(i) ?? []), [Math.min(from, to), Math.max(from, to)]]);
  const known = new Set();
  const bound = (key, entry) => {
    if (known.has(key)) return;
    known.add(key);
    bounds.push(entry);
  };
  const walked = new Set();
  const waiting = [];
  /** Sets off along a piece from `startM` towards one of its ends. flow: whether the way so far went against the flow, with it. */
  const setOff = (i, startM, end, flow, distanceM, fromTap = false) => {
    if (walked.has(`${i}:${end}`)) return;
    walked.add(`${i}:${end}`);
    waiting.push({ i, startM, end, flow, distanceM, fromTap });
  };
  /**
   * What a station is to the system, where a pipe of the system ends on it: its pump, or the place it lets
   * go. A station can be both (a second pipe of its own main runs back into its well): then the pipe one
   * comes by tells – it runs from the station, or into it – and 'both' when it does not.
   */
  const stationRole = (s, j, cameBy) => {
    const [pumpsHere, receivesHere] = [stations[s].pumpsInto.includes(x), stations[s].receives.includes(x)];
    if (!pumpsHere || !receivesHere) return pumpsHere ? 'pumps' : 'receives';
    const arrives = cameBy !== undefined && !isStubPiece(cameBy) ? lowerOf(pieces[cameBy]) : undefined;
    return arrives === undefined ? 'both' : arrives === j ? 'receives' : 'pumps';
  };
  /** Comes to a junction: what the stretch ends at there, or the pipes it goes on by. */
  function arrive(j, cameBy, flow, distanceM) {
    const junction = junctions[j];
    const place = { junction: j, distanceM: round1(distanceM) };
    if (junction.station !== undefined) {
      const role = stationRole(junction.station, j, cameBy);
      if (role !== 'receives') noLineValve.pumps = true;
      if (role !== 'pumps') noLineValve.discharge = true;
      bound(`station ${junction.station} ${role}`, { station: junction.station, role: role === 'receives' ? 'receives' : 'pumps', ...place });
      return;
    }
    if (junction.plant !== undefined) {
      noLineValve.discharge = true;
      bound(`plant ${junction.plant}`, { plant: junction.plant, ...place });
      return;
    }
    // Where the main lets go into a sewer the pressure ends: a second pumped main that arrives there is
    // not part of the stretch.
    if (dischargesOf[x].has(j)) {
      noLineValve.discharge = true;
      bound(`discharge ${j}`, { discharge: describeDischarge(network, { ...dischargesOf[x].get(j), via: [] }), ...place });
      return;
    }
    let onward = false;
    for (const i of piecesAt[j]) {
      if (i === cameBy || !inSystem(i)) continue;
      onward = true;
      setOff(i, pieces[i][A] === j ? pieces[i][FROM] : pieces[i][TO], pieces[i][A] === j ? B : A, flow, distanceM);
    }
    for (const k of linksAt[j]) {
      if (!links[k].pumped) continue;
      onward = true;
      if (crossed.has(k)) continue;
      crossed.add(k);
      doubts.push(linkDoubt(network, k, 'stretch'));
      arrive(otherEnd(links[k], j), undefined, flow, distanceM + links[k].lengthM);
    }
    if (onward) return;
    const pump = startsAt[x].get(j);
    if (pump !== undefined) noLineValve.pumps = true;
    bound(`end ${j}`, { end: j, ...(pump !== undefined && { pump }), ...(cameBy !== undefined && isStubPiece(cameBy) && { stub: true }), ...place });
  }
  /** Whether a line valve of the tapped piece lies towards its end B (sign 1) or its end A (-1) from the tapped point. */
  const aheadOfTap = (v, sign) => {
    const offM = valves[v].alongM - alongM;
    // A valve at the tapped point itself goes with the end of the main it was recorded at.
    return (Math.abs(offM) <= 0.05 ? valves[v].alongM > mainM / 2 : offM > 0) === sign > 0;
  };
  setOff(piece, alongM, A, { against: false, with: false }, 0, true);
  setOff(piece, alongM, B, { against: false, with: false }, 0, true);
  while (waiting.length) {
    const { i, startM, end, flow, distanceM, fromTap } = waiting.shift();
    const current = pieces[i];
    const sign = end === B ? 1 : -1;
    const stopM = end === B ? current[TO] : current[FROM];
    // (Which way a short pipe off the main was drawn says nothing of the flow in the main.)
    const run = isStubPiece(i) ? 0 : current[RUN];
    const sense = { against: flow.against || run === -sign, with: flow.with || run === sign };
    // The line valves ahead on this pipe, nearest first; one that will not close is passed.
    const ahead = valvesOf[i].filter((v) => valves[v].line && (!fromTap || aheadOfTap(v, sign))).sort(nearestTo(startM));
    const first = ahead.find((v) => {
      if (wontClose.has(v)) passedValves.add(v);
      return !wontClose.has(v);
    });
    if (first === undefined) {
      add(parts, i, startM, stopM);
      arrive(current[end], i, sense, distanceM + Math.abs(stopM - startM));
      continue;
    }
    add(parts, i, startM, valves[first].alongM);
    // Two valves recorded at one spot both stand there.
    for (const v of ahead) {
      if (wontClose.has(v) || Math.abs(valves[v].alongM - valves[first].alongM) > 0.05) continue;
      const reached = boundValves.get(v);
      if (reached) reached.inside = true; // from its other side too: the stretch lies on both sides of it
      else {
        const entry = { valve: v, piece: i, towards: end, sense, distanceM: round1(distanceM + Math.abs(valves[v].alongM - startM)) };
        boundValves.set(v, entry);
        bounds.push(entry);
      }
    }
  }
  // A valve reached from both its sides does not bound the stretch: the mains are joined round it.
  const inside = bounds.filter((entry) => entry.inside).map((entry) => entry.valve);
  for (const v of inside) boundValves.delete(v);
  bounds = bounds.filter((entry) => !entry.inside);

  // ---- Behind each valve: what lies beyond it, without coming back through the stretch.
  function beyond(from) {
    const found = { parts: new Map(), pumps: false, discharge: false };
    const seen = new Set();
    const queue = [{ i: from.piece, startM: valves[from.valve].alongM, end: from.towards, start: true }];
    const reach = (j, cameBy) => {
      const junction = junctions[j];
      if (junction.station !== undefined) {
        const role = stationRole(junction.station, j, cameBy);
        if (role !== 'receives') found.pumps = true;
        if (role !== 'pumps') found.discharge = true;
        return;
      }
      if (junction.plant !== undefined || dischargesOf[x].has(j)) {
        found.discharge = true;
        return;
      }
      if (startsAt[x].has(j)) found.pumps = true;
      for (const i of piecesAt[j]) if (i !== cameBy && inSystem(i)) queue.push({ i, startM: pieces[i][A] === j ? pieces[i][FROM] : pieces[i][TO], end: pieces[i][A] === j ? B : A });
      for (const k of linksAt[j]) {
        if (!links[k].pumped || seen.has(`link ${k}`)) continue;
        seen.add(`link ${k}`);
        reach(otherEnd(links[k], j), undefined);
      }
    };
    while (queue.length) {
      const { i, startM, end, start } = queue.pop();
      if (seen.has(i)) continue; // once is enough: come to again from its other end, it would lead back
      seen.add(i);
      const sign = end === B ? 1 : -1;
      // Another valve that bounds the stretch, ahead on this pipe: the stretch lies beyond it.
      const [next] = valvesOf[i].filter((v) => boundValves.has(v) && v !== from.valve && (!start || (valves[v].alongM - startM) * sign > 0.05)).sort(nearestTo(startM));
      if (next !== undefined) {
        add(found.parts, i, startM, valves[next].alongM);
        continue;
      }
      add(found.parts, i, startM, end === B ? pieces[i][TO] : pieces[i][FROM]);
      reach(pieces[i][end], i);
    }
    return found;
  }
  /** Parts of one pipe as few spans as they make: those reached from both sides, or either way from the tapped point, touch or overlap. */
  const joined = (spans) => {
    const whole = [];
    for (const [from, to] of [...spans].sort((p, q) => p[0] - q[0])) {
      if (whole.length && from <= whole.at(-1)[1] + 0.05) whole.at(-1)[1] = Math.max(whole.at(-1)[1], to);
      else whole.push([from, to]);
    }
    return whole;
  };
  const within = (store, i, atM) => (store.get(i) ?? []).some(([from, to]) => atM >= from - 0.05 && atM <= to + 0.05);
  /** The length of some parts of pipes, the property connections on them and the boundary kits recorded there. */
  function measure(store) {
    const total = { lengthM: 0, connections: 0, kits: 0, list: [] };
    for (const [i, spans] of store) {
      // A stub adds no length to its main.
      if (!isStubPiece(i)) for (const [from, to] of joined(spans)) total.lengthM += to - from;
      for (const c of connectionsOf[i]) {
        if (!within(store, i, connections[c][1])) continue;
        total.connections += 1;
        total.list.push(c);
      }
      total.kits += valvesOf[i].filter((v) => isKit(v) && within(store, i, valves[v].alongM)).length;
    }
    return { ...total, lengthM: round1(total.lengthM) };
  }
  const sizeOf = ({ lengthM, connections: properties, kits }) => ({ lengthM, connections: properties, kits });
  const behindParts = new Map();
  for (const entry of bounds) {
    if (entry.valve === undefined) continue;
    const { sense } = entry;
    const found = beyond(entry);
    const size = sizeOf(measure(found.parts));
    // The side: by the way the pipes run between the tapped point and the valve; where the record gives
    // no direction, by what lies beyond the valve.
    let side;
    if (sense.against !== sense.with) side = sense.against ? 'pumps' : 'discharge';
    else if (sense.against) side = 'branch';
    else side = found.discharge ? 'discharge' : found.pumps || size.connections ? 'pumps' : 'branch';
    // A side is only said when that is what lies there: a valve at the dead end of a branch is on a branch,
    // whichever way the branch was drawn.
    if ((side === 'discharge' && !found.discharge) || (side === 'pumps' && !found.pumps && !size.connections)) side = 'branch';
    // What has no discharge beyond the valve has no way out while it is closed.
    if (!found.discharge) for (const [i, spans] of found.parts) for (const [from, to] of spans) add(behindParts, i, from, to);
    for (const key of ['piece', 'towards', 'sense']) delete entry[key];
    Object.assign(entry, { side, needed: found.pumps || found.discharge || size.connections > 0, beyond: { ...size, pumps: found.pumps, discharge: found.discharge } });
  }
  const lineValves = bounds.filter((entry) => entry.valve !== undefined).sort((p, q) => p.distanceM - q.distanceM);
  const onStretchParts = measure(parts);
  const stretchSize = sizeOf(onStretchParts);
  const behind = sizeOf(measure(behindParts));
  // With no discharge on the map at all, no side of the stretch can be called "behind" it.
  if (!dischargesOf[x].size) Object.assign(behind, { connections: 0, kits: 0, lengthM: 0, cannotBeTold: true });

  // ---- The valves on the stretch that cut nothing, and those near it on no pipe.
  const onStretch = [...parts.keys()].flatMap((i) => valvesOf[i].filter((v) => within(parts, i, valves[v].alongM) && !boundValves.has(v)));
  const isAir = (v) => valves[v].type === 'Air release valve' || valves[v].role === 'air';
  const isNonReturn = (v) => valves[v].type === 'Non-return valve' || valves[v].role === 'nonReturn';
  const plain = onStretch.filter((v) => !isKit(v) && !passedValves.has(v) && !inside.includes(v));
  const drains = plain.filter((v) => valves[v].drain);
  // A hand valve at a joint of pipes of different sizes, with no size of its own: it may be on any of them,
  // so it ended no part of the stretch – and may still be a valve to close.
  const atJoints = plain.filter((v) => !valves[v].drain && valves[v].pipeNotKnown);
  const told = (v) => valves[v].drain || valves[v].pipeNotKnown;
  const air = plain.filter((v) => !told(v) && isAir(v));
  const nonReturn = plain.filter((v) => !told(v) && !isAir(v) && isNonReturn(v));
  const others = plain.filter((v) => !told(v) && !isAir(v) && !isNonReturn(v));
  const stretchParts = [...parts].flatMap(([i, spans]) => joined(spans).map(([from, to]) => [i, from, to]));
  const local = projector(placeOn(network, tapped[MAIN], alongM));
  const drawn = stretchParts.map(([i, from, to]) => measureLine(lineOf(network, i, from, to), local));
  const reachM = drawn.flatMap((line) => line.points).reduce((most, [px, py]) => Math.max(most, Math.hypot(px, py)), 0) + o.nearValveM; // none is further than this from the tapped point
  const nearby = valves.flatMap((valve, v) => {
    if (valve.piece >= 0 || isKit(v)) return [];
    const xy = local.toXY(valve.at);
    return Math.hypot(xy[0], xy[1]) <= reachM && drawn.some((line) => projectOnLine(line, xy).distance <= o.nearValveM) ? [v] : [];
  });

  // ---- The pumps to stop: those that pump through the tapped pipe first.
  // A pump pumps through the tapped pipe when its way to its discharge passes through it, or when the pipe is
  // recorded as running from it: going against the flow all the way, one comes to that pump. A short pipe off
  // the main is on nobody's way: what pumps past the place it hangs on pumps "through" it.
  const hangsOn = new Set();
  const feedsIt = new Set();
  if (isStubPiece(piece)) {
    for (const waitingStubs = [piece], seen = new Set(); waitingStubs.length; ) {
      const i = waitingStubs.pop();
      if (seen.has(i)) continue;
      seen.add(i);
      for (const j of [pieces[i][A], pieces[i][B]]) {
        hangsOn.add(j);
        for (const next of piecesAt[j]) if (inSystem(next) && isStubPiece(next)) waitingStubs.push(next);
      }
    }
  } else if (tapped[RUN] !== 0) {
    for (const up = [upperOf(tapped)]; up.length; ) {
      const j = up.pop();
      if (feedsIt.has(j)) continue;
      feedsIt.add(j);
      if (junctions[j].station !== undefined || junctions[j].plant !== undefined) continue;
      for (const i of piecesAt[j]) if (inSystem(i) && !isStubPiece(i) && lowerOf(pieces[i]) === j) up.push(upperOf(pieces[i]));
      for (const k of linksAt[j]) if (links[k].pumped) up.push(otherEnd(links[k], j));
    }
  }
  const through = (discharge, starts) => {
    if (starts.some((j) => feedsIt.has(j))) return true;
    if (!discharge) return false;
    return discharge.via.includes(piece) || discharge.via.some((step) => step >= 0 && (hangsOn.has(pieces[step][A]) || hangsOn.has(pieces[step][B])));
  };
  const howOf = (discharge, starts) => (through(discharge, starts) ? 'through' : tapped[RUN] === 0 && !isStubPiece(piece) ? 'mayPump' : 'sameSystem');
  const order = { through: 0, sameSystem: 1, mayPump: 2 };
  const toStop = [];
  const notOnMap = [];
  const joins = [];
  for (const source of system.sources) {
    if (source.station !== undefined) {
      const station = stations[source.station];
      toStop.push({ station: source.station, how: howOf(station.discharge, station.junctions), inferred: station.inferred, street: streetAt(network, station.junctions[0]), valves: station.valves, receives: arrivesAt(network, source), discharge: station.discharge && describeDischarge(network, station.discharge) });
      if (station.inferred) doubts.push({ kind: 'inferredPump', where: 'pipe', station: source.station, how: station.inferred, at: station.at });
      continue;
    }
    const outlet = outlets[source.outlet];
    const entry = { outlet: source.outlet, how: howOf(outlet.discharge, [outlet.from ?? outlet.junction]), junction: outlet.junction, manholes: junctions[outlet.junction].manholes ?? [], street: streetAt(network, outlet.junction), gapM: outlet.gapM, nowhere: outlet.nowhere, receives: arrivesAt(network, source), discharge: outlet.discharge && describeDischarge(network, outlet.discharge) };
    (outlet.kind === 'pump' ? notOnMap : joins).push(entry);
    // (Where sewers join the main is a line of the answer by itself; why a pump is taken to stand there is a doubt.)
    if (outlet.kind === 'pump') doubts.push({ kind: 'pumpNotOnMap', where: 'pipe', outlet: source.outlet, junction: outlet.junction, manholes: entry.manholes, gapM: outlet.gapM, at: junctionPlace(network, outlet.junction) });
    if (outlet.nowhere) doubts.push({ kind: 'nowhere', where: 'pipe', outlet: source.outlet, at: junctionPlace(network, outlet.junction) });
  }
  for (const list of [toStop, notOnMap, joins]) list.sort((p, q) => order[p.how] - order[q.how]);
  // What a station receives while it is stopped, and what joining sewers bring, are said as figures: with
  // what the map cannot count in them, and what is counted though it may go another way.
  for (const entry of [...toStop, ...joins]) doubts.push(...upstreamDoubts(network, entry.receives));

  // ---- Where it discharges, and the way on.
  /**
   * Going with the flow from the tapped pipe: the nearest place the sewage leaves the pressure system – or,
   * when it comes to none, the dead ends it runs into ({ ends }).
   */
  function firstDischargeBelow() {
    const far = new Map([[lowerOf(tapped), 0]]);
    const settled = new Set();
    const ends = [];
    for (;;) {
      let j;
      for (const [candidate, distanceM] of far) if (!settled.has(candidate) && (j === undefined || distanceM < far.get(j))) j = candidate;
      if (j === undefined) return { ends };
      settled.add(j);
      const junction = junctions[j];
      if (junction.station !== undefined) return { junction: j, kind: 'station', station: junction.station, via: [] };
      if (junction.plant !== undefined) return { junction: j, kind: 'plant', plant: junction.plant, via: [] };
      if (dischargesOf[x].has(j)) return { ...dischargesOf[x].get(j), via: [] };
      let onward = false;
      const reach = (to, lengthM) => {
        onward = true;
        if (!far.has(to) || far.get(j) + lengthM < far.get(to)) far.set(to, far.get(j) + lengthM);
      };
      for (const i of piecesAt[j]) if (i !== piece && inSystem(i) && !isStubPiece(i) && lowerOf(pieces[i]) !== j) reach(pieces[i][A] === j ? pieces[i][B] : pieces[i][A], pieces[i][TO] - pieces[i][FROM]);
      for (const k of linksAt[j]) if (links[k].pumped) reach(otherEnd(links[k], j), links[k].lengthM);
      if (!onward) ends.push(j);
    }
  }
  // Of the pumps whose way to their discharge runs through the tapped pipe; for a pipe on no pump's way (a
  // second main beside the first, a branch), where the flow in it comes to; failing that – a branch that
  // just ends, on a main that discharges elsewhere: said as a doubt – of the pumps of the system, and with
  // no pump at all, wherever the system lets go.
  const pumping = [...toStop, ...notOnMap, ...joins].filter((pump) => pump.discharge);
  const onItsWay = pumping.filter((pump) => pump.discharge.via.includes(piece));
  const letGo = new Map();
  const letsGo = (discharge) => letGo.has(discharge.junction) || letGo.set(discharge.junction, discharge);
  for (const pump of onItsWay) {
    letsGo(pump.discharge);
    doubts.push(...dischargeDoubts(network, pump.discharge, 'main'));
  }
  if (!letGo.size && !isStubPiece(piece) && tapped[RUN] !== 0) {
    const below = firstDischargeBelow();
    if (below.kind) letsGo(describeDischarge(network, below));
    else for (const junction of below.ends) doubts.push({ kind: 'deadEnd', where: 'pipe', junction, street: streetAt(network, junction), at: junctionPlace(network, junction) });
  }
  if (!letGo.size) {
    const throughIt = pumping.filter((pump) => pump.how === 'through');
    for (const pump of throughIt.length ? throughIt : pumping) letsGo(pump.discharge);
  }
  if (!letGo.size) for (const discharge of dischargesOf[x].values()) letsGo(describeDischarge(network, { ...discharge, via: [] }));
  const discharges = [...letGo.values()].map((discharge) => {
    const from = { from: discharge.junction, steps: [], doubts: [] };
    let way;
    if (discharge.kind === 'plant') way = { ...from, end: 'plant', plant: discharge.plant };
    else if (discharge.kind === 'leaves') way = { ...from, end: 'leaves', beyond: discharge.beyond };
    else if (discharge.kind === 'nowhere') way = { ...from, end: 'none', why: { reason: 'mainEnds', junction: discharge.junction, manholes: discharge.manholes, street: discharge.street } };
    else way = wayOn(network, discharge.junction);
    doubts.push(...way.doubts);
    return { ...discharge, way };
  });
  for (const junction of system.inflow ?? []) doubts.push({ kind: 'inflow', where: 'main', junction, at: junctionPlace(network, junction) });

  const kitsOnSystem = valves.reduce((total, valve, v) => total + (valve.piece >= 0 && pieces[valve.piece][SYSTEM] === x && isKit(v) ? 1 : 0), 0);
  const properties = stretchSize.connections + behind.connections;
  return {
    kind: 'pumped',
    piece,
    alongM,
    pipe: pipeOf(network, piece),
    direction: directionOf(tapped),
    system: x,
    systemKind: system.kind,
    stations: toStop,
    pumps: notOnMap,
    joins,
    stretch: { parts: stretchParts, links: [...crossed], ...stretchSize, connectionsAt: onStretchParts.list.map((c) => placeOn(network, pieces[connections[c][0]][MAIN], connections[c][1])) },
    bounds,
    valves: lineValves,
    inside,
    noLineValve,
    wontClose: [...passedValves],
    behind,
    block: { properties, limit: o.blockProperties, over: properties > o.blockProperties },
    onSystem: { connections: system.connections, kits: kitsOnSystem },
    drains,
    atJoints,
    air,
    nonReturn,
    others,
    nearby,
    discharges,
    inflow: system.inflow ?? [],
    doubts: distinct(doubts),
  };
}

// ---- What to draw --------------------------------------------------------------------------------

/** The [lon, lat] line of a piece of main between two distances along its main. */
function lineOf(network, i, fromM, toM) {
  const m = network.pieces[i][MAIN];
  const measured = measuredMain(network, m);
  // The ends of a piece are kept to the decimetre: a point of the main that close to one is that end.
  const inside = network.mains[m].line.filter((_, n) => measured.along[n] > fromM + 0.05 && measured.along[n] < toM - 0.05);
  return [placeOn(network, m, fromM), ...inside, placeOn(network, m, toM)];
}

/**
 * The lines of some pipes, to draw them – the counterpart of `stretchLines` of the water tool.
 * @param {object} network
 * @param {(number | number[])[]} parts  each a piece (whole), [piece, fromM, toM] (a pumped main can carry on
 *   beyond a valve, outside the stretch), or a link the map does not draw, as -(index + 1): the steps of a
 *   way, the `via` of a discharge and `stretch.pieces` can be given as they are
 * @returns {{ piece?: number, link?: number, main?: number, line: number[][] }[]}  [lon, lat] lines
 */
export function stretchLines(network, parts) {
  const lines = [];
  for (const part of parts) {
    if (typeof part === 'number' && part < 0) {
      const link = network.links[-part - 1];
      const [from, to] = [junctionPlace(network, link.a), junctionPlace(network, link.b)];
      if (from && to) lines.push({ link: -part - 1, line: [from, to] });
      continue;
    }
    const [i, fromM, toM] = typeof part === 'number' ? [part, network.pieces[part][FROM], network.pieces[part][TO]] : part;
    if (toM - fromM < 0.05) continue;
    lines.push({ piece: i, main: network.pieces[i][MAIN], line: lineOf(network, i, fromM, toM) });
  }
  return lines;
}
