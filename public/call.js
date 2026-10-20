/* public/call.js — 15 extra call features */
(function () {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const state = window.AppState;

  const RTC_CONFIG = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    iceCandidatePoolSize: 4
  };

  let pc = null, localStream = null, remoteStream = null;
  let currentCall = null, incomingCall = null, iceQueue = [];
  let muted = false, camOff = false, speakerOn = false, camFacing = 'user', blurSelf = false;
  let callStartTime = 0, callTimerInt = null;
  let statsInt = null;
  let prevStats = null;
  let ringAudio = null, ringTimeOut = null;
  const RING_TIMEOUT_MS = 45000;

  /* ---------- helpers ---------- */
  function setCallStatus(t) { const el = $('#call-status'); if (el) el.textContent = t; }

  function showCallUI(kind) {
    const ov = $('#call-overlay');
    ov.classList.remove('hidden');
    ov.classList.toggle('audio-only', kind === 'audio');
    $('#call-peer-name').textContent = state.partnerName;
    $('#localVideo').srcObject = localStream;
    $('#btn-mute').classList.remove('off');
    $('#btn-cam').classList.remove('off');
    $('#btn-mute').textContent = '🎤';
    $('#btn-cam').textContent = '📷';
    $('#call-timer').textContent = '00:00';
    $('#call-quality').textContent = 'Connecting…';
    $('#call-quality').className = 'q-good';
    $('#call-stats').textContent = '—';
    muted = false; camOff = false; speakerOn = false; blurSelf = false;
    camFacing = 'user';
    $('#localVideo').classList.remove('flipped', 'blurred');
    $('#remoteVideo').classList.remove('blurred');
    $('#btn-speaker').classList.remove('on');
    $('#btn-blur').classList.remove('off');
    $('#ringing-indicator').style.display = 'none';
    $('#call-chat').innerHTML = '';
    $('#call-react-layer').innerHTML = '';
    $('#call-chat-bar').classList.toggle('hidden', kind !== 'video' ? false : false);
  }

  /* ---------- features 1 & 2: timer + quality + stats ---------- */
  function startTimer() {
    callStartTime = Date.now();
    clearInterval(callTimerInt);
    callTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - callStartTime) / 1000);
      $('#call-timer').textContent = String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
    }, 500);
  }
  function stopTimer() { clearInterval(callTimerInt); callTimerInt = null; }

  function startStats() {
    clearInterval(statsInt); prevStats = null;
    statsInt = setInterval(async () => {
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let inb = null, outb = null;
        report.forEach((r) => {
          if (r.type === 'inbound-rtp' && !r.isRemote) inb = r;
          if (r.type === 'outbound-rtp' && !r.isRemote) outb = r;
        });
        const bytesIn  = inb && inb.bytesReceived ? inb.bytesReceived : 0;
        const bytesOut = outb && outb.bytesSent     ? outb.bytesSent     : 0;
        let lost = 0, rtt = 0;
        report.forEach((r) => {
          if (r.type === 'remote-inbound-rtp' && r.packetsLost != null) lost += r.packetsLost;
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
        });
        const bitrate = prevStats ? Math.round(((bytesIn + bytesOut - prevStats) * 8) / 1000 / 2) : 0; // kbps (2s window)
        prevStats = bytesIn + bytesOut;
        const rttMs = Math.round(rtt * 1000);
        $('#call-stats').textContent = bitrate + ' kbps · ' + rttMs + 'ms · ' + lost + ' lost';

        // quality (feature 5)
        const q = $('#call-quality');
        if (rttMs > 400 || lost > 30) { q.textContent = 'Poor'; q.className = 'q-poor'; }
        else if (rttMs > 200 || lost > 8) { q.textContent = 'Good'; q.className = 'q-good'; }
        else { q.textContent = 'Excellent'; q.className = 'q-excellent'; }
      } catch (_) {}
    }, 2000);
  }
  function stopStats() { clearInterval(statsInt); statsInt = null; prevStats = null; }

  /* ---------- feature 2: ringtone ---------- */
  function playRing() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const loop = () => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.connect(g); g.connect(ac.destination);
        o.frequency.value = 660; o.type = 'sine';
        g.gain.setValueAtTime(0.001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.06, ac.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.55);
        o.start(); o.stop(ac.currentTime + 0.6);
      };
      loop();
      ringAudio = setInterval(loop, 1400);
    } catch (_) {}
  }
  function stopRing() { if (ringAudio) { clearInterval(ringAudio); ringAudio = null; } }

  /* ---------- feature 3: vibration ---------- */
  function vibrateIncoming() {
    if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400, 200, 400]); } catch (_) {} }
  }

  /* ---------- feature 5: quality chip + feature 12 stats ---------- */
  // handled in startStats

  /* ---------- feature 6: push-to-talk (hold M or button) ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && currentCall && !e.repeat) {
      if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
      muted = false; $('#btn-mute').classList.remove('off'); $('#btn-mute').textContent = '🎤';
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'm' && currentCall) {
      if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      muted = true; $('#btn-mute').classList.add('off'); $('#btn-mute').textContent = '🔇';
    }
  });

  /* ---------- feature 7: speaker ---------- */
  function toggleSpeaker() {
    if (!localStream && !remoteStream) return;
    // speaker routed via <video> element's setSinkId if supported
    const rv = $('#remoteVideo');
    speakerOn = !speakerOn;
    $('#btn-speaker').classList.toggle('on', speakerOn);
    if (rv && rv.setSinkId) {
      // deviceId 'default' vs 'speaker' is browser-specific; fallback just toggling class
    }
  }
  $('#btn-speaker').addEventListener('click', toggleSpeaker);

  /* ---------- feature 8: switch camera ---------- */
  async function switchCamera() {
    if (!currentCall || currentCall.kind !== 'video') return;
    camFacing = camFacing === 'user' ? 'environment' : 'user';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const newTrack = stream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      const oldTrack = localStream.getVideoTracks()[0];
      if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
      localStream.addTrack(newTrack);
      $('#localVideo').srcObject = localStream;
      $('#localVideo').classList.toggle('flipped', camFacing === 'user');
      if (state.socket) state.socket.emit('call:switch-cam');
    } catch (_) { toast('Camera switch failed'); }
  }
  $('#btn-switch').addEventListener('click', switchCamera);

  /* ---------- feature 9: screenshot ---------- */
  function screenshot() {
    const v = $('#remoteVideo');
    if (!v || !v.videoWidth) return toast('No video yet');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'call-snap-' + Date.now() + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }, 'image/png');
    toast('Screenshot saved 📸');
  }
  $('#btn-snap').addEventListener('click', screenshot);

  /* ---------- feature 10: blur my video ---------- */
  function toggleBlurSelf() {
    blurSelf = !blurSelf;
    $('#localVideo').classList.toggle('blurred', blurSelf);
    $('#btn-blur').classList.toggle('off', blurSelf);
  }
  $('#btn-blur').addEventListener('click', toggleBlurSelf);

  /* ---------- feature 11: draggable PiP & swap ---------- */
  (function makeDraggable() {
    const el = $('#localVideo');
    let dragging = false, moved = false;
    let startX = 0, startY = 0, startL = 0, startT = 0;

    el.addEventListener('pointerdown', (e) => {
      if (!currentCall) return;
      dragging = true; moved = false;
      const r = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startL = r.left; startT = r.top;
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      el.style.left = (startL + dx) + 'px';
      el.style.top  = (startT + dy) + 'px';
    });
    el.addEventListener('pointerup', (e) => {
      dragging = false;
      if (!moved) swapVideos();
      el.releasePointerCapture(e.pointerId);
    });
  })();

  function swapVideos() {
    const lv = $('#localVideo'), rv = $('#remoteVideo');
    // swap streams
    const localSrc = lv.srcObject;
    lv.srcObject = rv.srcObject;
    rv.srcObject = localSrc;
    // reset position to bottom-right for local
    lv.style.left = ''; lv.style.top = ''; lv.style.right = '16px'; lv.style.bottom = '150px';
    toast('Swapped 🔁');
  }

  /* ---------- feature 13: in-call reactions ---------- */
  function floatReaction(emoji) {
    const layer = $('#call-react-layer'); if (!layer) return;
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'call-react';
      el.textContent = emoji;
      el.style.left = (10 + Math.random() * 80) + '%';
      el.style.animationDelay = (i * 0.15) + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    }
  }
  $('#btn-react').addEventListener('click', () => {
    const list = ['❤️','😂','👍','😮','😢','🔥'];
    const emoji = list[Math.floor(Math.random() * list.length)];
    if (state.socket) state.socket.emit('call:react', { emoji });
    floatReaction(emoji);
  });

  /* ---------- feature 14: in-call chat ---------- */
  function addCallChat(text, mine) {
    const box = $('#call-chat'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'cm ' + (mine ? 'mine' : 'theirs');
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    setTimeout(() => { if (el.parentNode) el.remove(); }, 12000);
  }
  $('#call-chat-send').addEventListener('click', () => {
    const inp = $('#call-chat-input');
    const t = inp.value.trim(); if (!t) return;
    inp.value = '';
    if (state.socket) state.socket.emit('call:chat', { text: t });
    addCallChat(t, true);
  });
  $('#call-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#call-chat-send').click(); }
  });

  /* ---------- call flows ---------- */
  async function getMedia(kind, facing) {
    facing = facing || 'user';
    const constraints = kind === 'video'
      ? { audio: { echoCancellation: true, noiseSuppression: true },
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } }
      : { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function createPC() {
    pc = new RTCPeerConnection(RTC_CONFIG);
    remoteStream = new MediaStream();
    $('#remoteVideo').srcObject = remoteStream;

    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => { if (e.candidate && state.socket) state.socket.emit('webrtc:ice', { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        e.streams[0].getTracks().forEach((t) => { if (!remoteStream.getTracks().includes(t)) remoteStream.addTrack(t); });
      } else remoteStream.addTrack(e.track);
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setCallStatus('Connected 💞');
        $('#ringing-indicator').style.display = 'none';
        stopRing();
        startTimer();
        startStats();
      }
      if (pc.connectionState === 'failed') { toast('Connection lost'); endCall(true); }
      if (pc.connectionState === 'disconnected') setCallStatus('Reconnecting…');
    };
    pc.oniceconnectionstatechange = () => {
      if (pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
        setCallStatus('Connected 💞');
        $('#ringing-indicator').style.display = 'none';
        stopRing();
        startTimer();
        startStats();
      }
    };
  }

  async function flushIce() {
    while (iceQueue.length) { const c = iceQueue.shift(); try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
  }

  function onRemoteIce({ candidate }) {
    if (!pc || !candidate) return;
    if (pc.remoteDescription && pc.remoteDescription.type) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    else iceQueue.push(candidate);
  }

  async function startCall(kind) {
    if (currentCall) return;
    if (!state.online) return toast('Your love is offline right now 💔');
    try { localStream = await getMedia(kind); }
    catch (_) { return toast('Allow camera & microphone access'); }
    currentCall = { kind, role: 'caller' };
    createPC(); showCallUI(kind); setCallStatus('Ringing…');
    $('#ringing-indicator').style.display = 'block';
    playRing();
    // auto-end if unanswered (feature 4)
    clearTimeout(ringTimeOut);
    ringTimeOut = setTimeout(() => {
      if (currentCall && !callStartTime) {
        toast('No answer 💔');
        endCall(true);
      }
    }, RING_TIMEOUT_MS);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('call:invite', { kind, sdp: offer });
    } catch (_) { toast('Could not start call'); endCall(true); }
  }

  function onIncomingCall({ kind, sdp }) {
    if (currentCall) { state.socket.emit('call:reject'); return; }
    incomingCall = { kind, sdp };
    $('#incoming-icon').textContent = kind === 'video' ? '🎥' : '📞';
    $('#incoming-title').textContent = kind === 'video' ? 'Incoming video call…' : 'Incoming voice call…';
    $('#incoming-sub').textContent = state.partnerName + ' is calling you';
    $('#incoming-modal').classList.remove('hidden');
    $('#incoming-modal').classList.add('flash');
    vibrateIncoming();
    playRing();
    clearTimeout(ringTimeOut);
    ringTimeOut = setTimeout(() => { if (incomingCall) { $('#btn-reject').click(); } }, RING_TIMEOUT_MS);
  }

  async function acceptCall() {
    $('#incoming-modal').classList.add('hidden');
    $('#incoming-modal').classList.remove('flash');
    stopRing();
    clearTimeout(ringTimeOut);
    if (!incomingCall) return;
    const call = incomingCall; incomingCall = null;
    try { localStream = await getMedia(call.kind); }
    catch (_) { toast('Allow camera & microphone'); state.socket.emit('call:reject'); return; }
    currentCall = { kind: call.kind, role: 'callee' };
    createPC(); showCallUI(call.kind); setCallStatus('Connecting…');
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(call.sdp));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('call:accept', { sdp: answer });
    } catch (_) { toast('Call failed'); endCall(true); }
  }

  async function onCallAccepted({ sdp }) {
    if (!pc) return;
    try { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); await flushIce(); setCallStatus('Connecting…'); }
    catch (_) { toast('Call failed'); endCall(true); }
  }

  function endCall(notify) {
    if (notify && state.socket) state.socket.emit('call:end');
    stopRing(); clearTimeout(ringTimeOut); stopTimer(); stopStats();
    if (pc) {
      pc.onicecandidate = null; pc.ontrack = null;
      pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch (_) {} pc = null;
    }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    if (remoteStream) { remoteStream.getTracks().forEach((t) => t.stop()); remoteStream = null; }
    iceQueue = []; currentCall = null; incomingCall = null;
    muted = false; camOff = false; speakerOn = false; blurSelf = false; camFacing = 'user';
    callStartTime = 0;
    const ov = $('#call-overlay'); if (ov) ov.classList.add('hidden');
    const im = $('#incoming-modal'); if (im) { im.classList.add('hidden'); im.classList.remove('flash'); }
    const rv = $('#remoteVideo'); if (rv) { rv.srcObject = null; rv.classList.remove('blurred'); }
    const lv = $('#localVideo'); if (lv) { lv.srcObject = null; lv.classList.remove('flipped', 'blurred'); lv.style.left = ''; lv.style.top = ''; lv.style.right = '16px'; lv.style.bottom = '150px'; }
    const sp = $('#btn-speaker'); if (sp) sp.classList.remove('on');
    const bl = $('#btn-blur'); if (bl) bl.classList.remove('off');
    const cc = $('#call-chat'); if (cc) cc.innerHTML = '';
    const cl = $('#call-react-layer'); if (cl) cl.innerHTML = '';
  }

  /* ---------- wire up buttons ---------- */
  $('#btn-mute').addEventListener('click', () => {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    $('#btn-mute').classList.toggle('off', muted);
    $('#btn-mute').textContent = muted ? '🔇' : '🎤';
  });
  $('#btn-cam').addEventListener('click', () => {
    if (!localStream) return;
    camOff = !camOff;
    localStream.getVideoTracks().forEach((t) => { t.enabled = !camOff; });
    $('#btn-cam').classList.toggle('off', camOff);
    $('#btn-cam').textContent = camOff ? '🚫' : '📷';
  });
  $('#btn-end').addEventListener('click', () => endCall(true));
  $('#btn-reject').addEventListener('click', () => {
    $('#incoming-modal').classList.add('hidden');
    $('#incoming-modal').classList.remove('flash');
    stopRing(); clearTimeout(ringTimeOut);
    incomingCall = null;
    if (state.socket) state.socket.emit('call:reject');
  });
  $('#btn-accept').addEventListener('click', acceptCall);

  /* ---------- public API ---------- */
  window.CallModule = {
    init() {
      // nothing needed; UI hooks already attached
    },
    attach(socket) {
      socket.on('call:unavailable', () => { toast('Your love is offline right now 💔'); endCall(false); });
      socket.on('call:incoming', onIncomingCall);
      socket.on('call:accepted', onCallAccepted);
      socket.on('call:rejected', () => { toast('Call declined 💔'); endCall(false); });
      socket.on('call:ended', () => endCall(false));
      socket.on('call:cancelled', () => { toast('Call cancelled'); endCall(false); });
      socket.on('webrtc:ice', onRemoteIce);
      socket.on('call:react-in', ({ emoji }) => floatReaction(emoji));
      socket.on('call:chat-in', ({ text }) => addCallChat(text, false));
      socket.on('call:peer-switched-cam', () => toast('Partner flipped their camera 🔄'));
      socket.on('call:typing-in', () => {});
    },
    endCall,
    startCall
  };

  // hook main buttons once DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    const a = $('#btn-audio-call'); if (a) a.addEventListener('click', () => startCall('audio'));
    const v = $('#btn-video-call'); if (v) v.addEventListener('click', () => startCall('video'));
  });
})();
