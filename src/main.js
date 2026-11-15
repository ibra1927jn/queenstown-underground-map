/**
 * Entry point: builds the map and connects the page controls to it.
 */
import { CONFIG } from './config.js';
import { Cesium } from './map/cesium.js';
import { createViewer } from './map/viewer.js';
import { createBaseMap } from './map/baseMap.js';
import { createTerrain } from './map/terrain.js';
import { createViewMode } from './map/viewMode.js';
import { createQualityControl } from './map/quality.js';
import { createControls } from './map/controls.js';
import { currentFocus, flyTo, lookAt } from './map/camera.js';
import { createPicking } from './map/picking.js';
import { createBuildingsLayer } from './layers/buildingsLayer.js';
import { createDisusedPipesSwitch, createNetworkLayer } from './layers/networkLayer.js';
import { groupZones, loadZones, zoneAt, zoneCentre } from './zones/zones.js';
import { createZoneLayers } from './zones/zoneLayers.js';
import { createStatus } from './ui/status.js';
import { createInfoPanel } from './ui/infoPanel.js';
import { createLayersPanel } from './ui/layersPanel.js';
import { createNavButtons } from './ui/navButtons.js';
import { createYearsControl } from './ui/yearsControl.js';
import { createViewMenu } from './ui/viewMenu.js';
import { createBaseMapControl } from './ui/baseMapControl.js';
import { createExcavationView } from './tools/excavationView.js';
import { createProfileView } from './tools/profileView.js';
import { createShutoffView } from './tools/shutoffView.js';
import { createAddressFinder } from './tools/addressFinder.js';
import { createAddedPipesTool } from './tools/addedPipesTool.js';
import { createAddedStore, zoneFor } from './util/addedPipes.js';
import { createOpenGroundView } from './tools/openGroundView.js';
import { createPressureZonesLayer } from './layers/pressureZonesLayer.js';
import { createUndergroundView } from './map/undergroundView.js';
import { byId, el } from './util/dom.js';

const PHONE_QUERY = '(max-width: 760px)';

async function start(status) {
  if (!Cesium) {
    throw new Error('The map library could not be loaded. Check the internet connection and reload the page.');
  }
  status.busy('Starting the map…');

  const zones = await loadZones(CONFIG.dataPath);
  const startZone = zones.find((zone) => zone.id === CONFIG.startZone) ?? zones[0];
  const isPhone = window.matchMedia(PHONE_QUERY).matches;
  const view = isPhone ? { ...CONFIG.view, ...CONFIG.view.phone } : CONFIG.view;
  const qualityPreset = isPhone ? CONFIG.quality.phone : CONFIG.quality.desktop;

  // ---- Map ----
  let viewer;
  try {
    viewer = createViewer({ container: byId('map'), creditContainer: byId('credits'), quality: qualityPreset, look: CONFIG.look });
  } catch (error) {
    console.error(error);
    throw new Error('This browser or device cannot show the 3D map (WebGL is not available).');
  }

  const quality = createQualityControl(viewer, qualityPreset, CONFIG.quality.governor);

  // Keys kept on this computer only (src/config.local.js, written by scripts/local-config.mjs): without the file, no aerial photos.
  const local = await import('./config.local.js').then((module) => module.LOCAL ?? {}, () => ({}));
  const baseMap = createBaseMap({ viewer, settings: CONFIG.aerial, key: local.linzBasemapsKey, anisotropy: qualityPreset.imageryAnisotropy });

  /** Where the camera looks for a zone. `height` is the ground height there, once known. */
  const zoneFocus = (zone, height = view.typicalGroundM) => {
    const [lon, lat] = zoneCentre(zone);
    return { lon, lat, height, span: zone.view?.spanMetres ?? view.spanMetres };
  };
  const zoneOrientation = (zone) => ({
    headingDegrees: zone.view?.headingDegrees ?? view.headingDegrees,
    pitchDegrees: zone.view?.pitchDegrees ?? view.pitchDegrees,
  });

  // Show the start zone straight away, instead of the whole globe while the terrain is being set up.
  lookAt(viewer, zoneFocus(startZone), zoneOrientation(startZone));

  // ---- Terrain ----
  const terrain = await createTerrain({
    sources: CONFIG.terrain.sources,
    probeTile: CONFIG.terrain.probeTile,
    cachedTiles: isPhone ? CONFIG.terrain.cachedTiles.phone : CONFIG.terrain.cachedTiles.desktop,
  });
  viewer.terrainProvider = terrain.provider;
  const { sampleGround } = terrain;

  // ---- Pipes and cables added by hand: kept in the browser of this device only ----
  const newAddedId = () => `mine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const zoneOfLine = (points) => zoneFor(zones, points);
  let browserStorage;
  try {
    browserStorage = window.localStorage;
  } catch {
    browserStorage = undefined; // site data blocked: nothing can be kept, and the tool says so
  }
  const addedStore = createAddedStore({ storage: browserStorage, key: CONFIG.added.storageKey, zoneOf: zoneOfLine, newId: newAddedId });

  // ---- Layers ----
  const buildings = createBuildingsLayer({ viewer, sampleGround, dataPath: CONFIG.dataPath, settings: CONFIG.buildings });
  // Each network a little higher than the next, so where pipes share a street the first of the list is on top.
  const networks = CONFIG.networks.list.map((network, order) =>
    createNetworkLayer({
      viewer,
      sampleGround,
      dataPath: CONFIG.dataPath,
      network,
      liftM: CONFIG.networks.liftM + (CONFIG.networks.list.length - 1 - order) * CONFIG.networks.layerGapM,
      settings: CONFIG.networks,
      added: (zoneId) => addedStore.inZone(zoneId, network.id),
    }),
  );
  const disusedPipes = createDisusedPipesSwitch({ networks, settings: CONFIG.networks });
  const pressureZones = createPressureZonesLayer({ viewer, dataPath: CONFIG.dataPath, settings: CONFIG.networks.pressureZones });
  const layers = [buildings, ...networks, disusedPipes, pressureZones];
  viewer.creditDisplay.addStaticCredit(new Cesium.Credit(CONFIG.networks.credit, true));
  const zoneLayers = createZoneLayers({ layers, maxLoadedZones: CONFIG.maxLoadedZones });

  // ---- Zones ----
  let activeZone = startZone;
  const centreHeights = new Map(); // zone id -> ground height at the zone centre

  async function groundAtCentre(zone) {
    if (!centreHeights.has(zone.id)) {
      const [height] = await sampleGround(zoneCentre(zone));
      if (!Number.isFinite(height)) return undefined; // not known right now: ask again next time
      centreHeights.set(zone.id, height);
    }
    return centreHeights.get(zone.id);
  }

  /** Set while the camera is on its way to a zone the user picked (see the moveEnd listener below). */
  let navigation = null;
  /** The excavation view (made further down); while it is open the camera circles the pit. */
  let cut;
  /** The background switch (made further down). */
  let background;
  /** Whether the arrows of the flow direction are on (the View menu). */
  let flowShown = false;
  let photosForOpenGround = () => {}; // set with the background (below)
  /** The open-ground view (made further down). */
  let openGround;
  /** Pipes and cables added by hand: the pencil button, the drawing (made further down). */
  let addedPipes;
  /** The View menu (made last): it shows which view is on. */
  let viewMenu;

  /** Moves the camera to a zone. Resolves to false when another zone was picked in the meantime. */
  async function goToZone(zone, move) {
    const thisNavigation = {};
    navigation = thisNavigation;
    const finish = () => {
      if (navigation === thisNavigation) navigation = null;
    };

    try {
      const focus = zoneFocus(zone, await groundAtCentre(zone));
      if (navigation !== thisNavigation) return false;
      openGround?.releaseCamera(); // it goes round the new place once there
      if (move === 'fly') {
        flyTo(viewer, focus, zoneOrientation(zone), finish);
      } else {
        lookAt(viewer, focus, zoneOrientation(zone));
        finish();
      }
      return true;
    } catch (error) {
      finish();
      throw error;
    }
  }

  /** Marks in the View menu which view is on (called whenever one changes). */
  function refreshViewMenu() {
    if (!viewMenu) return; // still being set up
    const view = cut.active ? 'excavation' : openGround.active ? 'open-ground' : undergroundView.on ? 'underground' : 'map';
    viewMenu.show({ view, toggled: { years: years.open, flow: flowShown } });
  }

  /** What the status line says once a zone is loaded. */
  function zoneSummary(zone) {
    const parts = [zone.name, ...layers.map((layer) => layer.summary(zone.id)).filter(Boolean)];
    const pipeKm = networks.map((network) => network.lengthKm(zone.id)).filter((km) => km !== undefined);
    if (pipeKm.length) parts.push(`${Math.round(pipeKm.reduce((sum, km) => sum + km, 0))} km of pipes`);
    const missingPipes = networks.reduce((sum, network) => sum + network.missingPipes(zone.id), 0);
    if (missingPipes) parts.push(`${missingPipes} pipes not shown (ground height unavailable – reload to retry)`);
    if (!terrain.hasRelief) parts.push('terrain unavailable, map shown flat');
    return parts.join(' · ');
  }

  /**
   * Makes a zone the active one and loads its data.
   * @param {'fly' | 'jump' | 'none'} move  how the camera gets there ('none': it is already there)
   */
  async function activateZone(zone, move) {
    activeZone = zone;
    zoneSelect.value = zone.id;
    background?.refresh(); // the photos of the time differ between Queenstown and Wanaka
    status.busy(`Loading ${zone.name}…`);

    try {
      if (move !== 'none' && !(await goToZone(zone, move))) return;
      // Say how far the loading is: on a slow connection it takes a while.
      await zoneLayers.show(zone, (done, total) => {
        if (activeZone === zone && done < total) status.busy(`Loading ${zone.name}… ${done} of ${total} layers`);
      });
      if (activeZone !== zone) return;
      cut?.refresh(); // a pit dug while the zone was still loading gets what arrived since
      openGround?.refresh();
      // The mains and buildings are on the map; the property connections and small fittings follow.
      status.busy(`${zone.name}: adding property connections and fittings…`);
      await zoneLayers.details(zone);
      if (activeZone !== zone) return;
      cut?.refresh();
      openGround?.refresh();
      status.done(zoneSummary(zone));
    } catch (error) {
      console.error(error);
      if (activeZone === zone) status.error(`Some data for ${zone.name} could not be loaded.`);
    }
  }

  const zoneSelect = byId('zone-select');
  for (const { group, zones: members } of groupZones(zones)) {
    zoneSelect.append(el('optgroup', { label: group }, ...members.map((zone) => el('option', { value: zone.id, text: zone.name }))));
  }
  // A list picked from with the mouse keeps the keyboard afterwards, and the arrow keys would
  // then hop from zone to zone instead of moving the map. So the keyboard goes back to the
  // map after such a pick – but not while the list itself is being worked with the keyboard.
  let pickedWithPointer = false;
  zoneSelect.addEventListener('pointerdown', () => (pickedWithPointer = true));
  // (Opened with the mouse and closed WITHOUT a pick, the list keeps the keyboard until the map is touched:
  // an open list cannot be told from a closed one here, and taking its arrow keys away would break it.)
  zoneSelect.addEventListener('keydown', () => (pickedWithPointer = false));
  zoneSelect.addEventListener('change', () => {
    if (pickedWithPointer) zoneSelect.blur();
    pickedWithPointer = false;
    const zone = zones.find((candidate) => candidate.id === zoneSelect.value);
    if (zone) {
      cut?.exit();
      activateZone(zone, 'fly');
    }
  });

  // "Back to the zone": the selector cannot re-pick the zone it already shows.
  byId('recentre-button').addEventListener('click', () => {
    cut?.exit();
    activateZone(activeZone, 'fly');
  });

  // Panning into another zone loads it automatically – but never while the camera is still
  // travelling to a zone picked from the list (it would look like the pick was ignored).
  viewer.camera.moveEnd.addEventListener(() => {
    if (navigation || cut?.active || openGround?.faceOn) return; // the excavation and the cut keep the zones they opened with
    const focus = currentFocus(viewer, centreHeights.get(activeZone.id) ?? view.typicalGroundM);
    if (!focus) return;
    // Stay with the active zone for as long as the middle of the screen is inside it.
    const zone = zoneAt([activeZone], focus.lon, focus.lat) ?? zoneAt(zones, focus.lon, focus.lat);
    if (zone && zone !== activeZone) activateZone(zone, 'none');
  });

  // ---- Moving around: gestures, keys and the round buttons ----
  const whereWeAre = () => zoneFocus(activeZone, centreHeights.get(activeZone.id));
  const navActions = createControls(viewer, CONFIG.controls, { isPhone, fallbackFocus: whereWeAre });

  // ---- The excavation view: a pit dug where you look, everything inside at its depth ----
  cut = createExcavationView({
    viewer,
    sampleGround,
    networks,
    suspendable: [buildings, pressureZones],
    controls: navActions,
    badge: byId('dig-badge'),
    settings: CONFIG.excavation,
    isPhone,
    fallbackFocus: whereWeAre,
    highlightColor: CONFIG.networks.highlightColor,
    onChange: (active) => {
      document.body.classList.toggle('is-dig', active);
      refreshViewMenu();
    },
  });
  byId('dig-badge').querySelector('.dig-badge__exit').addEventListener('click', () => cut.exit());
  // The details card opens below the message on top (styles/main.css), however tall the message wraps.
  new ResizeObserver(() => {
    const message = byId('dig-badge');
    if (!message.hidden) document.documentElement.style.setProperty('--dig-badge-bottom', `${message.offsetTop + message.offsetHeight}px`);
  }).observe(byId('dig-badge'));

  // While the pit is shown, the round buttons work on it: closer, round it, lean over it, back to the first view.
  // Face-on in the open ground they work on the cut: narrower or wider, along it, forward or back, straight in front again.
  // Otherwise in the open ground they go round the place: closer, round it, over it or under it, north.
  const buttonActions = {
    ...navActions,
    zoomIn: () => (cut.active ? cut.zoom(1) : openGround.faceOn ? openGround.zoom(1) : openGround.orbiting ? openGround.stepOrbit({ zoom: 1 }) : navActions.zoomIn()),
    zoomOut: () => (cut.active ? cut.zoom(-1) : openGround.faceOn ? openGround.zoom(-1) : openGround.orbiting ? openGround.stepOrbit({ zoom: -1 }) : navActions.zoomOut()),
    turnLeft: () => (cut.active ? cut.turn(-1) : openGround.faceOn ? openGround.slide(-1) : openGround.orbiting ? openGround.stepOrbit({ turn: -1 }) : navActions.turnLeft()),
    turnRight: () => (cut.active ? cut.turn(1) : openGround.faceOn ? openGround.slide(1) : openGround.orbiting ? openGround.stepOrbit({ turn: 1 }) : navActions.turnRight()),
    tiltFlatter: () => (cut.active ? cut.tilt(-1) : openGround.faceOn ? openGround.step(1) : openGround.orbiting ? openGround.stepOrbit({ tilt: 1 }) : navActions.tiltFlatter()),
    tiltSteeper: () => (cut.active ? cut.tilt(1) : openGround.faceOn ? openGround.step(-1) : openGround.orbiting ? openGround.stepOrbit({ tilt: -1 }) : navActions.tiltSteeper()),
    northUp: () => (cut.active ? cut.reset() : openGround.faceOn ? openGround.straighten() : openGround.orbiting ? openGround.stepOrbit({ north: true }) : navActions.northUp()),
  };
  const navButtons = createNavButtons({ container: byId('map-tools'), viewer, actions: buttonActions });

  // ---- Underground view (3D only): see-through ground, pipes at their depth ----
  const undergroundBar = byId('underground-bar');
  const undergroundView = createUndergroundView(viewer, CONFIG.underground, (on) => {
    undergroundBar.hidden = !on;
    for (const network of networks) network.setUnderground(on);
    buildings.setGlass(on); // the pipes under the buildings show
    refreshViewMenu();
  });
  // Its options: depths drawn deeper than they are (easier to tell apart), and how solid the ground looks.
  const depthScaleButtons = [...undergroundBar.querySelectorAll('[data-depth-scale]')];
  for (const button of depthScaleButtons) {
    button.addEventListener('click', () => {
      for (const other of depthScaleButtons) other.setAttribute('aria-pressed', String(other === button));
      for (const network of networks) network.setDepthScale(Number(button.dataset.depthScale));
      openGround.setDepthScale(Number(button.dataset.depthScale));
    });
  }
  const groundSlider = undergroundBar.querySelector('input[type="range"]');
  groundSlider.value = String(CONFIG.underground.groundOpacityNear);
  groundSlider.addEventListener('input', () => undergroundView.setGroundOpacity(Number(groundSlider.value)));

  // ---- Open ground (3D only): the whole map with the ground opened up, real shapes round where you look ----
  const openGroundNote = undergroundBar.querySelector('.depth-bar__note');
  const faceButton = byId('face-on-button');
  const faceBack = byId('face-back');
  openGround = createOpenGroundView({
    viewer,
    sampleGround,
    networks,
    suspendable: [buildings],
    undergroundView,
    controls: navActions,
    settings: CONFIG.openGround,
    shapeSettings: CONFIG.excavation,
    isPhone,
    fallbackFocus: whereWeAre,
    highlightColor: CONFIG.networks.highlightColor,
    onChange: (active) => {
      document.body.classList.toggle('is-open-ground', active);
      undergroundBar.querySelector('.depth-bar__title').hidden = !active;
      openGroundNote.hidden = !active;
      faceButton.hidden = !active;
      // The real shapes take the place of the symbols, which would cover them.
      for (const network of networks) network.setSymbolsShown(!active);
      // The ground more see-through than in the plain underground view, on light sand, with the aerial photos.
      groundSlider.value = String(active ? CONFIG.openGround.groundOpacity : CONFIG.underground.groundOpacityNear);
      undergroundView.setGroundOpacity(Number(groundSlider.value));
      undergroundView.setUnderside(active ? CONFIG.openGround.undersideColor : undefined);
      photosForOpenGround(active);
      refreshViewMenu();
    },
    onFaceChange: (faceOn) => {
      faceButton.setAttribute('aria-pressed', String(faceOn));
      faceBack.hidden = !faceOn;
      document.body.classList.toggle('is-face', faceOn);
    },
    onNote: (text) => (openGroundNote.textContent = text),
  });
  faceButton.addEventListener('click', () => {
    infoPanel.hide();
    picking.clear();
    openGround.setFace(!openGround.faceOn);
  });
  const faceBackButtons = [...faceBack.querySelectorAll('[data-face-back]')];
  for (const button of faceBackButtons) {
    button.addEventListener('click', () => {
      for (const other of faceBackButtons) other.setAttribute('aria-pressed', String(other === button));
      openGround.setBack(Number(button.dataset.faceBack));
    });
  }

  // ---- 2D / 3D switch ----
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  const showMode = (mode) => modeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  const viewMode = createViewMode(viewer, {
    defaultOrientation: zoneOrientation(startZone),
    fallbackFocus: whereWeAre,
    onChange: (mode) => {
      showMode(mode);
      if (mode === '2d') {
        // The flat map has no "below".
        openGround.exit(false);
        undergroundView.set(false);
      }
      navButtons.setViewMode(mode);
      for (const layer of layers) layer.setViewMode?.(mode);
    },
  });
  modeButtons.forEach((button) =>
    button.addEventListener('click', () => {
      cut.exit();
      if (button.dataset.mode === '2d') openGround.exit(false); // the flat map has no "below"
      viewMode.set(button.dataset.mode);
    }),
  );
  showMode(viewMode.mode);

  // ---- Panels ----
  const infoPanel = createInfoPanel(byId('info-panel'), { onClose: () => picking.clear() });

  // ---- Find a street or address: the map flies there and drops a pin ----
  const finder = createAddressFinder({
    viewer,
    button: byId('search-toggle'),
    panel: byId('search-panel'),
    dataPath: CONFIG.dataPath,
    sampleGround,
    settings: CONFIG.search,
    beforeFlight: () => {
      cut.exit(); // the excavation holds the camera at its pit
      openGround?.releaseCamera();
    },
    onOpen: () => {
      layersPanel.close();
      addedPipes.close();
    },
  });

  // ---- Pipes and cables added by hand: the pencil button, the drawing, the form ----
  /**
   * After a pipe was added, changed or deleted: the networks that draw it draw their zone again
   * (a zone that is not on the map picks it up when it is loaded). `shown`: a pipe to select then.
   */
  async function redrawAdded(changes, shown) {
    if (changes.length) {
      picking.clear();
      infoPanel.hide();
      const redraws = changes
        .map(({ zone, network }) => ({ layer: networks.find((candidate) => candidate.id === network), zone: zones.find((candidate) => candidate.id === zone) }))
        .filter(({ layer, zone }) => layer && zone && zoneLayers.isLoaded(zone.id));
      const refreshGround = () => {
        cut?.refresh();
        openGround?.refresh();
      };
      try {
        await Promise.all(redraws.map(({ layer, zone }) => layer.reloadZone(zone)));
      } catch (error) {
        console.error(error);
        status.error('The map could not be drawn again – reload the page to see the change.');
        return;
      }
      refreshGround();
      // Their property connections and small fittings follow, as when a zone is loaded.
      Promise.all(redraws.map(({ layer, zone }) => layer.loadZoneDetails(zone))).then(refreshGround, (error) => console.error(error));
    }
    if (!shown) return;
    const { id, zone, network } = shown.properties;
    if (changes.length && !zoneLayers.isLoaded(zone)) {
      // Drawn outside the zones on the map right now: it is kept, and shows with its zone.
      status.done(`Kept. It shows when ${zones.find((candidate) => candidate.id === zone)?.name ?? 'its zone'} is on the map.`);
      return;
    }
    const layer = networks.find((candidate) => candidate.id === network);
    if (layer && !layer.visible) {
      // Its network is switched off: on again, or the pipe would not be seen.
      layer.setVisible(true);
      renderLayersPanel();
      cut?.refresh();
      openGround?.refresh();
    }
    const index = layer?.cutSource().find((source) => source.zone === zone)?.features.findIndex((feature) => feature.properties.id === id) ?? -1;
    if (index >= 0) picking.select({ layer: network, zone, index });
  }
  addedPipes = createAddedPipesTool({
    viewer,
    store: addedStore,
    zoneOf: zoneOfLine,
    zoneName: (zoneId) => zones.find((zone) => zone.id === zoneId)?.name,
    newId: newAddedId,
    colorOf: (networkId) => CONFIG.networks.list.find((network) => network.id === networkId)?.color,
    button: byId('added-toggle'),
    panel: byId('added-panel'),
    overlay: byId('draw'),
    form: byId('added-form'),
    settings: CONFIG.added,
    sampleGround,
    groundHint: () => centreHeights.get(activeZone.id) ?? CONFIG.view.typicalGroundM,
    onOpen: () => {
      layersPanel.close();
      finder.close();
      infoPanel.hide();
      picking.clear();
    },
    beforeDrawing: () => {
      chooseView('map'); // the plain map: the pit and the open ground hold the camera
      layersPanel.close();
      finder.close();
      profile.close();
      shutoff.close();
      infoPanel.hide();
      picking.clear();
      picking.setEnabled(false); // a tap on the map selects nothing while drawing
      document.body.classList.add('is-drawing');
    },
    afterDrawing: () => {
      picking.setEnabled(true);
      document.body.classList.remove('is-drawing');
    },
    beforeFlight: () => {
      cut.exit();
      openGround?.releaseCamera();
    },
    onChange: redrawAdded,
  });

  // ---- Cut the water: which valves to close to leave a water main without water ----
  const shutoff = createShutoffView({
    viewer,
    panel: byId('shutoff-panel'),
    dataPath: CONFIG.dataPath,
    sampleGround,
    settings: CONFIG.shutoff,
    isSheet: () => window.matchMedia(PHONE_QUERY).matches,
    canFly: () => !cut.active, // the excavation holds the camera
    beforeFlight: () => openGround?.releaseCamera(),
    onToggle: (open) => document.body.classList.toggle('is-shutoff', open),
  });
  /** The pipe a picked id points at, from the network layer that drew it. */
  const pipeOf = (id) => (id?.index === undefined ? undefined : networks.find((network) => network.id === id.layer)?.cutSource().find((source) => source.zone === id.zone)?.features[id.index]);
  async function startShutoff(pipe, tappedAt) {
    const p = pipe.properties;
    if (window.matchMedia(PHONE_QUERY).matches) infoPanel.hide(); // the panel takes the card's place
    await shutoff.show({ pipeId: p.id, tappedAt, diameter: p.diameter, title: [p.type ?? 'Water main', p.diameter ? `${p.diameter} mm` : undefined, p.street].filter(Boolean).join(' · ') });
  }
  const picking = createPicking(viewer, {
    layers,
    onSelect: (description, id, tappedAt) => {
      layersPanel.close();
      // A pipe: its long section, from a button on its card – or straight away while one is open.
      if (profile.accepts(id)) {
        description.actions = [{ label: 'Long section', title: 'A face-on drawing of this pipe and the pipes that carry on from it: ground, depth, manholes, crossings', run: () => showProfile(id) }];
        if (profile.open) profile.show(id);
      }
      // A water main in use: which valves to close to leave it without water.
      const pipe = id?.layer === 'water' ? pipeOf(id) : undefined;
      if (pipe?.properties.kind === 'main' && pipe.properties.inUse !== false && pipe.properties.source !== 'mine') {
        (description.actions ??= []).push({ label: 'Cut the water here', title: 'Which valves to close to leave this main without water (approximate)', run: () => startShutoff(pipe, tappedAt) });
      }
      // A pipe added by hand: it can be changed or taken off the map.
      const mine = pipeOf(id);
      if (mine?.properties.source === 'mine') {
        (description.actions ??= []).push({ label: 'Change or delete', title: 'Change what you said about it, or take it off the map', run: () => addedPipes.edit(mine.properties.id) });
      }
      // On a phone the long section takes the place of the card.
      if (profile.open && window.matchMedia(PHONE_QUERY).matches) infoPanel.hide();
      else infoPanel.show(description);
    },
    onClear: () => infoPanel.hide(),
    onHighlight: (id) => {
      cut.highlight(id);
      openGround.highlight(id);
    },
  });

  // ---- The long section of a picked pipe ----
  const profilePanel = byId('profile');
  const profile = createProfileView({
    viewer,
    networks,
    sampleGround,
    panel: profilePanel,
    settings: CONFIG.profile,
    highlightColor: CONFIG.networks.highlightColor,
    onToggle: (open) => document.body.classList.toggle('is-profile', open),
  });
  async function showProfile(id) {
    if ((await profile.show(id)) && window.matchMedia(PHONE_QUERY).matches) infoPanel.hide();
  }
  // The round buttons step up above it on a phone (styles/main.css), however tall it is.
  new ResizeObserver(() => {
    if (!profilePanel.hidden) document.documentElement.style.setProperty('--profile-height', `${profilePanel.offsetHeight}px`);
  }).observe(profilePanel);

  const layersPanel = createLayersPanel({
    panel: byId('layers-panel'),
    list: byId('layer-list'),
    toggleButton: byId('layers-toggle'),
    onToggle: (layerId, visible) => {
      layers.find((layer) => layer.id === layerId)?.setVisible(visible);
      cut?.refresh(); // the pit shows the networks that are switched on
      openGround?.refresh();
    },
    // On phones both panels are sheets in the same place, so only one is open at a time.
    onOpen: () => {
      infoPanel.hide();
      picking.clear();
      addedPipes.close();
      if (window.matchMedia(PHONE_QUERY).matches) profile.close();
    },
  });
  const renderLayersPanel = () => layersPanel.render(layers.map(({ id, label, visible, legend }) => ({ id, label, visible, legend })));
  renderLayersPanel();

  // ---- By year installed: colours by decade and a timeline ----
  const yearsBar = byId('years-bar');
  const years = createYearsControl({
    bar: yearsBar,
    settings: CONFIG.networks.years,
    onChange: (state) => {
      for (const network of networks) network.setYears(state);
      cut.refresh(); // the pit is drawn in the same colours and years
      openGround.refresh();
      // "Laid up to 1995": the aerial photos of 1995 too. Otherwise the latest.
      background.setYear(state.colour && state.from === undefined ? state.to : undefined);
    },
    onToggle: (open) => {
      document.body.classList.toggle('is-years', open);
      measureYearsBar();
      refreshViewMenu();
    },
  });
  // On a phone the round buttons step up above the bar (styles/main.css), however tall it is.
  function measureYearsBar() {
    if (!yearsBar.hidden) document.documentElement.style.setProperty('--years-bar-height', `${yearsBar.offsetHeight}px`);
  }
  new ResizeObserver(measureYearsBar).observe(yearsBar);

  // ---- Background: street map or aerial photos (those of the time, with the timeline) ----
  // The open ground shows the photos; leaving it brings the street map back – unless the photos were
  // already on, or the background was changed by hand meanwhile.
  let photosByOpenGround = false;
  let switching = false;
  photosForOpenGround = (active) => {
    switching = true;
    if (active && CONFIG.openGround.photos && baseMap.available && baseMap.mode === 'map') {
      background.setMode('photo');
      photosByOpenGround = true;
    } else if (!active && photosByOpenGround) {
      background.setMode('map');
      photosByOpenGround = false;
    }
    switching = false;
  };
  background = createBaseMapControl({
    baseMap,
    panel: byId('base-map'),
    chip: byId('years-photo'),
    caption: byId('years-photo-words'),
    side: () => (activeZone.group === 'Wanaka' ? 'wanaka' : 'queenstown'),
    onChange: (photo) => {
      document.body.classList.toggle('is-photo', photo);
      if (!switching) photosByOpenGround = false; // picked by hand: kept after the open ground
    },
  });

  // ---- The View menu: which view is on – map, underground, open ground or excavation – and by year on or off ----
  /** Changes the view; leaving one view for another closes what belonged to it. */
  function chooseView(view) {
    if (view !== 'map') addedPipes.stopDrawing(); // drawing is done on the plain map
    if (view === 'excavation') {
      if (cut.active) return;
      layersPanel.close();
      infoPanel.hide();
      picking.clear();
      openGround.exit(false);
      undergroundView.set(false);
      if (viewMode.mode === '2d') viewMode.set('3d'); // the excavation is a 3D view
      cut.enter();
      return;
    }
    cut.exit();
    if (view === 'map') {
      openGround.exit(false);
      undergroundView.set(false);
      return;
    }
    if (viewMode.mode === '2d') viewMode.set('3d'); // the flat map has no "below"
    if (view === 'underground') {
      // From the open ground: back to the plain underground view (lines only).
      if (openGround.active) openGround.exit(true);
      else undergroundView.set(true);
    } else if (view === 'open-ground') {
      openGround.enter();
    }
  }
  viewMenu = createViewMenu({
    container: byId('view-menu'),
    onPick: chooseView,
    onToggle: (name) => {
      if (name === 'years') return years.toggle();
      // Flow direction: arrows on the pipes whose upper end the data supports.
      flowShown = !flowShown;
      for (const network of networks) network.setFlowShown(flowShown);
      refreshViewMenu();
    },
  });
  refreshViewMenu();

  // The round buttons and the bars at the bottom keep clear of the credits line, however many lines it wraps to.
  const credits = byId('credits');
  const measureCredits = () => document.documentElement.style.setProperty('--credits-height', `${credits.offsetHeight}px`);
  measureCredits();
  new ResizeObserver(measureCredits).observe(credits);

  // Handy for troubleshooting from the browser console.
  window.demo = { viewer, viewMode, layers, zones, terrain, quality, undergroundView, excavation: cut, years, baseMap, profile, picking, openGround, viewMenu, finder, added: addedPipes, addedStore };

  await activateZone(startZone, 'jump');
}

const status = createStatus(byId('status'));
start(status).catch((error) => {
  console.error(error);
  status.fatal(error.message || 'The map could not start.');
});
