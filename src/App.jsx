import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, deleteDoc } from 'firebase/firestore';

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

// Configuraciones de dificultad
const DIFFICULTIES = {
  easy: {
    label: 'Fácil',
    targetLifespan: 2000, 
    spawnDelay: 800,      
    sizePct: 22, 
    basePoints: 10,
    distractorChance: 0.15
  },
  medium: {
    label: 'Medio',
    targetLifespan: 1200,
    spawnDelay: 500,
    sizePct: 15,
    basePoints: 15,
    distractorChance: 0.30
  },
  hard: {
    label: 'Difícil',
    targetLifespan: 750,
    spawnDelay: 300,
    sizePct: 10,
    basePoints: 20,
    distractorChance: 0.45
  }
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

export default function ReactionTrainingApp() {
  const [gameState, setGameState] = useState('menu'); // 'menu', 'countdown', 'playing', 'gameover', 'ranking'
  const [playerName, setPlayerName] = useState('');
  const [difficulty, setDifficulty] = useState('easy');
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [target, setTarget] = useState(null); 
  const [ranking, setRanking] = useState([]);
  const [countdown, setCountdown] = useState(3);
  const [cameraError, setCameraError] = useState(null);
  
  // Usuario de Firebase
  const [user, setUser] = useState(null);
  
  // Guardar tiempos de reacción y coordenadas (para mapa de calor)
  const [reactionTimes, setReactionTimes] = useState([]);
  
  // Sistema de Combos
  const [comboUI, setComboUI] = useState(0);
  const comboRef = useRef(0);
  
  // Animaciones de puntos flotantes
  const [scorePopups, setScorePopups] = useState([]);
  
  // Referencias para visión artificial
  const motionCanvasRef = useRef(null);
  const visualCanvasRef = useRef(null);
  const lastFrameRef = useRef(null);
  const animationRef = useRef(null);
  const targetRef = useRef(null); 
  const gameStateRef = useRef(gameState);

  // Audio Context para sonidos
  const audioCtxRef = useRef(null);

  // Referencias para la cámara y temporizadores
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const gameTimerRef = useRef(null);
  const targetTimerRef = useRef(null);

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
        console.error("Error autenticando con Firebase:", error);
      }
    };
    initAuth();
  }, []);

  // --- SINCRONIZACIÓN CON FIREBASE EN TIEMPO REAL ---
  useEffect(() => {
    if (!user) return;

    const colRef = collection(db, dbPath);
    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      const data = [];
      snapshot.forEach(doc => data.push(doc.data()));
      data.sort((a, b) => b.score - a.score);
      setRanking(data);
    }, (error) => {
      console.error("Error leyendo Firebase:", error);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Inicializar cámara al cargar la app
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current.play().catch(e => console.error("Error reproduciendo video:", e));
          };
        }
        streamRef.current = stream;
        setCameraError(null);
      } catch (err) {
        console.warn("No se pudo acceder a la cámara:", err);
        setCameraError("No se pudo acceder a la cámara. Revisa los permisos.");
      }
    };

    startCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // Sistema de Sonidos (Web Audio API)
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

  // Bucle de cuenta regresiva
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

  // Bucle principal del juego
  useEffect(() => {
    if (gameState === 'playing') {
      gameTimerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            endGame();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      
      scheduleNextTarget();
      startMotionDetection(); 
    }

    return () => {
      clearInterval(gameTimerRef.current);
      clearTimeout(targetTimerRef.current);
      cancelAnimationFrame(animationRef.current);
    };
  }, [gameState]);

  // Motor de Visión Artificial (Frame Differencing)
  const startMotionDetection = () => {
    const checkMotion = () => {
      if (gameStateRef.current !== 'playing') return;

      const video = videoRef.current;
      const canvas = motionCanvasRef.current;
      const visualCanvas = visualCanvasRef.current;
      
      let vCtx = null;
      if (visualCanvas) {
        if (visualCanvas.width !== visualCanvas.clientWidth) {
            visualCanvas.width = visualCanvas.clientWidth;
            visualCanvas.height = visualCanvas.clientHeight;
        }
        vCtx = visualCanvas.getContext('2d');
        vCtx.clearRect(0, 0, visualCanvas.width, visualCanvas.height);
        vCtx.fillStyle = 'rgba(34, 211, 238, 0.7)'; 
      }

      if (video && canvas && video.readyState >= 3) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.restore();

        const currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const currentTarget = targetRef.current;

        let tx = -1, ty = -1, tw = -1, th = -1;
        if (currentTarget && !currentTarget.isHit) {
           tx = Math.floor((currentTarget.x / 100) * canvas.width);
           ty = Math.floor((currentTarget.y / 100) * canvas.height);
           tw = Math.floor((currentTarget.size / 100) * canvas.width);
           th = tw; 
        }

        if (lastFrameRef.current) {
           let motionCount = 0;
           let totalTargetPixels = 0;
           
           const step = 4;
           for (let y = 0; y < canvas.height; y += step) {
             for (let x = 0; x < canvas.width; x += step) {
               const i = (y * canvas.width + x) * 4;
               
               const diff = Math.abs(currentFrame.data[i] - lastFrameRef.current.data[i]) +
                            Math.abs(currentFrame.data[i+1] - lastFrameRef.current.data[i+1]) +
                            Math.abs(currentFrame.data[i+2] - lastFrameRef.current.data[i+2]);
                            
               if (diff > 60) { 
                 if (vCtx) {
                    const vx = (x / canvas.width) * visualCanvas.width;
                    const vy = (y / canvas.height) * visualCanvas.height;
                    vCtx.fillRect(vx, vy, 4, 4);
                 }

                 if (tx !== -1 && x >= tx && x <= tx + tw && y >= ty && y <= ty + th) {
                    motionCount++;
                 }
               }
               
               if (tx !== -1 && x >= tx && x <= tx + tw && y >= ty && y <= ty + th) {
                   totalTargetPixels++;
               }
             }
           }
           
           if (totalTargetPixels > 0 && (motionCount / totalTargetPixels) > 0.12) {
             handleTargetHit(currentTarget.id);
           }
        }
        
        lastFrameRef.current = currentFrame;
      }
      
      animationRef.current = requestAnimationFrame(checkMotion);
    };
    
    animationRef.current = requestAnimationFrame(checkMotion);
  };

  const scheduleNextTarget = () => {
    const config = DIFFICULTIES[difficulty];
    targetTimerRef.current = setTimeout(() => {
      spawnTarget();
    }, config.spawnDelay);
  };

  const spawnTarget = () => {
    if (gameStateRef.current !== 'playing') return;

    const config = DIFFICULTIES[difficulty];
    const size = config.sizePct;
    
    const x = Math.floor(Math.random() * (90 - size)) + 5;
    const y = Math.floor(Math.random() * (85 - size)) + 10;
    const id = Date.now();
    const spawnTime = Date.now();
    
    const isDistractor = Math.random() < config.distractorChance;
    
    let distractorData = null;
    if (isDistractor) {
        const distractors = [
            { bg: 'bg-red-500', shadow: 'shadow-[0_0_30px_rgba(239,68,68,0.8)]', inner: 'bg-red-300/50', penalty: 15 },
            { bg: 'bg-purple-500', shadow: 'shadow-[0_0_30px_rgba(168,85,247,0.8)]', inner: 'bg-purple-300/50', penalty: 10 },
            { bg: 'bg-orange-500', shadow: 'shadow-[0_0_30px_rgba(249,115,22,0.8)]', inner: 'bg-orange-300/50', penalty: 10 },
            { bg: 'bg-blue-500', shadow: 'shadow-[0_0_30px_rgba(59,130,246,0.8)]', inner: 'bg-blue-300/50', penalty: 5 },
        ];
        distractorData = distractors[Math.floor(Math.random() * distractors.length)];
    }

    const newTarget = { id, x, y, size, isHit: false, isDistractor, distractorData, spawnTime };
    setTarget(newTarget);
    targetRef.current = newTarget; 

    clearTimeout(targetTimerRef.current);
    targetTimerRef.current = setTimeout(() => {
      if (targetRef.current && !targetRef.current.isHit && !targetRef.current.isDistractor) {
         comboRef.current = 0;
         setComboUI(0);
      }
      
      setTarget(null);
      targetRef.current = null;
      scheduleNextTarget();
    }, config.targetLifespan);
  };

  const handleTargetHit = (id) => {
    if (!targetRef.current || targetRef.current.id !== id || targetRef.current.isHit) return;
    
    const hitTime = Date.now();
    const currentTarget = targetRef.current;
    currentTarget.isHit = true;
    setTarget(prev => ({...prev, isHit: true}));
    
    const config = DIFFICULTIES[difficulty];
    
    let scoreChange = 0;
    let popupColor = '';
    let popupText = '';
    
    if (currentTarget.isDistractor) {
      playSound('error');
      comboRef.current = 0;
      setComboUI(0);
      scoreChange = -currentTarget.distractorData.penalty;
      popupColor = 'text-red-500';
      popupText = `${scoreChange}`;
      setScore(prev => prev + scoreChange);
    } else {
      playSound('hit');
      
      comboRef.current += 1;
      setComboUI(comboRef.current);
      
      const currentCombo = comboRef.current;
      const multiplier = currentCombo >= 10 ? 3 : (currentCombo >= 5 ? 2 : 1);
      
      const reactionTime = hitTime - currentTarget.spawnTime;
      
      // Guardar tiempo de reacción junto con las coordenadas (x, y) para el análisis por cuadrantes
      setReactionTimes(prev => [...prev, { time: reactionTime, x: currentTarget.x, y: currentTarget.y }]);
      
      const speedBonus = reactionTime < 500 ? 10 : 0;
      scoreChange = (config.basePoints + speedBonus) * multiplier;
      
      popupColor = multiplier > 1 ? 'text-orange-400' : (speedBonus > 0 ? 'text-lime-300' : 'text-white/80'); 
      popupText = multiplier > 1 ? `+${scoreChange} (x${multiplier})` : `+${scoreChange}`;
      
      setScore(prev => prev + scoreChange);
    }
    
    const popupId = Date.now() + Math.random();
    setScorePopups(prev => [...prev, { 
      id: popupId, 
      text: popupText, 
      x: currentTarget.x, 
      y: currentTarget.y, 
      color: popupColor 
    }]);

    setTimeout(() => {
      setScorePopups(prev => prev.filter(p => p.id !== popupId));
    }, 1000);
    
    clearTimeout(targetTimerRef.current);
    setTimeout(() => {
      setTarget(null);
      targetRef.current = null;
      scheduleNextTarget();
    }, 150); 
  };

  const prepareGame = () => {
    if (!playerName.trim()) {
      alert("Por favor, ingresa el nombre del portero");
      return;
    }
    
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();

    setScore(0);
    setReactionTimes([]);
    comboRef.current = 0;
    setComboUI(0);
    setTimeLeft(GAME_DURATION);
    setTarget(null);
    targetRef.current = null;
    lastFrameRef.current = null;
    setCountdown(3);
    setGameState('countdown');
  };

  const endGame = () => {
    playSound('end');
    setGameState('gameover');
    setTarget(null);
    targetRef.current = null;
    clearTimeout(targetTimerRef.current);
    clearInterval(gameTimerRef.current);
    cancelAnimationFrame(animationRef.current);
    
    let avgReaction = 0;
    setTimeout(() => {
        setReactionTimes(currentTimes => {
            if (currentTimes.length > 0) {
              const total = currentTimes.reduce((a, b) => a + (typeof b === 'number' ? b : b.time), 0);
              avgReaction = Math.round(total / currentTimes.length);
            }
            
            const config = DIFFICULTIES[difficulty];
            const newRecord = {
              id: Date.now(),
              name: playerName,
              score: score, 
              difficulty: config.label,
              avgReactionMs: avgReaction,
              date: new Date().toLocaleDateString()
            };
            
            if (user) {
              const docRef = doc(db, dbPath, newRecord.id.toString());
              setDoc(docRef, newRecord).catch(e => console.error("Error guardando:", e));
            }
            
            return currentTimes;
        });
    }, 50);
  };

  const clearRanking = () => {
    if(window.confirm("¿Seguro que quieres borrar todos los récords en la Nube?")) {
      if (user) {
        ranking.forEach(r => {
           const docRef = doc(db, dbPath, r.id.toString());
           deleteDoc(docRef).catch(e => console.error(e));
        });
      }
    }
  };

  const abortGame = () => {
    setGameState('menu');
    setTarget(null);
    targetRef.current = null;
    clearTimeout(targetTimerRef.current);
    clearInterval(gameTimerRef.current);
    cancelAnimationFrame(animationRef.current);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // --- SISTEMA DE REPORTES PDF ---
  const printSessionPDF = (record) => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Reporte Sesión - ${record.name}</title>
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
          </style>
        </head>
        <body>
          <div class="header">
            <img src="escudo.PNG" class="logo" onerror="this.style.display='none'" />
            <div class="title">
              <h1>REPORTE DE RENDIMIENTO</h1>
              <h2>ATM REACTION GOALKEEPER - PREPARACIÓN FÍSICA</h2>
            </div>
          </div>
          <div class="box">
            <div class="row"><span>Portero Evaluado:</span> <span class="value">${record.name}</span></div>
            <div class="row"><span>Fecha de Sesión:</span> <span class="value">${record.date}</span></div>
            <div class="row"><span>Nivel de Dificultad:</span> <span class="value">${record.difficulty}</span></div>
          </div>
          <div class="box">
            <div class="row"><span>Puntuación Alcanzada:</span> <span class="value highlight">${record.score} pts</span></div>
            <div class="row"><span>Reacción Promedio:</span> <span class="value">${record.avgReactionMs > 0 ? record.avgReactionMs + ' ms' : '--'}</span></div>
          </div>
          <div class="footer">Documento Oficial. Generado por el sistema de entrenamiento biométrico ATM.</div>
          <script>window.onload = function() { window.print(); window.close(); }</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const printHistoryPDF = (playerName) => {
    const history = ranking.filter(r => r.name === playerName).sort((a, b) => a.id - b.id);
    
    if (history.length === 0) return;

    const maxScore = Math.max(...history.map(r => r.score));
    const validReactions = history.filter(r => r.avgReactionMs > 0).map(r => r.avgReactionMs);
    const bestReaction = validReactions.length > 0 ? Math.min(...validReactions) : '--';

    const rowsHTML = history.map((r, i) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">${i + 1}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${r.date}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${r.difficulty}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #CB3524;">${r.score}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${r.avgReactionMs > 0 ? r.avgReactionMs + ' ms' : '--'}</td>
      </tr>
    `).join('');

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Historial - ${playerName}</title>
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
            table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            th { background: #0f172a; color: white; padding: 12px; text-align: left; font-size: 14px; text-transform: uppercase; }
            .footer { text-align: center; font-size: 12px; color: #94a3b8; }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="escudo.PNG" class="logo" onerror="this.style.display='none'" />
            <div class="title">
              <h1>EVOLUCIÓN E HISTORIAL DEL PORTERO</h1>
              <h2>ATM REACTION GOALKEEPER - PREPARACIÓN FÍSICA</h2>
            </div>
          </div>
          
          <h3 style="margin-bottom: 20px;">ATLETA: <span style="color: #CB3524;">${playerName}</span></h3>
          
          <div class="summary">
            <div class="stat-box"><p>Total Sesiones</p><h3>${history.length}</h3></div>
            <div class="stat-box"><p>Puntaje Récord</p><h3>${maxScore} pts</h3></div>
            <div class="stat-box"><p>Mejor Reacción</p><h3>${bestReaction !== '--' ? bestReaction + ' ms' : '--'}</h3></div>
          </div>

          <table>
            <thead>
              <tr>
                <th style="border-radius: 8px 0 0 0; text-align: center;">#</th>
                <th>Fecha</th>
                <th>Dificultad</th>
                <th>Puntaje</th>
                <th style="border-radius: 0 8px 0 0;">Reacción Prom.</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHTML}
            </tbody>
          </table>
          
          <div class="footer">Documento Histórico Oficial. Generado por el sistema de entrenamiento biométrico ATM.</div>
          <script>window.onload = function() { window.print(); window.close(); }</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // --- Renderizado Compartido ---
  const renderBackground = (isMenu = false) => (
    <>
      <style dangerouslySetInnerHTML={{__html: `
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
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(15, 23, 42, 0.5); 
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(100, 116, 139, 0.5); 
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(100, 116, 139, 0.8); 
        }
        @media print {
          @page { size: A4 portrait; margin: 0; }
          body, html { 
            background-color: white !important; 
            color: black !important; 
            -webkit-print-color-adjust: exact; 
            print-color-adjust: exact; 
          }
          body * { 
            -webkit-print-color-adjust: exact; 
            print-color-adjust: exact; 
          }
        }
      `}} />
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
              ref={videoRef}
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
            src="escudo.PNG" 
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

          <div className="w-full mb-8">
            <p className="text-slate-300 text-xs mb-3 font-semibold text-center uppercase tracking-wider">Nivel de Dificultad</p>
            <div className="flex gap-2 justify-center">
              {Object.keys(DIFFICULTIES).map(diff => (
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

          <button 
            onClick={prepareGame}
            className="w-full bg-white text-slate-900 font-black text-lg md:text-xl py-4 rounded-xl shadow-[0_0_15px_rgba(255,255,255,0.4)] hover:scale-105 active:scale-95 transition-all mb-4"
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
          <p className="text-2xl md:text-4xl font-bold bg-black/50 px-6 py-2 rounded-full mb-8 backdrop-blur-md">Prepárate...</p>
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
                      <div className="text-xs text-slate-400 flex gap-2 mt-1">
                        <span className="bg-slate-800 px-2 py-0.5 rounded">{r.date}</span>
                        <span className="bg-slate-800 px-2 py-0.5 rounded">{r.difficulty}</span>
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
              <p className="text-xs text-slate-400">Sincronizado en tiempo real con la nube (Firebase).</p>
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
    const avgMs = reactionTimes.length > 0 
      ? Math.round(reactionTimes.reduce((a, b) => a + (typeof b === 'number' ? b : b.time), 0) / reactionTimes.length) 
      : 0;

    const getZoneAvg = (times, condition) => {
        const filtered = times.filter(t => typeof t === 'object' && condition(t));
        return filtered.length ? Math.round(filtered.reduce((a,b)=>a+b.time,0)/filtered.length) : '--';
    };
    
    const tlMs = getZoneAvg(reactionTimes, t => t.x < 50 && t.y < 50);
    const trMs = getZoneAvg(reactionTimes, t => t.x >= 50 && t.y < 50);
    const blMs = getZoneAvg(reactionTimes, t => t.x < 50 && t.y >= 50);
    const brMs = getZoneAvg(reactionTimes, t => t.x >= 50 && t.y >= 50);

    const currentRecord = ranking.length > 0 ? ranking[0] : null;

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
          </div>

          <div className="mb-6 bg-slate-900/50 p-4 rounded-xl border border-slate-700">
             <p className="text-[10px] text-slate-400 font-bold uppercase mb-3 tracking-widest">Análisis por Cuadrantes</p>
             <div className="grid grid-cols-2 gap-2 relative">
                <div className="absolute inset-0 border-t-4 border-x-4 border-white/20 rounded-t-lg pointer-events-none -m-2"></div>
                
                <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                   <span className="text-[9px] text-slate-500 mb-1">ARR-IZQ</span>
                   <span className="font-mono text-sm font-bold text-white">{tlMs} <span className="text-[10px] text-slate-400">ms</span></span>
                </div>
                <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                   <span className="text-[9px] text-slate-500 mb-1">ARR-DER</span>
                   <span className="font-mono text-sm font-bold text-white">{trMs} <span className="text-[10px] text-slate-400">ms</span></span>
                </div>
                <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                   <span className="text-[9px] text-slate-500 mb-1">ABA-IZQ</span>
                   <span className="font-mono text-sm font-bold text-white">{blMs} <span className="text-[10px] text-slate-400">ms</span></span>
                </div>
                <div className="bg-slate-800/80 rounded-md p-2 flex flex-col items-center justify-center border border-slate-700/50">
                   <span className="text-[9px] text-slate-500 mb-1">ABA-DER</span>
                   <span className="font-mono text-sm font-bold text-white">{brMs} <span className="text-[10px] text-slate-400">ms</span></span>
                </div>
             </div>
          </div>

          <div className="flex flex-col gap-3">
             {currentRecord && (
               <button 
                 onClick={() => printSessionPDF(currentRecord)}
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
      
      {/* Canvas oculto indispensable para procesar la detección de movimiento */}
      <canvas ref={motionCanvasRef} width={160} height={120} className="hidden" />
      
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

      {/* Popups de Puntuación Animados */}
      {scorePopups.map(popup => (
        <div 
          key={popup.id}
          className={`absolute z-40 font-black text-5xl md:text-7xl tracking-tighter drop-shadow-[0_5px_5px_rgba(0,0,0,0.8)] ${popup.color}`}
          style={{
            left: `${popup.x}%`,
            top: `${popup.y}%`,
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
          onPointerDown={(e) => {
            e.preventDefault(); 
            handleTargetHit(target.id);
          }}
          className={`absolute rounded-full cursor-pointer z-30 flex items-center justify-center 
            border-4 border-white aspect-square
            transform transition-all duration-75
            ${target.isHit 
              ? `bg-white scale-125 opacity-0 ${target.isDistractor ? target.distractorData.shadow : 'shadow-[0_0_50px_rgba(255,255,255,1)]'}` 
              : `${target.isDistractor ? `${target.distractorData.bg} ${target.distractorData.shadow}` : 'bg-lime-400 shadow-[0_0_30px_rgba(132,204,22,0.8)]'} hover:scale-95`
            }
          `}
          style={{
            left: `${target.x}%`,
            top: `${target.y}%`,
            width: `${target.size}%`,
            animation: target.isHit ? 'none' : 'pulse-fast 1s cubic-bezier(0.4, 0, 0.6, 1) infinite'
          }}
        >
          <div className={`w-1/2 h-1/2 rounded-full ${target.isHit ? 'bg-white' : (target.isDistractor ? target.distractorData.inner : 'bg-lime-200/50')}`}></div>
        </div>
      )}

      {/* Marcos Biométricos */}
      {gameState === 'playing' && (
        <div className="absolute inset-0 pointer-events-none z-20 border-[8px] border-cyan-500/10">
           <div className="absolute top-4 left-4 w-12 h-12 border-t-4 border-l-4 border-cyan-400/50"></div>
           <div className="absolute top-4 right-4 w-12 h-12 border-t-4 border-r-4 border-cyan-400/50"></div>
           <div className="absolute bottom-4 left-4 w-12 h-12 border-b-4 border-l-4 border-cyan-400/50"></div>
           <div className="absolute bottom-4 right-4 w-12 h-12 border-b-4 border-r-4 border-cyan-400/50"></div>
           <p className="absolute bottom-6 text-center w-full text-cyan-400/50 text-[10px] font-mono tracking-[0.5em]">BIOMETRIC MOTION TRACKING ACTIVE</p>
        </div>
      )}

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