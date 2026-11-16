import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

// --- CONFIGURACIÓN FIREBASE ---
const isImmersive = typeof __firebase_config !== 'undefined';
const firebaseConfig = isImmersive
  ? JSON.parse(__firebase_config)
  : {
      apiKey: "AIzaSyA_oBYFPEhxXFY4EaJL3cYoD85ewnq-5k8",
      authDomain: "atm-reaction.firebaseapp.com",
      projectId: "atm-reaction",
      storageBucket: "atm-reaction.firebasestorage.app",
      messagingSenderId: "373946278065",
      appId: "1:373946278065:web:c33550b5db4b5001120290"
    };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'atm-reaction-app';

// Ruta de base de datos adaptativa
const dbPath = isImmersive ? `artifacts/${appId}/public/data/rankings` : 'rankings';

// --- DETECTORES (MediaPipe) ---
// IMPORTANTE: la versión del paquete npm y la del WASM deben coincidir (0.10.14)
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Respaldo local de registros (por si Firebase falla o no hay conexión)
const LOCAL_KEY = 'atm-reaction-records-v2';
const LOGO_SRC = `${import.meta.env.BASE_URL}escudo.PNG`;

// ---- PARÁMETROS DE PRECISIÓN (ajustables) ----
const HAND_MIN_SCORE = 0.7;        // confianza mínima de "esto es una mano"
const HAND_MIN_SCORE_NOPOSE = 0.85; // más estricto si no se ve el cuerpo del portero
const HIT_RADIUS_FACTOR = 1.1;      // 1.0 = el centro de la palma debe tocar el círculo
const HIT_MIN_FRAMES = 2;           // detecciones seguidas dentro del círculo
const HIT_MIN_DWELL_MS = 60;        // y tiempo mínimo dentro del círculo
const COUNTDOWN_SECONDS = 4;        // tiempo para colocarse y calibrar

// Configuraciones de dificultad
// sizePct: diámetro en % del lado MÁS CORTO de la pantalla (modo Cerca)
// farFrac: diámetro como fracción del ancho de hombros del portero (modo Lejos)
const DIFFICULTIES = {
  easy: { label: 'Fácil', targetLifespan: 2000, spawnDelay: 800, sizePct: 15, farFrac: 0.55, basePoints: 10, distractorChance: 0.15 },
  medium: { label: 'Medio', targetLifespan: 1200, spawnDelay: 500, sizePct: 11, farFrac: 0.40, basePoints: 15, distractorChance: 0.30 },
  hard: { label: 'Difícil', targetLifespan: 750, spawnDelay: 300, sizePct: 8, farFrac: 0.28, basePoints: 20, distractorChance: 0.45 }
};

// Distancia del portero a la cámara
const DISTANCES = {
  near: { label: 'Cerca', desc: 'Círculos por toda la pantalla' },
  far: { label: 'Lejos', desc: 'Círculos junto al portero, a su alcance: pasos cortos. Se ajusta a su distancia' },
  mixed: { label: 'Mixto', desc: 'Alterna pantalla completa y alcance corto' }
};

const GAME_DURATION = 60; // Segundos que dura una partida

// Plantilla Oficial de Porteros
const ROSTER = [
  { short: 'ROBERTO', full: 'ROBERTO PERÉZ OLIVARES' },
  { short: 'JOSÉ', full: 'JOSÉ ALEJANDRO LEAL CEBALLOS' },
  { short: 'HUGO', full: 'HUGO GARCÍA MILLÁN' },
  { short: 'MATÍAS', full: 'MATÍAS MONTALVO LÓPEZ' },
  { short: 'IZAN', full: 'IZAN AHMED ALCALÁ' },
  { short: 'ÁLVARO', full: 'ÁLVARO RAMIREZ GARCÍA' },
  { short: 'MATEO', full: 'MATEO GUTIÉRREZ MORALES' },
  { short: 'GONZALO', full: 'GONZALO CAMARMA CABALLERO' }
];

const PALM_IDX = [0, 5, 9, 13, 17];
const POSE_HAND_IDX = [15, 16, 17, 18, 19, 20, 21, 22]; // muñecas, meñiques, índices, pulgares

const centroid = (pts, idx) => {
  const arr = idx.map((i) => pts[i]).filter(Boolean);
  return {
    x: arr.reduce((a, p) => a + p.x, 0) / arr.length,
    y: arr.reduce((a, p) => a + p.y, 0) / arr.length
  };
};

const bboxDiag = (pts) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

// Zona que el portero alcanza sin desplazarse mucho: centrada en su pecho,
// proporcional al ancho de sus hombros (así se adapta sola a la distancia).
const getReachBox = (cal) => {
  const cy = cal.oy + 0.5 * cal.sw;
  return { x0: cal.ox - 1.6 * cal.sw, x1: cal.ox + 1.6 * cal.sw, y0: cy - 1.0 * cal.sw, y1: cy + 1.0 * cal.sw };
};

const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const readLocalRecords = () => {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

const avgOf = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

export default function ReactionTrainingApp() {
  const [gameState, setGameState] = useState('menu'); // 'menu', 'countdown', 'playing', 'gameover', 'ranking'
  const [playerName, setPlayerName] = useState('');
  const [difficulty, setDifficulty] = useState('easy');
  const [distance, setDistance] = useState('near');
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [target, setTarget] = useState(null);
  const [cloudRanking, setCloudRanking] = useState([]);
  const [localRecords, setLocalRecords] = useState(readLocalRecords);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [cameraError, setCameraError] = useState(null);
  const [handStatus, setHandStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [poseStatus, setPoseStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [calibStatus, setCalibStatus] = useState('searching'); // 'searching' | 'ok' | 'unavailable'
  const [calibWarning, setCalibWarning] = useState(false);
  const [handVisible, setHandVisible] = useState(false);
  const [lastRecord, setLastRecord] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'cloud' | 'local'

  const [user, setUser] = useState(null);
  const [reactionTimes, setReactionTimes] = useState([]);
  const [comboUI, setComboUI] = useState(0);
  const [scorePopups, setScorePopups] = useState([]);

  // Refs de juego (siempre con el valor actual, sin problemas de closures)
  const scoreRef = useRef(0);
  const hitsRef = useRef([]);
  const errorsRef = useRef(0);
  const missedRef = useRef(0);
  const maxComboRef = useRef(0);
  const comboRef = useRef(0);
  const endedRef = useRef(false);
  const targetRef = useRef(null);
  const gameStateRef = useRef(gameState);
  const difficultyRef = useRef(difficulty);
  const distanceRef = useRef(distance);
  const playerNameRef = useRef(playerName);

  // Refs de visión
  const visualCanvasRef = useRef(null);
  const detectCanvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const poseRef = useRef(null);
  const poseCanvasRef = useRef(null);
  const poseCacheRef = useRef({ t: -1e9, poses: [] });
  const calibRef = useRef(null); // { ox, oy, sw } en px de pantalla
  const calibSamplesRef = useRef([]);
  const calibStatusRef = useRef('searching');
  const lastCenterRef = useRef(null);
  const animationRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const frameCountRef = useRef(0);
  const handVisibleRef = useRef(false);

  const audioCtxRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const gameTimerRef = useRef(null);
  const targetTimerRef = useRef(null);
  const hitTimeoutRef = useRef(null);

  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  useEffect(() => { difficultyRef.current = difficulty; }, [difficulty]);
  useEffect(() => { distanceRef.current = distance; }, [distance]);
  useEffect(() => { playerNameRef.current = playerName; }, [playerName]);

  // Ranking combinado (nube + respaldo local), sin duplicados
  const ranking = useMemo(() => {
    const map = new Map();
    localRecords.forEach((r) => map.set(String(r.id), r));
    cloudRanking.forEach((r) => map.set(String(r.id), r));
    return [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  }, [cloudRanking, localRecords]);

  // --- AUTENTICACIÓN FIREBASE ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined') {
          const userCredential = await signInWithCustomToken(auth, __initial_auth_token);
          setUser(userCredential.user);
        } else {
          const userCredential = await signInAnonymously(auth);
          setUser(userCredential.user);
        }
      } catch (error) {
        console.error('Error autenticando con Firebase:', error);
      }
    };
    initAuth();
  }, []);

  // --- SINCRONIZACIÓN CON FIREBASE EN TIEMPO REAL ---
  useEffect(() => {
    if (!user) return;
    const colRef = collection(db, dbPath);
    const unsubscribe = onSnapshot(
      colRef,
      (snapshot) => {
        const data = [];
        snapshot.forEach((d) => data.push(d.data()));
        setCloudRanking(data);
      },
      (error) => console.error('Error leyendo Firebase:', error)
    );
    return () => unsubscribe();
  }, [user]);

  // --- CARGA DE DETECTORES (manos + cuerpo) ---
  const loadHandModel = useCallback(async () => {
    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks(WASM_URL);
    } catch (err) {
      console.error('No se pudo cargar MediaPipe:', err);
      setHandStatus('error');
      setPoseStatus('error');
      return;
    }

    const build = async (Cls, modelUrl, opts) => {
      const create = (delegate) =>
        Cls.createFromOptions(vision, {
          baseOptions: { modelAssetPath: modelUrl, delegate },
          runningMode: 'IMAGE',
          ...opts
        });
      try {
        return await create('GPU');
      } catch (gpuErr) {
        console.warn('GPU no disponible, usando CPU:', gpuErr);
        return await create('CPU');
      }
    };

    // Manos (obligatorio)
    try {
      landmarkerRef.current = await build(HandLandmarker, HAND_MODEL_URL, {
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      setHandStatus('ready');
    } catch (err) {
      console.error('No se pudo cargar el detector de manos:', err);
      setHandStatus('error');
      return;
    }

    // Cuerpo (valida que la "mano" esté unida a una muñeca y calibra la distancia)
    try {
      poseRef.current = await build(PoseLandmarker, POSE_MODEL_URL, {
        numPoses: 2,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      setPoseStatus('ready');
    } catch (err) {
      console.error('No se pudo cargar el detector de cuerpo:', err);
      setPoseStatus('error');
    }
  }, []);

  useEffect(() => {
    loadHandModel();
    return () => {
      if (landmarkerRef.current) { landmarkerRef.current.close(); landmarkerRef.current = null; }
      if (poseRef.current) { poseRef.current.close(); poseRef.current = null; }
    };
  }, [loadHandModel]);

  // --- CÁMARA ---
  // Ref callback: si el <video> se vuelve a montar, se reconecta el stream
  const setVideoNode = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current && node.srcObject !== streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch((e) => console.error('Error reproduciendo video:', e));
    }
  }, []);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          },
          audio: false
        });
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (track) {
          track.addEventListener('ended', () =>
            setCameraError('La cámara se desconectó. Reconéctala y recarga la página.')
          );
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play().catch((e) => console.error('Error reproduciendo video:', e));
          };
        }
        setCameraError(null);
      } catch (err) {
        console.warn('No se pudo acceder a la cámara:', err);
        setCameraError('No se pudo acceder a la cámara. Revisa los permisos.');
      }
    };

    startCamera();

    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
      cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // --- SONIDOS ---
  const playSound = useCallback((type) => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    const now = ctx.currentTime;

    if (type === 'hit') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.5, now + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'error') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(100, now + 0.2);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.4, now + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'tick') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, now);
      gainNode.gain.setValueAtTime(0.3, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'end') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, now);
      gainNode.gain.setValueAtTime(0.3, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 1);
      osc.start(now);
      osc.stop(now + 1);
    }
  }, []);

  // --- GUARDADO DE REGISTROS ---
  const saveRecord = async (record) => {
    setSaveStatus('saving');

    // 1) Respaldo local inmediato (nunca se pierde la sesión)
    try {
      const list = readLocalRecords();
      list.push(record);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
      setLocalRecords(list);
    } catch (e) {
      console.error('No se pudo guardar en local:', e);
    }

    // 2) Nube
    try {
      if (!auth.currentUser) {
        try { await signInAnonymously(auth); } catch (e) { console.error(e); }
      }
      const docRef = doc(db, dbPath, String(record.id));
      await Promise.race([
        setDoc(docRef, record),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ]);
      setSaveStatus('cloud');
    } catch (e) {
      console.error('Error guardando en Firebase:', e);
      setSaveStatus('local');
    }
  };

  // --- FIN DE PARTIDA (usa solo refs: el puntaje siempre es el real) ---
  const finalizeSession = () => {
    if (endedRef.current) return;
    endedRef.current = true;

    playSound('end');
    clearTimeout(targetTimerRef.current);
    clearTimeout(hitTimeoutRef.current);
    clearInterval(gameTimerRef.current);
    cancelAnimationFrame(animationRef.current);

    const hits = hitsRef.current.slice();
    const zoneAvg = (cond) => {
      const f = hits.filter(cond).map((h) => h.time);
      return f.length ? avgOf(f) : 0;
    };

    const finalScore = scoreRef.current;
    const config = DIFFICULTIES[difficultyRef.current];
    const now = new Date();
    const record = {
      id: Date.now(),
      name: playerNameRef.current,
      score: finalScore,
      difficulty: config.label,
      distance: DISTANCES[distanceRef.current].label,
      calibrated: !!calibRef.current,
      hits: hits.length,
      errors: errorsRef.current,
      missed: missedRef.current,
      bestCombo: maxComboRef.current,
      avgReactionMs: avgOf(hits.map((h) => h.time)),
      quadrants: {
        tl: zoneAvg((h) => h.x < 50 && h.y < 50),
        tr: zoneAvg((h) => h.x >= 50 && h.y < 50),
        bl: zoneAvg((h) => h.x < 50 && h.y >= 50),
        br: zoneAvg((h) => h.x >= 50 && h.y >= 50)
      },
      date: now.toLocaleDateString('es-ES'),
      timestamp: now.toISOString()
    };

    setScore(finalScore);
    setReactionTimes(hits);
    setLastRecord(record);
    setTarget(null);
    targetRef.current = null;
    setTimeLeft(0);
    setGameState('gameover');

    saveRecord(record);
  };

  // --- CUENTA REGRESIVA ---
  useEffect(() => {
    if (gameState === 'countdown') {
      if (countdown > 0) {
        playSound('tick');
        const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
        return () => clearTimeout(timer);
      } else {
        playSound('hit');
        setGameState('playing');
      }
    }
  }, [gameState, countdown, playSound]);

  // --- BUCLE PRINCIPAL (temporizador + objetivos) ---
  useEffect(() => {
    if (gameState !== 'playing') return;

    lockCalibration();

    const deadline = performance.now() + GAME_DURATION * 1000;
    gameTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) finalizeSession();
    }, 250);

    scheduleNextTarget();

    // Mantener la pantalla encendida durante la sesión
    let wakeLock = null;
    let cancelled = false;
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen')
        .then((l) => { if (cancelled) l.release().catch(() => {}); else wakeLock = l; })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      if (wakeLock) wakeLock.release().catch(() => {});
      clearInterval(gameTimerRef.current);
      clearTimeout(targetTimerRef.current);
      clearTimeout(hitTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState]);

  // --- BUCLE DE VISIÓN (calibración en la cuenta atrás + manos en juego) ---
  useEffect(() => {
    if (gameState !== 'countdown' && gameState !== 'playing') return;
    startVisionLoop();
    return () => cancelAnimationFrame(animationRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState]);

  // ---------- CALIBRACIÓN DEL PORTERO ----------
  const lockCalibration = () => {
    const samples = calibSamplesRef.current;
    if (samples.length >= 5) {
      const recent = samples.slice(-15);
      calibRef.current = {
        sw: median(recent.map((x) => x.sw)),
        ox: median(recent.map((x) => x.ox)),
        oy: median(recent.map((x) => x.oy))
      };
    } else {
      calibRef.current = null;
    }
    setCalibWarning(distanceRef.current !== 'near' && !calibRef.current);
  };

  const setCalibStatusSafe = (status) => {
    if (calibStatusRef.current !== status) {
      calibStatusRef.current = status;
      setCalibStatus(status);
    }
  };

  // ---------- DETECCIÓN ----------
  const detectHands = (landmarker, video, crop) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!detectCanvasRef.current) detectCanvasRef.current = document.createElement('canvas');
    const canvas = detectCanvasRef.current;
    const scale = Math.min(1, 960 / crop.cw);
    const cw = Math.max(1, Math.round(crop.cw * scale));
    const ch = Math.max(1, Math.round(crop.ch * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    canvas.getContext('2d').drawImage(video, crop.sx, crop.sy, crop.cw, crop.ch, 0, 0, cw, ch);

    const result = landmarker.detect(canvas);
    const handedness = result.handedness || result.handednesses || [];
    return (result.landmarks || []).map((hand, i) => ({
      score: handedness[i]?.[0]?.score ?? 1,
      pts: hand.map((p) => ({ nx: (crop.sx + p.x * crop.cw) / vw, ny: (crop.sy + p.y * crop.ch) / vh }))
    }));
  };

  const detectPoses = (poseLm, video, geo) => {
    if (!poseCanvasRef.current) poseCanvasRef.current = document.createElement('canvas');
    const canvas = poseCanvasRef.current;
    const scale = Math.min(1, 960 / geo.vw);
    const cw = Math.round(geo.vw * scale);
    const ch = Math.round(geo.vh * scale);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    canvas.getContext('2d').drawImage(video, 0, 0, cw, ch);

    const res = poseLm.detect(canvas);
    return (res.landmarks || []).map((lms) => {
      const pts = lms.map((p) => ({
        x: (1 - p.x) * geo.vw * geo.s + geo.offX,
        y: p.y * geo.vh * geo.s + geo.offY,
        v: p.visibility ?? 1
      }));
      const a = pts[11];
      const b = pts[12];
      const sw = Math.hypot(a.x - b.x, a.y - b.y);
      return {
        pts, sw,
        ox: (a.x + b.x) / 2,
        oy: (a.y + b.y) / 2,
        valid: a.v >= 0.5 && b.v >= 0.5 && sw > 8
      };
    });
  };

  const pickMainPose = (poses) => {
    const valid = poses.filter((p) => p.valid);
    if (!valid.length) return null;
    return valid.reduce((best, p) => (p.sw > best.sw ? p : best));
  };

  // Región del video que se analiza para encontrar manos
  const getCrop = (mode, geo) => {
    const { vw, vh, s, offX, offY } = geo;
    const full = { sx: 0, sy: 0, cw: vw, ch: vh };
    if (mode === 'full') return full;

    const cal = calibRef.current;
    if (!cal) {
      const cw = vw * 0.7;
      return { sx: (vw - cw) / 2, sy: 0, cw, ch: vh };
    }
    // Recorte alrededor del portero (pantalla -> video, con espejo)
    const cyS = cal.oy + 0.5 * cal.sw;
    const xa = cal.ox - 2.4 * cal.sw;
    const xb = cal.ox + 2.4 * cal.sw;
    const ya = cyS - 1.8 * cal.sw;
    const yb = cyS + 1.8 * cal.sw;
    let x0 = Math.max(0, vw - (xb - offX) / s);
    let x1 = Math.min(vw, vw - (xa - offX) / s);
    let y0 = Math.max(0, (ya - offY) / s);
    let y1 = Math.min(vh, (yb - offY) / s);

    const minW = vw * 0.25;
    const minH = vh * 0.35;
    if (x1 - x0 < minW) {
      const c = (x0 + x1) / 2;
      x0 = Math.max(0, Math.min(vw - minW, c - minW / 2));
      x1 = x0 + minW;
    }
    if (y1 - y0 < minH) {
      const c = (y0 + y1) / 2;
      y0 = Math.max(0, Math.min(vh - minH, c - minH / 2));
      y1 = y0 + minH;
    }
    return { sx: x0, sy: y0, cw: x1 - x0, ch: y1 - y0 };
  };

  // ¿Es realmente una mano? (descarta cabeza, cara y falsos positivos)
  const validateHand = (h, poses, poseAge) => {
    if (h.score < HAND_MIN_SCORE) return false;

    const bodies = poses.filter((p) => p.valid);
    if (bodies.length === 0 || poseAge > 700) {
      // Sin referencia del cuerpo: exigir mucha más confianza
      return h.score >= HAND_MIN_SCORE_NOPOSE;
    }

    let best = Infinity;
    bodies.forEach((p) => {
      POSE_HAND_IDX.forEach((i) => {
        const q = p.pts[i];
        if (q && q.v >= 0.3) best = Math.min(best, Math.hypot(h.palm.x - q.x, h.palm.y - q.y));
      });
    });
    if (!isFinite(best)) return h.score >= HAND_MIN_SCORE_NOPOSE;

    // La palma debe estar pegada a una muñeca/mano del cuerpo detectado.
    const mainSw = Math.max(...bodies.map((p) => p.sw));
    const tol = Math.max(h.size * 1.0, mainSw * 0.4);
    return best <= tol;
  };

  const startVisionLoop = () => {
    lastVideoTimeRef.current = -1;
    frameCountRef.current = 0;

    const loop = () => {
      const gs = gameStateRef.current;
      if (gs !== 'playing' && gs !== 'countdown') return;

      const video = videoRef.current;
      const vc = visualCanvasRef.current;
      const handLm = landmarkerRef.current;

      if (
        video && vc && handLm &&
        video.readyState >= 2 && video.videoWidth > 0 &&
        video.currentTime !== lastVideoTimeRef.current
      ) {
        lastVideoTimeRef.current = video.currentTime;
        frameCountRef.current += 1;
        const now = performance.now();

        const W = vc.clientWidth;
        const H = vc.clientHeight;
        if (vc.width !== W || vc.height !== H) {
          vc.width = W;
          vc.height = H;
        }
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const s = Math.max(W / vw, H / vh); // object-cover
        const geo = { vw, vh, s, offX: (W - vw * s) / 2, offY: (H - vh * s) / 2, W, H };

        // --- Cuerpo (cada 2-3 frames) ---
        let poseUpdated = false;
        const poseEvery = gs === 'countdown' ? 2 : 3;
        if (poseRef.current && frameCountRef.current % poseEvery === 0) {
          try {
            poseCacheRef.current = { t: now, poses: detectPoses(poseRef.current, video, geo) };
            poseUpdated = true;
          } catch (e) {
            console.warn('Pose desactivada por error:', e);
            poseRef.current = null;
          }
        }
        const poses = poseCacheRef.current.poses;
        const poseAge = now - poseCacheRef.current.t;

        const vctx = vc.getContext('2d');
        vctx.clearRect(0, 0, W, H);

        // ================= CUENTA ATRÁS: CALIBRAR =================
        if (gs === 'countdown') {
          if (!poseRef.current) {
            setCalibStatusSafe('unavailable');
          } else {
            const main = poseAge < 700 ? pickMainPose(poses) : null;
            if (main && poseUpdated) {
              calibSamplesRef.current.push({ sw: main.sw, ox: main.ox, oy: main.oy });
              if (calibSamplesRef.current.length > 40) calibSamplesRef.current.shift();
            }
            if (poseUpdated || calibStatusRef.current === 'unavailable') {
              setCalibStatusSafe(main ? 'ok' : 'searching');
            }
            if (main) {
              // Hombros
              vctx.lineWidth = 4;
              vctx.strokeStyle = 'rgba(190, 242, 100, 0.95)';
              vctx.fillStyle = 'rgba(190, 242, 100, 0.95)';
              const a = main.pts[11];
              const b = main.pts[12];
              vctx.beginPath(); vctx.moveTo(a.x, a.y); vctx.lineTo(b.x, b.y); vctx.stroke();
              [a, b].forEach((p) => { vctx.beginPath(); vctx.arc(p.x, p.y, 7, 0, Math.PI * 2); vctx.fill(); });

              // Vista previa de la zona de alcance
              if (distanceRef.current !== 'near') {
                const box = getReachBox({ ox: main.ox, oy: main.oy, sw: main.sw });
                vctx.setLineDash([14, 10]);
                vctx.lineWidth = 3;
                vctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
                vctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
                vctx.setLineDash([]);
              }
            }
          }
          animationRef.current = requestAnimationFrame(loop);
          return;
        }

        // ================= JUEGO: MANOS =================
        const dist = distanceRef.current;
        const mode = dist === 'near' ? 'full'
          : dist === 'far' ? 'crop'
          : (frameCountRef.current % 2 === 0 ? 'crop' : 'full');

        let rawHands = [];
        try {
          rawHands = detectHands(handLm, video, getCrop(mode, geo));
        } catch (e) {
          console.error('Error detectando manos:', e);
        }

        const hands = rawHands.map((h) => {
          const pts = h.pts.map((p) => ({
            x: (1 - p.nx) * vw * s + geo.offX,
            y: p.ny * vh * s + geo.offY
          }));
          const hand = { pts, score: h.score, palm: centroid(pts, PALM_IDX), size: bboxDiag(pts) };
          hand.valid = validateHand(hand, poses, poseAge);
          return hand;
        });

        // Dibujo: cian = mano válida, rojo = descartada (cabeza, falso positivo)
        const conns = HandLandmarker.HAND_CONNECTIONS || [];
        hands.forEach((h) => {
          if (!h.valid) {
            vctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
            vctx.lineWidth = 3;
            vctx.beginPath();
            vctx.arc(h.palm.x, h.palm.y, Math.max(14, h.size / 3), 0, Math.PI * 2);
            vctx.stroke();
            return;
          }
          vctx.lineWidth = 3;
          vctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
          vctx.fillStyle = 'rgba(34, 211, 238, 0.95)';
          conns.forEach(({ start, end }) => {
            if (!h.pts[start] || !h.pts[end]) return;
            vctx.beginPath();
            vctx.moveTo(h.pts[start].x, h.pts[start].y);
            vctx.lineTo(h.pts[end].x, h.pts[end].y);
            vctx.stroke();
          });
          h.pts.forEach((p) => {
            vctx.beginPath();
            vctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            vctx.fill();
          });
          // Punto que cuenta para activar el círculo
          vctx.fillStyle = 'rgba(190, 242, 100, 1)';
          vctx.beginPath();
          vctx.arc(h.palm.x, h.palm.y, 9, 0, Math.PI * 2);
          vctx.fill();
        });

        processHands(hands.filter((h) => h.valid));
      }

      animationRef.current = requestAnimationFrame(loop);
    };

    animationRef.current = requestAnimationFrame(loop);
  };

  // Regla de activación: el CENTRO DE LA PALMA debe entrar en el círculo
  // (desde fuera) y permanecer unas décimas de segundo.
  const processHands = (hands) => {
    const now = Date.now();

    const visible = hands.length > 0;
    if (visible !== handVisibleRef.current) {
      handVisibleRef.current = visible;
      setHandVisible(visible);
    }

    const t = targetRef.current;
    if (!t || t.isHit) return;

    if (!visible) {
      if (!t.noHandSince) t.noHandSince = now;
      if (now - t.noHandSince >= 300) t.sawOutside = true;
      t.insideCount = 0;
      t.firstInsideAt = 0;
      return;
    }
    t.noHandSince = 0;

    const inside = hands.some(
      (h) => Math.hypot(h.palm.x - t.cx, h.palm.y - t.cy) <= t.r * HIT_RADIUS_FACTOR
    );

    if (!inside) {
      t.sawOutside = true;
      t.insideCount = 0;
      t.firstInsideAt = 0;
      return;
    }

    // Si la mano ya estaba dentro cuando apareció el círculo, debe salir y volver a entrar
    if (!t.sawOutside) return;

    if (t.insideCount === 0) t.firstInsideAt = now;
    t.insideCount += 1;
    if (t.insideCount >= HIT_MIN_FRAMES && now - t.firstInsideAt >= HIT_MIN_DWELL_MS) {
      handleTargetHit(t.id, t.firstInsideAt);
    }
  };

  // ---------- OBJETIVOS ----------
  const scheduleNextTarget = () => {
    const config = DIFFICULTIES[difficultyRef.current];
    targetTimerRef.current = setTimeout(() => {
      spawnTarget();
    }, config.spawnDelay);
  };

  const pickPosition = (zoneKey, r, W, H) => {
    const cal = calibRef.current;
    let box;
    if (zoneKey === 'far' && cal) {
      box = getReachBox(cal);
    } else if (zoneKey === 'far') {
      box = { x0: W * 0.3, x1: W * 0.7, y0: H * 0.25, y1: H * 0.8 };
    } else {
      box = { x0: W * 0.05, x1: W * 0.95, y0: H * 0.16, y1: H * 0.95 };
    }
    const m = 8;
    box = {
      x0: Math.max(box.x0, m), x1: Math.min(box.x1, W - m),
      y0: Math.max(box.y0, m), y1: Math.min(box.y1, H - m)
    };

    let minX = box.x0 + r, maxX = box.x1 - r;
    let minY = box.y0 + r, maxY = box.y1 - r;
    if (maxX < minX) { minX = maxX = (box.x0 + box.x1) / 2; }
    if (maxY < minY) { minY = maxY = (box.y0 + box.y1) / 2; }

    const prev = lastCenterRef.current;
    let pos = null;
    for (let i = 0; i < 30; i++) {
      pos = { cx: minX + Math.random() * (maxX - minX), cy: minY + Math.random() * (maxY - minY) };
      if (!prev || zoneKey !== 'far' || !cal) break;
      // Modo "lejos": el siguiente círculo queda cerca del anterior (pasos cortos)
      const d = Math.hypot(pos.cx - prev.cx, pos.cy - prev.cy);
      if (d >= 0.45 * cal.sw && d <= 1.3 * cal.sw) break;
    }
    return pos;
  };

  const spawnTarget = () => {
    if (gameStateRef.current !== 'playing') return;

    const config = DIFFICULTIES[difficultyRef.current];
    const dist = distanceRef.current;
    const zoneKey = dist === 'mixed' ? (Math.random() < 0.5 ? 'far' : 'near') : dist;

    const vc = visualCanvasRef.current;
    const W = (vc && vc.clientWidth) || window.innerWidth;
    const H = (vc && vc.clientHeight) || window.innerHeight;
    const cal = calibRef.current;

    // Tamaño: en "lejos" proporcional al portero; en "cerca" proporcional a la pantalla
    let d;
    if (zoneKey === 'far' && cal) {
      d = Math.min(Math.max(config.farFrac * cal.sw, 0.05 * H), 0.2 * H);
    } else {
      d = Math.max((config.sizePct / 100) * Math.min(W, H), 0.05 * H);
    }
    const r = d / 2;

    const { cx, cy } = pickPosition(zoneKey, r, W, H);
    lastCenterRef.current = { cx, cy };

    const id = Date.now();
    const isDistractor = Math.random() < config.distractorChance;

    let distractorData = null;
    if (isDistractor) {
      const distractors = [
        { bg: 'bg-red-500', shadow: 'shadow-[0_0_30px_rgba(239,68,68,0.8)]', inner: 'bg-red-300/50', penalty: 15 },
        { bg: 'bg-purple-500', shadow: 'shadow-[0_0_30px_rgba(168,85,247,0.8)]', inner: 'bg-purple-300/50', penalty: 10 },
        { bg: 'bg-orange-500', shadow: 'shadow-[0_0_30px_rgba(249,115,22,0.8)]', inner: 'bg-orange-300/50', penalty: 10 },
        { bg: 'bg-blue-500', shadow: 'shadow-[0_0_30px_rgba(59,130,246,0.8)]', inner: 'bg-blue-300/50', penalty: 5 }
      ];
      distractorData = distractors[Math.floor(Math.random() * distractors.length)];
    }

    const newTarget = {
      id, cx, cy, r,
      xPct: (cx / W) * 100,
      yPct: (cy / H) * 100,
      isHit: false, isDistractor, distractorData,
      spawnTime: Date.now(),
      sawOutside: false, insideCount: 0, firstInsideAt: 0, noHandSince: 0
    };
    setTarget(newTarget);
    targetRef.current = newTarget;

    clearTimeout(targetTimerRef.current);
    targetTimerRef.current = setTimeout(() => {
      const t = targetRef.current;
      if (t && !t.isHit && !t.isDistractor) {
        missedRef.current += 1;
        comboRef.current = 0;
        setComboUI(0);
      }
      setTarget(null);
      targetRef.current = null;
      scheduleNextTarget();
    }, config.targetLifespan);
  };

  const handleTargetHit = (id, hitTime = Date.now()) => {
    const currentTarget = targetRef.current;
    if (!currentTarget || currentTarget.id !== id || currentTarget.isHit) return;
    if (gameStateRef.current !== 'playing') return;

    currentTarget.isHit = true;
    setTarget((prev) => (prev ? { ...prev, isHit: true } : prev));

    const config = DIFFICULTIES[difficultyRef.current];
    let scoreChange = 0;
    let popupColor = '';
    let popupText = '';

    if (currentTarget.isDistractor) {
      playSound('error');
      comboRef.current = 0;
      setComboUI(0);
      errorsRef.current += 1;
      scoreChange = -currentTarget.distractorData.penalty;
      popupColor = 'text-red-500';
      popupText = `${scoreChange}`;
    } else {
      playSound('hit');
      comboRef.current += 1;
      maxComboRef.current = Math.max(maxComboRef.current, comboRef.current);
      setComboUI(comboRef.current);

      const multiplier = comboRef.current >= 10 ? 3 : comboRef.current >= 5 ? 2 : 1;
      const reactionTime = Math.max(0, hitTime - currentTarget.spawnTime);
      hitsRef.current.push({ time: reactionTime, x: currentTarget.xPct, y: currentTarget.yPct });

      const speedBonus = reactionTime < 500 ? 10 : 0;
      scoreChange = (config.basePoints + speedBonus) * multiplier;
      popupColor = multiplier > 1 ? 'text-orange-400' : speedBonus > 0 ? 'text-lime-300' : 'text-white/80';
      popupText = multiplier > 1 ? `+${scoreChange} (x${multiplier})` : `+${scoreChange}`;
    }

    // El puntaje real vive en el ref (nunca queda desactualizado)
    scoreRef.current = Math.max(0, scoreRef.current + scoreChange);
    setScore(scoreRef.current);

    const popupId = Date.now() + Math.random();
    setScorePopups((prev) => [
      ...prev,
      { id: popupId, text: popupText, x: currentTarget.cx - currentTarget.r, y: currentTarget.cy - currentTarget.r, color: popupColor }
    ]);
    setTimeout(() => setScorePopups((prev) => prev.filter((p) => p.id !== popupId)), 1000);

    clearTimeout(targetTimerRef.current);
    clearTimeout(hitTimeoutRef.current);
    hitTimeoutRef.current = setTimeout(() => {
      setTarget(null);
      targetRef.current = null;
      scheduleNextTarget();
    }, 150);
  };

  // ---------- CONTROL DE PARTIDA ----------
  const prepareGame = () => {
    if (!playerName.trim()) {
      alert('Por favor, ingresa el nombre del portero');
      return;
    }
    if (handStatus !== 'ready' || poseStatus === 'loading') {
      alert('Los detectores todavía no están listos.');
      return;
    }

    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();

    scoreRef.current = 0;
    hitsRef.current = [];
    errorsRef.current = 0;
    missedRef.current = 0;
    maxComboRef.current = 0;
    comboRef.current = 0;
    endedRef.current = false;
    targetRef.current = null;
    handVisibleRef.current = false;
    calibRef.current = null;
    calibSamplesRef.current = [];
    calibStatusRef.current = 'searching';
    lastCenterRef.current = null;
    poseCacheRef.current = { t: -1e9, poses: [] };
    setCalibStatus('searching');
    setCalibWarning(false);

    setHandVisible(false);
    setScore(0);
    setReactionTimes([]);
    setLastRecord(null);
    setSaveStatus('idle');
    setComboUI(0);
    setTimeLeft(GAME_DURATION);
    setTarget(null);
    setCountdown(COUNTDOWN_SECONDS);
    setGameState('countdown');
  };

  const clearRanking = () => {
    if (window.confirm('¿Seguro que quieres borrar todos los récords (nube y dispositivo)?')) {
      ranking.forEach((r) => {
        deleteDoc(doc(db, dbPath, String(r.id))).catch((e) => console.error(e));
      });
      try { localStorage.removeItem(LOCAL_KEY); } catch (e) { console.error(e); }
      setLocalRecords([]);
      setCloudRanking([]);
    }
  };

  const abortGame = () => {
    endedRef.current = true; // evita que se guarde una sesión abortada
    setGameState('menu');
    setTarget(null);
    targetRef.current = null;
    clearTimeout(targetTimerRef.current);
    clearTimeout(hitTimeoutRef.current);
    clearInterval(gameTimerRef.current);
    cancelAnimationFrame(animationRef.current);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // --- SISTEMA DE REPORTES PDF ---
  const openPrintWindow = (html) => {
    const w = window.open('', '_blank');
    if (!w) {
      alert('El navegador bloqueó la ventana del PDF. Permite las ventanas emergentes para este sitio.');
      return;
    }
    w.document.write(html);
    w.document.close();
  };

  const logoUrl = () => new URL(LOGO_SRC, window.location.origin).href;

  const printSessionPDF = (record) => {
    if (!record) return;
    const q = record.quadrants || {};
    const fmtMs = (v) => (v > 0 ? `${v} ms` : '--');
    openPrintWindow(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Reporte Sesión - ${esc(record.name)}</title>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; }
            .header { display: flex; align-items: center; border-bottom: 5px solid #CB3524; padding-bottom: 20px; margin-bottom: 30px; }
            .logo { width: 80px; margin-right: 20px; }
            .title h1 { color: #0f172a; margin: 0; font-size: 28px; text-transform: uppercase; }
            .title h2 { color: #CB3524; margin: 5px 0 0 0; font-size: 16px; font-weight: 600; }
            .box { background: #f8fafc; border: 2px solid #e2e8f0; padding: 25px; border-radius: 12px; margin-bottom: 20px; }
            .row { display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 18px; border-bottom: 1px solid #cbd5e1; padding-bottom: 10px; }
            .row:last-child { border: none; margin: 0; padding: 0; }
            .value { font-weight: bold; color: #0f172a; }
            .highlight { font-size: 28px; color: #CB3524; }
            .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #94a3b8; }
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="${logoUrl()}" class="logo" onerror="this.style.display='none'" />
            <div class="title">
              <h1>REPORTE DE RENDIMIENTO</h1>
              <h2>ATM REACTION GOALKEEPER - PREPARACIÓN FÍSICA</h2>
            </div>
          </div>
          <div class="box">
            <div class="row"><span>Portero Evaluado:</span> <span class="value">${esc(record.name)}</span></div>
            <div class="row"><span>Fecha de Sesión:</span> <span class="value">${esc(record.date)}</span></div>
            <div class="row"><span>Nivel de Dificultad:</span> <span class="value">${esc(record.difficulty)}</span></div>
            <div class="row"><span>Distancia a la cámara:</span> <span class="value">${esc(record.distance || '--')}</span></div>
          </div>
          <div class="box">
            <div class="row"><span>Puntuación Alcanzada:</span> <span class="value highlight">${Number(record.score) || 0} pts</span></div>
            <div class="row"><span>Reacción Promedio:</span> <span class="value">${fmtMs(record.avgReactionMs)}</span></div>
            <div class="row"><span>Aciertos:</span> <span class="value">${record.hits ?? '--'}</span></div>
            <div class="row"><span>Errores (señuelos):</span> <span class="value">${record.errors ?? '--'}</span></div>
            <div class="row"><span>Objetivos perdidos:</span> <span class="value">${record.missed ?? '--'}</span></div>
            <div class="row"><span>Mejor racha:</span> <span class="value">${record.bestCombo ?? '--'}</span></div>
          </div>
          <div class="box">
            <div class="row"><span>Reacción Arriba-Izquierda:</span> <span class="value">${fmtMs(q.tl)}</span></div>
            <div class="row"><span>Reacción Arriba-Derecha:</span> <span class="value">${fmtMs(q.tr)}</span></div>
            <div class="row"><span>Reacción Abajo-Izquierda:</span> <span class="value">${fmtMs(q.bl)}</span></div>
            <div class="row"><span>Reacción Abajo-Derecha:</span> <span class="value">${fmtMs(q.br)}</span></div>
          </div>
          <div class="footer">Documento Oficial. Generado por el sistema de entrenamiento biométrico ATM.</div>
          <script>window.onload = function() { window.print(); }</script>
        </body>
      </html>
    `);
  };

  const printHistoryPDF = (name) => {
    const history = ranking.filter((r) => r.name === name).sort((a, b) => a.id - b.id);
    if (history.length === 0) return;

    const maxScore = Math.max(...history.map((r) => Number(r.score) || 0));
    const validReactions = history.filter((r) => r.avgReactionMs > 0).map((r) => r.avgReactionMs);
    const bestReaction = validReactions.length > 0 ? Math.min(...validReactions) : '--';

    const rowsHTML = history
      .map(
        (r, i) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">${i + 1}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${esc(r.date)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${esc(r.difficulty)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${esc(r.distance || '--')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #CB3524;">${Number(r.score) || 0}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${r.hits ?? '--'}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${r.avgReactionMs > 0 ? r.avgReactionMs + ' ms' : '--'}</td>
      </tr>`
      )
      .join('');

    openPrintWindow(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Historial - ${esc(name)}</title>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; }
            .header { display: flex; align-items: center; border-bottom: 5px solid #CB3524; padding-bottom: 20px; margin-bottom: 30px; }
            .logo { width: 80px; margin-right: 20px; }
            .title h1 { color: #0f172a; margin: 0; font-size: 28px; text-transform: uppercase; }
            .title h2 { color: #CB3524; margin: 5px 0 0 0; font-size: 16px; font-weight: 600; }
            .summary { display: flex; gap: 20px; margin-bottom: 30px; }
            .stat-box { flex: 1; background: #f8fafc; border: 2px solid #e2e8f0; padding: 20px; border-radius: 12px; text-align: center; }
            .stat-box p { margin: 0 0 5px 0; font-size: 14px; color: #64748b; font-weight: bold; text-transform: uppercase; }
            .stat-box h3 { margin: 0; font-size: 24px; color: #CB3524; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
            th { background: #0f172a; color: white; padding: 12px; text-align: left; font-size: 13px; text-transform: uppercase; }
            .footer { text-align: center; font-size: 12px; color: #94a3b8; }
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="${logoUrl()}" class="logo" onerror="this.style.display='none'" />
            <div class="title">
              <h1>EVOLUCIÓN E HISTORIAL DEL PORTERO</h1>
              <h2>ATM REACTION GOALKEEPER - PREPARACIÓN FÍSICA</h2>
            </div>
          </div>
          <h3 style="margin-bottom: 20px;">ATLETA: <span style="color: #CB3524;">${esc(name)}</span></h3>
          <div class="summary">
            <div class="stat-box"><p>Total Sesiones</p><h3>${history.length}</h3></div>
            <div class="stat-box"><p>Puntaje Récord</p><h3>${maxScore} pts</h3></div>
            <div class="stat-box"><p>Mejor Reacción</p><h3>${bestReaction !== '--' ? bestReaction + ' ms' : '--'}</h3></div>
          </div>
          <table>
            <thead>
              <tr>
                <th style="text-align: center;">#</th>
                <th>Fecha</th>
                <th>Dificultad</th>
                <th>Distancia</th>
                <th>Puntaje</th>
                <th>Aciertos</th>
                <th>Reacción Prom.</th>
              </tr>
            </thead>
            <tbody>${rowsHTML}</tbody>
          </table>
          <div class="footer">Documento Histórico Oficial. Generado por el sistema de entrenamiento biométrico ATM.</div>
          <script>window.onload = function() { window.print(); }</script>
        </body>
      </html>
    `);
  };

  // --- Renderizado Compartido ---
  const renderBackground = (isMenu = false) => (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes pulse-fast {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(0.92); opacity: 0.85; }
        }
        @keyframes float-up-fade {
          0% { transform: translateY(0) scale(0.5); opacity: 0; }
          20% { transform: translateY(-20px) scale(1.2); opacity: 0.9; }
          100% { transform: translateY(-80px) scale(1); opacity: 0; }
        }
        .scanlines {
          background: repeating-linear-gradient(
            to bottom,
            rgba(0,0,0,0) 0px,
            rgba(0,0,0,0) 2px,
            rgba(0,0,0,0.3) 3px,
            rgba(0,0,0,0.3) 4px
          );
        }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.5); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(100, 116, 139, 0.5); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(100, 116, 139, 0.8); }
      ` }} />
      <div className="fixed inset-0 z-0 bg-slate-900 pointer-events-none flex flex-col items-center justify-center print:hidden">
        {cameraError ? (
          <div className="bg-red-500/20 border border-red-500 p-4 rounded-xl text-red-200 z-50 text-center max-w-sm mx-auto">
            <span className="text-2xl block mb-2">📷❌</span>
            {cameraError}
            <p className="text-xs mt-2 opacity-80">Si estás en móvil, asegúrate de dar permiso y no tener el modo ahorro de batería bloqueando videos.</p>
          </div>
        ) : (
          <>
            <video
              ref={setVideoNode}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover scale-x-[-1] transition-all duration-1000 ${isMenu ? 'opacity-30 blur-sm grayscale' : 'opacity-100 contrast-125 saturate-50'}`}
            />
            {!isMenu && <div className="absolute inset-0 pointer-events-none scanlines z-10 opacity-30 mix-blend-overlay"></div>}
            {!isMenu && (
              <canvas
                ref={visualCanvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none z-20 mix-blend-screen opacity-80"
              />
            )}
          </>
        )}
      </div>
    </>
  );

  // --- Pantalla: Menú Principal ---
  if (gameState === 'menu') {
    return (
      <div className="min-h-screen bg-slate-900 text-white font-sans overflow-hidden flex items-center justify-center relative p-4">
        {renderBackground(true)}

        <div className="z-10 bg-slate-800/80 backdrop-blur-xl p-6 md:p-8 rounded-[2rem] shadow-2xl border border-slate-600/50 w-full max-w-lg flex flex-col items-center max-h-[95vh] overflow-y-auto custom-scrollbar">
          <img
            src={LOGO_SRC}
            alt="Escudo Atlético de Madrid"
            className="w-20 md:w-24 h-auto mb-4 animate-pulse drop-shadow-[0_0_20px_rgba(255,255,255,0.2)]"
          />
          <h1 className="text-2xl md:text-3xl font-black mb-1 text-center tracking-tight leading-none">ATM REACTION GOALKEEPER</h1>
          <p className="text-slate-400 mb-6 text-center text-xs md:text-sm">Entrenamiento Cognitivo y Visión</p>

          <div className="w-full mb-6">
            <p className="text-slate-300 text-xs mb-2 font-semibold text-center uppercase tracking-wider">Plantilla Oficial</p>
            <div className="grid grid-cols-4 gap-2 mb-4">
              {ROSTER.map((player) => (
                <button
                  key={player.short}
                  onClick={() => setPlayerName(player.full)}
                  className="bg-slate-700/50 hover:bg-red-600 hover:text-white text-slate-300 text-[10px] font-bold py-2 px-1 rounded-lg border border-slate-600 transition-colors"
                >
                  {player.short}
                </button>
              ))}
            </div>

            <p className="text-slate-300 text-xs mb-2 font-semibold text-center uppercase tracking-wider">O ingreso manual</p>
            <input
              type="text"
              placeholder="Nombre completo del portero"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value.toUpperCase())}
              className="w-full p-3 rounded-xl bg-slate-900/80 border border-slate-600 focus:border-red-500 focus:ring-2 focus:ring-red-500 focus:outline-none text-white text-sm md:text-base text-center transition-all"
            />
          </div>

          <div className="w-full mb-5">
            <p className="text-slate-300 text-xs mb-3 font-semibold text-center uppercase tracking-wider">Nivel de Dificultad</p>
            <div className="flex gap-2 justify-center">
              {Object.keys(DIFFICULTIES).map((diff) => (
                <button
                  key={diff}
                  onClick={() => setDifficulty(diff)}
                  className={`flex-1 py-3 px-2 rounded-xl font-bold transition-all text-sm ${difficulty === diff ? 'bg-lime-500 text-slate-900 shadow-[0_0_15px_rgba(132,204,22,0.4)] scale-105 border-none' : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600 border border-slate-600'}`}
                >
                  {DIFFICULTIES[diff].label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-full mb-6">
            <p className="text-slate-300 text-xs mb-3 font-semibold text-center uppercase tracking-wider">Distancia del portero a la cámara</p>
            <div className="flex gap-2 justify-center">
              {Object.keys(DISTANCES).map((d) => (
                <button
                  key={d}
                  onClick={() => setDistance(d)}
                  className={`flex-1 py-3 px-2 rounded-xl font-bold transition-all text-sm ${distance === d ? 'bg-cyan-400 text-slate-900 shadow-[0_0_15px_rgba(34,211,238,0.4)] scale-105 border-none' : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600 border border-slate-600'}`}
                >
                  {DISTANCES[d].label}
                </button>
              ))}
            </div>
            <p className="text-slate-400 text-[11px] text-center mt-2">{DISTANCES[distance].desc}</p>
          </div>

          {handStatus === 'loading' && (
            <p className="text-cyan-300 text-xs mb-3 animate-pulse">⏳ Cargando detector de manos...</p>
          )}
          {handStatus === 'ready' && poseStatus === 'loading' && (
            <p className="text-cyan-300 text-xs mb-3 animate-pulse">⏳ Cargando calibración del portero...</p>
          )}
          {handStatus === 'ready' && poseStatus === 'error' && (
            <p className="text-orange-300 text-xs mb-3 text-center">Modo básico: sin calibración de distancia ni filtro de cabeza. Revisa la conexión y recarga.</p>
          )}
          {handStatus === 'error' && (
            <div className="text-center mb-3">
              <p className="text-red-300 text-xs mb-2">No se pudo cargar el detector de manos. Revisa la conexión a internet.</p>
              <button
                onClick={() => { setHandStatus('loading'); setPoseStatus('loading'); loadHandModel(); }}
                className="bg-red-600 hover:bg-red-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg"
              >
                Reintentar
              </button>
            </div>
          )}

          <button
            onClick={prepareGame}
            disabled={handStatus !== 'ready' || poseStatus === 'loading'}
            className="w-full bg-white text-slate-900 font-black text-lg md:text-xl py-4 rounded-xl shadow-[0_0_15px_rgba(255,255,255,0.4)] hover:scale-105 active:scale-95 transition-all mb-4 disabled:opacity-40 disabled:hover:scale-100"
          >
            INICIAR SESIÓN
          </button>

          <button
            onClick={() => setGameState('ranking')}
            className="text-slate-400 hover:text-white underline text-xs md:text-sm transition-colors"
          >
            Ver Tabla de Posiciones y Reportes
          </button>
        </div>
      </div>
    );
  }

  // --- Pantalla: Cuenta Regresiva ---
  if (gameState === 'countdown') {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center relative">
        {renderBackground(false)}
        <div className="z-10 flex flex-col items-center">
          <p className="text-2xl md:text-4xl font-bold bg-black/50 px-6 py-2 rounded-full mb-4 backdrop-blur-md">Colócate en tu posición</p>
          <p className={`text-sm md:text-base font-bold px-4 py-1.5 rounded-full mb-6 backdrop-blur-md ${calibStatus === 'ok' ? 'bg-lime-500/80 text-slate-900' : 'bg-black/60 text-orange-300'}`}>
            {calibStatus === 'ok' && '✅ Portero detectado: distancia calibrada'}
            {calibStatus === 'searching' && '⚠️ Busca tu cuerpo: hombros visibles frente a la cámara'}
            {calibStatus === 'unavailable' && 'Calibración no disponible (modo básico)'}
          </p>
          <h1 className="text-9xl md:text-[15rem] font-black text-lime-400 drop-shadow-[0_0_30px_rgba(132,204,22,1)] animate-bounce">
            {countdown}
          </h1>
        </div>
      </div>
    );
  }

  // --- Pantalla: Ranking ---
  if (gameState === 'ranking') {
    return (
      <div className="min-h-screen bg-slate-900 text-white font-sans p-6 relative flex flex-col items-center">
        {renderBackground(true)}

        <div className="z-10 w-full max-w-4xl bg-slate-800/90 backdrop-blur-xl rounded-3xl p-6 md:p-10 border border-slate-600 shadow-2xl mt-4">
          <div className="flex justify-between items-center mb-8">
            <h2 className="text-3xl font-black text-lime-400">REGISTROS</h2>
            <button
              onClick={() => setGameState('menu')}
              className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg font-bold transition-colors"
            >
              Volver
            </button>
          </div>

          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
            {ranking.length === 0 ? (
              <p className="text-slate-400 text-center py-10">No hay registros almacenados.</p>
            ) : (
              ranking.map((r, idx) => (
                <div key={r.id} className="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-900/80 p-4 rounded-xl border border-slate-700 gap-4">
                  <div className="flex items-center gap-4">
                    <div className="text-xl font-black text-slate-500 w-6 text-center">{idx + 1}</div>
                    <div>
                      <div className="font-bold text-lg md:text-xl text-white">{r.name}</div>
                      <div className="text-xs text-slate-400 flex flex-wrap gap-2 mt-1">
                        <span className="bg-slate-800 px-2 py-0.5 rounded">{r.date}</span>
                        <span className="bg-slate-800 px-2 py-0.5 rounded">{r.difficulty}</span>
                        {r.distance && <span className="bg-slate-800 px-2 py-0.5 rounded">{r.distance}</span>}
                        <span className="bg-slate-800 px-2 py-0.5 rounded text-cyan-400">{r.avgReactionMs ? `${r.avgReactionMs}ms prom.` : 'Sin datos'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center w-full md:w-auto justify-between md:justify-end gap-6">
                    <div className="text-3xl font-black text-lime-400">{r.score} <span className="text-sm font-normal text-slate-500">pt</span></div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => printSessionPDF(r)}
                        title="Reporte de esta sesión"
                        className="bg-slate-700 hover:bg-slate-600 p-2 rounded-lg text-lg transition-colors border border-slate-500"
                      >
                        📄 <span className="text-xs font-bold hidden md:inline ml-1">Sesión</span>
                      </button>
                      <button
                        onClick={() => printHistoryPDF(r.name)}
                        title="Evolución Histórica del Portero"
                        className="bg-red-900 hover:bg-red-700 p-2 rounded-lg text-lg transition-colors border border-red-500 text-white"
                      >
                        📈 <span className="text-xs font-bold hidden md:inline ml-1">Historial</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {ranking.length > 0 && (
            <div className="mt-8 text-center flex justify-between items-center border-t border-slate-700 pt-4">
              <p className="text-xs text-slate-400">Sincronizado con la nube (Firebase) y respaldado en este dispositivo.</p>
              <button
                onClick={clearRanking}
                className="text-red-400 hover:text-red-300 text-sm underline font-bold"
              >
                Borrar todos los datos
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Pantalla: Fin de Juego ---
  if (gameState === 'gameover') {
    const avgMs = lastRecord ? lastRecord.avgReactionMs : 0;
    const q = (lastRecord && lastRecord.quadrants) || {};
    const fmt = (v) => (v > 0 ? v : '--');

    return (
      <div className="min-h-screen bg-slate-900 text-white font-sans flex items-center justify-center relative p-4">
        {renderBackground(true)}

        <div className="z-10 bg-slate-800/90 backdrop-blur-xl p-8 md:p-10 rounded-3xl text-center shadow-2xl border border-slate-600 w-full max-w-md max-h-[95vh] overflow-y-auto custom-scrollbar">
          <h2 className="text-4xl font-black text-white mb-2 tracking-widest">¡TIEMPO!</h2>
          <p className="text-slate-400 mb-4 font-bold text-lg">{playerName}</p>

          <div className="bg-slate-900 rounded-2xl p-4 mb-4 border border-lime-500/30 shadow-[inset_0_0_20px_rgba(0,0,0,0.5)]">
            <p className="text-xs text-slate-400 font-bold mb-1 uppercase">Puntaje</p>
            <p className="text-6xl font-black text-lime-400 drop-shadow-md">{score}</p>
          </div>

          <div className="flex justify-between gap-2 mb-4">
            <div className="flex-1 bg-slate-900/80 rounded-xl p-3 border border-slate-700">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Reacción Media</p>
              <p className="text-xl font-mono text-cyan-400 font-bold">{avgMs > 0 ? `${avgMs} ms` : '--'}</p>
            </div>
            <div className="flex-1 bg-slate-900/80 rounded-xl p-3 border border-slate-700">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Aciertos</p>
              <p className="text-xl font-mono text-white font-bold">{reactionTimes.length}</p>
            </div>
            <div className="flex-1 bg-slate-900/80 rounded-xl p-3 border border-slate-700">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Perdidos</p>
              <p className="text-xl font-mono text-white font-bold">{lastRecord ? lastRecord.missed : 0}</p>
            </div>
          </div>

          <div className="mb-6 bg-slate-900/50 p-4 rounded-xl border border-slate-700">
            <p className="text-[10px] text-slate-400 font-bold uppercase mb-3 tracking-widest">Análisis por Cuadrantes</p>
            <div className="grid grid-cols-2 gap-2 relative">
              <div className="absolute inset-0 border-t-4 border-x-4 border-white/20 rounded-t-lg pointer-events-none -m-2"></div>

              <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                <span className="text-[9px] text-slate-500 mb-1">ARR-IZQ</span>
                <span className="font-mono text-sm font-bold text-white">{fmt(q.tl)} <span className="text-[10px] text-slate-400">ms</span></span>
              </div>
              <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                <span className="text-[9px] text-slate-500 mb-1">ARR-DER</span>
                <span className="font-mono text-sm font-bold text-white">{fmt(q.tr)} <span className="text-[10px] text-slate-400">ms</span></span>
              </div>
              <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                <span className="text-[9px] text-slate-500 mb-1">ABA-IZQ</span>
                <span className="font-mono text-sm font-bold text-white">{fmt(q.bl)} <span className="text-[10px] text-slate-400">ms</span></span>
              </div>
              <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                <span className="text-[9px] text-slate-500 mb-1">ABA-DER</span>
                <span className="font-mono text-sm font-bold text-white">{fmt(q.br)} <span className="text-[10px] text-slate-400">ms</span></span>
              </div>
            </div>
          </div>

          <p className="text-xs mb-3 text-slate-400">
            {saveStatus === 'saving' && '⏳ Guardando sesión...'}
            {saveStatus === 'cloud' && '✅ Sesión guardada en la nube'}
            {saveStatus === 'local' && '⚠️ Guardada solo en este dispositivo (sin conexión a la nube)'}
          </p>

          <div className="flex flex-col gap-3">
            {lastRecord && (
              <button
                onClick={() => printSessionPDF(lastRecord)}
                className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 border border-red-400"
              >
                <span className="text-xl">📄</span> GENERAR REPORTE PDF
              </button>
            )}

            <div className="flex gap-3 mt-2">
              <button
                onClick={() => setGameState('menu')}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-bold py-4 rounded-xl transition-all"
              >
                Menú
              </button>
              <button
                onClick={prepareGame}
                className="flex-1 bg-white hover:bg-slate-200 text-slate-900 font-bold py-4 rounded-xl shadow-[0_0_15px_rgba(255,255,255,0.3)] transition-all"
              >
                Reintentar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Pantalla: Jugando (In Game) ---
  return (
    <div className="fixed inset-0 bg-black touch-none select-none font-sans overflow-hidden">
      {renderBackground(false)}

      {/* Puntuación e Indicador de Racha (Izquierda) y Tiempo/Nivel (Derecha) */}
      <div className="absolute top-0 left-0 w-full p-4 md:p-6 flex justify-between items-start z-10 pointer-events-none gap-4">

        <div className="flex flex-col gap-2">
          <div className="bg-slate-900/80 backdrop-blur-md px-4 md:px-6 py-2 md:py-3 rounded-2xl border border-slate-600 shadow-lg text-center">
            <p className="text-slate-300 text-[10px] md:text-xs font-bold tracking-wider mb-1">PUNTOS</p>
            <p className="text-white text-3xl md:text-4xl font-black font-mono leading-none">{score}</p>
          </div>

          {comboUI >= 5 && (
            <div className={`backdrop-blur-md px-3 py-1.5 rounded-xl border shadow-[0_0_15px_rgba(234,88,12,0.6)] flex items-center justify-center gap-1 transition-all ${comboUI >= 10 ? 'bg-red-600/90 border-red-400 animate-pulse' : 'bg-orange-600/90 border-orange-400'}`}>
              <span className="text-sm md:text-base">🔥</span>
              <span className="text-white text-xs md:text-sm font-black tracking-widest">x{comboUI >= 10 ? '3' : '2'}</span>
            </div>
          )}

          <div className={`px-3 py-1 rounded-xl border text-[10px] md:text-xs font-bold tracking-wider text-center backdrop-blur-md ${handVisible ? 'bg-lime-500/80 border-lime-300 text-slate-900' : 'bg-slate-900/80 border-slate-600 text-slate-300'}`}>
            {handVisible ? '✋ MANO DETECTADA' : '✋ BUSCANDO MANO...'}
          </div>
        </div>

        {/* Tiempo y Nivel (Estilo Atlético de Madrid) */}
        <div className="flex flex-col items-end w-40 md:w-64">
          <div className="flex w-full items-center bg-slate-900/90 p-1.5 md:p-2 rounded-xl border border-slate-700 shadow-lg backdrop-blur-md">
            <div className="bg-red-600 text-white font-black text-sm md:text-base px-2 py-1 md:px-3 md:py-1.5 rounded-lg mr-2 shadow-[0_0_10px_rgba(220,38,38,0.5)] flex-shrink-0 border border-red-500">
              {difficulty === 'easy' ? 'LV1' : difficulty === 'medium' ? 'LV2' : 'LV3'}
            </div>

            <div className="flex-1 h-6 md:h-8 bg-slate-950 rounded-lg overflow-hidden relative border border-slate-800 shadow-inner">
              <div
                className="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-1000 ease-linear shadow-[0_0_15px_rgba(220,38,38,0.6)]"
                style={{ width: `${(timeLeft / GAME_DURATION) * 100}%` }}
              ></div>
              <div className="absolute inset-0 flex items-center justify-center text-white font-black font-mono text-sm md:text-base tracking-widest drop-shadow-md">
                {formatTime(timeLeft)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {calibWarning && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-40 bg-orange-600/90 border border-orange-300 text-white text-xs md:text-sm font-bold px-4 py-2 rounded-xl pointer-events-none text-center">
          ⚠️ No se detectó el cuerpo del portero en la calibración: se usa una zona central fija
        </div>
      )}

      {/* Popups de Puntuación Animados */}
      {scorePopups.map((popup) => (
        <div
          key={popup.id}
          className={`absolute z-40 font-black text-5xl md:text-7xl tracking-tighter drop-shadow-[0_5px_5px_rgba(0,0,0,0.8)] ${popup.color}`}
          style={{
            left: `${popup.x}px`,
            top: `${popup.y}px`,
            animation: 'float-up-fade 1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards',
            pointerEvents: 'none'
          }}
        >
          {popup.text}
        </div>
      ))}

      {/* El Objetivo (Luz) */}
      {target && (
        <div
          className={`absolute rounded-full z-30 flex items-center justify-center
            border-4 border-white aspect-square
            transform transition-all duration-75
            ${target.isHit
              ? `bg-white scale-125 opacity-0 ${target.isDistractor ? target.distractorData.shadow : 'shadow-[0_0_50px_rgba(255,255,255,1)]'}`
              : `${target.isDistractor ? `${target.distractorData.bg} ${target.distractorData.shadow}` : 'bg-lime-400 shadow-[0_0_30px_rgba(132,204,22,0.8)]'}`
            }
          `}
          style={{
            left: `${target.cx - target.r}px`,
            top: `${target.cy - target.r}px`,
            width: `${target.r * 2}px`,
            height: `${target.r * 2}px`,
            animation: target.isHit ? 'none' : 'pulse-fast 1s cubic-bezier(0.4, 0, 0.6, 1) infinite'
          }}
        >
          <div className={`w-1/2 h-1/2 rounded-full ${target.isHit ? 'bg-white' : (target.isDistractor ? target.distractorData.inner : 'bg-lime-200/50')}`}></div>
        </div>
      )}

      {/* Marcos Biométricos */}
      <div className="absolute inset-0 pointer-events-none z-20 border-[8px] border-cyan-500/10">
        <div className="absolute top-4 left-4 w-12 h-12 border-t-4 border-l-4 border-cyan-400/50"></div>
        <div className="absolute top-4 right-4 w-12 h-12 border-t-4 border-r-4 border-cyan-400/50"></div>
        <div className="absolute bottom-4 left-4 w-12 h-12 border-b-4 border-l-4 border-cyan-400/50"></div>
        <div className="absolute bottom-4 right-4 w-12 h-12 border-b-4 border-r-4 border-cyan-400/50"></div>
        <p className="absolute bottom-6 text-center w-full text-cyan-400/50 text-[10px] font-mono tracking-[0.5em]">HAND TRACKING ACTIVE</p>
      </div>

      {/* Botón de abortar/reiniciar partida */}
      <div className="absolute bottom-4 right-4 md:bottom-6 md:right-6 z-50 pointer-events-auto">
        <button
          onClick={abortGame}
          className="bg-red-600/60 hover:bg-red-500 active:scale-95 text-white font-bold py-2 px-4 rounded-full shadow-[0_0_10px_rgba(220,38,38,0.4)] backdrop-blur-md border border-red-500/50 transition-all flex items-center gap-1.5 text-xs md:text-sm opacity-70 hover:opacity-100"
        >
          <span className="text-sm leading-none">⏹</span>
          <span>REINICIAR</span>
        </button>
      </div>
    </div>
  );
}