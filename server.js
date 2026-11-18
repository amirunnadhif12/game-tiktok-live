const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// File paths
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const MINIGAMES_FILE = path.join(__dirname, 'minigames.json');
const FOLLOWERS_FILE = path.join(__dirname, 'followers.json');
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- JSON Persistence Helpers ---
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf8');
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
  }
}

// --- Load Initial Data ---
let questions = readJsonSafe(QUESTIONS_FILE, []);
let minigamesData = readJsonSafe(MINIGAMES_FILE, { sebutKata: [], lengkapiKalimat: [], benarSalah: [], battleVoting: [] });
let followers = readJsonSafe(FOLLOWERS_FILE, {}); // { [uniqueIdLower]: { uniqueId, nickname, profilePictureUrl, followedAt, via } }
let leaderboard = readJsonSafe(LEADERBOARD_FILE, {}); // { [uniqueIdLower]: { uniqueId, nickname, profilePictureUrl, score, wins, lastWinAt } }

// --- Game & Connection State ---
const GAME_MODES = ['tebak_tebakan', 'hitung_cepat', 'sebut_kata', 'lengkapi_kalimat', 'benar_salah', 'battle_voting', 'campur'];
const SINGLE_MODES = ['tebak_tebakan', 'hitung_cepat', 'sebut_kata', 'lengkapi_kalimat', 'benar_salah', 'battle_voting'];
const VALID_THEMES = ['kayu_hangat', 'cyber_neon', 'sakura_candy', 'samudra_biru', 'hutan_zamrud'];

const state = {
  tiktokUsername: '',
  connectionStatus: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
  connectionError: '',
  strictFollow: false,
  allowFollowCommand: true,
  autoAdvance: true,
  shuffleQuestions: true,
  gameMode: 'tebak_tebakan', // 'tebak_tebakan' | 'hitung_cepat' | 'sebut_kata' | 'lengkapi_kalimat' | 'campur'
  activeRoundMode: 'tebak_tebakan',
  difficulty: 'semua', // 'semua' | 'mudah' | 'sedang' | 'sulit'
  dailySchedule: 'auto', // 'auto' | 'all' | '0'..'6'
  theme: 'kayu_hangat', // 'kayu_hangat' | 'cyber_neon' | 'sakura_candy' | 'samudra_biru' | 'hutan_zamrud'
  transparentBg: true,
  showMascots: true,
  giftPointsEnabled: true,
  pointsPerCoin: 10,
  autoReconnect: true,
  isPaused: false,
  roundDuration: 45,
  currentQuestionIndex: 0,
  questionsCompleted: 0,
  activeQuestion: null,
  sebutKataClaimed: [],
  sebutKataMaxSlots: 6,
  timeLeft: 45,
  roundLocked: false,
  roundGraceActive: false,
  revealedIndices: [],
  answerFeed: [],
  recentChats: []
};

let tiktokConnection = null;
let roundInterval = null;
let nextQuestionTimeout = null;
let roundGraceTimeout = null;
let reconnectTimeout = null;
let watchdogInterval = null;
let lastPacketAt = 0;
let connectionSeq = 0;
let manualDisconnect = false;
let mathCounter = 0;
let feedCounter = 0;
let roundWinnersThisRound = new Set();
let graceWinnerCount = 0;
let sebutKataUsersThisRound = new Set();
let benarSalahVotes = new Map();
let battleVoters = new Map();
const modeQueues = {
  tebak_tebakan: [],
  lengkapi_kalimat: [],
  sebut_kata: [],
  benar_salah: [],
  battle_voting: []
};

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
let lastAutoDayIndex = new Date().getDay();

function getActiveDayIndex() {
  if (state.dailySchedule === 'all') return null;
  if (state.dailySchedule === 'auto') return new Date().getDay();
  const parsed = Number(state.dailySchedule);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 6 ? parsed : new Date().getDay();
}

function getActiveDayName() {
  const dayIdx = getActiveDayIndex();
  return dayIdx === null ? 'Semua Hari' : DAY_NAMES[dayIdx];
}

function matchesDailyFilter(item, activeDay = getActiveDayIndex()) {
  if (activeDay === null) return true;
  return typeof item?.dayOfWeek !== 'number' || item.dayOfWeek === activeDay;
}

function getDatasetForMode(mode) {
  if (mode === 'lengkapi_kalimat') return minigamesData.lengkapiKalimat || [];
  if (mode === 'sebut_kata') return minigamesData.sebutKata || [];
  if (mode === 'benar_salah') return minigamesData.benarSalah || [];
  if (mode === 'battle_voting') return minigamesData.battleVoting || [];
  return questions;
}

function getFilteredIndices(mode = 'tebak_tebakan') {
  const list = getDatasetForMode(mode);
  if (!list.length) return [];

  const activeDay = getActiveDayIndex();
  const dayIndices = [];
  list.forEach((q, idx) => {
    if (matchesDailyFilter(q, activeDay)) {
      dayIndices.push(idx);
    }
  });
  const baseIndices = dayIndices.length ? dayIndices : list.map((_, idx) => idx);

  if (state.difficulty === 'semua') {
    return baseIndices;
  }
  const filtered = baseIndices.filter((idx) => (list[idx].difficulty || 'mudah') === state.difficulty);
  return filtered.length ? filtered : baseIndices;
}

function getEffectiveDifficulty(q) {
  if (state.difficulty !== 'semua') return state.difficulty;
  return q?.difficulty || 'mudah';
}

function getPointsForDifficulty(diff) {
  if (diff === 'sulit') return 25;
  if (diff === 'sedang') return 15;
  return 10;
}

function refillQueueForMode(mode, excludeIndex = -1) {
  const arr = getFilteredIndices(mode);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  if (arr.length > 1 && arr[0] === excludeIndex) {
    const last = arr.length - 1;
    [arr[0], arr[last]] = [arr[last], arr[0]];
  }
  modeQueues[mode] = arr;
}

function getNextIndexForMode(mode) {
  const list = getDatasetForMode(mode);
  if (!list.length) return 0;
  const pool = getFilteredIndices(mode);
  if (!state.shuffleQuestions && mode === state.activeRoundMode) {
    const pos = pool.indexOf(state.currentQuestionIndex);
    return pool[(pos + 1) % pool.length];
  }
  if (!modeQueues[mode] || modeQueues[mode].length === 0) {
    refillQueueForMode(mode, mode === state.activeRoundMode ? state.currentQuestionIndex : -1);
  }
  return modeQueues[mode].shift();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateMathQuestion(preferredDiff) {
  const diff =
    preferredDiff === 'semua'
      ? ['mudah', 'sedang', 'sulit'][randInt(0, 2)]
      : preferredDiff;
  mathCounter += 1;
  let expr = '';
  let ans = 0;

  if (diff === 'mudah') {
    const op = randInt(0, 2);
    if (op === 0) {
      const a = randInt(2, 25);
      const b = randInt(2, 25);
      expr = `${a} + ${b}`;
      ans = a + b;
    } else if (op === 1) {
      const a = randInt(10, 35);
      const b = randInt(2, a - 1);
      expr = `${a} - ${b}`;
      ans = a - b;
    } else {
      const a = randInt(2, 9);
      const b = randInt(2, 5);
      expr = `${a} × ${b}`;
      ans = a * b;
    }
  } else if (diff === 'sedang') {
    const op = randInt(0, 3);
    if (op === 0) {
      const a = randInt(22, 89);
      const b = randInt(15, 79);
      expr = `${a} + ${b}`;
      ans = a + b;
    } else if (op === 1) {
      const a = randInt(45, 120);
      const b = randInt(14, a - 10);
      expr = `${a} - ${b}`;
      ans = a - b;
    } else if (op === 2) {
      const a = randInt(4, 12);
      const b = randInt(4, 9);
      expr = `${a} × ${b}`;
      ans = a * b;
    } else {
      const b = randInt(3, 9);
      const res = randInt(4, 15);
      const a = b * res;
      expr = `${a} ÷ ${b}`;
      ans = res;
    }
  } else {
    const op = randInt(0, 2);
    if (op === 0) {
      const a = randInt(4, 12);
      const b = randInt(3, 9);
      const c = randInt(10, 45);
      expr = `${a} × ${b} + ${c}`;
      ans = a * b + c;
    } else if (op === 1) {
      const a = randInt(12, 24);
      const b = randInt(4, 9);
      expr = `${a} × ${b}`;
      ans = a * b;
    } else {
      const a = randInt(60, 140);
      const b = randInt(3, 9);
      const c = randInt(3, 8);
      expr = `${a} - (${b} × ${c})`;
      ans = a - b * c;
    }
  }

  return {
    id: `math_${mathCounter}`,
    category: 'Hitung Cepat',
    difficulty: diff,
    question: `Hitung cepat: ${expr} = ?`,
    answer: String(ans),
    aliases: [String(ans)]
  };
}

function getNextQuestionIndex() {
  return getNextIndexForMode(state.activeRoundMode);
}

// --- Utility Functions ---
function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultAvatar(seed) {
  const encoded = encodeURIComponent(seed || 'player');
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encoded}&backgroundColor=ffd5dc,c0aede,d1d4f9,b6e3f4,ffdfbf`;
}

function getSortedLeaderboard(limit = 5) {
  return Object.values(leaderboard)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.lastWinAt || 0) - (a.lastWinAt || 0);
    })
    .slice(0, limit);
}

function getCurrentQuestion() {
  return state.activeQuestion;
}

function buildHintTiles(answer, revealedIndices) {
  const upper = String(answer || '').toUpperCase();
  const revealedSet = new Set(revealedIndices);
  return upper.split('').map((ch, idx) => {
    if (ch === ' ') {
      return { char: ' ', isSpace: true, revealed: true };
    }
    return {
      char: revealedSet.has(idx) ? ch : '',
      isSpace: false,
      revealed: revealedSet.has(idx)
    };
  });
}

function pickRevealIndices(answer, targetCount, existingIndices) {
  const upper = String(answer || '').toUpperCase();
  const letterIndices = [];
  for (let i = 0; i < upper.length; i++) {
    if (upper[i] !== ' ' && !existingIndices.includes(i)) {
      letterIndices.push(i);
    }
  }
  const result = [...existingIndices];
  // Always reveal index 0 first if not revealed
  if (!result.includes(0) && upper[0] && upper[0] !== ' ' && result.length < targetCount) {
    result.push(0);
    const pos = letterIndices.indexOf(0);
    if (pos !== -1) letterIndices.splice(pos, 1);
  }
  while (result.length < targetCount && letterIndices.length > 0) {
    const randIdx = Math.floor(Math.random() * letterIndices.length);
    result.push(letterIndices[randIdx]);
    letterIndices.splice(randIdx, 1);
  }
  return result;
}

function getPublicState() {
  const q = getCurrentQuestion();
  const list = getDatasetForMode(state.activeRoundMode);
  const listLen = list.length;
  const activeDay = getActiveDayIndex();
  const dailyIndices = [];
  list.forEach((item, idx) => {
    if (matchesDailyFilter(item, activeDay)) {
      dailyIndices.push(idx);
    }
  });
  const activePoolLen = dailyIndices.length || listLen;
  const posInDaily = dailyIndices.indexOf(state.currentQuestionIndex);
  const displayNum = posInDaily >= 0 ? posInDaily + 1 : (state.currentQuestionIndex % Math.max(listLen, 1)) + 1;
  const displayTotal = posInDaily >= 0 ? activePoolLen : listLen;
  const isSebutKata = state.activeRoundMode === 'sebut_kata';
  const isBenarSalah = state.activeRoundMode === 'benar_salah';
  const isBattle = state.activeRoundMode === 'battle_voting';
  const isMath = state.activeRoundMode === 'hitung_cepat';

  let bsCountBenar = 0;
  let bsCountSalah = 0;
  if (isBenarSalah) {
    benarSalahVotes.forEach((v) => {
      if (v.choice === 'BENAR') bsCountBenar += 1;
      else bsCountSalah += 1;
    });
  }

  let battleCountA = 0;
  let battleCountB = 0;
  if (isBattle) {
    battleVoters.forEach((v) => {
      if (v.side === 'A') battleCountA += 1;
      else battleCountB += 1;
    });
  }

  return {
    tiktokUsername: state.tiktokUsername,
    connectionStatus: state.connectionStatus,
    connectionError: state.connectionError,
    strictFollow: state.strictFollow,
    allowFollowCommand: state.allowFollowCommand,
    autoAdvance: state.autoAdvance,
    shuffleQuestions: state.shuffleQuestions,
    gameMode: state.gameMode,
    activeRoundMode: state.activeRoundMode,
    difficulty: state.difficulty,
    dailySchedule: state.dailySchedule,
    activeDayIndex: activeDay,
    activeDayName: getActiveDayName(),
    currentQuestionRawIndex: state.currentQuestionIndex,
    theme: state.theme,
    transparentBg: state.transparentBg,
    showMascots: state.showMascots,
    giftPointsEnabled: state.giftPointsEnabled,
    pointsPerCoin: state.pointsPerCoin,
    autoReconnect: state.autoReconnect,
    isPaused: state.isPaused,
    roundDuration: state.roundDuration,
    questionsCompleted: state.questionsCompleted,
    questionNumber: isMath ? mathCounter : displayNum,
    totalQuestions: isMath ? '∞' : displayTotal,
    question: q
      ? {
          id: q.id,
          category: q.category,
          difficulty: getEffectiveDifficulty(q),
          points: isBattle ? 10 : getPointsForDifficulty(getEffectiveDifficulty(q)),
          question: q.question,
          isSebutKata,
          isBenarSalah,
          isBattle,
          bsCounts: { benar: bsCountBenar, salah: bsCountSalah },
          battle: isBattle
            ? {
                optionA: q.optionA,
                optionB: q.optionB,
                countA: battleCountA,
                countB: battleCountB
              }
            : null,
          letter: q.letter || '',
          maxSlots: state.sebutKataMaxSlots,
          claimedWords: state.sebutKataClaimed,
          answerLength: q.answer ? q.answer.replace(/\s+/g, '').length : 0,
          tiles:
            isSebutKata || isBenarSalah || isBattle
              ? []
              : buildHintTiles(q.answer, state.revealedIndices)
        }
      : null,
    timeLeft: state.timeLeft,
    roundLocked: state.roundLocked,
    answerFeed: state.answerFeed,
    leaderboard: getSortedLeaderboard(10),
    totalFollowers: Object.keys(followers).length
  };
}

function broadcastState() {
  io.emit('game_state', getPublicState());
  const q = getCurrentQuestion();
  let answer = q?.answer || '';
  let answerPreview = q?.answer || '';
  if (state.activeRoundMode === 'sebut_kata' && q?.answers) {
    answer = q.answers[0] || '';
    answerPreview = q.answers.slice(0, 6).join(', ') + '...';
  } else if (state.activeRoundMode === 'battle_voting' && q) {
    answer = '1';
    answerPreview = `1 = ${q.optionA} | 2 = ${q.optionB}`;
  }
  io.emit('admin_round_info', {
    activeRoundMode: state.activeRoundMode,
    answer,
    answerPreview
  });
}

// --- Round Timer Management ---
function clearTimers() {
  if (roundInterval) {
    clearInterval(roundInterval);
    roundInterval = null;
  }
  if (nextQuestionTimeout) {
    clearTimeout(nextQuestionTimeout);
    nextQuestionTimeout = null;
  }
  if (roundGraceTimeout) {
    clearTimeout(roundGraceTimeout);
    roundGraceTimeout = null;
  }
}

function pickActiveMode() {
  if (state.gameMode !== 'campur') return state.gameMode;
  const others = SINGLE_MODES.filter((m) => m !== state.activeRoundMode);
  return others[randInt(0, others.length - 1)];
}

function startRound(explicitIndex = null) {
  clearTimers();

  const activeMode = explicitIndex !== null && state.gameMode !== 'campur' ? state.gameMode : pickActiveMode();
  state.activeRoundMode = activeMode;
  state.timeLeft = state.roundDuration;
  state.roundLocked = false;
  state.roundGraceActive = false;
  state.isPaused = false;
  state.sebutKataClaimed = [];
  roundWinnersThisRound = new Set();
  graceWinnerCount = 0;
  sebutKataUsersThisRound = new Set();
  benarSalahVotes = new Map();
  battleVoters = new Map();

  if (activeMode === 'hitung_cepat') {
    state.activeQuestion = generateMathQuestion(state.difficulty);
    state.revealedIndices = [];
  } else {
    const list = getDatasetForMode(activeMode);
    if (!list.length) return;
    const idx =
      explicitIndex !== null
        ? ((explicitIndex % list.length) + list.length) % list.length
        : getNextIndexForMode(activeMode);
    state.currentQuestionIndex = idx;
    state.activeQuestion = list[idx];

    if (activeMode === 'benar_salah') {
      state.timeLeft = Math.min(state.roundDuration, 25);
      state.revealedIndices = [];
    } else if (activeMode === 'battle_voting') {
      state.timeLeft = Math.min(state.roundDuration, 25);
      state.revealedIndices = [];
    } else if (activeMode === 'sebut_kata') {
      state.sebutKataMaxSlots = Math.min(state.activeQuestion.answers?.length || 6, 6);
      state.revealedIndices = [];
    } else {
      const activeDiff = getEffectiveDifficulty(state.activeQuestion);
      // In Mudah mode (word-based games), reveal 1st letter right away as a helpful clue
      state.revealedIndices =
        activeDiff === 'mudah' && state.activeQuestion.answer.length > 1
          ? pickRevealIndices(state.activeQuestion.answer, 1, [])
          : [];
    }
  }

  const roundTotalDuration = state.timeLeft;
  broadcastState();

  roundInterval = setInterval(() => {
    if (state.roundLocked || state.isPaused) return;

    state.timeLeft -= 1;
    const q = getCurrentQuestion();
    const isSpecialBoard =
      state.activeRoundMode === 'sebut_kata' ||
      state.activeRoundMode === 'benar_salah' ||
      state.activeRoundMode === 'battle_voting';

    if (q && !isSpecialBoard && q.answer) {
      const cleanLen = q.answer.replace(/\s+/g, '').length;
      const diff = getEffectiveDifficulty(q);

      if (state.activeRoundMode === 'hitung_cepat') {
        // Only reveal 1 digit if answer has 2+ digits and time is very low
        if (cleanLen >= 2 && state.timeLeft === Math.floor(roundTotalDuration * 0.25)) {
          state.revealedIndices = pickRevealIndices(q.answer, 1, state.revealedIndices);
        }
      } else if (diff === 'mudah') {
        if (state.timeLeft === Math.floor(roundTotalDuration * 0.6)) {
          const count = Math.max(2, Math.ceil(cleanLen * 0.4));
          state.revealedIndices = pickRevealIndices(q.answer, count, state.revealedIndices);
        } else if (state.timeLeft === Math.floor(roundTotalDuration * 0.3)) {
          const count = Math.max(3, Math.ceil(cleanLen * 0.65));
          state.revealedIndices = pickRevealIndices(q.answer, count, state.revealedIndices);
        }
      } else if (diff === 'sulit') {
        if (state.timeLeft === Math.floor(roundTotalDuration * 0.25)) {
          state.revealedIndices = pickRevealIndices(q.answer, 1, state.revealedIndices);
        }
      } else {
        // Sedang (normal hints)
        if (state.timeLeft === Math.floor(roundTotalDuration * 0.55)) {
          const count = Math.max(1, Math.ceil(cleanLen * 0.25));
          state.revealedIndices = pickRevealIndices(q.answer, count, state.revealedIndices);
        } else if (state.timeLeft === Math.floor(roundTotalDuration * 0.28)) {
          const count = Math.max(2, Math.ceil(cleanLen * 0.5));
          state.revealedIndices = pickRevealIndices(q.answer, count, state.revealedIndices);
        }
      }
    }

    io.emit('timer_tick', {
      timeLeft: Math.max(0, state.timeLeft),
      roundDuration: roundTotalDuration,
      tiles:
        q && !isSpecialBoard
          ? buildHintTiles(q.answer, state.revealedIndices)
          : []
    });

    if (state.timeLeft <= 0) {
      handleRoundTimeout();
    }
  }, 1000);
}

function handleRoundTimeout() {
  clearTimers();
  state.roundLocked = true;
  const q = getCurrentQuestion();

  if (state.activeRoundMode === 'benar_salah' && q) {
    const pts = getPointsForDifficulty(getEffectiveDifficulty(q));
    let winnersCount = 0;
    let countBenar = 0;
    let countSalah = 0;
    let topList = getSortedLeaderboard(10);
    benarSalahVotes.forEach((v) => {
      if (v.choice === 'BENAR') countBenar += 1;
      else countSalah += 1;
      if (v.choice === q.answer) {
        winnersCount += 1;
        const res = addPointsToLeaderboard(v.user, pts);
        topList = res.topList;
      }
    });
    if (winnersCount > 0) state.questionsCompleted += 1;
    io.emit('benar_salah_result', {
      answer: q.answer,
      benar: countBenar,
      salah: countSalah,
      winnersCount,
      pointsEarned: pts,
      questionsCompleted: state.questionsCompleted,
      leaderboard: topList
    });
  } else if (state.activeRoundMode === 'battle_voting' && q) {
    let countA = 0;
    let countB = 0;
    battleVoters.forEach((v) => {
      if (v.side === 'A') countA += 1;
      else countB += 1;
    });
    const winnerSide = countA > countB ? 'A' : countB > countA ? 'B' : 'TIE';
    const bonusPts = winnerSide === 'TIE' ? 5 : 10;
    let topList = getSortedLeaderboard(10);
    battleVoters.forEach((v) => {
      if (winnerSide === 'TIE' || v.side === winnerSide) {
        const res = addPointsToLeaderboard(v.user, bonusPts);
        topList = res.topList;
      }
    });
    if (countA + countB > 0) state.questionsCompleted += 1;
    const winnerLabel =
      winnerSide === 'A' ? q.optionA : winnerSide === 'B' ? q.optionB : 'SERI!';
    io.emit('battle_voting_result', {
      winnerSide,
      winnerLabel,
      countA,
      countB,
      bonusPts,
      questionsCompleted: state.questionsCompleted,
      leaderboard: topList
    });
  } else {
    let revealAnswer = q ? q.answer : '';
    if (state.activeRoundMode === 'sebut_kata' && q?.answers?.length) {
      const claimedSet = new Set(state.sebutKataClaimed.map((c) => c.word));
      const sample = q.answers.filter((w) => !claimedSet.has(w)).slice(0, 4);
      revealAnswer = sample.length ? `Contoh: ${sample.join(', ')}` : 'Semua slot terjawab!';
    }

    io.emit('round_timeout', {
      answer: revealAnswer,
      isSebutKata: state.activeRoundMode === 'sebut_kata'
    });
  }

  if (state.autoAdvance) {
    nextQuestionTimeout = setTimeout(() => {
      startRound();
    }, 3500);
  }
}

// --- Core Follower & Answer Logic ---
function registerFollower({ uniqueId, nickname, profilePictureUrl, via = 'live_follow' }) {
  if (!uniqueId) return null;
  const key = uniqueId.toLowerCase();
  const isNew = !followers[key];
  const record = {
    uniqueId,
    nickname: nickname || uniqueId,
    profilePictureUrl: profilePictureUrl || defaultAvatar(uniqueId),
    followedAt: followers[key]?.followedAt || Date.now(),
    via
  };
  followers[key] = record;
  writeJsonSafe(FOLLOWERS_FILE, followers);

  if (isNew) {
    io.emit('new_follower', {
      ...record,
      totalFollowers: Object.keys(followers).length
    });
  }
  return { record, isNew };
}

function isFollower(uniqueId) {
  if (!uniqueId) return false;
  return Boolean(followers[uniqueId.toLowerCase()]);
}

function addPointsToLeaderboard({ uniqueId, nickname, profilePictureUrl }, pointsEarned) {
  const key = uniqueId.toLowerCase();
  const existing = leaderboard[key] || {
    uniqueId,
    nickname: nickname || uniqueId,
    profilePictureUrl: profilePictureUrl || defaultAvatar(uniqueId),
    score: 0,
    wins: 0,
    lastWinAt: 0
  };

  existing.nickname = nickname || existing.nickname;
  existing.profilePictureUrl = profilePictureUrl || existing.profilePictureUrl;
  existing.score += pointsEarned;
  existing.wins += 1;
  existing.lastWinAt = Date.now();

  leaderboard[key] = existing;
  writeJsonSafe(LEADERBOARD_FILE, leaderboard);

  const topList = getSortedLeaderboard(10);
  const rank = topList.findIndex((p) => p.uniqueId.toLowerCase() === key) + 1;
  return { existing, topList, rank };
}

function pushAnswerFeed({ uniqueId, comment, isCorrect, pointsEarned = 0 }) {
  feedCounter += 1;
  const entry = {
    id: feedCounter,
    uniqueId,
    comment: String(comment || '').slice(0, 28),
    isCorrect: Boolean(isCorrect),
    pointsEarned,
    timestamp: Date.now()
  };
  state.answerFeed.unshift(entry);
  if (state.answerFeed.length > 10) state.answerFeed.pop();
  return entry;
}

function awardWinner(userInfo, answerText, rawComment) {
  const key = userInfo.uniqueId.toLowerCase();
  if (roundWinnersThisRound.has(key)) {
    const feedEntry = pushAnswerFeed({ uniqueId: userInfo.uniqueId, comment: rawComment, isCorrect: false });
    io.emit('chat_feed_update', { entry: feedEntry, answerFeed: state.answerFeed });
    return;
  }
  roundWinnersThisRound.add(key);

  const q = getCurrentQuestion();
  const basePoints = getPointsForDifficulty(getEffectiveDifficulty(q));
  const pointsEarned = Math.max(4, basePoints - graceWinnerCount);
  const isFirstWinner = !state.roundGraceActive;
  graceWinnerCount += 1;

  const { existing, topList, rank } = addPointsToLeaderboard(userInfo, pointsEarned);
  const feedEntry = pushAnswerFeed({
    uniqueId: existing.uniqueId,
    comment: rawComment || answerText,
    isCorrect: true,
    pointsEarned
  });

  if (isFirstWinner) {
    state.roundGraceActive = true;
    state.questionsCompleted += 1;
    if (roundInterval) {
      clearInterval(roundInterval);
      roundInterval = null;
    }

    // Reveal full answer tiles during the 2.8s runner-up window
    if (q && q.answer) {
      state.revealedIndices = q.answer.split('').map((_, idx) => idx);
    }

    io.emit('round_winner', {
      isFirstWinner: true,
      winner: {
        uniqueId: existing.uniqueId,
        nickname: existing.nickname,
        profilePictureUrl: existing.profilePictureUrl,
        score: existing.score,
        pointsEarned,
        rank: rank > 0 ? rank : null
      },
      answer: answerText,
      tiles: q && q.answer ? buildHintTiles(q.answer, state.revealedIndices) : [],
      questionsCompleted: state.questionsCompleted,
      answerFeed: state.answerFeed,
      feedEntry,
      leaderboard: topList
    });

    // Give 2.8s window so fast runners-up also get points, then advance to next question
    roundGraceTimeout = setTimeout(() => {
      state.roundLocked = true;
      startRound();
    }, 2800);
  } else {
    io.emit('round_winner_bonus', {
      winner: {
        uniqueId: existing.uniqueId,
        nickname: existing.nickname,
        profilePictureUrl: existing.profilePictureUrl,
        score: existing.score,
        pointsEarned,
        rank: rank > 0 ? rank : null
      },
      answerFeed: state.answerFeed,
      feedEntry,
      leaderboard: topList
    });
  }
}

function handleSebutKataAnswer({ uniqueId, nickname, profilePictureUrl, normalized, rawComment }) {
  const q = getCurrentQuestion();
  if (!q || !Array.isArray(q.answers)) return false;

  const userKey = uniqueId.toLowerCase();
  if (sebutKataUsersThisRound.has(userKey)) return false;

  const matchedWord = q.answers.find((ans) => normalizeText(ans) === normalized);
  if (!matchedWord) return false;

  const alreadyClaimed = state.sebutKataClaimed.some(
    (entry) => normalizeText(entry.word) === normalized
  );
  if (alreadyClaimed) return false;

  sebutKataUsersThisRound.add(userKey);
  const pointsEarned = getPointsForDifficulty(getEffectiveDifficulty(q));
  const { existing, topList } = addPointsToLeaderboard(
    { uniqueId, nickname, profilePictureUrl },
    pointsEarned
  );

  const hitEntry = {
    word: matchedWord.toUpperCase(),
    uniqueId: existing.uniqueId,
    nickname: existing.nickname,
    profilePictureUrl: existing.profilePictureUrl,
    points: pointsEarned
  };
  state.sebutKataClaimed.push(hitEntry);
  const feedEntry = pushAnswerFeed({
    uniqueId: existing.uniqueId,
    comment: rawComment || matchedWord,
    isCorrect: true,
    pointsEarned
  });

  const isCompletedNow = state.sebutKataClaimed.length >= state.sebutKataMaxSlots;
  if (isCompletedNow) {
    state.questionsCompleted += 1;
  }

  io.emit('sebut_kata_hit', {
    entry: hitEntry,
    claimedWords: state.sebutKataClaimed,
    maxSlots: state.sebutKataMaxSlots,
    questionsCompleted: state.questionsCompleted,
    answerFeed: state.answerFeed,
    feedEntry,
    leaderboard: topList
  });

  if (isCompletedNow) {
    clearTimers();
    state.roundLocked = true;
    nextQuestionTimeout = setTimeout(() => {
      startRound();
    }, 3000);
  }
  return true;
}

function handleBenarSalahAnswer({ uniqueId, nickname, profilePictureUrl, normalized, rawComment }) {
  const userKey = uniqueId.toLowerCase();
  if (benarSalahVotes.has(userKey)) return false;

  let choice = null;
  if (normalized === 'benar' || normalized === 'b' || normalized === 'true' || normalized === 'betul') {
    choice = 'BENAR';
  } else if (normalized === 'salah' || normalized === 's' || normalized === 'false') {
    choice = 'SALAH';
  }
  if (!choice) return false;

  benarSalahVotes.set(userKey, {
    choice,
    user: { uniqueId, nickname, profilePictureUrl }
  });

  let countBenar = 0;
  let countSalah = 0;
  benarSalahVotes.forEach((v) => {
    if (v.choice === 'BENAR') countBenar += 1;
    else countSalah += 1;
  });

  const feedEntry = pushAnswerFeed({
    uniqueId,
    comment: choice,
    isCorrect: false
  });

  io.emit('benar_salah_update', {
    benar: countBenar,
    salah: countSalah,
    entry: feedEntry,
    answerFeed: state.answerFeed
  });
  return true;
}

function handleBattleVotingAnswer({ uniqueId, nickname, profilePictureUrl, normalized, rawComment }) {
  const q = getCurrentQuestion();
  if (!q) return false;
  const userKey = uniqueId.toLowerCase();
  if (battleVoters.has(userKey)) return false;

  const listA = ['1', 'a', ...(q.aliasesA || []).map(normalizeText)];
  const listB = ['2', 'b', ...(q.aliasesB || []).map(normalizeText)];

  let side = null;
  if (listA.includes(normalized)) side = 'A';
  else if (listB.includes(normalized)) side = 'B';
  if (!side) return false;

  battleVoters.set(userKey, {
    side,
    user: { uniqueId, nickname, profilePictureUrl }
  });

  const votePts = 5;
  const { existing, topList } = addPointsToLeaderboard(
    { uniqueId, nickname, profilePictureUrl },
    votePts
  );

  let countA = 0;
  let countB = 0;
  battleVoters.forEach((v) => {
    if (v.side === 'A') countA += 1;
    else countB += 1;
  });

  const feedEntry = pushAnswerFeed({
    uniqueId: existing.uniqueId,
    comment: side === 'A' ? `1️⃣ ${q.optionA}` : `2️⃣ ${q.optionB}`,
    isCorrect: true,
    pointsEarned: votePts
  });

  io.emit('battle_voting_update', {
    countA,
    countB,
    uniqueId: existing.uniqueId,
    answerFeed: state.answerFeed,
    entry: feedEntry,
    leaderboard: topList
  });
  return true;
}

function handleIncomingChat({ uniqueId, nickname, profilePictureUrl, comment }) {
  if (!uniqueId || !comment) return;
  const normalized = normalizeText(comment);
  const avatar = profilePictureUrl || defaultAvatar(uniqueId);

  // Save to recent chat log for admin visibility
  state.recentChats.unshift({
    uniqueId,
    nickname: nickname || uniqueId,
    comment,
    timestamp: Date.now()
  });
  if (state.recentChats.length > 20) state.recentChats.pop();
  io.emit('admin_chat_log', state.recentChats);

  // Fallback command: !ikut or !follow
  if (state.allowFollowCommand && (normalized === '!ikut' || normalized === '!follow')) {
    const res = registerFollower({
      uniqueId,
      nickname,
      profilePictureUrl: avatar,
      via: 'command'
    });
    if (res && !res.isNew) {
      io.emit('follower_already', {
        uniqueId,
        nickname: nickname || uniqueId
      });
    }
    return;
  }

  const q = getCurrentQuestion();
  if (state.roundLocked || !q) {
    const feedEntry = pushAnswerFeed({ uniqueId, comment, isCorrect: false });
    io.emit('chat_feed_update', { entry: feedEntry, answerFeed: state.answerFeed });
    return;
  }

  if (state.activeRoundMode === 'sebut_kata') {
    const hit = handleSebutKataAnswer({
      uniqueId,
      nickname,
      profilePictureUrl: avatar,
      normalized,
      rawComment: comment
    });
    if (!hit) {
      const feedEntry = pushAnswerFeed({ uniqueId, comment, isCorrect: false });
      io.emit('chat_feed_update', { entry: feedEntry, answerFeed: state.answerFeed });
    }
    return;
  }

  if (state.activeRoundMode === 'benar_salah') {
    const voted = handleBenarSalahAnswer({
      uniqueId,
      nickname,
      profilePictureUrl: avatar,
      normalized,
      rawComment: comment
    });
    if (!voted) {
      const feedEntry = pushAnswerFeed({ uniqueId, comment, isCorrect: false });
      io.emit('chat_feed_update', { entry: feedEntry, answerFeed: state.answerFeed });
    }
    return;
  }

  if (state.activeRoundMode === 'battle_voting') {
    const voted = handleBattleVotingAnswer({
      uniqueId,
      nickname,
      profilePictureUrl: avatar,
      normalized,
      rawComment: comment
    });
    if (!voted) {
      const feedEntry = pushAnswerFeed({ uniqueId, comment, isCorrect: false });
      io.emit('chat_feed_update', { entry: feedEntry, answerFeed: state.answerFeed });
    }
    return;
  }

  const validAnswers = [normalizeText(q.answer), ...(q.aliases || []).map(normalizeText)].filter(Boolean);
  if (!validAnswers.includes(normalized)) {
    const feedEntry = pushAnswerFeed({ uniqueId, comment, isCorrect: false });
    io.emit('chat_feed_update', { entry: feedEntry, answerFeed: state.answerFeed });
    return;
  }

  // Valid winner! (Semua penonton boleh langsung ikut tanpa wajib follow)
  awardWinner({ uniqueId, nickname, profilePictureUrl: avatar }, q.answer, comment);
}

// --- TikTok Live Connector Management ---
function extractTikTokUser(data) {
  const userObj = data?.user || data || {};
  const rawId = userObj.id?.toString() || userObj.idStr?.toString() || '';
  const uniqueId =
    userObj.uniqueId ||
    userObj.displayId ||
    data?.uniqueId ||
    userObj.nickname ||
    (rawId ? `user_${rawId.slice(-6)}` : '');
  const nickname = userObj.nickname || data?.nickname || uniqueId;
  const profilePictureUrl =
    userObj.profilePictureUrl ||
    userObj.avatarLarge?.urlList?.[0] ||
    userObj.avatarThumb?.urlList?.[0] ||
    userObj.profilePicture?.url?.[0] ||
    data?.profilePictureUrl ||
    defaultAvatar(uniqueId);
  return { uniqueId, nickname, profilePictureUrl };
}

function clearReconnectTimer() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

function startWatchdog(seq) {
  stopWatchdog();
  lastPacketAt = Date.now();
  watchdogInterval = setInterval(() => {
    if (seq !== connectionSeq || manualDisconnect || state.connectionStatus !== 'connected') {
      stopWatchdog();
      return;
    }
    const idleMs = Date.now() - lastPacketAt;
    if (idleMs > 75000 && state.autoReconnect && state.tiktokUsername) {
      console.log(`[WATCHDOG] Tidak ada data masuk selama 75 detik, mencoba reconnect ke @${state.tiktokUsername}...`);
      scheduleAutoReconnect('Koneksi macet (timeout data), menyambung ulang...');
    }
  }, 15000);
}

async function disconnectTikTok(isManual = true) {
  manualDisconnect = isManual;
  connectionSeq += 1;
  clearReconnectTimer();
  stopWatchdog();
  if (tiktokConnection) {
    const oldConn = tiktokConnection;
    tiktokConnection = null;
    try {
      oldConn.removeAllListeners();
      await oldConn.disconnect();
    } catch (e) {
      // ignore disconnect errors
    }
  }
  state.connectionStatus = 'disconnected';
  state.connectionError = '';
  broadcastState();
}

function scheduleAutoReconnect(reasonMsg) {
  if (manualDisconnect || !state.autoReconnect || !state.tiktokUsername) return;
  clearReconnectTimer();
  stopWatchdog();
  state.connectionStatus = 'connecting';
  state.connectionError = reasonMsg || 'Koneksi terputus, mencoba hubungkan ulang dalam 5 detik...';
  broadcastState();
  reconnectTimeout = setTimeout(() => {
    if (!manualDisconnect && state.tiktokUsername) {
      console.log(`[RECONNECT] Mencoba reconnect ke @${state.tiktokUsername}...`);
      connectTikTok(state.tiktokUsername);
    }
  }, 5000);
}

async function connectTikTok(username) {
  const cleanUser = String(username || '').trim().replace(/^@/, '');
  if (!cleanUser) {
    state.connectionStatus = 'error';
    state.connectionError = 'Username TikTok tidak boleh kosong.';
    broadcastState();
    return;
  }

  await disconnectTikTok(false);
  const mySeq = ++connectionSeq;
  manualDisconnect = false;
  state.tiktokUsername = cleanUser;
  state.connectionStatus = 'connecting';
  state.connectionError = '';
  broadcastState();

  const conn = new TikTokLiveConnection(cleanUser, {
    processInitialData: false,
    enableExtendedGiftInfo: false
  });
  tiktokConnection = conn;

  conn.on(ControlEvent.DECODED_DATA, () => {
    if (mySeq !== connectionSeq) return;
    lastPacketAt = Date.now();
  });

  conn.on(ControlEvent.WEBSOCKET_CONNECTED, () => {
    if (mySeq !== connectionSeq) return;
    lastPacketAt = Date.now();
    console.log(`[WS] WebSocket terhubung ke room @${cleanUser}`);
  });

  conn.on(WebcastEvent.FOLLOW, (data) => {
    if (mySeq !== connectionSeq) return;
    lastPacketAt = Date.now();
    const user = extractTikTokUser(data);
    if (!user.uniqueId) return;
    console.log(`[FOLLOW] @${user.uniqueId}`);
    registerFollower({
      ...user,
      via: 'live_follow'
    });
  });

  conn.on(WebcastEvent.CHAT, (data) => {
    if (mySeq !== connectionSeq) return;
    lastPacketAt = Date.now();
    const user = extractTikTokUser(data);
    const commentText = data?.content || data?.comment || '';
    if (!commentText) return;
    const safeUser = user.uniqueId ? user : { ...user, uniqueId: `penonton_${Date.now().toString().slice(-4)}`, nickname: 'Penonton' };
    console.log(`[CHAT] @${safeUser.uniqueId}: ${commentText}`);
    handleIncomingChat({
      ...safeUser,
      comment: commentText
    });
  });

  conn.on(WebcastEvent.GIFT, (data) => {
    if (mySeq !== connectionSeq) return;
    lastPacketAt = Date.now();
    const user = extractTikTokUser(data);
    if (!user.uniqueId) return;
    // Wait until combo streak finishes to avoid double-counting points
    if ((data?.gift?.combo || data?.gift?.type === 1) && data?.repeatEnd === 0) return;

    const giftName = data?.gift?.name || 'Gift';
    const diamondCount = Number(data?.gift?.diamondCount || 1);
    const repeatCount = Number(data?.repeatCount || data?.comboCount || 1);
    processGiftReward({ ...user, giftName, diamondCount, repeatCount });
  });

  conn.on(WebcastEvent.STREAM_END || 'streamEnd', () => {
    if (mySeq !== connectionSeq) return;
    console.log(`[STREAM_END] Live @${cleanUser} telah berakhir.`);
    manualDisconnect = true;
    clearReconnectTimer();
    stopWatchdog();
    state.connectionStatus = 'disconnected';
    state.connectionError = 'Live stream telah berakhir.';
    broadcastState();
  });

  conn.on(ControlEvent.DISCONNECTED, (info) => {
    if (mySeq !== connectionSeq) return;
    console.log(`[DISCONNECTED] Koneksi TikTok terputus:`, info || '');
    stopWatchdog();
    if (!manualDisconnect && state.autoReconnect) {
      scheduleAutoReconnect('Koneksi terputus, mencoba hubungkan ulang...');
    } else if (state.connectionStatus === 'connected') {
      state.connectionStatus = 'disconnected';
      broadcastState();
    }
  });

  conn.on(ControlEvent.ERROR, (err) => {
    if (mySeq !== connectionSeq) return;
    console.error('TikTok Live Error:', err?.info || '', err?.exception?.message || err?.message || err);
  });

  try {
    const roomState = await conn.connect();
    if (mySeq !== connectionSeq) {
      conn.removeAllListeners();
      await conn.disconnect().catch(() => {});
      return;
    }
    state.connectionStatus = 'connected';
    state.connectionError = '';
    startWatchdog(mySeq);
    console.log(`Connected to @${cleanUser} (Room ID: ${roomState.roomId})`);
    broadcastState();
  } catch (err) {
    if (mySeq !== connectionSeq) return;
    state.connectionStatus = 'error';
    state.connectionError = err?.message || 'Gagal terhubung ke TikTok Live. Pastikan akun sedang LIVE.';
    console.error(`Failed to connect to @${cleanUser}:`, state.connectionError);
    broadcastState();
    if (!manualDisconnect && state.autoReconnect) {
      scheduleAutoReconnect(`Gagal connect (${state.connectionError}). Mencoba ulang 5 detik lagi...`);
    }
  }
}

function emitQuestionsListForSocket(target = io) {
  const mode = state.gameMode === 'campur' ? state.activeRoundMode : state.gameMode;
  const list = getDatasetForMode(mode);
  const activeDay = getActiveDayIndex();
  const dailyFiltered = [];
  list.forEach((q, idx) => {
    if (matchesDailyFilter(q, activeDay)) {
      dailyFiltered.push({
        index: idx,
        id: q.id,
        category: q.category,
        difficulty: q.difficulty || 'mudah',
        dayOfWeek: typeof q.dayOfWeek === 'number' ? q.dayOfWeek : null,
        dayName: typeof q.dayOfWeek === 'number' ? DAY_NAMES[q.dayOfWeek] : null,
        question: q.question,
        answer: q.answer || (q.answers ? q.answers.slice(0, 5).join(', ') + '...' : '')
      });
    }
  });
  target.emit('admin_questions_list', {
    mode,
    activeDayIndex: activeDay,
    activeDayName: getActiveDayName(),
    questions: dailyFiltered
  });
}

function processGiftReward({ uniqueId, nickname, profilePictureUrl, giftName = 'Gift', diamondCount = 1, repeatCount = 1 }) {
  const safeCoinsPerUnit = Math.max(1, Number(diamondCount) || 1);
  const safeRepeat = Math.max(1, Number(repeatCount) || 1);
  const totalCoins = safeCoinsPerUnit * safeRepeat;
  const pointsEarned = state.giftPointsEnabled ? totalCoins * state.pointsPerCoin : 0;

  let topList = getSortedLeaderboard(10);
  let displayUser = {
    uniqueId,
    nickname: nickname || uniqueId,
    profilePictureUrl: profilePictureUrl || defaultAvatar(uniqueId)
  };

  if (pointsEarned > 0) {
    const res = addPointsToLeaderboard(displayUser, pointsEarned);
    displayUser = res.existing;
    topList = res.topList;
    pushAnswerFeed({
      uniqueId: displayUser.uniqueId,
      comment: `🎁 ${totalCoins} Koin`,
      isCorrect: true,
      pointsEarned
    });
  }

  console.log(`[GIFT] @${displayUser.uniqueId} kirim ${safeRepeat}x ${giftName} (${totalCoins} koin = +${pointsEarned} poin)`);
  io.emit('new_gift', {
    uniqueId: displayUser.uniqueId,
    nickname: displayUser.nickname,
    profilePictureUrl: displayUser.profilePictureUrl,
    giftName,
    repeatCount: safeRepeat,
    totalCoins,
    pointsEarned,
    leaderboard: topList,
    answerFeed: state.answerFeed
  });
}

// --- Socket.io Events ---
io.on('connection', (socket) => {
  socket.emit('game_state', getPublicState());
  const q = getCurrentQuestion();
  socket.emit('admin_round_info', {
    activeRoundMode: state.activeRoundMode,
    answer: q?.answer || (q?.answers ? q.answers[0] : ''),
    answerPreview: q?.answer || (q?.answers ? q.answers.slice(0, 6).join(', ') + '...' : '')
  });
  socket.emit('admin_chat_log', state.recentChats);
  emitQuestionsListForSocket(socket);

  socket.on('admin_connect_tiktok', ({ username }) => {
    connectTikTok(username);
  });

  socket.on('admin_disconnect_tiktok', () => {
    disconnectTikTok(true);
  });

  socket.on('admin_update_settings', (settings) => {
    // Selalu nonaktifkan wajib follow agar semua penonton bebas ikut main
    state.strictFollow = false;
    if (typeof settings.allowFollowCommand === 'boolean') state.allowFollowCommand = settings.allowFollowCommand;
    if (typeof settings.autoAdvance === 'boolean') state.autoAdvance = settings.autoAdvance;
    if (typeof settings.shuffleQuestions === 'boolean') state.shuffleQuestions = settings.shuffleQuestions;
    if (typeof settings.theme === 'string' && VALID_THEMES.includes(settings.theme)) {
      state.theme = settings.theme;
    }
    if (typeof settings.transparentBg === 'boolean') state.transparentBg = settings.transparentBg;
    if (typeof settings.showMascots === 'boolean') state.showMascots = settings.showMascots;
    if (typeof settings.giftPointsEnabled === 'boolean') state.giftPointsEnabled = settings.giftPointsEnabled;
    if (typeof settings.pointsPerCoin === 'number' && settings.pointsPerCoin >= 1 && settings.pointsPerCoin <= 1000) {
      state.pointsPerCoin = Math.round(settings.pointsPerCoin);
    }
    if (typeof settings.autoReconnect === 'boolean') state.autoReconnect = settings.autoReconnect;
    if (typeof settings.roundDuration === 'number' && settings.roundDuration >= 10 && settings.roundDuration <= 180) {
      state.roundDuration = settings.roundDuration;
      if (!state.roundLocked && state.timeLeft > state.roundDuration) {
        state.timeLeft = state.roundDuration;
      }
    }

    let needNewRound = false;
    if (typeof settings.gameMode === 'string' && GAME_MODES.includes(settings.gameMode) && settings.gameMode !== state.gameMode) {
      state.gameMode = settings.gameMode;
      needNewRound = true;
    }

    const validDifficulties = ['semua', 'mudah', 'sedang', 'sulit'];
    if (typeof settings.difficulty === 'string' && validDifficulties.includes(settings.difficulty) && settings.difficulty !== state.difficulty) {
      state.difficulty = settings.difficulty;
      Object.keys(modeQueues).forEach((m) => refillQueueForMode(m, -1));
      needNewRound = true;
    }

    const validSchedules = ['auto', 'all', '0', '1', '2', '3', '4', '5', '6'];
    if (settings.dailySchedule !== undefined) {
      const schedStr = String(settings.dailySchedule);
      if (validSchedules.includes(schedStr) && schedStr !== state.dailySchedule) {
        state.dailySchedule = schedStr;
        if (schedStr === 'auto') {
          lastAutoDayIndex = new Date().getDay();
        }
        Object.keys(modeQueues).forEach((m) => refillQueueForMode(m, -1));
        needNewRound = true;
      }
    }

    if (needNewRound) {
      emitQuestionsListForSocket(io);
      startRound();
      return;
    }

    broadcastState();
  });

  socket.on('admin_toggle_pause', () => {
    if (!state.roundLocked) {
      state.isPaused = !state.isPaused;
      broadcastState();
    }
  });

  socket.on('admin_add_question', ({ category, difficulty, question, answer, jumpNow }) => {
    const cleanQ = String(question || '').trim();
    const cleanA = String(answer || '').trim().toUpperCase();
    const cleanCat = String(category || 'Custom').trim() || 'Custom';
    const validDiff = ['mudah', 'sedang', 'sulit'].includes(difficulty) ? difficulty : 'mudah';
    if (!cleanQ || !cleanA) return;

    const maxId = questions.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
    const activeDay = getActiveDayIndex();
    const newItem = {
      id: maxId + 1,
      category: cleanCat,
      difficulty: validDiff,
      dayOfWeek: activeDay !== null ? activeDay : new Date().getDay(),
      question: cleanQ,
      answer: cleanA,
      aliases: [cleanA.toLowerCase()]
    };
    questions.push(newItem);
    writeJsonSafe(QUESTIONS_FILE, questions);

    const newIndex = questions.length - 1;
    if (matchesDailyFilter(newItem) && (state.difficulty === 'semua' || state.difficulty === validDiff)) {
      modeQueues.tebak_tebakan.push(newIndex);
    }

    emitQuestionsListForSocket(io);

    if (jumpNow) {
      state.gameMode = 'tebak_tebakan';
      startRound(newIndex);
    } else {
      broadcastState();
    }
  });

  socket.on('admin_sim_gift', ({ uniqueId, nickname, giftName, diamondCount, repeatCount }) => {
    const cleanId = (uniqueId || `sultan_${Math.floor(Math.random() * 900 + 100)}`).replace(/^@/, '');
    processGiftReward({
      uniqueId: cleanId,
      nickname: nickname || cleanId,
      profilePictureUrl: defaultAvatar(cleanId),
      giftName: giftName || 'Mawar',
      diamondCount: Number(diamondCount) || 1,
      repeatCount: Number(repeatCount) || 1
    });
  });

  socket.on('admin_next_question', () => {
    startRound();
  });

  socket.on('admin_shuffle_now', () => {
    Object.keys(modeQueues).forEach((m) => refillQueueForMode(m, state.currentQuestionIndex));
    startRound();
  });

  socket.on('admin_prev_question', () => {
    const activeMode = state.activeRoundMode || 'tebak_tebakan';
    if (activeMode === 'hitung_cepat') {
      startRound();
      return;
    }
    const pool = getFilteredIndices(activeMode);
    if (!pool.length) {
      startRound();
      return;
    }
    const pos = pool.indexOf(state.currentQuestionIndex);
    const prevIdx = pos >= 0 ? pool[(pos - 1 + pool.length) % pool.length] : pool[0];
    startRound(prevIdx);
  });

  socket.on('admin_jump_question', ({ index }) => {
    if (typeof index === 'number') {
      startRound(index);
    }
  });

  socket.on('admin_reset_leaderboard', () => {
    leaderboard = {};
    state.questionsCompleted = 0;
    state.answerFeed = [];
    writeJsonSafe(LEADERBOARD_FILE, leaderboard);
    broadcastState();
  });

  socket.on('admin_reset_followers', () => {
    followers = {};
    writeJsonSafe(FOLLOWERS_FILE, followers);
    broadcastState();
  });

  // Simulation events for offline testing
  socket.on('admin_sim_follow', ({ uniqueId, nickname }) => {
    const cleanId = (uniqueId || `penonton_${Math.floor(Math.random() * 900 + 100)}`).replace(/^@/, '');
    registerFollower({
      uniqueId: cleanId,
      nickname: nickname || cleanId,
      profilePictureUrl: defaultAvatar(cleanId),
      via: 'simulation'
    });
    broadcastState();
  });

  socket.on('admin_sim_chat', ({ uniqueId, nickname, comment }) => {
    const cleanId = (uniqueId || `penonton_${Math.floor(Math.random() * 900 + 100)}`).replace(/^@/, '');
    handleIncomingChat({
      uniqueId: cleanId,
      nickname: nickname || cleanId,
      profilePictureUrl: defaultAvatar(cleanId),
      comment: comment || ''
    });
  });

  socket.on('admin_reload_questions', () => {
    questions = readJsonSafe(QUESTIONS_FILE, []);
    minigamesData = readJsonSafe(MINIGAMES_FILE, { sebutKata: [], lengkapiKalimat: [], benarSalah: [], battleVoting: [] });
    Object.keys(modeQueues).forEach((m) => refillQueueForMode(m, -1));
    startRound();
    emitQuestionsListForSocket(io);
  });
});

// Start initial round, watch midnight day rollover, and listen
startRound();

setInterval(() => {
  if (state.dailySchedule !== 'auto') return;
  const currentDay = new Date().getDay();
  if (currentDay !== lastAutoDayIndex) {
    lastAutoDayIndex = currentDay;
    console.log(`[DAILY ROTATION] Hari berganti ke ${DAY_NAMES[currentDay]}. Memuat soal edisi ${DAY_NAMES[currentDay]}...`);
    Object.keys(modeQueues).forEach((m) => refillQueueForMode(m, -1));
    emitQuestionsListForSocket(io);
    startRound();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🎮 Tebak-Tebakan Live TikTok Overlay Ready!`);
  console.log(`📺 Overlay (9:16) : http://localhost:${PORT}`);
  console.log(`⚙️  Admin Panel    : http://localhost:${PORT}/admin`);
  console.log(`=================================================`);
});
