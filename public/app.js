const socket = io();

// DOM Elements
const liveStatusDot = document.getElementById('live-status-dot');
const liveStatusText = document.getElementById('live-status-text');
const dailyEditionText = document.getElementById('daily-edition-text');
const gameModeTitle = document.getElementById('game-mode-title');
const questionCategory = document.getElementById('question-category');
const questionDifficulty = document.getElementById('question-difficulty');
const questionNumber = document.getElementById('question-number');
const questionTotal = document.getElementById('question-total');
const questionText = document.getElementById('question-text');
const tilesContainer = document.getElementById('tiles-container');
const timerPill = document.getElementById('timer-pill');
const ruleText = document.getElementById('rule-text');

const activityLabel = document.getElementById('activity-label');
const activityBars = document.getElementById('activity-bars');
const questionsCompletedEl = document.getElementById('questions-completed');

const answerFeedList = document.getElementById('answer-feed-list');
const leaderboardList = document.getElementById('leaderboard-list');
const notificationsSection = document.getElementById('notifications-section');
const tickerTitleText = document.getElementById('ticker-title-text');
const tickerSubText = document.getElementById('ticker-sub-text');

const winnerSpotlight = document.getElementById('winner-spotlight');
const winnerAvatar = document.getElementById('winner-avatar');
const winnerPoints = document.getElementById('winner-points');
const winnerName = document.getElementById('winner-name');
const winnerAnswer = document.getElementById('winner-answer');

const timeoutBanner = document.getElementById('timeout-banner');
const timeoutAnswerText = document.getElementById('timeout-answer-text');
const confettiCanvas = document.getElementById('confetti-canvas');

const mascotsStage = document.getElementById('mascots-stage');
const mascotTutuWrap = document.getElementById('mascot-tutu-wrap');
const mascotPikoWrap = document.getElementById('mascot-piko-wrap');
const mascotTutu = document.getElementById('mascot-tutu');
const mascotPiko = document.getElementById('mascot-piko');

let currentQuestionId = null;
let prevRevealedSet = new Set();
let winnerTimeout = null;
let timeoutBannerTimer = null;
let tickerResetTimer = null;
let mascotMoodTimer = null;
let mascotLockedUntil = 0;
let recentChatTimestamps = [];

// =========================================================
// WEB AUDIO API SOUND EFFECTS (No External MP3 Required)
// =========================================================
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(freq, startTime, duration, type = 'triangle', volume = 0.15) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(0.001, startTime);
  gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playWinSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    playTone(523.25, now, 0.15, 'triangle', 0.18);
    playTone(659.25, now + 0.08, 0.15, 'triangle', 0.18);
    playTone(783.99, now + 0.16, 0.16, 'triangle', 0.18);
    playTone(1046.5, now + 0.25, 0.4, 'sine', 0.22);
  } catch (e) {}
}

function playFollowSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    playTone(660, now, 0.1, 'sine', 0.1);
    playTone(880, now + 0.08, 0.15, 'sine', 0.12);
  } catch (e) {}
}

function playGiftSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    playTone(783.99, now, 0.12, 'sine', 0.16);
    playTone(987.77, now + 0.08, 0.12, 'sine', 0.16);
    playTone(1318.51, now + 0.16, 0.25, 'sine', 0.18);
  } catch (e) {}
}

// =========================================================
// CONFETTI PARTICLE SYSTEM
// =========================================================
const ctxConfetti = confettiCanvas.getContext('2d');
let confettiParticles = [];
let confettiAnimId = null;

function resizeConfetti() {
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeConfetti);
resizeConfetti();

function launchConfetti() {
  const colors = ['#fde047', '#fb7185', '#34d399', '#60a5fa', '#ffffff', '#fb923c'];
  for (let i = 0; i < 85; i++) {
    confettiParticles.push({
      x: confettiCanvas.width * (0.2 + Math.random() * 0.6),
      y: confettiCanvas.height * 0.35,
      vx: (Math.random() - 0.5) * 14,
      vy: -(Math.random() * 11 + 3),
      size: Math.random() * 9 + 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 12,
      life: 1
    });
  }
  if (!confettiAnimId) {
    animateConfetti();
  }
}

function animateConfetti() {
  ctxConfetti.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiParticles = confettiParticles.filter((p) => p.life > 0 && p.y < confettiCanvas.height + 40);

  for (const p of confettiParticles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.32;
    p.vx *= 0.99;
    p.rotation += p.vRot;
    p.life -= 0.012;

    ctxConfetti.save();
    ctxConfetti.globalAlpha = Math.max(0, p.life);
    ctxConfetti.translate(p.x, p.y);
    ctxConfetti.rotate((p.rotation * Math.PI) / 180);
    ctxConfetti.fillStyle = p.color;
    ctxConfetti.fillRect(-p.size / 2, -p.size / 4, p.size, p.size * 0.6);
    ctxConfetti.restore();
  }

  if (confettiParticles.length > 0) {
    confettiAnimId = requestAnimationFrame(animateConfetti);
  } else {
    confettiAnimId = null;
    ctxConfetti.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  }
}

// =========================================================
// RENDERING HELPERS
// =========================================================
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderConnectionStatus(status, username) {
  if (status === 'connected') {
    liveStatusDot.classList.add('is-live');
    liveStatusText.textContent = username ? `LIVE @${username}` : 'LIVE';
  } else if (status === 'connecting') {
    liveStatusDot.classList.remove('is-live');
    liveStatusText.textContent = 'CONNECTING...';
  } else {
    liveStatusDot.classList.remove('is-live');
    liveStatusText.textContent = 'SIMULASI';
  }
}

function updateActivityMeter() {
  const now = Date.now();
  recentChatTimestamps = recentChatTimestamps.filter((ts) => now - ts < 15000);
  const count = recentChatTimestamps.length;
  const activeCount = Math.min(5, Math.ceil(count / 2));

  const bars = activityBars.querySelectorAll('.act-bar');
  bars.forEach((b, idx) => {
    b.classList.toggle('is-hot', idx < activeCount);
  });

  if (count >= 8) {
    activityLabel.textContent = 'SUPER RAME!';
  } else if (count >= 3) {
    activityLabel.textContent = 'MULAI RAME';
  } else {
    activityLabel.textContent = 'SIAP MAIN';
  }
}

function renderTiles(tiles = [], questionId) {
  if (questionId !== currentQuestionId) {
    currentQuestionId = questionId;
    prevRevealedSet = new Set();
  }

  tilesContainer.innerHTML = '';
  tiles.forEach((tile, idx) => {
    if (tile.isSpace) {
      const spacer = document.createElement('div');
      spacer.className = 'tile-space';
      tilesContainer.appendChild(spacer);
      return;
    }

    const el = document.createElement('div');
    el.className = 'letter-tile';
    if (tile.revealed && tile.char) {
      el.textContent = tile.char;
      if (!prevRevealedSet.has(idx)) {
        el.classList.add('is-revealed');
        prevRevealedSet.add(idx);
      }
    } else {
      el.classList.add('is-blank');
      el.textContent = '?';
    }
    tilesContainer.appendChild(el);
  });
}

function renderSebutKataSlots(claimedWords = [], maxSlots = 6, letter = '') {
  tilesContainer.innerHTML = '';
  for (let i = 0; i < maxSlots; i++) {
    const entry = claimedWords[i];
    const slot = document.createElement('div');
    if (entry) {
      slot.className = 'word-slot is-found';
      slot.innerHTML = `<span>✅ ${escapeHtml(entry.word)}</span><span class="word-slot-user">@${escapeHtml(entry.uniqueId)}</span>`;
    } else {
      slot.className = 'word-slot';
      slot.textContent = `${escapeHtml(letter || '?')} _ _ _`;
    }
    tilesContainer.appendChild(slot);
  }
}

function renderBenarSalahBoard(counts = { benar: 0, salah: 0 }, revealedAnswer = null) {
  const bClass =
    revealedAnswer === 'BENAR'
      ? 'is-winner-choice'
      : revealedAnswer === 'SALAH'
        ? 'is-loser-choice'
        : '';
  const sClass =
    revealedAnswer === 'SALAH'
      ? 'is-winner-choice'
      : revealedAnswer === 'BENAR'
        ? 'is-loser-choice'
        : '';

  tilesContainer.innerHTML = `
    <div class="bs-board">
      <div class="bs-card ${bClass}">
        <span>✅ BENAR</span>
        <span class="bs-count">${counts.benar || 0}</span>
      </div>
      <div class="bs-card ${sClass}">
        <span>❌ SALAH</span>
        <span class="bs-count">${counts.salah || 0}</span>
      </div>
    </div>
  `;
}

let activeBattleInfo = { optionA: 'KUBU 1', optionB: 'KUBU 2' };

function renderBattleVotingBoard(battle, winnerSide = null) {
  if (!battle) return;
  activeBattleInfo = { optionA: battle.optionA, optionB: battle.optionB };
  const countA = Number(battle.countA || 0);
  const countB = Number(battle.countB || 0);
  const total = countA + countB;
  const pctA = total > 0 ? Math.round((countA / total) * 100) : 50;
  const pctB = total > 0 ? 100 - pctA : 50;

  tilesContainer.innerHTML = `
    <div class="battle-board">
      <div class="battle-cards-row">
        <div class="battle-opt-card side-a ${winnerSide === 'A' ? 'is-winner-choice' : ''}">
          <span class="battle-opt-title">1️⃣ ${escapeHtml(battle.optionA)}</span>
          <span class="battle-opt-stat">${pctA}% (${countA})</span>
        </div>
        <div class="battle-opt-card side-b ${winnerSide === 'B' ? 'is-winner-choice' : ''}">
          <span class="battle-opt-title">2️⃣ ${escapeHtml(battle.optionB)}</span>
          <span class="battle-opt-stat">${pctB}% (${countB})</span>
        </div>
      </div>
      <div class="battle-bar-track">
        <div class="battle-bar-a" style="width: ${pctA}%"></div>
      </div>
    </div>
  `;
}

function setMascotMood(mood, durationMs = 0) {
  if (!mascotTutu || !mascotPiko) return;
  const tutuMap = {
    thinking: '/mascots/tutu-thinking.png',
    happy: '/mascots/tutu-happy.png',
    excited: '/mascots/tutu-excited.png',
    wink: '/mascots/tutu-wink.png',
    surprised: '/mascots/tutu-surprised.png',
    sleepy: '/mascots/tutu-sleepy.png'
  };
  const nextTutu = tutuMap[mood] || tutuMap.thinking;
  if (!mascotTutu.src.endsWith(nextTutu)) {
    mascotTutu.src = nextTutu;
  }

  const isCheering = mood === 'happy' || mood === 'excited' || mood === 'wink';
  const nextPiko = isCheering ? '/mascots/piko-front.png' : '/mascots/piko-cute.png';
  if (!mascotPiko.src.endsWith(nextPiko)) {
    mascotPiko.src = nextPiko;
  }

  mascotTutuWrap.classList.toggle('is-cheering', isCheering);
  mascotPikoWrap.classList.toggle('is-cheering', isCheering);

  if (durationMs > 0) {
    mascotLockedUntil = Date.now() + durationMs;
    clearTimeout(mascotMoodTimer);
    mascotMoodTimer = setTimeout(() => {
      mascotTutuWrap.classList.remove('is-cheering');
      mascotPikoWrap.classList.remove('is-cheering');
      setMascotMood('thinking', 0);
    }, durationMs);
  }
}

function updateTimer(timeLeft, roundDuration, isPaused = false) {
  const isUrgent = !isPaused && timeLeft <= 10;
  timerPill.classList.toggle('is-urgent', isUrgent);
  timerPill.classList.toggle('is-paused', Boolean(isPaused));

  if (isPaused) {
    timerPill.innerHTML = `<span>⏸️</span><span>PAUSE</span>`;
    if (Date.now() > mascotLockedUntil) setMascotMood('sleepy', 0);
  } else {
    timerPill.innerHTML = `<span>⏱️</span><span id="timer-seconds">${timeLeft}</span>s`;
    if (Date.now() > mascotLockedUntil) {
      setMascotMood(isUrgent ? 'surprised' : 'thinking', 0);
    }
  }
}

function renderAnswerFeed(feed = []) {
  if (!feed || !feed.length) {
    answerFeedList.innerHTML = `<div class="empty-mini">Menunggu komentar masuk...</div>`;
    return;
  }

  answerFeedList.innerHTML = '';
  feed.slice(0, 9).forEach((item) => {
    const row = document.createElement('div');
    row.className = `feed-row ${item.isCorrect ? 'is-correct' : ''}`;
    const badgeHtml = item.isCorrect
      ? `<span class="feed-badge-ok">✓ BENAR +${item.pointsEarned}</span>`
      : '';
    row.innerHTML = `
      <span class="feed-user">@${escapeHtml(item.uniqueId)}</span>
      <span class="feed-ans">${escapeHtml(item.comment)}</span>
      ${badgeHtml}
    `;
    answerFeedList.appendChild(row);
  });
}

// FLIP-animated Top 10 Leaderboard
function renderLeaderboard(items = [], highlightId = null) {
  const prevPositions = new Map();
  leaderboardList.querySelectorAll('.leader-row').forEach((el) => {
    prevPositions.set(el.dataset.id, el.getBoundingClientRect().top);
  });

  if (!items.length) {
    leaderboardList.innerHTML = `<div class="empty-mini">Belum ada poin</div>`;
    return;
  }

  leaderboardList.innerHTML = '';
  items.slice(0, 10).forEach((player, idx) => {
    const rank = idx + 1;
    const idKey = player.uniqueId.toLowerCase();
    const isHighlighted = highlightId && idKey === highlightId.toLowerCase();
    const row = document.createElement('div');
    row.className = `leader-row rank-${rank}`;
    row.dataset.id = idKey;

    const naikBadge = isHighlighted ? `<span class="leader-naik-badge">▲ NAIK!</span>` : '';
    const crown = rank === 1 ? '👑 ' : '';

    row.innerHTML = `
      <span class="leader-rank-num">${rank}</span>
      <img class="leader-mini-avatar" src="${escapeHtml(player.profilePictureUrl)}" alt="${escapeHtml(player.uniqueId)}" />
      <span class="leader-name">${crown}@${escapeHtml(player.uniqueId)}</span>
      ${naikBadge}
      <span class="leader-pts">${player.score}</span>
    `;

    leaderboardList.appendChild(row);

    if (prevPositions.has(idKey)) {
      const oldTop = prevPositions.get(idKey);
      const newTop = row.getBoundingClientRect().top;
      const deltaY = oldTop - newTop;
      if (Math.abs(deltaY) > 1) {
        row.style.transition = 'none';
        row.style.transform = `translateY(${deltaY}px)`;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            row.style.transition = 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)';
            row.style.transform = 'translateY(0)';
          });
        });
      }
    }
  });
}

let currentGiftPointsEnabled = true;
let currentPointsPerCoin = 10;

function getDefaultTickerHtml() {
  if (!currentGiftPointsEnabled) {
    return `<div class="ticker-placeholder">Kirim komentar jawabanmu untuk naik ke Top 10! 🚀</div>`;
  }
  const onePts = currentPointsPerCoin.toLocaleString('id-ID');
  const tenPts = (currentPointsPerCoin * 10).toLocaleString('id-ID');
  return `
    <div class="gift-power-grid">
      <div class="gift-power-box gp-one">
        <span class="gp-coin">🪙 1 Koin</span>
        <strong class="gp-pts">+${onePts} Poin</strong>
      </div>
      <div class="gift-power-box gp-ten">
        <span class="gp-coin">🪙 10 Koin</span>
        <strong class="gp-pts">+${tenPts} Poin</strong>
      </div>
    </div>
  `;
}

function renderDefaultTicker() {
  if (tickerTitleText && tickerSubText) {
    if (currentGiftPointsEnabled) {
      tickerTitleText.textContent = '🎁 KEKUATAN GIFT TIKTOK';
      tickerSubText.textContent = `1 KOIN = +${currentPointsPerCoin.toLocaleString('id-ID')} POIN`;
    } else {
      tickerTitleText.textContent = '🎁 INFO LIVE • FOLLOW & GIFT';
      tickerSubText.textContent = 'BEBAS IKUT SEMUA!';
    }
  }
  if (!tickerResetTimer) {
    notificationsSection.innerHTML = getDefaultTickerHtml();
  }
}

function showInlineTicker({ type, avatar, htmlText }) {
  clearTimeout(tickerResetTimer);
  const typeClass = type === 'gift' ? 'toast-gift' : 'toast-follow';
  notificationsSection.innerHTML = `
    <div class="toast-inline ${typeClass}">
      <img src="${escapeHtml(avatar)}" alt="avatar" />
      <span>${htmlText}</span>
    </div>
  `;

  tickerResetTimer = setTimeout(() => {
    tickerResetTimer = null;
    notificationsSection.innerHTML = getDefaultTickerHtml();
  }, 5500);
}

// =========================================================
// SOCKET.IO EVENT LISTENERS
// =========================================================
socket.on('game_state', (data) => {
  document.body.dataset.theme = data.theme || 'kayu_hangat';
  document.body.classList.toggle('is-transparent', Boolean(data.transparentBg));
  if (mascotsStage) {
    mascotsStage.classList.toggle('hidden', data.showMascots === false);
  }
  currentGiftPointsEnabled = data.giftPointsEnabled !== false;
  currentPointsPerCoin = Number(data.pointsPerCoin) || 10;
  renderDefaultTicker();
  renderConnectionStatus(data.connectionStatus, data.tiktokUsername);
  if (dailyEditionText && data.activeDayName) {
    dailyEditionText.textContent =
      data.dailySchedule === 'all'
        ? '📅 SEMUA HARI'
        : `📅 EDISI ${String(data.activeDayName).toUpperCase()}`;
  }
  questionsCompletedEl.textContent = data.questionsCompleted || 0;

  if (data.question) {
    const modeTitles = {
      tebak_tebakan: 'TEBAK-TEBAKAN',
      hitung_cepat: 'MATEMATIKA',
      sebut_kata: 'SEBUT KATA',
      lengkapi_kalimat: 'LENGKAPI KALIMAT',
      benar_salah: 'BENAR / SALAH',
      battle_voting: 'BATTLE VOTING'
    };
    gameModeTitle.textContent = modeTitles[data.activeRoundMode] || 'TEBAK-TEBAKAN';
    questionCategory.textContent = data.question.category || 'LIVE QUIZ';

    const diff = data.question.difficulty || 'mudah';
    const pts = data.question.points || 10;
    const diffLabel = data.question.isBattle
      ? '⚔️ VOTE +5 • MENANG +10'
      : diff === 'sulit'
        ? `🔴 SULIT: +${pts} POIN`
        : diff === 'sedang'
          ? `🟡 SEDANG: +${pts} POIN`
          : `🟢 MUDAH: +${pts} POIN`;
    questionDifficulty.textContent = diffLabel;
    questionDifficulty.className = `session-reward-pill diff-${diff}`;

    questionNumber.textContent = data.questionNumber;
    questionTotal.textContent = data.totalQuestions;
    questionText.textContent = data.question.question;

    if (data.question.isSebutKata) {
      renderSebutKataSlots(data.question.claimedWords, data.question.maxSlots, data.question.letter);
    } else if (data.question.isBenarSalah) {
      renderBenarSalahBoard(data.question.bsCounts);
    } else if (data.question.isBattle) {
      renderBattleVotingBoard(data.question.battle);
    } else {
      renderTiles(data.question.tiles, data.question.id);
    }
  }

  updateTimer(data.timeLeft, data.roundDuration, data.isPaused);
  renderAnswerFeed(data.answerFeed);
  renderLeaderboard(data.leaderboard);

  const ruleMessages = {
    sebut_kata: 'SEBUT 1 KATA VALID DI KOMENTAR!',
    benar_salah: 'KETIK "BENAR" ATAU "SALAH" DI KOMENTAR!',
    battle_voting: 'KETIK "1" ATAU "2" DI KOMENTAR!'
  };
  ruleText.textContent = ruleMessages[data.activeRoundMode] || 'JAWAB DI KOMENTAR!';
});

socket.on('timer_tick', ({ timeLeft, roundDuration, tiles }) => {
  updateTimer(timeLeft, roundDuration);
  if (tiles && tiles.length) {
    renderTiles(tiles, currentQuestionId);
  }
});

socket.on('chat_feed_update', ({ answerFeed }) => {
  recentChatTimestamps.push(Date.now());
  updateActivityMeter();
  renderAnswerFeed(answerFeed);
});

socket.on('new_follower', (follower) => {
  playFollowSound();
  setMascotMood('wink', 2200);
  showInlineTicker({
    type: 'follow',
    avatar: follower.profilePictureUrl,
    htmlText: `<strong>@${escapeHtml(follower.uniqueId)}</strong> baru saja FOLLOW! 🎉`
  });
});

socket.on('new_gift', (gift) => {
  playGiftSound();
  setMascotMood('excited', 2800);
  if (gift.pointsEarned >= 100) {
    launchConfetti();
  }
  if (Array.isArray(gift.answerFeed)) {
    renderAnswerFeed(gift.answerFeed);
  }
  if (Array.isArray(gift.leaderboard)) {
    renderLeaderboard(gift.leaderboard, gift.uniqueId);
  }
  const countText = gift.repeatCount > 1 ? `${gift.repeatCount}x ` : '';
  const ptsText = gift.pointsEarned ? ` (+${gift.pointsEarned} Poin!)` : '';
  showInlineTicker({
    type: 'gift',
    avatar: gift.profilePictureUrl,
    htmlText: `🎁 <strong>@${escapeHtml(gift.uniqueId)}</strong> kirim <strong>${countText}${escapeHtml(gift.giftName)}</strong>${ptsText} ✨`
  });
});

socket.on('sebut_kata_hit', ({ entry, claimedWords, maxSlots, questionsCompleted, answerFeed, leaderboard }) => {
  recentChatTimestamps.push(Date.now());
  updateActivityMeter();
  playFollowSound();
  setMascotMood('happy', 1800);
  if (typeof questionsCompleted === 'number') {
    questionsCompletedEl.textContent = questionsCompleted;
  }
  renderSebutKataSlots(claimedWords, maxSlots, entry.word?.[0] || '');
  renderAnswerFeed(answerFeed);
  renderLeaderboard(leaderboard, entry.uniqueId);
});

socket.on('round_winner', ({ winner, answer, tiles, questionsCompleted, answerFeed, leaderboard }) => {
  clearTimeout(winnerTimeout);
  timeoutBanner.classList.add('hidden');
  recentChatTimestamps.push(Date.now());
  updateActivityMeter();

  playWinSound();
  launchConfetti();
  setMascotMood('happy', 2600);

  if (typeof questionsCompleted === 'number') {
    questionsCompletedEl.textContent = questionsCompleted;
  }
  if (tiles && tiles.length) {
    renderTiles(tiles, currentQuestionId);
  }
  renderAnswerFeed(answerFeed);
  renderLeaderboard(leaderboard, winner.uniqueId);

  winnerAvatar.src = winner.profilePictureUrl;
  winnerPoints.textContent = `+${winner.pointsEarned} POIN`;
  winnerName.textContent = `@${winner.uniqueId}`;
  winnerAnswer.textContent = answer;
  winnerSpotlight.classList.remove('hidden');

  winnerTimeout = setTimeout(() => {
    winnerSpotlight.classList.add('hidden');
  }, 2400);
});

socket.on('round_winner_bonus', ({ winner, answerFeed, leaderboard }) => {
  recentChatTimestamps.push(Date.now());
  updateActivityMeter();
  renderAnswerFeed(answerFeed);
  renderLeaderboard(leaderboard, winner.uniqueId);
});

socket.on('round_timeout', ({ answer }) => {
  clearTimeout(timeoutBannerTimer);
  setMascotMood('sleepy', 3000);
  timeoutAnswerText.textContent = answer || '-';
  timeoutBanner.classList.remove('hidden');

  timeoutBannerTimer = setTimeout(() => {
    timeoutBanner.classList.add('hidden');
  }, 3000);
});

socket.on('benar_salah_update', ({ benar, salah, answerFeed }) => {
  recentChatTimestamps.push(Date.now());
  updateActivityMeter();
  renderBenarSalahBoard({ benar, salah });
  renderAnswerFeed(answerFeed);
});

socket.on('benar_salah_result', ({ answer, benar, salah, winnersCount, pointsEarned, questionsCompleted, leaderboard }) => {
  clearTimeout(timeoutBannerTimer);
  playWinSound();
  if (winnersCount > 0) {
    launchConfetti();
    setMascotMood('happy', 2600);
  }
  if (typeof questionsCompleted === 'number') {
    questionsCompletedEl.textContent = questionsCompleted;
  }
  renderBenarSalahBoard({ benar: benar || 0, salah: salah || 0 }, answer);
  renderLeaderboard(leaderboard);

  timeoutAnswerText.textContent = `${answer}! (${winnersCount} pemain dapat +${pointsEarned} poin)`;
  timeoutBanner.classList.remove('hidden');
  timeoutBannerTimer = setTimeout(() => {
    timeoutBanner.classList.add('hidden');
  }, 3200);
});

socket.on('battle_voting_update', ({ countA, countB, uniqueId, answerFeed, leaderboard }) => {
  recentChatTimestamps.push(Date.now());
  updateActivityMeter();
  playFollowSound();
  renderBattleVotingBoard({ ...activeBattleInfo, countA, countB });
  renderAnswerFeed(answerFeed);
  renderLeaderboard(leaderboard, uniqueId);
});

socket.on('battle_voting_result', ({ winnerSide, winnerLabel, countA, countB, bonusPts, questionsCompleted, leaderboard }) => {
  clearTimeout(timeoutBannerTimer);
  playWinSound();
  launchConfetti();
  setMascotMood('happy', 2600);
  if (typeof questionsCompleted === 'number') {
    questionsCompletedEl.textContent = questionsCompleted;
  }
  renderBattleVotingBoard({ ...activeBattleInfo, countA, countB }, winnerSide);
  renderLeaderboard(leaderboard);

  timeoutAnswerText.textContent =
    winnerSide === 'TIE'
      ? `SERI! Semua voter +${bonusPts} poin`
      : `🏆 ${winnerLabel} MENANG! (+${bonusPts} bonus)`;
  timeoutBanner.classList.remove('hidden');
  timeoutBannerTimer = setTimeout(() => {
    timeoutBanner.classList.add('hidden');
  }, 3200);
});
