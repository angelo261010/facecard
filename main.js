"use strict";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model";
const STORAGE_KEY = "secureface_registry_v1";
const MATCH_THRESHOLD = 0.48;

const $ = (id) => document.getElementById(id);
const video = $("camera");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");

let stream = null;
let modelsReady = false;
let running = false;
let busy = false;
let frameRequest = null;
let latestDetections = [];
let registry = [];
let lastRecognitionLog = new Map();

function setNotice(message, type = "") {
  $("notice").textContent = message;
  $("notice").className = "notice" + (type ? " " + type : "");
}

function setHeader(message, state = "") {
  $("headerStatus").textContent = message;
  $("headerDot").className = "status-dot" + (state ? " " + state : "");
}

function logEvent(message, type = "info") {
  const log = $("eventLog");
  const empty = log.querySelector(".empty-state");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "event-item" + (type === "error" ? " error" : "");
  const marker = document.createElement("span");
  marker.className = "event-marker";

  const content = document.createElement("div");
  content.className = "event-content";
  const description = document.createElement("p");
  description.textContent = message;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("pt-BR");

  content.append(description, time);
  item.append(marker, content);
  log.prepend(item);
  while (log.children.length > 30) log.lastElementChild.remove();
}

function loadRegistry() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const parsed = data ? JSON.parse(data) : [];
    if (!Array.isArray(parsed)) throw new Error("Formato inválido.");

    registry = parsed.filter((person) =>
      person &&
      typeof person.id === "string" &&
      Array.isArray(person.descriptor) &&
      person.descriptor.length > 0 &&
      person.descriptor.every(Number.isFinite)
    );
  } catch (error) {
    console.error("Não foi possível ler os cadastros:", error);
    registry = [];
    setNotice("Não foi possível ler a base local. Verifique o armazenamento do navegador.", "error");
  }
  renderRegistry();
}

function persistRegistry() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
    return true;
  } catch (error) {
    console.error("Falha ao salvar a base:", error);
    setNotice("Não foi possível salvar. O armazenamento pode estar cheio ou bloqueado.", "error");
    return false;
  }
}

function renderRegistry() {
  const container = $("faceRegistry");
  container.replaceChildren();

  $("savedCount").textContent = String(registry.length);
  $("registryCount").textContent = registry.length + (registry.length === 1 ? " registro" : " registros");

  if (registry.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nenhum rosto cadastrado ainda.";
    container.appendChild(empty);
    return;
  }

  for (const person of registry) {
    const card = document.createElement("article");
    card.className = "face-card";

    const top = document.createElement("div");
    top.className = "face-card-top";
    const avatar = document.createElement("div");
    avatar.className = "face-avatar";
    avatar.textContent = "◉";

    const title = document.createElement("div");
    title.className = "face-card-title";
    const name = document.createElement("strong");
    name.textContent = person.name || "Rosto sem nome";

    const date = document.createElement("small");
    date.textContent = "Cadastrado em " + new Date(person.createdAt).toLocaleDateString("pt-BR");
    title.append(name, date);
    top.append(avatar, title);

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 60;
    input.autocomplete = "off";
    input.placeholder = "Digite um nome";
    input.value = person.name || "";
    input.setAttribute("aria-label", "Nome do cadastro");

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const saveButton = document.createElement("button");
    saveButton.className = "btn btn-primary";
    saveButton.textContent = "Salvar nome";

    saveButton.addEventListener("click", () => {
      const newName = input.value.trim();
      person.name = newName;
      if (!persistRegistry()) return;
      renderRegistry();
      setNotice(newName ? "Nome salvo no cadastro local." : "O cadastro agora está sem nome.", "success");
      logEvent(newName ? "Nome adicionado ao cadastro: " + newName + "." : "Nome removido de um cadastro.");
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "btn btn-secondary";
    deleteButton.textContent = "Excluir";
    deleteButton.addEventListener("click", () => {
      if (!confirm("Excluir este cadastro facial deste navegador?")) return;
      registry = registry.filter((entry) => entry.id !== person.id);
      if (persistRegistry()) {
        renderRegistry();
        setNotice("Cadastro excluído.", "success");
        logEvent("Um cadastro facial foi excluído.");
      }
    });

    actions.append(saveButton, deleteButton);
    card.append(top, input, actions);
    container.appendChild(card);
  }
}

async function loadModels() {
  $("connectBtn").disabled = true;
  $("saveFaceBtn").disabled = true;
  $("modelStatus").textContent = "Carregando";

  try {
    if (!window.faceapi) {
      throw new Error("A biblioteca face-api.js não carregou. Verifique a internet ou o CDN.");
    }

    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);

    modelsReady = true;
    $("modelStatus").textContent = "Disponível";
    $("connectBtn").disabled = false;
    setHeader("Sistema pronto", "online");
    setNotice("Modelos carregados. Conecte a câmera para iniciar.", "success");
    logEvent("Modelos de detecção e reconhecimento carregados.");
  } catch (error) {
    console.error("Erro ao carregar modelos:", error);
    $("modelStatus").textContent = "Indisponível";
    setHeader("Erro no detector", "error");
    setNotice("Falha ao carregar a biblioteca ou os modelos. Confira sua internet e abra F12 > Console para ver o erro.", "error");
    logEvent("Falha ao carregar os modelos: " + error.message, "error");
  }
}

async function connectCamera() {
  if (!modelsReady || stream) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setNotice("A câmera exige localhost ou HTTPS em um navegador compatível.", "error");
    return;
  }

  $("connectBtn").disabled = true;
  setNotice("Solicitando acesso à câmera...");

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
    });

    stream = newStream;
    video.srcObject = stream;

    await new Promise((resolve, reject) => {
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("O vídeo não pôde ser iniciado.")), { once: true });
    });

    await video.play();
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    video.classList.add("visible");
    $("cameraPlaceholder").classList.add("hidden");
    $("liveBadge").textContent = "AO VIVO";
    $("liveBadge").classList.add("active");
    $("cameraStatus").textContent = "Conectada";
    $("disconnectBtn").disabled = false;

    running = true;
    setHeader("Câmera conectada", "online");
    setNotice("Câmera conectada. Procurando rostos...", "success");
    logEvent("Câmera conectada.");
    startDetection();
  } catch (error) {
    console.error("Erro na câmera:", error);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }

    $("connectBtn").disabled = !modelsReady;
    $("disconnectBtn").disabled = true;
    let message = "Não foi possível conectar a câmera.";

    if (error.name === "NotAllowedError") {
      message = "Permissão negada. Autorize a câmera nas configurações do navegador.";
    } else if (error.name === "NotFoundError") {
      message = "Nenhuma câmera foi encontrada.";
    } else if (error.name === "NotReadableError") {
      message = "A câmera pode estar sendo usada por outro aplicativo.";
    } else {
      message += " " + (error.message || "");
    }

    setNotice(message, "error");
    setHeader("Erro na câmera", "error");
    logEvent(message, "error");
  }
}

function getBestMatch(descriptor) {
  let bestPerson = null;
  let bestDistance = Infinity;

  for (const person of registry) {
    const saved = new Float32Array(person.descriptor);
    if (saved.length !== descriptor.length) continue;

    const distance = faceapi.euclideanDistance(descriptor, saved);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPerson = person;
    }
  }

  if (bestPerson && bestDistance <= MATCH_THRESHOLD) {
    return { person: bestPerson, distance: bestDistance };
  }
  return null;
}

function drawDetection(detection, label, color) {
  const box = detection.detection.box;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, canvas.width / 500);
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const text = label.length > 30 ? label.slice(0, 27) + "..." : label;
  ctx.font = "bold 13px sans-serif";
  const labelWidth = ctx.measureText(text).width + 14;
  const labelY = Math.max(0, box.y - 27);

  ctx.fillStyle = "rgba(5, 15, 24, 0.9)";
  ctx.fillRect(box.x, labelY, labelWidth, 24);
  ctx.fillStyle = color;
  ctx.fillText(text, box.x + 7, labelY + 16);
}

async function startDetection() {
  if (!running || !stream || busy) return;
  busy = true;

  try {
    if (video.readyState >= 2) {
      const results = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({
          inputSize: 320,
          scoreThreshold: 0.5
        }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (!running) return;
      latestDetections = results;
      $("faceCount").textContent = String(results.length);
      $("saveFaceBtn").disabled = results.length === 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const result of results) {
        const match = getBestMatch(result.descriptor);
        if (match) {
          const label = match.person.name || "Cadastro sem nome";
          drawDetection(result, label, "#50e3c2");

          const now = Date.now();
          const last = lastRecognitionLog.get(match.person.id) || 0;
          if (now - last > 10000) {
            logEvent(match.person.name
              ? 'Possível correspondência com o cadastro "' + match.person.name + '".'
              : "Rosto semelhante a um cadastro sem nome.");
            lastRecognitionLog.set(match.person.id, now);
          }
        } else {
          drawDetection(result, "Rosto não cadastrado", "#ffbd69");
        }
      }

      if (results.length === 0) {
        setNotice("Nenhum rosto detectado.");
      } else {
        setNotice(results.length + " rosto(s) detectado(s). As correspondências são estimativas, não confirmação de identidade.", "success");
      }
    }
  } catch (error) {
    console.error("Erro durante a detecção:", error);
    setNotice("Erro durante a detecção. Confira o Console (F12).", "error");
  } finally {
    busy = false;
  }

  if (running) frameRequest = requestAnimationFrame(startDetection);
}

function saveCurrentFace() {
  if (!running || latestDetections.length === 0) {
    setNotice("Nenhum rosto disponível para cadastrar.", "error");
    return;
  }

  if (latestDetections.length > 1) {
    setNotice("Foram detectados vários rostos. Deixe apenas uma pessoa diante da câmera e tente novamente.", "error");
    return;
  }

  const result = latestDetections[0];
  const existingMatch = getBestMatch(result.descriptor);
  if (existingMatch) {
    setNotice("Este rosto já parece corresponder a um cadastro existente. Confira a lista antes de cadastrar novamente.", "error");
    return;
  }

  const entry = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2)),
    name: "",
    descriptor: Array.from(result.descriptor),
    createdAt: new Date().toISOString()
  };

  registry.push(entry);
  if (!persistRegistry()) {
    registry.pop();
    return;
  }

  renderRegistry();
  setNotice("Rosto cadastrado sem nome. Você pode adicionar o nome no cartão abaixo.", "success");
  logEvent("Novo descritor facial salvo localmente, sem nome.");

  const firstInput = $("faceRegistry").querySelector("input");
  if (firstInput) firstInput.focus();
}

function disconnectCamera() {
  running = false;
  if (frameRequest !== null) {
    cancelAnimationFrame(frameRequest);
    frameRequest = null;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  video.pause();
  video.srcObject = null;
  video.classList.remove("visible");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  latestDetections = [];

  $("cameraPlaceholder").classList.remove("hidden");
  $("liveBadge").textContent = "DESLIGADA";
  $("liveBadge").classList.remove("active");
  $("cameraStatus").textContent = "Desconectada";
  $("faceCount").textContent = "—";
  $("saveFaceBtn").disabled = true;
  $("connectBtn").disabled = !modelsReady;
  $("disconnectBtn").disabled = true;

  setHeader(modelsReady ? "Sistema pronto" : "Detector indisponível", modelsReady ? "online" : "error");
  setNotice("Câmera desconectada.");
  logEvent("Câmera desconectada.");
}

$("connectBtn").addEventListener("click", connectCamera);
$("disconnectBtn").addEventListener("click", disconnectCamera);
$("saveFaceBtn").addEventListener("click", saveCurrentFace);

$("clearLogBtn").addEventListener("click", () => {
  const log = $("eventLog");
  log.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "Os eventos aparecerão aqui.";
  log.appendChild(empty);
});

$("deleteAllBtn").addEventListener("click", () => {
  if (registry.length === 0) {
    setNotice("Não existem cadastros para apagar.");
    return;
  }

  if (!confirm("Tem certeza de que deseja apagar TODOS os cadastros faciais deste navegador?")) return;

  const previous = registry;
  registry = [];
  if (!persistRegistry()) {
    registry = previous;
    renderRegistry();
    return;
  }

  lastRecognitionLog.clear();
  renderRegistry();
  setNotice("Todos os cadastros locais foram apagados.", "success");
  logEvent("Todos os cadastros faciais foram apagados.");
});

window.addEventListener("pagehide", () => {
  running = false;
  if (stream) stream.getTracks().forEach((track) => track.stop());
});

loadRegistry();
loadModels();