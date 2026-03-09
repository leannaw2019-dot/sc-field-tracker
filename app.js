/* =========================================================
   SC FIELD TRACKER — APP.JS
   PURPOSE:
   - GOOGLE MAPS VERSION
   - 2 pages only: Job + Setup
   - Job page: live map, timer, coverage, GPS
   - Setup page: perimeter recording map
   - Save fields + equipment to localStorage
========================================================= */

(() => {
  "use strict";

  /* =========================================================
     [01] DOM HELPERS
  ========================================================= */
  function el(id) {
    return document.getElementById(id);
  }

  /* =========================================================
     [02] STORAGE KEYS
  ========================================================= */
  const STORAGE_FIELDS = "sc_field_tracker_fields_v1";
  const STORAGE_EQUIPMENT = "sc_field_tracker_equipment_v1";

  /* =========================================================
     [03] DEFAULT MAP CENTER
  ========================================================= */
  const DEFAULT_CENTER = { lat: 33.95, lng: -83.38 };
  const DEFAULT_ZOOM = 16;

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
  let jobCoverageCircles = [];

  let perimeterWatchId = null;
  let jobWatchId = null;

  let isPerimeterRecording = false;
  let isJobRunning = false;
  let isJobPaused = false;

  let perimeterPoints = [];
  let lastCoverageLatLng = null;

  let timerInterval = null;
  let timerStartMs = 0;
  let timerElapsedMs = 0;

  /* =========================================================
     [05] SAFE STORAGE
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
    el("jobStatus").textContent = text;
  }

  function setGpsStatus(text) {
    el("gpsStatus").textContent = text;
  }

  function setPerimeterStatus(text) {
    el("perimeterStatus").textContent = text;
  }

  function setPerimeterPointCount(count) {
    el("perimeterPoints").textContent = String(count);
  }

  /* =========================================================
     [07] PAGE NAV
  ========================================================= */
  function showPage(pageName) {
    const jobPage = el("jobPage");
    const setupPage = el("setupPage");
    const navJob = el("navJob");
    const navSetup = el("navSetup");

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

    setTimeout(() => {
      if (jobMap) google.maps.event.trigger(jobMap, "resize");
      if (setupMap) google.maps.event.trigger(setupMap, "resize");
    }, 150);
  }

  /* =========================================================
     [08] TIMER
  ========================================================= */
  function renderTimer(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    el("jobTimer").textContent =
      String(hours).padStart(2, "0") + ":" +
      String(minutes).padStart(2, "0") + ":" +
      String(seconds).padStart(2, "0");
  }

  function startTimer() {
    timerStartMs = Date.now();

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const current = timerElapsedMs + (Date.now() - timerStartMs);
      renderTimer(current);
    }, 1000);
  }

  function pauseTimer() {
    if (!timerStartMs) return;
    timerElapsedMs += Date.now() - timerStartMs;
    timerStartMs = 0;
    clearInterval(timerInterval);
    timerInterval = null;
    renderTimer(timerElapsedMs);
  }

  function resetTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    timerStartMs = 0;
    timerElapsedMs = 0;
    renderTimer(0);
  }

  /* =========================================================
     [09] MAP INIT
  ========================================================= */
  function initMaps() {
    jobMap = new google.maps.Map(el("jobMap"), {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      mapTypeId: "hybrid",
      tilt: 0,
      streetViewControl: false,
      fullscreenControl: false,
      mapTypeControl: true
    });

    setupMap = new google.maps.Map(el("setupMap"), {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      mapTypeId: "hybrid",
      tilt: 0,
      streetViewControl: false,
      fullscreenControl: false,
      mapTypeControl: true
    });
  }

  /* =========================================================
     [10] DROPDOWNS
  ========================================================= */
  function loadFieldDropdown() {
    const fields = getFields();
    const select = el("fieldSelect");
    select.innerHTML = "";

    if (!fields.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No fields saved";
      select.appendChild(option);
      return;
    }

    fields.forEach((field, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = field.name;
      select.appendChild(option);
    });
  }

  function loadEquipmentDropdown() {
    const equipment = getEquipment();
    const select = el("equipmentSelect");
    select.innerHTML = "";

    if (!equipment.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No equipment saved";
      select.appendChild(option);
      return;
    }

    equipment.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${item.name} (${item.width} ft)`;
      select.appendChild(option);
    });
  }

  /* =========================================================
     [11] LIST RENDERING
  ========================================================= */
  function renderFieldList() {
    const list = el("fieldList");
    const fields = getFields();
    list.innerHTML = "";

    if (!fields.length) {
      const li = document.createElement("li");
      li.textContent = "No fields saved yet.";
      list.appendChild(li);
      return;
    }

    fields.forEach((field, index) => {
      const li = document.createElement("li");

      const left = document.createElement("span");
      left.textContent = field.name;

      const rightWrap = document.createElement("div");

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.textContent = "View";
      viewBtn.addEventListener("click", () => {
        zoomSetupMapToField(index);
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => {
        deleteField(index);
      });

      rightWrap.appendChild(viewBtn);
      rightWrap.appendChild(delBtn);

      li.appendChild(left);
      li.appendChild(rightWrap);
      list.appendChild(li);
    });
  }

  function renderEquipmentList() {
    const list = el("equipmentList");
    const equipment = getEquipment();
    list.innerHTML = "";

    if (!equipment.length) {
      const li = document.createElement("li");
      li.textContent = "No equipment saved yet.";
      list.appendChild(li);
      return;
    }

    equipment.forEach((item, index) => {
      const li = document.createElement("li");

      const left = document.createElement("span");
      left.textContent = `${item.name} (${item.width} ft)`;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => {
        deleteEquipment(index);
      });

      li.appendChild(left);
      li.appendChild(delBtn);
      list.appendChild(li);
    });
  }

  function refreshSavedDataUI() {
    loadFieldDropdown();
    loadEquipmentDropdown();
    renderFieldList();
    renderEquipmentList();
    drawSelectedFieldOnJobMap();
  }

  /* =========================================================
     [12] MAP HELPERS
  ========================================================= */
  function latLngLiteral(point) {
    return {
      lat: Number(point.lat),
      lng: Number(point.lng)
    };
  }

  function pathToBounds(path) {
    const bounds = new google.maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    return bounds;
  }

  function clearSetupPreviewGraphics() {
    if (setupPreviewPolyline) {
      setupPreviewPolyline.setMap(null);
      setupPreviewPolyline = null;
    }

    if (setupPreviewPolygon) {
      setupPreviewPolygon.setMap(null);
      setupPreviewPolygon = null;
    }

    setupPointMarkers.forEach((marker) => marker.setMap(null));
    setupPointMarkers = [];
  }

  function clearJobFieldGraphics() {
    if (selectedFieldPolygon) {
      selectedFieldPolygon.setMap(null);
      selectedFieldPolygon = null;
    }
  }

  /* =========================================================
     [13] FIELD DRAW / DISPLAY HELPERS
  ========================================================= */
  function renderSetupPerimeterPreview() {
    clearSetupPreviewGraphics();

    if (!perimeterPoints.length) {
      setPerimeterPointCount(0);
      return;
    }

    perimeterPoints.forEach((point) => {
      const marker = new google.maps.Marker({
        position: point,
        map: setupMap,
        clickable: false,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 4,
          fillColor: "#49b37d",
          fillOpacity: 1,
          strokeColor: "#49b37d",
          strokeWeight: 1
        }
      });

      setupPointMarkers.push(marker);
    });

    if (perimeterPoints.length >= 2) {
      setupPreviewPolyline = new google.maps.Polyline({
        path: perimeterPoints,
        map: setupMap,
        strokeColor: "#49b37d",
        strokeOpacity: 1,
        strokeWeight: 3
      });
    }

    if (perimeterPoints.length >= 3) {
      setupPreviewPolygon = new google.maps.Polygon({
        paths: perimeterPoints,
        map: setupMap,
        strokeColor: "#49b37d",
        strokeOpacity: 1,
        strokeWeight: 2,
        fillColor: "#49b37d",
        fillOpacity: 0.18
      });
    }

    setPerimeterPointCount(perimeterPoints.length);
  }

  function drawSelectedFieldOnJobMap() {
    clearJobFieldGraphics();

    const fields = getFields();
    const index = Number(el("fieldSelect").value);

    if (!Number.isInteger(index) || !fields[index]) return;

    const field = fields[index];
    if (!Array.isArray(field.boundary) || field.boundary.length < 3) return;

    const path = field.boundary.map(latLngLiteral);

    selectedFieldPolygon = new google.maps.Polygon({
      paths: path,
      map: jobMap,
      strokeColor: "#67d39b",
      strokeOpacity: 1,
      strokeWeight: 2,
      fillColor: "#67d39b",
      fillOpacity: 0.12
    });

    const bounds = pathToBounds(path);
    jobMap.fitBounds(bounds);
  }

  function zoomSetupMapToField(index) {
    const fields = getFields();
    const field = fields[index];
    if (!field || !Array.isArray(field.boundary) || field.boundary.length < 3) return;

    clearSetupPreviewGraphics();

    const path = field.boundary.map(latLngLiteral);

    setupPreviewPolygon = new google.maps.Polygon({
      paths: path,
      map: setupMap,
      strokeColor: "#49b37d",
      strokeOpacity: 1,
      strokeWeight: 2,
      fillColor: "#49b37d",
      fillOpacity: 0.18
    });

    const bounds = pathToBounds(path);
    setupMap.fitBounds(bounds);
  }

  /* =========================================================
     [14] GPS HELPERS
  ========================================================= */
  function centerMapOnCurrentLocation(targetMap, markerType) {
    if (!navigator.geolocation) {
      alert("This device does not support GPS.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latLng = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        targetMap.setCenter(latLng);
        targetMap.setZoom(19);

        if (markerType === "job") {
          if (!jobUserMarker) {
            jobUserMarker = new google.maps.Marker({
              position: latLng,
              map: jobMap
            });
          } else {
            jobUserMarker.setPosition(latLng);
          }
        }

        if (markerType === "setup") {
          if (!setupUserMarker) {
            setupUserMarker = new google.maps.Marker({
              position: latLng,
              map: setupMap
            });
          } else {
            setupUserMarker.setPosition(latLng);
          }
        }
      },
      (error) => {
        alert("Could not get GPS location: " + error.message);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  }

  /* =========================================================
     [15] PERIMETER RECORDING
  ========================================================= */
  function startPerimeterRecording() {
    if (!navigator.geolocation) {
      alert("This device does not support GPS.");
      return;
    }

    if (isPerimeterRecording) return;

    perimeterPoints = [];
    clearSetupPreviewGraphics();
    setPerimeterPointCount(0);

    if (perimeterWatchId !== null) {
      navigator.geolocation.clearWatch(perimeterWatchId);
      perimeterWatchId = null;
    }

    isPerimeterRecording = true;
    setPerimeterStatus("Recording perimeter...");

    perimeterWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const latLng = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        if (!setupUserMarker) {
          setupUserMarker = new google.maps.Marker({
            position: latLng,
            map: setupMap
          });
        } else {
          setupUserMarker.setPosition(latLng);
        }

        setupMap.setCenter(latLng);
        setupMap.setZoom(19);

        const lastPoint = perimeterPoints[perimeterPoints.length - 1];
        if (!lastPoint || distanceMeters(lastPoint, latLng) >= 3) {
          perimeterPoints.push(latLng);
          renderSetupPerimeterPreview();
        }
      },
      (error) => {
        alert("Perimeter GPS error: " + error.message);
        stopPerimeterRecording();
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  }

  function stopPerimeterRecording() {
    if (perimeterWatchId !== null) {
      navigator.geolocation.clearWatch(perimeterWatchId);
      perimeterWatchId = null;
    }

    isPerimeterRecording = false;

    if (perimeterPoints.length >= 3) {
      setPerimeterStatus("Perimeter recorded");
      renderSetupPerimeterPreview();
    } else {
      setPerimeterStatus("Not enough points yet");
    }
  }

  function clearPerimeterRecording() {
    stopPerimeterRecording();
    perimeterPoints = [];
    clearSetupPreviewGraphics();
    setPerimeterPointCount(0);
    setPerimeterStatus("Not recording");
  }

  function saveField() {
    const name = String(el("fieldNameInput").value || "").trim();

    if (!name) {
      alert("Enter a field name.");
      return;
    }

    if (perimeterPoints.length < 3) {
      alert("Record the perimeter first.");
      return;
    }

    const closedBoundary = autoCloseBoundary(perimeterPoints);
    const fields = getFields();

    fields.push({
      name,
      boundary: closedBoundary,
      createdAt: new Date().toISOString()
    });

    setFields(fields);

    el("fieldNameInput").value = "";
    setPerimeterStatus("Field saved");
    refreshSavedDataUI();
  }

  function deleteField(index) {
    const fields = getFields();
    fields.splice(index, 1);
    setFields(fields);
    refreshSavedDataUI();
  }

  function autoCloseBoundary(points) {
    if (points.length < 3) return points.slice();

    const first = points[0];
    const last = points[points.length - 1];

    if (distanceMeters(first, last) <= 6) {
      const next = points.slice();
      next[next.length - 1] = { lat: first.lat, lng: first.lng };
      return next;
    }

    const closed = points.slice();
    closed.push({ lat: first.lat, lng: first.lng });
    return closed;
  }

  /* =========================================================
     [16] EQUIPMENT
  ========================================================= */
  function addEquipment() {
    const name = String(el("equipmentNameInput").value || "").trim();
    const width = Number(el("equipmentWidthInput").value || 0);

    if (!name) {
      alert("Enter an equipment name.");
      return;
    }

    if (!width || width <= 0) {
      alert("Enter a width greater than 0.");
      return;
    }

    const equipment = getEquipment();
    equipment.push({
      name,
      width,
      createdAt: new Date().toISOString()
    });

    setEquipment(equipment);

    el("equipmentNameInput").value = "";
    el("equipmentWidthInput").value = "";

    refreshSavedDataUI();
  }

  function deleteEquipment(index) {
    const equipment = getEquipment();
    equipment.splice(index, 1);
    setEquipment(equipment);
    refreshSavedDataUI();
  }

  /* =========================================================
     [17] JOB COVERAGE
     NOTE:
     - Simple circle-strip version for testing
  ========================================================= */
  function drawCoverageAt(latLng) {
    const equipment = getEquipment();
    const equipIndex = Number(el("equipmentSelect").value);
    const item = equipment[equipIndex];

    const widthFeet = item ? Number(item.width) : 6;
    const radiusMeters = (widthFeet * 0.3048) / 2;

    if (!lastCoverageLatLng || distanceMeters(lastCoverageLatLng, latLng) >= Math.max(1.5, radiusMeters * 0.5)) {
      const circle = new google.maps.Circle({
        map: jobMap,
        center: latLng,
        radius: radiusMeters,
        strokeColor: "#49b37d",
        strokeOpacity: 0.7,
        strokeWeight: 1,
        fillColor: "#49b37d",
        fillOpacity: 0.24
      });

      jobCoverageCircles.push(circle);
      lastCoverageLatLng = { lat: latLng.lat, lng: latLng.lng };
    }
  }

  function clearCoverage() {
    jobCoverageCircles.forEach((circle) => circle.setMap(null));
    jobCoverageCircles = [];
    lastCoverageLatLng = null;
  }

  /* =========================================================
     [18] JOB GPS TRACKING
  ========================================================= */
  function startJob() {
    const fields = getFields();
    const equipment = getEquipment();
    const fieldIndex = Number(el("fieldSelect").value);
    const equipmentIndex = Number(el("equipmentSelect").value);

    if (!fields[fieldIndex]) {
      alert("Pick a saved field first.");
      return;
    }

    if (!equipment[equipmentIndex]) {
      alert("Pick saved equipment first.");
      return;
    }

    if (!navigator.geolocation) {
      alert("This device does not support GPS.");
      return;
    }

    if (isJobRunning && !isJobPaused) return;

    if (jobWatchId !== null) {
      navigator.geolocation.clearWatch(jobWatchId);
      jobWatchId = null;
    }

    isJobRunning = true;
    isJobPaused = false;
    setJobStatus("Running");
    setGpsStatus("Tracking");
    startTimer();

    jobWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const latLng = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        if (!jobUserMarker) {
          jobUserMarker = new google.maps.Marker({
            position: latLng,
            map: jobMap
          });
        } else {
          jobUserMarker.setPosition(latLng);
        }

        jobMap.setCenter(latLng);
        jobMap.setZoom(19);
        drawCoverageAt(latLng);
      },
      (error) => {
        alert("Job GPS error: " + error.message);
        pauseJob();
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  }

  function pauseJob() {
    if (jobWatchId !== null) {
      navigator.geolocation.clearWatch(jobWatchId);
      jobWatchId = null;
    }

    if (!isJobRunning) return;

    isJobPaused = true;
    isJobRunning = false;
    pauseTimer();
    setJobStatus("Paused");
    setGpsStatus("Paused");
  }

  function stopJob() {
    if (jobWatchId !== null) {
      navigator.geolocation.clearWatch(jobWatchId);
      jobWatchId = null;
    }

    isJobRunning = false;
    isJobPaused = false;
    resetTimer();
    lastCoverageLatLng = null;
    setJobStatus("Stopped");
    setGpsStatus("Idle");
  }

  /* =========================================================
     [19] UTILITIES
  ========================================================= */
  function distanceMeters(a, b) {
    if (
      window.google &&
      google.maps &&
      google.maps.geometry &&
      google.maps.geometry.spherical
    ) {
      return google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(a.lat, a.lng),
        new google.maps.LatLng(b.lat, b.lng)
      );
    }

    const lat1 = a.lat * Math.PI / 180;
    const lng1 = a.lng * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const lng2 = b.lng * Math.PI / 180;

    const dLat = lat2 - lat1;
    const dLng = lng2 - lng1;

    const earthRadius = 6371000;

    const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const y = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));

    return earthRadius * y;
  }

  /* =========================================================
     [20] EVENTS
  ========================================================= */
  function bindEvents() {
    el("navJob").addEventListener("click", () => showPage("job"));
    el("navSetup").addEventListener("click", () => showPage("setup"));

    el("fieldSelect").addEventListener("change", drawSelectedFieldOnJobMap);

    el("startJobBtn").addEventListener("click", startJob);
    el("pauseJobBtn").addEventListener("click", pauseJob);
    el("stopJobBtn").addEventListener("click", stopJob);
    el("clearCoverageBtn").addEventListener("click", clearCoverage);
    el("centerJobBtn").addEventListener("click", () => {
      centerMapOnCurrentLocation(jobMap, "job");
    });

    el("startPerimeterBtn").addEventListener("click", startPerimeterRecording);
    el("stopPerimeterBtn").addEventListener("click", stopPerimeterRecording);
    el("saveFieldBtn").addEventListener("click", saveField);
    el("clearPerimeterBtn").addEventListener("click", clearPerimeterRecording);
    el("centerSetupBtn").addEventListener("click", () => {
      centerMapOnCurrentLocation(setupMap, "setup");
    });

    el("addEquipmentBtn").addEventListener("click", addEquipment);
  }

  /* =========================================================
     [21] BOOT
  ========================================================= */
  function init() {
    if (!window.google || !google.maps) {
      alert("Google Maps did not load. Check your API key.");
      return;
    }

    initMaps();
    bindEvents();
    refreshSavedDataUI();
    renderTimer(0);
    setJobStatus("Ready");
    setGpsStatus("Idle");
    setPerimeterStatus("Not recording");
    setPerimeterPointCount(0);
  }

  window.addEventListener("load", init);
})()