/* =========================================================
   FILE 1 — APP.JS
   SC FIELD TRACKER — FULL REWRITE
   PURPOSE:
   - Google Maps version
   - Job page + Setup page
   - Safer map boot so async Google load does not break maps
   - Keeps saved fields + equipment
   - Keeps job tracking, perimeter recording, timer, coverage
========================================================= */

(() => {
  "use strict";

  /* =========================================================
     [01] DOM HELPERS
  ========================================================= */
  function el(id) {
    return document.getElementById(id);
  }

  function hasGoogleMaps() {
    return !!(
      window.google &&
      google.maps &&
      typeof google.maps.Map === "function"
    );
  }

  /* =========================================================
     [02] STORAGE KEYS
  ========================================================= */
  const STORAGE_FIELDS = "sc_field_tracker_fields_v2";
  const STORAGE_EQUIPMENT = "sc_field_tracker_equipment_v1";

  /* =========================================================
     [03] DEFAULT MAP SETTINGS
  ========================================================= */
  const DEFAULT_CENTER = { lat: 33.95, lng: -83.38 };
  const DEFAULT_ZOOM = 16;
  const MAX_GPS_ACCURACY_METERS = 6.1; /* about 20 feet */
  const MIN_PERIMETER_POINT_SPACING_METERS = 3;

  /* =========================================================
     [04] APP STATE
  ========================================================= */
  let jobMap = null;
  let setupMap = null;

  let jobUserMarker = null;
  let setupUserMarker = null;

  let selectedFieldPolygon = null;
  let setupPreviewPolyline = null;
  let setupPreviewPolygon = null;

  let setupPointMarkers = [];

  let perimeterWatchId = null;
  let jobWatchId = null;

  let isPerimeterRecording = false;
  let isJobRunning = false;
  let isJobPaused = false;

  let perimeterPoints = [];

  /* ---------- JOB TRACKING ---------- */
  let jobPath = [];
  let jobPathLine = null;
  let lastCoverageLatLng = null;
  let totalCoveredSqMeters = 0;

  /* ---------- TIMER ---------- */
  let timerInterval = null;
  let timerStartMs = 0;
  let timerElapsedMs = 0;

  /* ---------- BOOT ---------- */
  let appBooted = false;
  let googleWaitAttempts = 0;
  const GOOGLE_WAIT_MAX = 80; /* ~20 seconds */

  /* =========================================================
     [05] STORAGE HELPERS
  ========================================================= */
  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getFields() {
    return readJson(STORAGE_FIELDS, []);
  }

  function setFields(fields) {
    writeJson(STORAGE_FIELDS, fields);
  }

  function getEquipment() {
    return readJson(STORAGE_EQUIPMENT, []);
  }

  function setEquipment(items) {
    writeJson(STORAGE_EQUIPMENT, items);
  }

  /* =========================================================
     [06] STATUS HELPERS
  ========================================================= */
  function setJobStatus(text) {
    const node = el("jobStatus");
    if (node) node.textContent = text;
  }

  function setGpsStatus(text) {
    const node = el("gpsStatus");
    if (node) node.textContent = text;
  }

  function setPerimeterStatus(text) {
    const node = el("perimeterStatus");
    if (node) node.textContent = text;
  }

  function setPerimeterPointCount(count) {
    const node = el("perimeterPoints");
    if (node) node.textContent = String(count);
  }

  function setSetupFieldStats(text) {
    const node = el("setupFieldStats");
    if (node) node.textContent = text;
  }

  function setJobFieldStats(text) {
    const node = el("jobFieldStats");
    if (node) node.textContent = text;
  }

  function setJobCoverageStats(text) {
    const node = el("jobCoverageStats");
    if (node) node.textContent = text;
  }

  function setJobCompletion(text) {
    const node = el("jobCompletion");
    if (node) node.textContent = text;
  }

  /* =========================================================
     [07] NUMBER / FORMAT HELPERS
  ========================================================= */
  function formatFeet(value) {
    const num = Number(value || 0);
    return `${Math.round(num).toLocaleString()} ft`;
  }

  function formatAcres(value) {
    const num = Number(value || 0);
    return `${num.toFixed(2)} acres`;
  }

  function sqMetersToAcres(value) {
    return Number(value || 0) / 4046.8564224;
  }

  function acresToSqMeters(value) {
    return Number(value || 0) * 4046.8564224;
  }

  function circleAreaSqMeters(radiusMeters) {
    return Math.PI * radiusMeters * radiusMeters;
  }

  function formatAccuracyFeet(meters) {
    return `${Math.round(Number(meters || 0) * 3.28084)} ft`;
  }

  function getPositionAccuracyMeters(position) {
    return Number(position?.coords?.accuracy || 0);
  }

  function isAccurateEnough(position) {
    const accuracyMeters = getPositionAccuracyMeters(position);
    if (!accuracyMeters) return true;
    return accuracyMeters <= MAX_GPS_ACCURACY_METERS;
  }

  /* =========================================================
     [08] PAGE NAV
  ========================================================= */
  function showPage(pageName) {
    const jobPage = el("jobPage");
    const setupPage = el("setupPage");
    const navJob = el("navJob");
    const navSetup = el("navSetup");

    if (!jobPage || !setupPage || !navJob || !navSetup) return;

    jobPage.classList.remove("active");
    setupPage.classList.remove("active");
    navJob.classList.remove("active");
    navSetup.classList.remove("active");

    if (pageName === "setup") {
      setupPage.classList.add("active");
      navSetup.classList.add("active");
    } else {
      jobPage.classList.add("active");
      navJob.classList.add("active");
    }

    window.setTimeout(() => {
      if (jobMap && hasGoogleMaps()) {
        google.maps.event.trigger(jobMap, "resize");
      }
      if (setupMap && hasGoogleMaps()) {
        google.maps.event.trigger(setupMap, "resize");
      }
    }, 150);
  }

  /* =========================================================
     [09] TIMER
  ========================================================= */
  function renderTimer(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const timerNode = el("jobTimer");
    if (!timerNode) return;

    timerNode.textContent =
      `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);

    timerStartMs = Date.now();

    timerInterval = setInterval(() => {
      const current = timerElapsedMs + (Date.now() - timerStartMs);
      renderTimer(current);
    }, 1000);
  }

  function pauseTimer() {
    if (!timerInterval) return;

    clearInterval(timerInterval);
    timerInterval = null;
    timerElapsedMs += (Date.now() - timerStartMs);
  }

  function resetTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    timerElapsedMs = 0;
    timerStartMs = 0;
    renderTimer(0);
  }

  /* =========================================================
     [10] GEO HELPERS
  ========================================================= */
  function toLatLngLiteral(position) {
    return {
      lat: Number(position.coords.latitude),
      lng: Number(position.coords.longitude)
    };
  }

  function distanceMeters(a, b) {
    if (!hasGoogleMaps()) return 0;
    return google.maps.geometry.spherical.computeDistanceBetween(
      new google.maps.LatLng(a.lat, a.lng),
      new google.maps.LatLng(b.lat, b.lng)
    );
  }

  function getPolygonAreaSqMeters(points) {
    if (!hasGoogleMaps() || !Array.isArray(points) || points.length < 3) return 0;
    const path = points.map((p) => new google.maps.LatLng(p.lat, p.lng));
    return Math.abs(google.maps.geometry.spherical.computeArea(path));
  }

  function getPolygonPerimeterMeters(points) {
    if (!hasGoogleMaps() || !Array.isArray(points) || points.length < 2) return 0;
    const path = points.map((p) => new google.maps.LatLng(p.lat, p.lng));
    return google.maps.geometry.spherical.computeLength(path);
  }

  function isPointInsideField(latLngLiteral, fieldPoints) {
    if (!hasGoogleMaps()) return false;
    if (!Array.isArray(fieldPoints) || fieldPoints.length < 3) return false;

    const point = new google.maps.LatLng(latLngLiteral.lat, latLngLiteral.lng);
    const polygon = new google.maps.Polygon({
      paths: fieldPoints
    });

    return google.maps.geometry.poly.containsLocation(point, polygon);
  }

  function getSelectedField() {
    const select = el("fieldSelect");
    const fields = getFields();
    if (!select) return null;
    return fields.find((field) => field.id === select.value) || null;
  }

  function getSelectedEquipment() {
    const select = el("equipmentSelect");
    const equipment = getEquipment();
    if (!select) return null;
    return equipment.find((item) => item.id === select.value) || null;
  }

  /* =========================================================
     [11] ID HELPERS
  ========================================================= */
  function uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /* =========================================================
     [12] MAP DRAW HELPERS
  ========================================================= */
  function ensureJobMap() {
    if (!hasGoogleMaps() || jobMap) return;

    const mapNode = el("jobMap");
    if (!mapNode) return;

    jobMap = new google.maps.Map(mapNode, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      mapTypeId: "satellite",
      streetViewControl: false,
      fullscreenControl: true,
      mapTypeControl: true
    });

    jobUserMarker = new google.maps.Marker({
      map: jobMap,
      position: DEFAULT_CENTER,
      title: "Your position"
    });
  }

  function ensureSetupMap() {
    if (!hasGoogleMaps() || setupMap) return;

    const mapNode = el("setupMap");
    if (!mapNode) return;

    setupMap = new google.maps.Map(mapNode, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      mapTypeId: "satellite",
      streetViewControl: false,
      fullscreenControl: true,
      mapTypeControl: true
    });

    setupUserMarker = new google.maps.Marker({
      map: setupMap,
      position: DEFAULT_CENTER,
      title: "Your position"
    });

    setupPreviewPolyline = new google.maps.Polyline({
      map: setupMap,
      path: [],
      strokeColor: "#49b37d",
      strokeOpacity: 0.95,
      strokeWeight: 3
    });

    setupPreviewPolygon = new google.maps.Polygon({
      map: setupMap,
      paths: [],
      strokeColor: "#49b37d",
      strokeOpacity: 0.95,
      strokeWeight: 2,
      fillColor: "#49b37d",
      fillOpacity: 0.18
    });
  }

  function clearSetupPointMarkers() {
    setupPointMarkers.forEach((marker) => marker.setMap(null));
    setupPointMarkers = [];
  }

  function redrawSetupPreview() {
    if (!setupPreviewPolyline || !setupPreviewPolygon) return;

    setupPreviewPolyline.setPath(perimeterPoints);

    if (perimeterPoints.length >= 3) {
      setupPreviewPolygon.setPaths(perimeterPoints);
    } else {
      setupPreviewPolygon.setPaths([]);
    }

    clearSetupPointMarkers();

    if (!setupMap || !hasGoogleMaps()) return;

    perimeterPoints.forEach((pt, index) => {
      const marker = new google.maps.Marker({
        map: setupMap,
        position: pt,
        label: String(index + 1)
      });
      setupPointMarkers.push(marker);
    });

    setPerimeterPointCount(perimeterPoints.length);

    if (perimeterPoints.length >= 3) {
      const areaSqMeters = getPolygonAreaSqMeters(perimeterPoints);
      const areaAcres = sqMetersToAcres(areaSqMeters);
      const perimeterMeters = getPolygonPerimeterMeters([...perimeterPoints, perimeterPoints[0]]);
      const perimeterFeet = perimeterMeters * 3.28084;

      setSetupFieldStats(
        `Area: ${formatAcres(areaAcres)} | Perimeter: ${formatFeet(perimeterFeet)}`
      );
    } else {
      setSetupFieldStats("Need at least 3 points to form a field.");
    }
  }

  function clearSelectedFieldPolygon() {
    if (selectedFieldPolygon) {
      selectedFieldPolygon.setMap(null);
      selectedFieldPolygon = null;
    }
  }

  function drawSelectedFieldOnJobMap(field) {
    clearSelectedFieldPolygon();

    if (!field || !jobMap || !hasGoogleMaps()) return;

    selectedFieldPolygon = new google.maps.Polygon({
      map: jobMap,
      paths: field.points,
      strokeColor: "#67d39b",
      strokeOpacity: 1,
      strokeWeight: 2,
      fillColor: "#67d39b",
      fillOpacity: 0.12
    });

    const bounds = new google.maps.LatLngBounds();
    field.points.forEach((pt) => bounds.extend(pt));
    jobMap.fitBounds(bounds);
  }

  function clearJobPathLine() {
    if (jobPathLine) {
      jobPathLine.setMap(null);
      jobPathLine = null;
    }
  }

  function redrawJobPathLine() {
    clearJobPathLine();

    if (!jobMap || !hasGoogleMaps() || jobPath.length < 2) return;

    jobPathLine = new google.maps.Polyline({
      map: jobMap,
      path: jobPath,
      strokeColor: "#49b37d",
      strokeOpacity: 1,
      strokeWeight: 4
    });
  }

  function clearCoverageVisualsAndData() {
    jobPath = [];
    lastCoverageLatLng = null;
    totalCoveredSqMeters = 0;
    clearJobPathLine();
    updateJobFieldAndCoverageUI();
  }

  /* =========================================================
     [13] UI DATA LOADERS
  ========================================================= */
  function populateFieldSelect() {
    const select = el("fieldSelect");
    if (!select) return;

    const currentValue = select.value;
    const fields = getFields();

    select.innerHTML = "";

    if (!fields.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No saved fields";
      select.appendChild(opt);
      setJobFieldStats("No field selected.");
      setJobCoverageStats(`Covered: ${formatAcres(0)}`);
      setJobCompletion("Completion: 0.0%");
      clearSelectedFieldPolygon();
      return;
    }

    fields.forEach((field) => {
      const opt = document.createElement("option");
      opt.value = field.id;
      opt.textContent = field.name;
      select.appendChild(opt);
    });

    if (fields.some((field) => field.id === currentValue)) {
      select.value = currentValue;
    }

    const selected = getSelectedField();
    drawSelectedFieldOnJobMap(selected);
    updateJobFieldAndCoverageUI();
  }

  function populateEquipmentSelect() {
    const select = el("equipmentSelect");
    if (!select) return;

    const currentValue = select.value;
    const items = getEquipment();

    select.innerHTML = "";

    if (!items.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No saved equipment";
      select.appendChild(opt);
      return;
    }

    items.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = `${item.name} (${item.widthFeet} ft)`;
      select.appendChild(opt);
    });

    if (items.some((item) => item.id === currentValue)) {
      select.value = currentValue;
    }
  }

  function renderFieldList() {
    const list = el("fieldList");
    if (!list) return;

    list.innerHTML = "";
    const fields = getFields();

    if (!fields.length) {
      const li = document.createElement("li");
      li.textContent = "No saved fields yet.";
      list.appendChild(li);
      return;
    }

    fields.forEach((field) => {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.textContent = field.name;

      const buttonWrap = document.createElement("div");
      buttonWrap.style.display = "flex";
      buttonWrap.style.gap = "8px";

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.textContent = "View";
      viewBtn.className = "view-btn";
      viewBtn.addEventListener("click", () => {
        showPage("job");
        const select = el("fieldSelect");
        if (select) {
          select.value = field.id;
          drawSelectedFieldOnJobMap(field);
          updateJobFieldAndCoverageUI();
        }
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.className = "delete-btn";
      deleteBtn.addEventListener("click", () => deleteField(field.id));

      buttonWrap.appendChild(viewBtn);
      buttonWrap.appendChild(deleteBtn);

      li.appendChild(label);
      li.appendChild(buttonWrap);

      list.appendChild(li);
    });
  }

  function renderEquipmentList() {
    const list = el("equipmentList");
    if (!list) return;

    list.innerHTML = "";
    const items = getEquipment();

    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "No saved equipment yet.";
      list.appendChild(li);
      return;
    }

    items.forEach((item) => {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.textContent = `${item.name} — ${item.widthFeet} ft`;

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.className = "delete-btn";
      deleteBtn.addEventListener("click", () => deleteEquipment(item.id));

      li.appendChild(label);
      li.appendChild(deleteBtn);

      list.appendChild(li);
    });
  }

  function refreshAllListsAndSelectors() {
    renderFieldList();
    renderEquipmentList();
    populateFieldSelect();
    populateEquipmentSelect();
  }

  /* =========================================================
     [14] FIELD / EQUIPMENT CRUD
  ========================================================= */
  function saveField() {
    const nameInput = el("fieldNameInput");
    const name = (nameInput?.value || "").trim();

    if (!name) {
      alert("Please enter a field name.");
      return;
    }

    if (perimeterPoints.length < 3) {
      alert("You need at least 3 perimeter points.");
      return;
    }

    const areaSqMeters = getPolygonAreaSqMeters(perimeterPoints);
    const areaAcres = sqMetersToAcres(areaSqMeters);

    const perimeterMeters = getPolygonPerimeterMeters([...perimeterPoints, perimeterPoints[0]]);
    const perimeterFeet = perimeterMeters * 3.28084;

    const fields = getFields();
    fields.push({
      id: uid("field"),
      name,
      points: perimeterPoints.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
      areaAcres,
      perimeterFeet
    });

    setFields(fields);

    if (nameInput) nameInput.value = "";

    clearPerimeter();
    refreshAllListsAndSelectors();
    alert("Field saved.");
  }

  function deleteField(fieldId) {
    const fields = getFields();
    const field = fields.find((item) => item.id === fieldId);

    if (!field) return;

    const ok = window.confirm(`Delete field "${field.name}"?`);
    if (!ok) return;

    const next = fields.filter((item) => item.id !== fieldId);
    setFields(next);
    refreshAllListsAndSelectors();
  }

  function saveEquipment() {
    const nameInput = el("equipmentNameInput");
    const widthInput = el("equipmentWidthInput");

    const name = (nameInput?.value || "").trim();
    const widthFeet = Number(widthInput?.value || 0);

    if (!name) {
      alert("Please enter equipment name.");
      return;
    }

    if (!widthFeet || widthFeet <= 0) {
      alert("Please enter a valid width in feet.");
      return;
    }

    const items = getEquipment();
    items.push({
      id: uid("equip"),
      name,
      widthFeet
    });

    setEquipment(items);

    if (nameInput) nameInput.value = "";
    if (widthInput) widthInput.value = "";

    refreshAllListsAndSelectors();
    alert("Equipment saved.");
  }

  function deleteEquipment(itemId) {
    const items = getEquipment();
    const item = items.find((entry) => entry.id === itemId);

    if (!item) return;

    const ok = window.confirm(`Delete equipment "${item.name}"?`);
    if (!ok) return;

    const next = items.filter((entry) => entry.id !== itemId);
    setEquipment(next);
    refreshAllListsAndSelectors();
  }

  /* =========================================================
     [15] PERIMETER RECORDING
  ========================================================= */
  function clearPerimeter() {
    perimeterPoints = [];
    isPerimeterRecording = false;

    if (perimeterWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(perimeterWatchId);
      perimeterWatchId = null;
    }

    redrawSetupPreview();
    setPerimeterStatus("Not recording");
    setPerimeterPointCount(0);
    setSetupFieldStats("No perimeter yet.");
  }

  function handlePerimeterPosition(position) {
    if (!setupMap || !setupUserMarker) return;

    const latLng = toLatLngLiteral(position);
    setupUserMarker.setPosition(latLng);
    setupMap.panTo(latLng);

    const accuracyMeters = getPositionAccuracyMeters(position);

    if (!isAccurateEnough(position)) {
      setPerimeterStatus(`Waiting for better GPS (${formatAccuracyFeet(accuracyMeters)} accuracy)`);
      return;
    }

    setPerimeterStatus(`Recording perimeter (${formatAccuracyFeet(accuracyMeters)} accuracy)`);

    const lastPoint = perimeterPoints[perimeterPoints.length - 1];

    if (!lastPoint) {
      perimeterPoints.push(latLng);
      redrawSetupPreview();
      return;
    }

    const meters = distanceMeters(lastPoint, latLng);

    if (meters >= MIN_PERIMETER_POINT_SPACING_METERS) {
      perimeterPoints.push(latLng);
      redrawSetupPreview();
    }
  }

  function startPerimeterRecording() {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported on this device.");
      return;
    }

    if (isPerimeterRecording) return;

    isPerimeterRecording = true;
    setPerimeterStatus("Starting perimeter...");

    perimeterWatchId = navigator.geolocation.watchPosition(
      handlePerimeterPosition,
      (err) => {
        setPerimeterStatus(`GPS error: ${err.message}`);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      }
    );
  }

  function stopPerimeterRecording() {
    isPerimeterRecording = false;

    if (perimeterWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(perimeterWatchId);
      perimeterWatchId = null;
    }

    setPerimeterStatus("Perimeter stopped");
  }

  /* =========================================================
     [16] JOB COVERAGE + STATS
  ========================================================= */
  function updateJobFieldAndCoverageUI() {
    const field = getSelectedField();

    if (!field) {
      setJobFieldStats("No field selected.");
      setJobCoverageStats(`Covered: ${formatAcres(0)}`);
      setJobCompletion("Completion: 0.0%");
      return;
    }

    const fieldAreaAcres = Number(field.areaAcres || 0);
    const coveredAcres = sqMetersToAcres(totalCoveredSqMeters);
    const completionPct = fieldAreaAcres > 0
      ? Math.min(100, (coveredAcres / fieldAreaAcres) * 100)
      : 0;

    setJobFieldStats(
      `Field: ${field.name} | Size: ${formatAcres(fieldAreaAcres)}`
    );
    setJobCoverageStats(
      `Covered: ${formatAcres(coveredAcres)}`
    );
    setJobCompletion(
      `Completion: ${completionPct.toFixed(1)}%`
    );
  }

  function drawCoverageAt(latLng) {
    jobPath.push(latLng);
    redrawJobPathLine();

    const equipment = getSelectedEquipment();
    if (!equipment) return;

    const radiusMeters = (Number(equipment.widthFeet || 0) * 0.3048) / 2;
    if (!radiusMeters) return;

    if (!lastCoverageLatLng) {
      totalCoveredSqMeters += circleAreaSqMeters(radiusMeters);
      lastCoverageLatLng = { lat: latLng.lat, lng: latLng.lng };
      updateJobFieldAndCoverageUI();
      return;
    }

    const meters = distanceMeters(lastCoverageLatLng, latLng);
    const spacingThreshold = Math.max(1.5, radiusMeters * 0.5);

    if (meters >= spacingThreshold) {
      totalCoveredSqMeters += circleAreaSqMeters(radiusMeters);
      lastCoverageLatLng = { lat: latLng.lat, lng: latLng.lng };
      updateJobFieldAndCoverageUI();
    }
  }

  /* =========================================================
     [17] JOB TRACKING
  ========================================================= */
  function handleJobPosition(position) {
    if (!jobMap || !jobUserMarker) return;

    const latLng = toLatLngLiteral(position);
    jobUserMarker.setPosition(latLng);
    jobMap.panTo(latLng);

    const accuracyMeters = getPositionAccuracyMeters(position);
    setGpsStatus(`GPS accuracy: ${formatAccuracyFeet(accuracyMeters)}`);

    if (!isJobRunning || isJobPaused) return;

    if (!isAccurateEnough(position)) {
      setJobStatus(`Running — waiting for better GPS (${formatAccuracyFeet(accuracyMeters)})`);
      return;
    }

    const field = getSelectedField();
    if (!field || !Array.isArray(field.points) || field.points.length < 3) {
      setJobStatus("Running — no valid field selected");
      return;
    }

    if (!isPointInsideField(latLng, field.points)) {
      setJobStatus("Running — outside field boundary");
      return;
    }

    setJobStatus("Running");
    drawCoverageAt(latLng);
  }

  function startJob() {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported on this device.");
      return;
    }

    const field = getSelectedField();
    const equipment = getSelectedEquipment();

    if (!field) {
      alert("Please select a field.");
      return;
    }

    if (!equipment) {
      alert("Please select equipment.");
      return;
    }

    if (!isJobRunning) {
      clearCoverageVisualsAndData();
      resetTimer();
      startTimer();

      isJobRunning = true;
      isJobPaused = false;

      setJobStatus("Starting job...");

      jobWatchId = navigator.geolocation.watchPosition(
        handleJobPosition,
        (err) => {
          setJobStatus(`GPS error: ${err.message}`);
          setGpsStatus(`GPS error: ${err.message}`);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000
        }
      );
    } else if (isJobPaused) {
      isJobPaused = false;
      startTimer();
      setJobStatus("Running");
    }
  }

  function pauseJob() {
    if (!isJobRunning || isJobPaused) return;

    isJobPaused = true;
    pauseTimer();
    setJobStatus("Paused");
  }

  function stopJob() {
    if (!isJobRunning) return;

    isJobRunning = false;
    isJobPaused = false;

    if (jobWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(jobWatchId);
      jobWatchId = null;
    }

    pauseTimer();
    setJobStatus("Stopped");
  }

  function clearCoverage() {
    clearCoverageVisualsAndData();
    setJobStatus(isJobRunning ? "Running" : "Not running");
  }

  /* =========================================================
     [18] MAP CENTER HELPERS
  ========================================================= */
  function centerMapOnCurrentPosition(target) {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported on this device.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latLng = toLatLngLiteral(position);

        if (target === "job" && jobMap) {
          jobMap.panTo(latLng);
          jobMap.setZoom(18);
          if (jobUserMarker) jobUserMarker.setPosition(latLng);
        }

        if (target === "setup" && setupMap) {
          setupMap.panTo(latLng);
          setupMap.setZoom(18);
          if (setupUserMarker) setupUserMarker.setPosition(latLng);
        }
      },
      (err) => {
        alert(`Could not get current position: ${err.message}`);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      }
    );
  }

  /* =========================================================
     [19] EVENT HOOKS
  ========================================================= */
  function bindEvents() {
    el("navJob")?.addEventListener("click", () => showPage("job"));
    el("navSetup")?.addEventListener("click", () => showPage("setup"));

    el("startPerimeterBtn")?.addEventListener("click", startPerimeterRecording);
    el("stopPerimeterBtn")?.addEventListener("click", stopPerimeterRecording);
    el("saveFieldBtn")?.addEventListener("click", saveField);
    el("clearPerimeterBtn")?.addEventListener("click", clearPerimeter);
    el("centerSetupBtn")?.addEventListener("click", () => centerMapOnCurrentPosition("setup"));

    el("addEquipmentBtn")?.addEventListener("click", saveEquipment);

    el("startJobBtn")?.addEventListener("click", startJob);
    el("pauseJobBtn")?.addEventListener("click", pauseJob);
    el("stopJobBtn")?.addEventListener("click", stopJob);
    el("clearCoverageBtn")?.addEventListener("click", clearCoverage);
    el("centerJobBtn")?.addEventListener("click", () => centerMapOnCurrentPosition("job"));

    el("fieldSelect")?.addEventListener("change", () => {
      const field = getSelectedField();
      drawSelectedFieldOnJobMap(field);
      updateJobFieldAndCoverageUI();
    });
  }

  /* =========================================================
     [20] DEFAULT DATA
  ========================================================= */
  function ensureDefaultEquipment() {
    const items = getEquipment();
    if (items.length) return;

    setEquipment([
      { id: uid("equip"), name: "Bush Hog", widthFeet: 6 },
      { id: uid("equip"), name: "Mower", widthFeet: 5 },
      { id: uid("equip"), name: "Seeder", widthFeet: 8 }
    ]);
  }

  /* =========================================================
     [21] INITIAL GPS SNAP
  ========================================================= */
  function doInitialPositionSnap() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latLng = toLatLngLiteral(position);

        if (jobMap) {
          jobMap.panTo(latLng);
          if (jobUserMarker) jobUserMarker.setPosition(latLng);
        }

        if (setupMap) {
          setupMap.panTo(latLng);
          if (setupUserMarker) setupUserMarker.setPosition(latLng);
        }

        const accuracyMeters = getPositionAccuracyMeters(position);
        setGpsStatus(`GPS accuracy: ${formatAccuracyFeet(accuracyMeters)}`);
      },
      () => {},
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      }
    );
  }

  /* =========================================================
     [22] BOOT CORE
  ========================================================= */
  function finishBoot() {
    if (appBooted) return;

    ensureJobMap();
    ensureSetupMap();
    ensureDefaultEquipment();

    bindEvents();
    refreshAllListsAndSelectors();
    doInitialPositionSnap();

    renderTimer(0);
    setJobStatus("Not running");
    setGpsStatus("Waiting for GPS");
    setPerimeterStatus("Not recording");
    setPerimeterPointCount(0);
    setSetupFieldStats("No perimeter yet.");
    updateJobFieldAndCoverageUI();

    appBooted = true;
    console.log("SC Field Tracker booted.");
  }

  function waitForGoogleAndBoot() {
    if (appBooted) return;

    if (hasGoogleMaps()) {
      finishBoot();
      return;
    }

    googleWaitAttempts += 1;

    if (googleWaitAttempts > GOOGLE_WAIT_MAX) {
      console.error("Google Maps did not load.");
      alert("Google Maps did not load. Check your API key or script tag.");
      return;
    }

    window.setTimeout(waitForGoogleAndBoot, 250);
  }

  /* =========================================================
     [24] GLOBAL CALLBACKS
  ========================================================= */
  window.initFieldTracker = function initFieldTracker() {
    waitForGoogleAndBoot();
  };

  /* =========================================================
     [25] BOOT TRIGGERS
  ========================================================= */
  document.addEventListener("DOMContentLoaded", waitForGoogleAndBoot);
  window.addEventListener("load", waitForGoogleAndBoot);
})();
