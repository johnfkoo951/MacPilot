(function () {
  "use strict";

  // ───────── 연결 ─────────
  const statusEl = document.getElementById("status");
  const dot = document.getElementById("dot");
  let ws = null, reconnectTimer = null;
  let latencyMs = null, pingTimer = null;
  let reauthRequested = false, coreAuthorized = false, sensitiveAuthorized = false;
  const SENSITIVE_RESPONSE_TYPES = new Set([
    "cmux", "cmuxStatuses", "ctermGrid", "csessRead",
    "omniState", "omniSearch", "omniFocus", "omniPtt",
  ]);
  const pendingPings = new Map();
  let networkUIRefresh = null;   // 설정 모달이 열려 있을 때 자동 프리셋 변경을 반영

  function connect() {
    // https(테일스케일 serve 등)로 열렸으면 wss 로 — 아니면 ws
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      reauthRequested = false;
      coreAuthorized = false;
      sensitiveAuthorized = false;
      setStatus(true);
      send({ t: "hello", name: "Safari" });
      startPing();
      if (currentTab === "agent") startCmuxPoll();
      if (currentTab === "term") startTermPoll();
      if (currentTab === "search") srchGo();
      if (mirror.active) startMirror();   // 재연결 시 미러 자동 재개
    };
    ws.onclose = () => {
      coreAuthorized = false;
      stopPing(); clearSensitiveSessionData(); setStatus(false);
      if (!reauthRequested) scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (coreAuthorized) onMirrorFrame(ev.data);
        return;
      }   // 미러 영상 프레임
      try {
        const m = JSON.parse(ev.data);
        // 서버가 보낸 최초 인증 봉투를 받은 뒤에만 응답을 반영한다. PIN 변경 직전
        // 시작된 비동기 요청이 늦게 도착해 폐기한 화면을 다시 채우는 것을 막는다.
        if (m.t === "security") {
          if (m.core === "authorized" && m.pairing === "authorized") {
            coreAuthorized = true;
            sensitiveAuthorized = true;
            restoreSensitiveSessionData();
            send({ t: "getDeck" });
          } else if (m.core === "authorized" && m.pairing === "disabled") {
            coreAuthorized = true;
            clearSensitiveSessionData();
            send({ t: "getDeck" });
          } else if (m.required === "pairing") {
            clearSensitiveSessionData();
            toast("세션 기능을 사용하려면 Mac 메뉴에서 PIN 페어링을 켜세요");
          } else if (m.required === "reload") {
            reauthRequested = true;
            coreAuthorized = false;
            clearSensitiveSessionData();
            setStatus(false);
            setTimeout(() => location.reload(), 60);
          }
          return;
        }
        if (!coreAuthorized) return;
        if (SENSITIVE_RESPONSE_TYPES.has(m.t) && !sensitiveAuthorized) return;
        if (m.t === "deck") {
          if (m.json && m.json.folders) { deck = m.json; saveLocal(); renderDeck(); }
          else { pushDeckToServer(); }   // 서버에 덱 없음 → 현재 덱으로 시드
        } else if (m.t === "apps") {
          installedApps = m.list || [];
          if (appsPickerRefresh) appsPickerRefresh();
        } else if (m.t === "mirrorInfo") {
          mirror.dispW = m.dispW; mirror.dispH = m.dispH;
          const ms = document.getElementById("mirror-status");
          if (ms) ms.textContent = "연결됨 · " + m.dispW + "×" + m.dispH;
        } else if (m.t === "mirrorDisplays") {
          renderMonitorTabs(m.displays || []);
        } else if (m.t === "ctermGrid") {
          if (!m.error && m.grid) renderTermGrid(m.grid);
        } else if (m.t === "mirror" && m.error) {
          const ms = document.getElementById("mirror-status");
          if (ms) ms.textContent = "권한 필요";
          toast(m.error);
        } else if (m.t === "window") {
          if (m.ok === false) {
            if (m.reason === "single") toast("이 앱은 창이 하나뿐이에요");
            else if (m.reason === "none") toast("전환할 창이 없어요");
            else toast("창 전환 실패" + (m.code ? " (" + m.code + ")" : ""));
          }
        } else if (m.t === "cmux") {
          const snapshot = JSON.stringify(m);
          if (m.backend === "herdr") {       // herdr 탭으로 라우팅
            if (snapshot !== lastHerdrJSON) { lastHerdrJSON = snapshot; herdrState = m; renderHerdr(); }
          } else if (snapshot !== lastCmuxJSON) {   // cmux(기본) — 변경 없으면 리렌더 생략
            lastCmuxJSON = snapshot; cmuxState = m; renderCmux(); renderSessCards();
            lastLiveAt = Date.now();
            omniCache.cmux = m; omniCache.ts = Date.now(); saveCacheSoon();
            prefetchScreens();
          }
        } else if (m.t === "omniSearch") {
          renderSearch(m);
        } else if (m.t === "omniFocus") {
          document.querySelectorAll(".srch-row.busy").forEach((b) => b.classList.remove("busy"));
          toast(m.ok ? "맥에서 열었습니다 ✓" : "열기 실패 — 데몬/cmux 상태 확인");
        } else if (m.t === "omniPtt") {
          handleOmniPttAck(m);
        } else if (m.t === "cmuxStatuses") {
          // 카드 워크스페이스들의 사이드바 필(결정 힌트·사분면·Running) — 지연 조회 응답
          const snap = JSON.stringify(m.statuses || {});
          if (snap !== lastStatusesJSON) {
            lastStatusesJSON = snap; wsStatuses = m.statuses || {};
            lastCardsSig = ""; renderSessCards();
          }
        } else if (m.t === "omniState") {
          const snap = JSON.stringify(m);
          if (snap !== lastOmniJSON) {
            lastOmniJSON = snap; omniState = m; renderSessCards();
            renderPttBanner(); renderVoicePill();
            lastLiveAt = Date.now();
            omniCache.omni = m; omniCache.ts = Date.now(); saveCacheSoon();
            prefetchScreens();
          }
        } else if (m.t === "csessRead") {
          onSessRead(m);
        } else if (m.t === "capture") {
          const capBox = document.getElementById("cap-result");
          if (capBox) capBox.innerHTML = m.data
            ? '<img src="data:image/jpeg;base64,' + m.data + '" alt="맥 화면"><div class="cap-note">이미지를 길게 눌러 저장·복사</div>'
            : '<div class="cap-note">캡처 실패 — 맥의 화면 기록 권한을 확인하세요 (시스템 설정 → 개인정보 보호 및 보안 → 화면 기록)</div>';
        } else if (m.t === "ocr") {
          const ocrBox = document.getElementById("cap-result");
          if (ocrBox) ocrBox.innerHTML = m.text
            ? '<div class="cap-note">✓ 맥 클립보드에 복사됨</div><textarea readonly>' + String(m.text).replace(/</g, "&lt;") + '</textarea>'
            : '<div class="cap-note">인식된 텍스트가 없습니다</div>';
        } else if (m.t === "pong") {
          const sent = pendingPings.get(m.id);
          if (sent) {
            pendingPings.delete(m.id);
            latencyMs = Math.max(1, Math.round(performance.now() - sent));
            setStatus(true);
            applyAutoTier();   // "자동" 프리셋이면 RTT에 맞춰 주사율/보정 조정
            const lat = document.getElementById("set-latency");
            if (lat) lat.textContent = latencyMs + "ms";
          }
        }
      } catch (e) {}
    };
  }
  function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1000); }
  function setStatus(ok) {
    statusEl.textContent = ok
      ? ("연결됨" + (latencyMs ? " · " + latencyMs + "ms" : ""))
      : (reauthRequested ? "PIN 재인증 중…" : "연결 끊김 · 탭하여 새로고침");
    statusEl.onclick = ok ? null : () => location.reload();
    dot.className = "dot" + (ok ? " on" : "");
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function startPing() {
    stopPing();
    const ping = () => {
      const id = "p" + Math.random().toString(36).slice(2, 9);
      pendingPings.set(id, performance.now());
      send({ t: "ping", id });
      for (const [key, value] of pendingPings) {
        if (performance.now() - value > 10000) pendingPings.delete(key);
      }
    };
    ping();
    pingTimer = setInterval(ping, 3000);
  }
  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    pendingPings.clear();
    latencyMs = null;
  }

  // ───────── 페이지 확대(핀치/더블탭) 강제 차단 ─────────
  // iOS 사파리는 viewport 메타를 무시하므로 gesture 이벤트를 직접 막아야 함.
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  // 멀티터치 핀치(스크롤 영역 밖) 방지
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1 && !e.target.closest("#trackpad")) e.preventDefault();
  }, { passive: false });

  // ───────── 설정 (감도 등, 기기별 localStorage) ─────────
  const SETTINGS_KEY = "macpilot.settings.v2";
  const SETTINGS_DEFAULTS = {
    moveSpeed: 1.15,
    accel: 0.045,
    scrollSpeed: 1.0,
    scrollDir: 1,
    theme: "dark",
    networkPreset: "auto",
    pointerHz: 60,
    pointerSmoothing: 0.16,
    resolutionScale: 1.0,
    airSensitivity: 1.2,   // 에어마우스(자이로) 감도
    sheetPos: 0,        // 트랙패드 시트 위치 (0=풀, 1=닫힘, 중간=부분)
    sheetOpenPos: 0,    // 마지막으로 열어둔 높이
    layoutMode: "auto", // 화면 모드: auto(폭 기준) | phone | tablet
    dockSplit: 0.42,    // 도킹 시 컴패니언(트랙패드/키보드)이 차지하는 비율(0.3~0.72).
    dockCompanion: "trackpad",  // 도킹 컴패니언 슬롯: "trackpad" | "keyboard" | "none"
    vaultPrimary: "",           // 개인 볼트명은 기기 localStorage에만 저장
    vaultSecondary: ""
  };
  const NETWORK_PRESETS = {
    auto: { label: "자동" },   // RTT 기반 — 아래 AUTO_TIERS 로 실시간 조정
    fast: { label: "빠른 Wi-Fi", pointerHz: 120, pointerSmoothing: 0.06, resolutionScale: 1.05 },
    balanced: { label: "균형", pointerHz: 60, pointerSmoothing: 0.16, resolutionScale: 1.0 },
    stable: { label: "불안정한 네트워크", pointerHz: 36, pointerSmoothing: 0.26, resolutionScale: 0.92 },
    manual: { label: "수동", pointerHz: 60, pointerSmoothing: 0.16, resolutionScale: 1.0 }
  };
  // "자동": 3초마다 측정되는 RTT로 전송 주사율을 고른다. 좋은 Wi-Fi(<8ms)면 120Hz까지 올라감.
  // 측정 편차로 프리셋이 널뛰지 않게 한 번에 한 단계씩만 이동.
  const AUTO_TIERS = [
    { maxRtt: 12, pointerHz: 120, pointerSmoothing: 0.04 },
    { maxRtt: 30, pointerHz: 90, pointerSmoothing: 0.08 },
    { maxRtt: 60, pointerHz: 60, pointerSmoothing: 0.14 },
    { maxRtt: Infinity, pointerHz: 36, pointerSmoothing: 0.24 }
  ];
  let autoTierIdx = -1;
  function applyAutoTier() {
    if (settings.networkPreset !== "auto" || latencyMs == null) return;
    let idx = AUTO_TIERS.findIndex((t) => latencyMs <= t.maxRtt);
    if (idx < 0) idx = AUTO_TIERS.length - 1;
    if (autoTierIdx === -1) autoTierIdx = idx;
    else if (idx > autoTierIdx) autoTierIdx++;
    else if (idx < autoTierIdx) autoTierIdx--;
    const tier = AUTO_TIERS[autoTierIdx];
    if (settings.pointerHz === tier.pointerHz && settings.pointerSmoothing === tier.pointerSmoothing) return;
    settings.pointerHz = tier.pointerHz;
    settings.pointerSmoothing = tier.pointerSmoothing;
    tuneEuroFromSettings();
    if (networkUIRefresh) networkUIRefresh();
  }
  let settings = loadSettings();
  function loadSettings() {
    try { const r = localStorage.getItem(SETTINGS_KEY); if (r) return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(r)); } catch (e) {}
    return Object.assign({}, SETTINGS_DEFAULTS);
  }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

  // 테마 적용 (system 이면 기기 설정 따라감) + 로고도 테마에 맞게 교체
  const themeMQ = window.matchMedia("(prefers-color-scheme: dark)");
  function resolvedTheme() {
    let t = settings.theme || "dark";
    return t === "system" ? (themeMQ.matches ? "dark" : "light") : t;
  }
  function currentLogoSrc() { return resolvedTheme() === "light" ? "/logo-mark.png" : "/logo-mark-dark.png"; }
  function updateLogos() { document.querySelectorAll(".logo-img").forEach((i) => { i.src = currentLogoSrc(); }); }
  function applyTheme() {
    const t = resolvedTheme();
    document.documentElement.setAttribute("data-theme", t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#f6f7f8" : "#0f1115");
    updateLogos();
  }
  themeMQ.addEventListener("change", () => { if (settings.theme === "system") applyTheme(); });
  function applyNetworkPreset(name) {
    const preset = NETWORK_PRESETS[name];
    if (!preset) return;
    settings.networkPreset = name;
    if (name === "manual") return;
    if (name === "auto") { autoTierIdx = -1; applyAutoTier(); return; }
    settings.pointerHz = preset.pointerHz;
    settings.pointerSmoothing = preset.pointerSmoothing;
    settings.resolutionScale = preset.resolutionScale;
    tuneEuroFromSettings();
  }
  if (settings.networkPreset && settings.networkPreset !== "manual") applyNetworkPreset(settings.networkPreset);
  // 예전 기본값(balanced)으로 저장된 기기를 자동 프리셋으로 1회 이관
  if (!settings._autoMigrated) {
    settings._autoMigrated = true;
    if (settings.networkPreset === "balanced") { settings.networkPreset = "auto"; }
    saveSettings();
  }
  applyTheme();

  // ───────── 실제 가시 높이 + 소프트키보드 추적 (A) ─────────
  // 가시 영역은 visualViewport 기준: 사파리 주소창 접힘/펼침, standalone, 소프트키보드까지 한 번에 반영.
  // iOS는 소프트키보드가 떠도 innerHeight는 그대로고 visualViewport.height만 줄어든다
  //  → --app-height = visualViewport.height 로 두면 레이아웃 전체가 '키보드 위 영역'으로 수축.
  //  → 키보드 높이만큼 CSS가 하단 바를 걷어 입력창을 키보드 바로 위에 고정. fixed body 밀림은 scrollTo로 원복.
  if (navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches)
    document.documentElement.classList.add("standalone");
  const vvp = window.visualViewport;
  function setAppHeight() {
    // --app-height 는 **Safari 전용** 셸 높이 = visualViewport.height (하단 URL 바·키보드 제외).
    // standalone 은 어떤 높이 '값'도 홈 인디케이터만큼 짧게 보고되므로 신뢰 불가 →
    //   CSS 가 body 를 물리 4변(position:fixed; inset:0)에 고정하고, 키보드 때만 --kb-height 로 바닥을 든다.
    //   (근거·원칙: docs/VIEWPORT.md)
    document.documentElement.style.setProperty("--app-height", Math.round(vvp ? vvp.height : window.innerHeight) + "px");
    const kb = vvp ? Math.max(0, window.innerHeight - vvp.height - (vvp.offsetTop || 0)) : 0;
    document.documentElement.style.setProperty("--kb-height", Math.round(kb) + "px");
    const open = kb > 100;   // 물리 키보드 후보바(~55px)·iOS26 visualViewport 잔차(~24px) 제외, 소프트키보드만
    document.documentElement.classList.toggle("kb-open", open);
    if (open && vvp && vvp.offsetTop) window.scrollTo(0, 0);   // iOS fixed body 밀림 원복
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);

  // ───────── 기기 구분 (phone / tablet-sm / tablet-lg × 가로·세로 × 도킹) ─────────
  //  · 긴 변(=Math.max(screen.w,screen.h)) — 회전 불변, 기기 크기 판별에 안정적
  //    iPhone ≤ ~932 / iPad mini 1133 / iPad·11" 1180~1194 / 12.9"·13" 1366
  //  · 도킹(멀티패널): 태블릿이고 짧은 뷰포트 변 ≥ 680px → 트랙패드+패널 동시 배치
  //  · 강제모드: settings.layoutMode = auto | phone | tablet
  let deckCols = 3, deckRows = 3;
  function classifyDevice() {
    const longest = Math.max(screen.width || 0, screen.height || 0, window.innerWidth);
    const vw = window.innerWidth, vh = window.innerHeight;
    const land = vw >= vh;
    const mode = settings.layoutMode || "auto";
    let cls;
    if (mode === "phone") cls = "phone";
    else if (mode === "tablet") cls = longest >= 1151 ? "tablet-lg" : "tablet-sm";
    else if (longest <= 950) cls = "phone";        // iPhone (Pro Max 긴 변 932)
    else if (longest <= 1150) cls = "tablet-sm";   // iPad mini(1133)·소형
    else cls = "tablet-lg";                        // iPad·11"·12.9" Pro
    const isTablet = cls !== "phone";
    const docked = isTablet && Math.min(vw, vh) >= 680;
    return { cls, land, docked };
  }
  function deckGrid(cls, land) {
    if (cls === "tablet-lg") return land ? { cols: 5, rows: 4 } : { cols: 7, rows: 6 };
    if (cls === "tablet-sm") return land ? { cols: 4, rows: 3 } : { cols: 5, rows: 5 };
    return { cols: 3, rows: 3 };                   // phone
  }
  function isDocked() { return document.documentElement.classList.contains("docked"); }
  function applyDeviceClass(initial) {
    const { cls, land, docked } = classifyDevice();
    const root = document.documentElement;
    const sig = cls + (land ? "L" : "P") + (docked ? "D" : "_");
    if (root.__layoutSig === sig) return;          // 변화 없으면 리렌더 생략(리사이즈 깜빡임 방지)
    const wasDocked = root.classList.contains("docked");
    root.__layoutSig = sig;
    root.classList.toggle("phone",     cls === "phone");
    root.classList.toggle("tablet-sm", cls === "tablet-sm");
    root.classList.toggle("tablet-lg", cls === "tablet-lg");
    root.classList.toggle("tablet",    cls !== "phone");
    root.classList.toggle("wide",      cls !== "phone");   // 기존 html.wide 규칙 하위호환
    root.classList.toggle("orient-land", land);
    root.classList.toggle("orient-port", !land);
    root.classList.toggle("docked",    docked);
    const g = deckGrid(cls, land);
    deckCols = g.cols; deckRows = g.rows;
    root.style.setProperty("--deck-cols", deckCols);
    if (docked) { applyDockSplit(); syncDockBar(currentTab); applyDockCompanion(); }   // 분할/패널 배치/컴패니언 반영
    if (docked && !wasDocked) { sheetEl.style.transition = "none"; sheetEl.style.transform = "none"; }
    if (!docked && wasDocked) { sheetReflow(); }
    if (!initial) renderDeck();
  }
  // 초기 적용은 sheetEl 등이 정의된 뒤(파일 끝)에서 호출. 리스너는 런타임에만 발화하므로 여기 등록 OK.
  window.addEventListener("resize", () => applyDeviceClass(false));
  window.addEventListener("orientationchange", () => setTimeout(() => applyDeviceClass(false), 60));

  // 햅틱 피드백 (안드로이드 Chrome 지원, iOS는 무시됨)
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {} }

  // ───────── 물리 키보드 감지 (소프트키보드와 구분) ─────────
  // 소프트키보드가 화면에 없는데(visualViewport 축소 없음) 실제 키 이벤트가 오면 물리 키보드로 판정.
  const HW = { present: false };
  function softKbHeight() {
    const vv = window.visualViewport;
    return vv ? Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0)) : 0;
  }
  function setPhysicalKB(on) {
    if (HW.present === on) return;
    HW.present = on;
    document.documentElement.classList.toggle("has-hwkb", on);
  }
  document.addEventListener("keydown", (e) => {
    if (e.keyCode === 229 || e.key === "Unidentified" || e.key === "Process") return;  // IME/소프트 합성키 제외
    if (softKbHeight() < 120) setPhysicalKB(true);   // 소프트키보드 없이 온 '실제' 키 = 물리 키보드
  }, true);

  // 간단 토스트 (창전환 실패 등 안내)
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1900);
  }

  function clampNum(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }

  // ───────── one-euro 포인터 필터 (지터 제거 · 지연 0) ─────────
  // 정지·저속엔 강하게 스무딩(손떨림/센서 양자화 제거), 플릭엔 컷오프↑로 원본 통과(지연 0).
  // 상대 포인터라 델타 누적합(raw 위치)을 필터링 → 필터 위치의 차분을 델타로 보냄(스트로크마다 리셋).
  class LowPass {
    constructor() { this.s = null; this.init = false; }
    filter(x, a) { this.s = this.init ? a * x + (1 - a) * this.s : x; this.init = true; return this.s; }
    reset() { this.s = null; this.init = false; }
  }
  class OneEuro {
    constructor(mc, beta, dc) { this.mc = mc; this.beta = beta; this.dc = dc; this.xf = new LowPass(); this.dxf = new LowPass(); this.tPrev = null; this.xPrev = 0; }
    alpha(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
    filter(x, t) {
      if (this.tPrev === null) { this.tPrev = t; this.xPrev = x; return this.xf.filter(x, 1); }
      let dt = t - this.tPrev; if (dt <= 0) dt = 1e-3; this.tPrev = t;
      const dx = (x - this.xPrev) / dt; this.xPrev = x;
      const edx = this.dxf.filter(dx, this.alpha(this.dc, dt));
      const cut = this.mc + this.beta * Math.abs(edx);
      return this.xf.filter(x, this.alpha(cut, dt));
    }
    reset() { this.xf.reset(); this.dxf.reset(); this.tPrev = null; this.xPrev = 0; }
    tune(mc, beta) { this.mc = mc; this.beta = beta; }
  }
  let euroX = new OneEuro(1.0, 0.02, 1.0), euroY = new OneEuro(1.0, 0.02, 1.0);
  let rawX = 0, rawY = 0, filtLastX = 0, filtLastY = 0;
  function resetMotionFilter() { euroX.reset(); euroY.reset(); rawX = rawY = filtLastX = filtLastY = 0; }
  // pointerSmoothing(0~0.45) → 필터 강도. 불안정망일수록 컷오프↓(더 부드럽게)
  function tuneEuroFromSettings() {
    const s = clampNum(settings.pointerSmoothing || 0.1, 0, 0.45);
    const mc = Math.max(0.5, 2.2 - s * 5.0);     // s=0→2.2Hz, s=0.26→0.9Hz
    const beta = Math.max(0.006, 0.03 - s * 0.05);
    euroX.tune(mc, beta); euroY.tune(mc, beta);
  }

  // ───────── 모션 전송 큐 ─────────
  // 프레임 단위로 델타를 모아 일정 주기로 전송. 스무딩은 위 1€ 필터가 담당(분수-carry 제거).
  let motionRAF = null, motionTimer = null, lastMotionFlush = 0;
  let pendingMove = { dx: 0, dy: 0 }, pendingScroll = { dx: 0, dy: 0 };
  function motionInterval() { return 1000 / clampNum(settings.pointerHz || 60, 24, 120); }
  function motionScale() { return clampNum(settings.resolutionScale || 1, 0.5, 2); }
  function scheduleMotion() {
    if (motionRAF || motionTimer) return;
    const wait = motionInterval() - (performance.now() - lastMotionFlush);
    // 리딩엣지: 전송 주기가 이미 지났으면 대기 없이 즉시 전송.
    // (기존 rAF 대기는 프레임당 최대 8~16ms 지연을 추가로 얹었다)
    if (wait <= 1) { flushMotionFrame(performance.now()); return; }
    motionTimer = setTimeout(() => { motionTimer = null; flushMotionFrame(performance.now()); }, wait);
  }
  function queueMove(dx, dy) {
    const scale = motionScale();
    const t = performance.now() / 1000;
    rawX += dx * scale; rawY += dy * scale;
    const fx = euroX.filter(rawX, t), fy = euroY.filter(rawY, t);   // 1€ 필터 경유
    pendingMove.dx += fx - filtLastX;
    pendingMove.dy += fy - filtLastY;
    filtLastX = fx; filtLastY = fy;
    scheduleMotion();
  }
  function queueScroll(dx, dy) {
    pendingScroll.dx += dx;
    pendingScroll.dy += dy;
    scheduleMotion();
  }
  // 에어마우스 전용: 틸트=속도 제어(데드존 내장)라 1€ 스무딩은 지연만 얹는다 → 직접 누적으로 즉각 반응.
  function airQueueMove(dx, dy) {
    pendingMove.dx += dx;
    pendingMove.dy += dy;
    scheduleMotion();
  }
  function flushMotion(immediate) {
    if (motionTimer) { clearTimeout(motionTimer); motionTimer = null; }
    if (motionRAF) { cancelAnimationFrame(motionRAF); motionRAF = null; }
    if (immediate) {
      if (Math.abs(pendingMove.dx) > 0.01 || Math.abs(pendingMove.dy) > 0.01) send({ t: "move", dx: pendingMove.dx, dy: pendingMove.dy });
      if (Math.abs(pendingScroll.dx) > 0.01 || Math.abs(pendingScroll.dy) > 0.01) send({ t: "scroll", dx: pendingScroll.dx, dy: pendingScroll.dy });
      pendingMove = { dx: 0, dy: 0 }; pendingScroll = { dx: 0, dy: 0 };
      lastMotionFlush = performance.now();
      return;
    }
    flushMotionFrame(performance.now());
  }
  function flushMotionFrame(t) {
    motionRAF = null; motionTimer = null;
    lastMotionFlush = t || performance.now();
    if (Math.abs(pendingScroll.dx) > 0.01 || Math.abs(pendingScroll.dy) > 0.01) {
      send({ t: "scroll", dx: pendingScroll.dx, dy: pendingScroll.dy });
      pendingScroll = { dx: 0, dy: 0 };
    }
    if (Math.abs(pendingMove.dx) > 0.01 || Math.abs(pendingMove.dy) > 0.01) {
      send({ t: "move", dx: pendingMove.dx, dy: pendingMove.dy });   // 1€가 이미 스무딩함
      pendingMove = { dx: 0, dy: 0 };
    }
  }

  // ───────── 키 매핑 ─────────
  const KEYMAP = {
    a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,
    o:31,u:32,i:34,p:35,l:37,j:38,k:40,n:45,m:46,
    "1":18,"2":19,"3":20,"4":21,"5":23,"6":22,"7":26,"8":28,"9":25,"0":29,
    "-":27,"=":24,"[":33,"]":30,";":41,"'":39,",":43,".":47,"/":44,"\\":42,"`":50," ":49
  };
  const SPECIAL_KEYS = [
    {label:"space",keyCode:49},{label:"return",keyCode:36},{label:"tab",keyCode:48},
    {label:"esc",keyCode:53},{label:"⌫",keyCode:51},{label:"⌦",keyCode:117},
    {label:"←",keyCode:123},{label:"→",keyCode:124},{label:"↑",keyCode:126},{label:"↓",keyCode:125},
    {label:"home",keyCode:115},{label:"end",keyCode:119},{label:"⇞",keyCode:116},{label:"⇟",keyCode:121},
    {label:"F1",keyCode:122},{label:"F2",keyCode:120},{label:"F3",keyCode:99},{label:"F4",keyCode:118},
    {label:"F5",keyCode:96},{label:"F6",keyCode:97},{label:"F7",keyCode:98},{label:"F8",keyCode:100},
    {label:"F9",keyCode:101},{label:"F10",keyCode:109},{label:"F11",keyCode:103},{label:"F12",keyCode:111}
  ];
  const MOD_SYMBOL = { command:"⌘", control:"⌃", shift:"⇧", option:"⌥" };
  const MOD_ORDER = ["control","option","shift","command"];

  function keyCodeForChar(ch) { if (!ch) return null; const c = ch.toLowerCase(); return KEYMAP[c] !== undefined ? KEYMAP[c] : null; }
  function keyLabel(keyCode) {
    if (keyCode === null || keyCode === undefined) return "?";
    const sp = SPECIAL_KEYS.find(s => s.keyCode === keyCode);
    if (sp) return sp.label;
    for (const k in KEYMAP) if (KEYMAP[k] === keyCode) return k === " " ? "space" : k.toUpperCase();
    return "?";
  }
  function comboLabel(keyCode, mods) {
    const ordered = MOD_ORDER.filter(m => (mods || []).includes(m)).map(m => MOD_SYMBOL[m]).join("");
    return ordered + keyLabel(keyCode);
  }
  function uid() { return "x" + Math.random().toString(36).slice(2, 9); }

  // ───────── 탭 전환 ─────────
  const kb = document.getElementById("kb-input");
  let currentTab = "deck";   // 초기 활성 패널(HTML 기본값)
  function selectTab(name) {
    currentTab = name;
    setSheet(false);   // 탭을 누르면 트랙패드 시트를 내려 해당 탭을 보여줌
    if (name !== "mirror") exitMirrorFull();   // 미러를 벗어나면 전체화면 해제
    document.querySelectorAll("#tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    syncDockBar(name);
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
    if (name === "keyboard") setTimeout(() => kb.focus(), 50); else kb.blur();
    if (name === "deck") renderDeck();
    if (name === "agent") startCmuxPoll(); else stopCmuxPoll();   // 에이전트 탭(cmux) 표시 중엔 4초 자동 갱신
    if (name === "herdr") startHerdrPoll(); else stopHerdrPoll(); // herdr 탭 표시 중엔 4초 자동 갱신
    if (name === "mirror") { mirrorInit(); resetMirrorView(); startMirror(); if (HW.present) { const mi = document.getElementById("mirror-input"); if (mi) mi.focus(); } } else stopMirror();
    // 터미널 탭: 소프트키보드는 자동으로 안 띄운다(들어가자마자 키보드가 화면을 밀어올리던 문제).
    // 입력하려면 화면/입력창을 탭하면 포커스됨. 물리 키보드가 붙어 있을 때만 자동 포커스.
    if (name === "term") { wireTerm(); startTermPoll(); if (HW.present) focusTermTarget(); } else stopTermPoll();
    // 검색 탭: 최근 질의 칩 + 현재 뷰 로드. 소프트키보드는 자동으로 안 띄움(터미널 탭과 동일 원칙).
    if (name === "search") {
      if (sensitiveAuthorized) renderSrchRecent();
      srchGo();
      if (HW.present) setTimeout(() => document.getElementById("srch-input")?.focus(), 50);
    }
    if (document.documentElement.classList.contains("docked")) applyDockCompanion();   // 활성 패널 변경 시 키보드 컴패니언 중복 회피
  }
  document.querySelectorAll("#tabbar .tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  });
  function syncDockBar(name) {
    document.querySelectorAll("#dock-panels button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  }

  // ═════════ 도킹 레이아웃 컨트롤 (패널 배치 + 트랙패드 분할) ═════════
  const DOCK_SPLIT_PRESETS = { small: 0.38, balance: 0.5, large: 0.62 };
  function applyDockSplit() {
    const f = clampNum(settings.dockSplit != null ? settings.dockSplit : 0.42, 0.3, 0.72);
    const root = document.documentElement;
    root.style.setProperty("--tp-fr", (f * 100).toFixed(2) + "fr");
    root.style.setProperty("--panel-fr", ((1 - f) * 100).toFixed(2) + "fr");
    // 가장 가까운 프리셋을 하이라이트 (임의 드래그 값이면 전부 꺼짐)
    document.querySelectorAll("#dock-splits button").forEach((b) => {
      const pv = DOCK_SPLIT_PRESETS[b.dataset.split];
      b.classList.toggle("on", Math.abs(pv - f) < 0.02);
    });
  }
  function setDockSplitPreset(name) {
    const v = DOCK_SPLIT_PRESETS[name];
    if (v == null) return;
    settings.dockSplit = v; saveSettings(); applyDockSplit();
  }
  document.querySelectorAll("#dock-panels button").forEach((b) => b.addEventListener("click", () => { buzz(); selectTab(b.dataset.tab); }));
  document.querySelectorAll("#dock-splits button").forEach((b) => b.addEventListener("click", () => { buzz(); setDockSplitPreset(b.dataset.split); }));

  // ── 컴패니언 슬롯 선택 (트랙패드 / 키보드 / 없음) ──
  const DOCK_COMPANIONS = ["trackpad", "keyboard", "none"];
  // 활성 패널이 키보드인데 컴패니언도 키보드면 중복 → '없음'으로 낮춘다.
  function effectiveDockCompanion() {
    let c = settings.dockCompanion || "trackpad";
    if (!DOCK_COMPANIONS.includes(c)) c = "trackpad";
    if (c === "keyboard" && currentTab === "keyboard") c = "none";
    return c;
  }
  function applyDockCompanion() {
    const root = document.documentElement;
    const eff = effectiveDockCompanion();
    root.classList.toggle("dock-comp-trackpad", eff === "trackpad");
    root.classList.toggle("dock-comp-keyboard", eff === "keyboard");
    root.classList.toggle("dock-comp-none", eff === "none");
    const sel = settings.dockCompanion || "trackpad";   // 하이라이트는 사용자 선택값 유지
    document.querySelectorAll("#dock-companion button").forEach((b) => b.classList.toggle("on", b.dataset.comp === sel));
  }
  function setDockCompanion(name) {
    if (!DOCK_COMPANIONS.includes(name)) return;
    settings.dockCompanion = name; saveSettings();
    applyDockCompanion(); applyDockSplit();
  }
  document.querySelectorAll("#dock-companion button").forEach((b) => b.addEventListener("click", () => { buzz(); setDockCompanion(b.dataset.comp); }));

  // 분할선 드래그: 가로=수평 위치로 트랙패드 폭, 세로=수직 위치로 트랙패드 높이 (트랙패드는 좌/하단)
  (function setupSplitter() {
    const sp = document.getElementById("dock-splitter");
    if (!sp) return;
    let dragging = false;
    function onMove(clientX, clientY) {
      const r = mainEl.getBoundingClientRect();
      let f;
      if (document.documentElement.classList.contains("orient-port")) f = 1 - (clientY - r.top) / Math.max(r.height, 1);
      else f = (clientX - r.left) / Math.max(r.width, 1);
      settings.dockSplit = clampNum(f, 0.3, 0.72);
      applyDockSplit();
    }
    sp.addEventListener("pointerdown", (e) => {
      if (!isDocked()) return;
      dragging = true; sp.classList.add("drag");
      try { sp.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    sp.addEventListener("pointermove", (e) => { if (dragging) onMove(e.clientX, e.clientY); });
    const end = () => { if (!dragging) return; dragging = false; sp.classList.remove("drag"); saveSettings(); };
    sp.addEventListener("pointerup", end);
    sp.addEventListener("pointercancel", end);
  })();

  // ═════════ 미러 전체화면 (크롬 숨김 · 캔버스 확대) ═════════
  function mirrorFullOn() { return document.documentElement.classList.contains("mirror-full"); }
  function enterMirrorFull() {
    resetMirrorView();   // 레이아웃 변경 시 팬 클램프 기준이 바뀌므로 리셋
    document.documentElement.classList.add("mirror-full");
    const b = document.getElementById("mirror-full");
    if (b) { b.textContent = "종료"; b.classList.add("on"); }
    const stage = document.getElementById("mirror-stage");   // 진짜 Fullscreen API가 되면 함께 (iOS는 대부분 미지원 → CSS가 담당)
    if (stage && stage.requestFullscreen) { try { stage.requestFullscreen().catch(() => {}); } catch (e) {} }
  }
  function exitMirrorFull() {
    if (!mirrorFullOn()) return;
    resetMirrorView();
    document.documentElement.classList.remove("mirror-full");
    const b = document.getElementById("mirror-full");
    if (b) { b.textContent = "전체화면"; b.classList.remove("on"); }
    if (document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch (e) {} }
  }
  (function wireMirrorFull() {
    const full = document.getElementById("mirror-full");
    const exit = document.getElementById("mirror-exit");
    if (full) full.addEventListener("click", () => { buzz(); mirrorFullOn() ? exitMirrorFull() : enterMirrorFull(); });
    if (exit) exit.addEventListener("click", () => { buzz(); exitMirrorFull(); });
  })();

  // ═════════ 트랙패드 시트 (핸들 드래그 → 원하는 높이 디텐트에 스냅) ═════════
  // 0 = 풀화면, 0.45·0.7 = 부분(위에 덱/키보드 레이어가 함께 보임), 1 = 닫힘(핸들만).
  // 마지막 높이는 기기별로 기억된다 (settings.sheetPos / sheetOpenPos).
  const mainEl = document.querySelector("main");
  const sheetEl = document.getElementById("tp-sheet");
  const sheetHandle = document.getElementById("tp-handle");
  const HANDLE_H = 46;
  const SHEET_DETENTS = [0, 0.45, 0.7, 1];
  let sheetPos = clampNum(settings.sheetPos != null ? settings.sheetPos : 0, 0, 1);
  let sheetCurOff = 0, sheetDrag = null;

  function sheetOpenNow() { return sheetPos < 1; }
  function closedOffset() { return Math.max(mainEl.clientHeight - HANDLE_H, 0); }
  function applySheet(off, animate) {
    if (isDocked()) return;   // 도킹(태블릿) 중엔 CSS 그리드가 위치 담당
    sheetCurOff = off;
    sheetEl.style.transition = animate ? "transform .25s cubic-bezier(.2,.8,.2,1)" : "none";
    sheetEl.style.transform = "translateY(" + off + "px)";
  }
  function nearestDetent(frac) {
    let best = SHEET_DETENTS[0], dist = Infinity;
    for (const d of SHEET_DETENTS) { const dd = Math.abs(frac - d); if (dd < dist) { dist = dd; best = d; } }
    return best;
  }
  function setSheetPos(pos, animate) {
    if (isDocked()) { sheetEl.style.transform = "none"; return; }   // 도킹 중 no-op
    sheetPos = pos;
    applySheet(pos * closedOffset(), animate !== false);
    sheetHandle.classList.toggle("open", pos < 1);
    if (pos < 1) { kb.blur(); settings.sheetOpenPos = pos; }   // 마지막 열림 높이 기억
    settings.sheetPos = pos;
    saveSettings();
  }
  function setSheet(open) {
    if (isDocked()) return;   // 도킹 중엔 트랙패드 상시 표시(탭 전환은 패널만 교체)
    setSheetPos(open ? (settings.sheetOpenPos != null ? settings.sheetOpenPos : 0) : 1);
  }
  function sheetReflow() {
    if (isDocked()) { sheetEl.style.transform = "none"; return; }
    applySheet(sheetPos * closedOffset(), false);
  }
  sheetHandle.addEventListener("touchstart", (e) => {
    if (isDocked()) return;
    sheetDrag = { y: e.touches[0].clientY, startOff: sheetPos * closedOffset(), moved: false };
  }, { passive: true });
  sheetHandle.addEventListener("touchmove", (e) => {
    if (!sheetDrag) return;
    e.preventDefault();
    const dy = e.touches[0].clientY - sheetDrag.y;
    if (Math.abs(dy) > 6) sheetDrag.moved = true;
    applySheet(Math.max(0, Math.min(sheetDrag.startOff + dy, closedOffset())), false);
  }, { passive: false });
  sheetHandle.addEventListener("touchend", () => {
    if (!sheetDrag) return;
    if (!sheetDrag.moved) setSheet(!sheetOpenNow());       // 탭 = 열기/닫기 토글
    else setSheetPos(nearestDetent(sheetCurOff / Math.max(closedOffset(), 1)));   // 드래그 = 가까운 디텐트로
    sheetDrag = null;
  });
  window.addEventListener("resize", sheetReflow);
  if (vvp) {
    vvp.addEventListener("resize", () => { setAppHeight(); sheetReflow(); });
    // 스크롤(주소창 접힘·offsetTop 단독 변화)에도 재계산 — iOS 뷰포트 안정화(window 'resize'는 iOS에서 미발화/부정확)
    vvp.addEventListener("scroll", () => { setAppHeight(); if (document.documentElement.classList.contains("kb-open")) window.scrollTo(0, 0); });
  }

  // 좌/우 클릭 버튼 — 누르고 있으면 마우스 버튼이 '눌린 채' 유지.
  // → 좌클릭 누른 채 다른 손가락으로 트랙패드 드래그하면 진짜 드래그-선택.
  // → 짧게 눌렀다 떼면 down+up = 일반 클릭.
  let leftHeld = false, rightHeld = false;
  function buttonHeld() { return leftHeld || rightHeld; }
  function setupClickButton(btn, button) {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      if (button === "left") leftHeld = true; else rightHeld = true;
      btn.classList.add("held");
      send({ t: "down", button });
    });
    const release = () => {
      if (button === "left") { if (!leftHeld) return; leftHeld = false; }
      else { if (!rightHeld) return; rightHeld = false; }
      flushMotion(true);
      btn.classList.remove("held");
      send({ t: "up", button });
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
  }
  setupClickButton(document.getElementById("click-left"), "left");
  setupClickButton(document.getElementById("click-right"), "right");

  // ═════════ 에어마우스 (자이로) ═════════
  // ✈ 버튼을 누르고 있는 동안 폰의 회전 속도(rotationRate)로 커서를 움직인다 —
  // 폰을 리모컨처럼 들고 좌우로 돌리면 좌우, 위아래로 기울이면 상하. (이동이 아니라 '회전'에 반응)
  // ⚠️ iOS 는 모션 센서를 HTTPS(보안 컨텍스트)에서만 허용.
  // 조용한 실패 금지: 센서 이벤트가 1.2초 안에 안 오면 원인을 화면에 알려준다.
  const airBtn = document.getElementById("air-btn");
  let airActive = false, airListening = false, airLastEvent = 0, airCheckTimer = null;
  let airNeutral = null;   // 틸트 조이스틱 중립 기준 자세

  function airSensK() { return clampNum(settings.airSensitivity || 1.2, 0.3, 3) * 0.3; }
  function airStatus(txt) { const s = airBtn && airBtn.querySelector("span"); if (s) s.textContent = txt; }

  // 라이브니스만 — 실제 이동은 아래 틸트 조이스틱(onAirOrient)이 담당.
  function onAirMotion(e) {
    if (e && (e.rotationRate || e.accelerationIncludingGravity)) airLastEvent = performance.now();
  }

  // 화면 방향을 보정한 앞뒤(fb)·좌우(lr) 기울기(도). beta=앞뒤, gamma=좌우(중력 기준·드리프트 없음).
  function airTiltAxes(e) {
    const beta = e.beta || 0, gamma = e.gamma || 0;
    const ang = (screen.orientation && typeof screen.orientation.angle === "number")
      ? screen.orientation.angle : (window.orientation || 0);
    if (ang === 90) return { fb: gamma, lr: -beta };
    if (ang === -90 || ang === 270) return { fb: -gamma, lr: beta };
    if (ang === 180) return { fb: -beta, lr: -gamma };
    return { fb: beta, lr: gamma };                            // 세로(기본)
  }

  // 틸트 조이스틱: 폰을 기울인 '방향'으로 커서가 흐른다(기울기量 = 속도). 자세를 되돌리면 멈춤.
  //   앞뒤로 기울이면 상하, 좌우로 기울이면 좌우. 시작 자세가 중립(0).
  function onAirOrient(e) {
    if (e.beta == null && e.gamma == null) return;
    airLastEvent = performance.now();
    if (!airActive) { airNeutral = null; return; }
    const t = airTiltAxes(e);
    if (!airNeutral) { airNeutral = t; return; }               // 에어 시작 자세 = 중립
    const DEAD = 2.5, MAXT = 30;                                // 데드존 / 최대기울기(도)
    const clampT = (x) => Math.max(-MAXT, Math.min(MAXT, x));
    const dfb = clampT(t.fb - airNeutral.fb);
    const dlr = clampT(t.lr - airNeutral.lr);
    const k = airSensK() * 1.6;                                 // 기울기(도) → px/이벤트
    const vy = Math.abs(dfb) < DEAD ? 0 : -dfb * k;            // 뒤로 기울이면 위, 앞으로 기울이면 아래
    const vx = Math.abs(dlr) < DEAD ? 0 :  dlr * k;            // 오른쪽 기울이면 오른쪽
    if (vx || vy) airQueueMove(vx, vy);   // 스무딩 우회(즉각), 감도(airSensitivity)만 반영
  }

  async function airRequestPermissions() {
    // iOS의 '동작 및 방향'은 모션/방향 공용 권한 — 한 번만 요청해야 한다.
    // (연속 두 번 요청하면 두 번째가 사용자 제스처 밖으로 판정돼 자동 거부됨)
    const Ev = (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function")
      ? DeviceMotionEvent
      : (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function")
        ? DeviceOrientationEvent
        : null;
    if (!Ev) return { ok: true, detail: "no-perm-api" };   // Android 등 권한 개념 없는 플랫폼
    try {
      const res = await Ev.requestPermission();
      return { ok: res === "granted", detail: "result=" + res };
    } catch (err) {
      return { ok: false, detail: "throw=" + ((err && err.message) || String(err)) };
    }
  }

  // 권한은 ensureMotionPermission()(에어 버튼 탭)에서 이미 확보. 여기선 센서 리스너만 붙이고 이동 시작.
  function airStart() {
    if (typeof DeviceMotionEvent === "undefined" && typeof DeviceOrientationEvent === "undefined") {
      alert("이 브라우저는 모션 센서를 지원하지 않습니다."); return;
    }
    if (!airListening) {
      window.addEventListener("devicemotion", onAirMotion);
      window.addEventListener("deviceorientation", onAirOrient);
      airListening = true;
    }
    airActive = true;
    airNeutral = null;
    resetMotionFilter();   // 에어마우스 시작 — 1€ 리셋
    buzz();
    airBtn.classList.add("held");
    airStatus("대기…");
    // 1.2초 안에 센서 이벤트가 안 오면 원인 안내 (조용한 실패 방지)
    clearTimeout(airCheckTimer);
    const t0 = performance.now();
    airCheckTimer = setTimeout(() => {
      if (!airActive) return;
      if (airLastEvent < t0) {
        airStop();
        alert("센서 이벤트가 오지 않습니다.\n\n현재 주소: " + location.protocol + "//" + location.host +
              "\n- 자물쇠(HTTPS)로 접속했는지\n- 모션 팝업에서 '허용'을 눌렀는지 확인");
      } else {
        airStatus("작동중");
      }
    }, 1200);
  }

  function airStop() {
    if (!airActive) return;
    airActive = false;
    airNeutral = null;
    airBtn.classList.remove("held");
    airStatus("에어");
    clearTimeout(airCheckTimer);
    flushMotion(true);
  }

  // 모션 권한(iOS)은 pointerdown 이 아니라 click(=탭)에서 요청해야 팝업이 뜬다.
  // 그래서 권한 획득(탭)과 이동(누르고 있기)을 분리한다.
  const needsMotionPerm = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
  let airGranted = !needsMotionPerm;   // 권한 개념 없는 플랫폼(안드 등)은 바로 허용
  async function ensureMotionPermission() {
    if (airGranted) return true;
    if (!window.isSecureContext) {
      toast("에어마우스는 HTTPS 접속에서만 동작해요");
      alert("에어마우스(모션 센서)는 HTTPS에서만 동작합니다. 지금은 http로 열려 있어요.\n\n" +
            "맥 메뉴바(📡) → '에어마우스·모션 (HTTPS)'의 https:// 주소로 접속하세요.\n" +
            "(Tailscale 켠 폰 → https://<맥이름>.<tailnet>.ts.net)");
      return false;
    }
    const perm = await airRequestPermissions();
    if (perm.ok) {
      airGranted = true;
      airStatus("에어");
      toast("모션 허용됨 — 에어 버튼을 누르고 있으면 커서가 움직여요");
      return true;
    }
    // iOS 17+/27: 설정에 Motion 메뉴 없음. '한 번 뜨는 팝업'이 전부. 거부/미표시면 사이트 데이터 삭제로 리셋.
    alert(
      "모션 권한을 받지 못했어요.\n\n" +
      "iOS 17 이상은 Safari 설정에 '동작 및 방향' 메뉴가 없고, 첫 탭 때 뜨는 팝업으로만 허용합니다.\n" +
      "팝업이 안 떴거나 이전에 '허용 안 함'을 눌렀다면, 이 사이트 권한을 초기화하세요:\n" +
      "  설정 → 앱 → Safari → 고급 → 웹사이트 데이터 → 이 주소 찾아 삭제\n" +
      "→ 페이지 새로고침 후 에어 버튼을 한 번 '탭'(짧게).\n\n" +
      "[진단] " + location.protocol + " · secure=" + window.isSecureContext + " · " + perm.detail
    );
    return false;
  }
  if (airBtn) {
    airBtn.style.touchAction = "none";
    // 탭(click) = 권한 요청. iOS가 확실히 user-activation으로 인정하는 제스처.
    airBtn.addEventListener("click", () => { if (!airGranted) ensureMotionPermission(); });
    // 누르고 있기 = 이동 (권한 있을 때만). 권한 없으면 무시 → 위 click이 먼저 권한 받게 함.
    airBtn.addEventListener("pointerdown", (e) => { if (!airGranted) return; e.preventDefault(); airStart(); });
    airBtn.addEventListener("pointerup", airStop);
    airBtn.addEventListener("pointercancel", airStop);
  }

  // ═════════ 키보드 탭 ═════════
  let activeMods = [];
  function refreshModChips() {
    document.querySelectorAll("#kb-mods .modchip").forEach((c) => c.classList.toggle("on", activeMods.includes(c.dataset.mod)));
  }
  document.querySelectorAll("#kb-mods .modchip").forEach((chip) => {
    chip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const m = chip.dataset.mod;
      if (activeMods.includes(m)) activeMods = activeMods.filter((x) => x !== m); else activeMods.push(m);
      refreshModChips();
    });
  });

  let lastValue = "", composing = false;
  function flushDiff() {
    const value = kb.value;
    let p = 0; const minLen = Math.min(lastValue.length, value.length);
    while (p < minLen && lastValue[p] === value[p]) p++;
    const removed = lastValue.length - p;
    const added = value.slice(p);

    if (activeMods.length > 0 && removed === 0 && added) {
      // 모디파이어 켜짐 → 입력 글자를 조합키로 전송하고 입력창은 되돌림
      for (const ch of added) {
        const kc = keyCodeForChar(ch);
        if (kc !== null) send({ t: "key", keyCode: kc, mods: activeMods.slice() });
        else send({ t: "text", text: ch });
      }
      kb.value = lastValue;
      return;
    }
    for (let i = 0; i < removed; i++) send({ t: "key", keyCode: 51, mods: [] });
    if (added) send({ t: "text", text: added });
    lastValue = kb.value;
    if (kb.value.length > 80 && !composing) { kb.value = ""; lastValue = ""; }
  }
  kb.addEventListener("compositionstart", () => { composing = true; });
  kb.addEventListener("compositionend", () => { composing = false; flushDiff(); });
  kb.addEventListener("input", (e) => { if (e.isComposing || composing) return; flushDiff(); });
  document.getElementById("kb-clear").addEventListener("click", () => { kb.value = ""; lastValue = ""; kb.focus(); });

  document.querySelectorAll("#kb-special .sp").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      send({ t: "key", keyCode: parseInt(btn.dataset.key, 10), mods: activeMods.slice() });
    });
  });

  // ═════════ 에이전트 탭 + 퀵바 (고정 단축 버튼) ═════════
  // phrase = 텍스트 입력 후 자동 return (서버 매크로로 순차 실행 보장)
  function runQuickAction(b) {
    buzz();
    const act = b.dataset.act;
    if (act === "key") {
      const mods = (b.dataset.mods || "").split(",").filter(Boolean);
      send({ t: "key", keyCode: parseInt(b.dataset.key, 10), mods });
    } else if (act === "ctrlc") {
      send({ t: "key", keyCode: 8, mods: ["control"] });
    } else if (act === "phrase") {
      send({ t: "macro", steps: [
        { type: "text", text: b.dataset.text || "" },
        { type: "delay", ms: 120 },
        { type: "key", keyCode: 36, mods: [] }
      ] });
    } else if (act === "launch") {
      let target = b.dataset.target || "";
      if (b.dataset.vaultSlot) {
        const key = b.dataset.vaultSlot === "secondary" ? "vaultSecondary" : "vaultPrimary";
        const vault = String(settings[key] || "").trim();
        target = vault ? "obsidian://open?vault=" + encodeURIComponent(vault) : "obsidian://open";
      }
      send({ t: "launch", target });
    } else if (act === "window") {
      send({ t: "window", dir: b.dataset.dir || "next" });   // AX 직접 창 전환(키 입력 없음)
    } else if (act === "capmenu") {
      openCaptureMenu();
    }
  }
  document.querySelectorAll("#panel-agent .agent-btn, #quickbar button, #quickbar2 button").forEach((b) => {
    b.addEventListener("click", () => runQuickAction(b));
  });

  // ═════════ 빠른 지시 — 일반적인 에이전트 작업 흐름 기본값 + 사용자 편집 ═════════
  const QP_DEFAULT = [
    "진행해", "현재 상태는?",
    "응 해줘", "커밋하고 푸시해줘",
    "지금까지 진행상황 요약해줘", "배포해줘",
    "/compact", "/clear",
  ];
  let quickPhrases = (() => {
    try {
      const v = JSON.parse(localStorage.getItem("quickPhrases.v1"));
      return Array.isArray(v) && v.length ? v : QP_DEFAULT.slice();
    } catch (e) { return QP_DEFAULT.slice(); }
  })();
  function renderQuickPhrases() {
    const box = document.getElementById("quick-phrases");
    if (!box) return;
    box.innerHTML = "";
    quickPhrases.forEach((text) => {
      const b = document.createElement("button");
      b.className = "agent-btn ph";
      b.dataset.act = "phrase"; b.dataset.text = text;
      b.textContent = text.length > 14 ? text.slice(0, 13) + "…" : text;
      b.title = text;
      b.addEventListener("click", () => { buzz(); runQuickAction(b); });
      box.appendChild(b);
    });
  }
  renderQuickPhrases();
  document.getElementById("qp-edit")?.addEventListener("click", () => {
    buzz();
    modalRoot.innerHTML =
      '<div class="modal-bg"></div><div class="modal-card">' +
      '<div class="modal-head"><div class="modal-title">빠른 지시 편집</div><button id="qp-close" class="modal-x">✕</button></div>' +
      '<div class="ed-label">한 줄에 하나 — 버튼을 누르면 그대로 타이핑 후 ⏎ 전송됩니다</div>' +
      '<textarea id="qp-text" class="ed-input" style="min-height:180px"></textarea>' +
      '<div class="modal-actions">' +
        '<button id="qp-save" class="primary">저장</button>' +
        '<button id="qp-reset">기본값 복원</button>' +
      '</div></div>';
    const ta = document.getElementById("qp-text");
    ta.value = quickPhrases.join("\n");
    const close = () => { modalRoot.innerHTML = ""; };
    document.getElementById("qp-close").addEventListener("click", close);
    modalRoot.querySelector(".modal-bg").addEventListener("click", close);
    document.getElementById("qp-reset").addEventListener("click", () => {
      ta.value = QP_DEFAULT.join("\n");
    });
    document.getElementById("qp-save").addEventListener("click", () => {
      const list = ta.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 16);
      if (list.length) {
        quickPhrases = list;
        try { localStorage.setItem("quickPhrases.v1", JSON.stringify(list)); } catch (e) {}
        renderQuickPhrases();
      }
      close(); toast("빠른 지시 " + list.length + "개 저장됨");
    });
  });

  // ═════════ 캡처 메뉴 (양방향) ═════════
  // ① 맥에서 영역 캡처(⇧⌘4)  ② 맥 화면을 폰으로 가져오기  ③ 폰 카메라 → OCR → 맥 클립보드
  function openCaptureMenu() {
    modalRoot.innerHTML =
      '<div class="modal-bg"></div><div class="modal-card">' +
      '<div class="modal-head"><div class="modal-title">캡처</div><button id="cap-close" class="modal-x">✕</button></div>' +
      '<div class="cap-actions">' +
        '<button id="cap-region">✂️ 맥에서 영역 캡처<span>⇧⌘4 — 맥 화면에서 드래그로 영역 선택</span></button>' +
        '<button id="cap-fetch">🖥 맥 화면 가져오기<span>지금 맥 화면을 폰으로 (길게 눌러 저장)</span></button>' +
        '<button id="cap-ocr">📷 카메라 텍스트 스캔<span>촬영 → 문자인식(OCR) → 맥 클립보드로</span></button>' +
      '</div>' +
      '<div id="cap-result" class="cap-result"></div>' +
      '</div>';
    const close = () => { modalRoot.innerHTML = ""; };
    modalRoot.querySelector(".modal-bg").addEventListener("click", close);
    modalRoot.querySelector("#cap-close").addEventListener("click", close);
    modalRoot.querySelector("#cap-region").addEventListener("click", () => {
      buzz(); send({ t: "key", keyCode: 21, mods: ["command", "shift"] }); close();
    });
    modalRoot.querySelector("#cap-fetch").addEventListener("click", () => {
      buzz();
      document.getElementById("cap-result").innerHTML = '<div class="cap-note">맥 화면 가져오는 중…</div>';
      send({ t: "capture" });
    });
    modalRoot.querySelector("#cap-ocr").addEventListener("click", () => {
      buzz();
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*"; inp.capture = "environment";
      inp.addEventListener("change", async () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        const box = document.getElementById("cap-result");
        if (box) box.innerHTML = '<div class="cap-note">텍스트 인식 중…</div>';
        try {
          const b64 = await imageFileToJpegBase64(file, 1600);
          send({ t: "ocr", text: b64 });
        } catch (e) {
          if (box) box.innerHTML = '<div class="cap-note">이미지 처리 실패</div>';
        }
      });
      inp.click();
    });
  }
  /// 카메라 원본(수 MB)을 그대로 보내지 않도록 긴 변 maxDim 으로 축소 후 JPEG base64 로.
  async function imageFileToJpegBase64(file, maxDim) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
  }

  // 키보드 탭: 타이핑 박스 하단 빠른 전송 버튼 (⏎ 크게 + esc/⌫/⇥)
  document.querySelectorAll(".kb-quick .kbq").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      buzz();
      send({ t: "key", keyCode: parseInt(btn.dataset.key, 10), mods: activeMods.slice() });
    });
  });

  // ═════════ 화면 미러 (맥 화면 실시간 + 탭→클릭) ═════════
  const mirror = {
    canvas: null, ctx: null, dispW: 0, dispH: 0, pending: null,
    decoding: false, active: false, display: null, generation: 0,
  };
  // 미러 로컬 뷰(맥에 안 보냄 — 캔버스 CSS transform 전용). scale 1~5, tx/ty px.
  const mirrorView = { scale: 1, tx: 0, ty: 0 };
  const MIRROR_ZOOM_MAX = 5;
  function applyMirrorView() {
    if (!mirror.canvas) return;
    const v = mirrorView;
    mirror.canvas.style.transform = "translate(" + v.tx + "px," + v.ty + "px) scale(" + v.scale + ")";
  }
  function resetMirrorView() { mirrorView.scale = 1; mirrorView.tx = 0; mirrorView.ty = 0; applyMirrorView(); }
  // 빈 여백 방지: 확대된 캔버스(offsetWidth×scale = 실제 시각 폭)가 스테이지를 덮도록 tx/ty 클램프.
  function clampMirrorPan() {
    const v = mirrorView;
    if (v.scale <= 1) { v.tx = 0; v.ty = 0; return; }
    const stage = document.getElementById("mirror-stage");
    if (!stage || !mirror.canvas) return;
    const bw = mirror.canvas.offsetWidth * v.scale, bh = mirror.canvas.offsetHeight * v.scale;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const maxX = Math.max(0, (bw - sw) / 2), maxY = Math.max(0, (bh - sh) / 2);
    v.tx = Math.max(-maxX, Math.min(maxX, v.tx));
    v.ty = Math.max(-maxY, Math.min(maxY, v.ty));
  }
  // 핀치 midpoint(clientX/Y) 기준 줌. 그 지점 콘텐츠 고정. transform-origin center=스테이지 중심 가정.
  function zoomAt(clientX, clientY, factor, stageRect) {
    const v = mirrorView, s0 = v.scale;
    let s1 = Math.max(1, Math.min(MIRROR_ZOOM_MAX, s0 * factor));
    if (s1 === s0) return;
    const cx = stageRect.left + stageRect.width / 2, cy = stageRect.top + stageRect.height / 2;
    const dX = clientX - cx, dY = clientY - cy;   // midpoint - stageCenter
    const k = s1 / s0;
    v.tx = dX * (1 - k) + k * v.tx;               // = d(1-k) + k·tx₀
    v.ty = dY * (1 - k) + k * v.ty;
    v.scale = s1;
    if (v.scale <= 1.0001) { v.scale = 1; v.tx = 0; v.ty = 0; }   // scale===1 → 리셋
    clampMirrorPan();
    applyMirrorView();
  }
  function mirrorInit() {
    mirror.canvas = document.getElementById("mirror-canvas");
    if (!mirror.canvas || mirror.ctx) return;
    mirror.ctx = mirror.canvas.getContext("2d");
    wireMirrorInput();
    wireMirrorKeys();   // 물리 키보드 → 맥
    const fit = document.getElementById("mirror-fit");
    if (fit) fit.addEventListener("click", () => { resetMirrorView(); toast("원본 크기로 맞춤"); });
  }
  // (D) 미러: 물리 키보드 → 맥으로 (픽셀뷰라 t:text / t:key)
  const EVENT_KEYCODE = {
    Enter: 36, Tab: 48, Escape: 53, Backspace: 51, Delete: 117, " ": 49,
    ArrowLeft: 123, ArrowRight: 124, ArrowUp: 126, ArrowDown: 125,
    Home: 115, End: 119, PageUp: 116, PageDown: 121
  };
  function macKeyCodeForEvent(e) {
    if (EVENT_KEYCODE[e.key] !== undefined) return EVENT_KEYCODE[e.key];
    if ((e.metaKey || e.ctrlKey || e.altKey) && e.key.length === 1) return keyCodeForChar(e.key);
    return null;
  }
  // (D) 미러 키보드: 텍스트는 항상 진짜 input 으로 → OS IME 조합 → 완성형만 t:text.
  //     제어·조합키(Enter/Tab/Esc/방향/Backspace/⌘⌃⌥+문자)만 keydown 에서 t:key.
  function wireMirrorKeys() {
    const inp = document.getElementById("mirror-input");
    if (!inp || inp.__keysWired) return; inp.__keysWired = true;
    let composing = false;
    const flushBox = () => { if (inp.value) { send({ t: "text", text: inp.value }); inp.value = ""; } };
    inp.addEventListener("compositionstart", () => { composing = true; });
    inp.addEventListener("compositionupdate", () => { composing = true; });
    inp.addEventListener("compositionend", () => { composing = false; flushBox(); });   // 완성형만
    inp.addEventListener("input", (e) => {
      if (composing || e.isComposing) return;                              // 조합 중 절대 전송 안 함
      if (e.inputType && e.inputType.indexOf("Composition") >= 0) return;  // insertCompositionText 누수 차단
      flushBox();                                                          // 영문/숫자/붙여넣기 = 즉시
    });
    inp.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;   // 조합 중 keydown 무시(자소분리 원천 차단)
      const mods = [];
      if (e.metaKey) mods.push("command");
      if (e.ctrlKey) mods.push("control");
      if (e.altKey) mods.push("option");
      if (e.shiftKey) mods.push("shift");
      const kc = macKeyCodeForEvent(e);   // 특수키·조합키만 keyCode, 평문자는 null
      if (kc !== null && kc !== undefined) { e.preventDefault(); send({ t: "key", keyCode: kc, mods }); }
      // 평문자는 여기서 처리 안 함 → input/compositionend 가 완성형으로 전송
    });
  }
  // ⌨ 토글: iPhone 처럼 소프트키보드가 미러를 가릴 때 입력 포커스를 켜고/끈다.
  (function wireMirrorKbdToggle() {
    const btn = document.getElementById("mirror-kbd");
    const inp = document.getElementById("mirror-input");
    if (!btn || !inp) return;
    btn.addEventListener("click", () => {
      buzz();
      if (document.activeElement === inp) inp.blur();
      else inp.focus();   // 사용자 제스처 안 → iOS 소프트키보드 상승 허용
    });
    inp.addEventListener("focus", () => btn.classList.add("on"));
    inp.addEventListener("blur", () => btn.classList.remove("on"));
  })();
  function onMirrorFrame(buf) {
    // 8바이트 헤더 스킵 → JPEG 바이트만. 항상 최신만 보관 → 밀린 프레임 자연 폐기
    mirror.pending = new Blob([new Uint8Array(buf, 8)], { type: "image/jpeg" });
    if (!mirror.decoding) drainMirror();
  }
  async function drainMirror() {
    mirror.decoding = true;
    while (mirror.pending) {
      const blob = mirror.pending; mirror.pending = null;
      const generation = mirror.generation;
      try {
        const bmp = await createImageBitmap(blob);      // 오프-메인 디코드
        if (generation !== mirror.generation) { bmp.close(); continue; }
        if (mirror.canvas.width !== bmp.width) { mirror.canvas.width = bmp.width; mirror.canvas.height = bmp.height; }
        mirror.ctx.drawImage(bmp, 0, 0);
        bmp.close();
      } catch (e) {}
    }
    mirror.decoding = false;
  }
  const MIRROR_TIERS = [
    { maxRtt: 12, w: 1400, fps: 15, q: 0.62 },
    { maxRtt: 30, w: 1100, fps: 12, q: 0.55 },
    { maxRtt: 60, w: 900, fps: 10, q: 0.50 },
    { maxRtt: Infinity, w: 720, fps: 8, q: 0.45 },
  ];
  function pickMirrorTier() {
    const rtt = latencyMs || 20;
    return MIRROR_TIERS.find((t) => rtt <= t.maxRtt) || MIRROR_TIERS[MIRROR_TIERS.length - 1];
  }
  // 설정 '미러 화질' override — auto(RTT 자동 티어) / high(고화질) / max(원본급, Swift clamp 4096)
  const MIRROR_QUALITY = {
    high: { w: 2560, fps: 24, q: 0.75 },
    max:  { w: 3840, fps: 30, q: 0.90 },
  };
  function mirrorConfig() { return MIRROR_QUALITY[settings.mirrorQuality] || pickMirrorTier(); }
  function startMirror() {
    mirror.active = true;
    const cfg = mirrorConfig();
    send({ t: "mirror", action: "config", w: cfg.w, fps: cfg.fps, q: cfg.q });
    send({ t: "mirror", action: "start", display: mirror.display });
    send({ t: "mirror", action: "displays" });   // 모니터 목록 요청
    const ms = document.getElementById("mirror-status"); if (ms) ms.textContent = "연결 중…";
  }
  function stopMirror() { if (!mirror.active) return; mirror.active = false; send({ t: "mirror", action: "stop" }); }
  function renderMonitorTabs(displays) {
    const bar = document.getElementById("mirror-monitors");
    if (!bar) return;
    bar.innerHTML = "";
    if (displays.length <= 1) return;   // 모니터 1개면 탭 숨김
    displays.forEach((d) => {
      const b = document.createElement("button");
      b.className = "mon-tab" + (d.current ? " on" : "");
      b.textContent = d.name.replace(/\s*\(.*\)$/, "");   // 이름만(해상도 생략)
      b.addEventListener("click", () => {
        buzz();
        mirror.display = d.id;
        send({ t: "mirror", action: "select", display: d.id });
        bar.querySelectorAll(".mon-tab").forEach((x) => x.classList.toggle("on", x === b));
      });
      bar.appendChild(b);
    });
  }

  // 미러 화면 탭 → 절대 클릭. object-fit: contain 레터박스 제외하고 정규화(0..1).
  function normFromTouch(clientX, clientY) {
    const el = mirror.canvas, r = el.getBoundingClientRect();
    if (!el.width || !r.width) return null;
    const srcAR = el.width / el.height, boxAR = r.width / r.height;
    let cw = r.width, ch = r.height, ox = 0, oy = 0;
    if (srcAR > boxAR) { ch = r.width / srcAR; oy = (r.height - ch) / 2; }
    else { cw = r.height * srcAR; ox = (r.width - cw) / 2; }
    const x = clientX - r.left - ox, y = clientY - r.top - oy;
    if (x < 0 || y < 0 || x > cw || y > ch) return null;   // 레터박스 여백 무시
    return { nx: x / cw, ny: y / ch };
  }
  function wireMirrorInput() {
    const el = mirror.canvas;
    let mDown = null, mMoved = false, mLong = null, cursorDragging = false;   // 1핑거 커서/탭
    let mPanLast = null;                                                       // 1핑거 뷰 팬(줌 상태)
    let two = null;                                                            // 2핑거 (pinch=줌 / pan=뷰팬 or mscroll)
    let mThree = false, mGFired = false, mGStart = null, mGLast = null, mGFingers = 3, mGStartTime = 0;   // 3·4핑거 제스처(로컬)

    function cancelCursor() {                 // 2·3핑거 진입 시 1핑거 커서/드래그 취소(sticky)
      clearTimeout(mLong);
      if (cursorDragging) { send({ t: "mup" }); cursorDragging = false; }
      mDown = null; mMoved = false; mPanLast = null;
    }
    function mFireSwipe() {
      if (mGFired || !mGStart || !mGLast) return;
      const dx = mGLast.x - mGStart.x, dy = mGLast.y - mGStart.y;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < SWIPE3_THRESH) return;
      const dir = adx > ady ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
      fireGesture(mGFingers, dir);            // 트랙패드와 공유 헬퍼(런타임 참조 → hoisting OK)
      mGFired = true;
    }
    function resetMirrorGesture() { mThree = false; mGFired = false; mGStart = null; mGLast = null; mGFingers = 3; }

    el.addEventListener("touchstart", (e) => {
      const inp = document.getElementById("mirror-input"); if (inp && HW.present) inp.focus();
      const n = e.touches.length;
      if (n >= 3) {                            // 3·4핑거 제스처 (커서/2핑거 취소)
        cancelCursor(); two = null;
        if (!mThree) { mThree = true; mGFired = false; mGFingers = n; }
        else { mGFingers = Math.max(mGFingers, n); }   // 3→4 승격
        mGStart = centroid(e.touches); mGLast = mGStart;   // 손가락 추가마다 재기준
        mGStartTime = now();
        return;
      }
      if (n === 2) {                           // 2핑거 (커서 취소 후 pinch/pan 판정 대기)
        cancelCursor(); mThree = false;
        const c = centroid(e.touches), d = dist2(e.touches);
        two = { mode: null, d0: d, c0: c, lastDist: d, lastCentroid: c,
                startN: normFromTouch(e.touches[0].clientX, e.touches[0].clientY) };
        return;
      }
      const t = e.touches[0];                  // n === 1
      if (mirrorView.scale > 1) {              // 줌 상태: 드래그=팬, 탭=클릭
        mPanLast = { x: t.clientX, y: t.clientY };
        mDown = normFromTouch(t.clientX, t.clientY);
        mMoved = false;
        return;
      }
      const nrm = normFromTouch(t.clientX, t.clientY);  // scale===1: 기존 커서
      if (!nrm) return;
      mDown = nrm; mMoved = false; cursorDragging = false;
      mLong = setTimeout(() => {               // 길게 = 우클릭 (scale===1 한정)
        send({ t: "mtap", nx: mDown.nx, ny: mDown.ny, button: "right", count: 1 });
        mDown = null; buzz();
      }, 500);
    }, { passive: true });

    el.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const len = e.touches.length;
      if (mThree) {
        if (len >= 3) {
          const c = centroid(e.touches);
          if (now() - mGStartTime < SWIPE3_SETTLE) mGStart = c;   // 착지 정착 창(오발화 방지)
          mGLast = c;
          mFireSwipe();
        }
        return;
      }
      if (len === 2 && two) {
        const c = centroid(e.touches), d = dist2(e.touches);
        if (two.mode === null) {               // pinch vs pan 판정
          const distChange = Math.abs(d - two.d0);
          const transChange = two.c0 ? Math.hypot(c.x - two.c0.x, c.y - two.c0.y) : 0;
          if (Math.max(distChange, transChange) > PINCH_DECIDE) {
            two.mode = distChange > transChange ? "pinch" : "pan";
            if (two.mode === "pinch") two.lastDist = d;   // 판정 순간 기준거리 리셋(시작 점프 제거)
          }
        }
        if (two.mode === "pinch") {
          const stage = document.getElementById("mirror-stage"), sr = stage.getBoundingClientRect();
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          zoomAt(midX, midY, d / two.lastDist, sr);
          two.lastDist = d;
        } else if (two.mode === "pan") {
          const dx = c.x - two.lastCentroid.x, dy = c.y - two.lastCentroid.y;
          if (mirrorView.scale > 1) { mirrorView.tx += dx; mirrorView.ty += dy; clampMirrorPan(); applyMirrorView(); }
          else if (two.startN) send({ t: "mscroll", nx: two.startN.nx, ny: two.startN.ny, dx: 0, dy: dy });
        }
        two.lastCentroid = c;
        return;
      }
      if (len === 1) {
        const t = e.touches[0];
        if (mirrorView.scale > 1 && mPanLast) {   // 줌 상태 1핑거 = 뷰 팬
          const dx = t.clientX - mPanLast.x, dy = t.clientY - mPanLast.y;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) mMoved = true;
          mirrorView.tx += dx; mirrorView.ty += dy; clampMirrorPan(); applyMirrorView();
          mPanLast = { x: t.clientX, y: t.clientY };
          return;
        }
        if (!mDown) return;                       // scale===1 커서 이동
        const nrm = normFromTouch(t.clientX, t.clientY);
        if (!nrm) return;
        clearTimeout(mLong);
        if (!cursorDragging) { send({ t: "mdown", nx: mDown.nx, ny: mDown.ny, button: "left" }); cursorDragging = true; mMoved = true; }
        send({ t: "mmove", nx: nrm.nx, ny: nrm.ny });
      }
    }, { passive: false });

    el.addEventListener("touchend", (e) => {
      const remaining = e.touches.length;
      if (mThree) { mFireSwipe(); if (remaining === 0) resetMirrorGesture(); return; }
      if (remaining >= 1) {                        // 손가락 하나 뗐지만 남음: 2핑거 종료·클릭 억제
        if (remaining === 1) {
          two = null;
          const t = e.touches[0];
          if (mirrorView.scale > 1) mPanLast = { x: t.clientX, y: t.clientY };
        }
        return;
      }
      clearTimeout(mLong);                         // remaining === 0
      if (cursorDragging) { send({ t: "mup" }); cursorDragging = false; }
      else if (mDown && !mMoved) send({ t: "mtap", nx: mDown.nx, ny: mDown.ny, button: "left", count: 1 });
      mDown = null; mMoved = false; mPanLast = null; two = null;
    }, { passive: false });

    el.addEventListener("touchcancel", () => {
      clearTimeout(mLong);
      if (cursorDragging) { send({ t: "mup" }); cursorDragging = false; }
      if (mThree) mFireSwipe();
      mDown = null; mMoved = false; mPanLast = null; two = null; resetMirrorGesture();
    }, { passive: false });
  }

  // ═════════ cmux 터미널 뷰 (포커스된 터미널 화면 텍스트 + 입력) ═════════
  const term = { active: false, poll: null, lastSig: "" };
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  /// 렌더 그리드 → {html, bg} — 터미널 탭과 세션 시트가 공유하는 컬러 렌더러.
  function gridToHTML(g) {
    const styles = {};
    (g.styles || []).forEach((s) => { styles[s.id] = s; });
    const rows = g.rows || 24;
    const byRow = {};
    (g.row_spans || []).forEach((sp) => { (byRow[sp.row] = byRow[sp.row] || []).push(sp); });
    let html = "";
    for (let r = 0; r < rows; r++) {
      const spans = (byRow[r] || []).sort((a, b) => a.column - b.column);
      let line = "", col = 0;
      for (const sp of spans) {
        if (sp.column > col) line += " ".repeat(sp.column - col);
        const st = styles[sp.style_id] || {};
        let css = "";
        if (st.foreground) css += "color:" + st.foreground + ";";
        if (st.background && st.id !== 0) css += "background:" + st.background + ";";
        if (st.bold) css += "font-weight:700;";
        if (st.italic) css += "font-style:italic;";
        if (st.faint) css += "opacity:.6;";
        if (st.inverse) css += "filter:invert(1);";
        line += css ? '<span style="' + css + '">' + esc(sp.text) + "</span>" : esc(sp.text);
        col = sp.column + (sp.cell_width || sp.text.length);
      }
      html += "<div class='tline'>" + (line || "&nbsp;") + "</div>";
    }
    return { html, bg: (styles[0] && styles[0].background) || "#1a1c23" };
  }

  function renderTermGrid(g) {
    const screen = document.getElementById("term-screen");
    if (!screen) return;
    const out = gridToHTML(g);
    screen.style.background = out.bg;
    screen.innerHTML = out.html;
    screen.scrollTop = screen.scrollHeight;   // 항상 최신 줄로
  }
  function requestTermGrid() { send({ t: "cterm", backend: currentBackend, action: "grid" }); }
  function startTermPoll() {
    stopTermPoll(); term.active = true;
    requestTermGrid();
    term.poll = setInterval(() => { if (document.visibilityState === "visible") requestTermGrid(); }, 700);
  }
  function stopTermPoll() { if (term.poll) clearInterval(term.poll); term.poll = null; term.active = false; }
  function termInput(textSeq) { if (textSeq) send({ t: "cterm", backend: currentBackend, action: "input", text: textSeq }); }
  function refreshTermSoon() { setTimeout(requestTermGrid, 120); }
  // keydown → 터미널 입력 시퀀스 (물리 키보드·특수키 공용)
  function termSeqForKey(e) {
    const k = e.key;
    if (e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) {   // Ctrl+문자 → 제어코드 0x01~0x1a
      const c = k.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
      if (k === "[") return "\x1b"; if (k === "\\") return "\x1c"; if (k === "]") return "\x1d";
    }
    switch (k) {
      case "Enter": return "\r";
      case "Backspace": return "\x7f";
      case "Tab": return "\t";
      case "Escape": return "\x1b";
      case "ArrowUp": return "\x1b[A";
      case "ArrowDown": return "\x1b[B";
      case "ArrowRight": return "\x1b[C";
      case "ArrowLeft": return "\x1b[D";
      case "Home": return "\x1b[H";
      case "End": return "\x1b[F";
      case "Delete": return "\x1b[3~";
      case "PageUp": return "\x1b[5~";
      case "PageDown": return "\x1b[6~";
    }
    if (e.altKey && k.length === 1 && !e.metaKey && !e.ctrlKey) return "\x1b" + k;   // Alt+문자
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return k;           // 일반 문자
    return null;
  }
  function focusTermTarget() {
    const inp = document.getElementById("term-input");
    if (inp) inp.focus();   // 물리 키보드여도 텍스트는 조합 가능한 input 으로만
  }
  function wireTerm() {
    if (term.wired) return; term.wired = true;
    const scr = document.getElementById("term-screen");
    const inp = document.getElementById("term-input");
    // 라인 입력 모델: 입력창에 텍스트를 '보이게' 쌓아두고(IME 완성형 그대로) ⏎ 로 한 줄을 전송.
    //  → (1) 글자가 보임 (2) 한 줄 1회 전송이라 문자별 딜레이 없음 (3) IME 조합이 입력창에서 끝나 자소분리 없음.
    function sendLine() {
      termInput(inp.value + "\r");   // 현재 줄 + 개행 (빈 줄이면 개행만)
      inp.value = "";
      refreshTermSoon();
    }
    // term-bar 버튼: ⏎ = 라인 전송, 나머지(esc·tab·⌃C·↑·↓) = raw 제어 즉시 전송.
    document.querySelectorAll("#panel-term .term-key").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.preventDefault(); buzz();
        if (b.dataset.seq === "\r") sendLine();
        else { termInput(b.dataset.seq); refreshTermSoon(); }
        inp.focus();
      });
    });
    // Enter(물리/소프트) = 라인 전송. Esc/Tab/Ctrl·Alt 조합 = raw 제어. 일반 문자·편집키는 입력창에 남긴다.
    inp.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;     // 한글 조합 중엔 개입 X
      if (e.key === "Enter") { e.preventDefault(); sendLine(); return; }
      const raw = (e.ctrlKey && !e.metaKey) || (e.altKey && !e.metaKey) || e.key === "Escape" || e.key === "Tab";
      if (!raw) return;                                   // 일반 문자·Backspace·방향키 = 입력창 편집(통과)
      const seq = termSeqForKey(e);
      if (seq == null) return;
      e.preventDefault(); termInput(seq); refreshTermSoon();
    });
    scr.addEventListener("click", () => inp.focus());
  }

  // ═════════ cmux 원격 (창 / 워크스페이스 / 탭 전환) ═════════
  // 동기화 모델: 요청 시 스냅샷 + 에이전트 탭이 보이는 동안 4초 폴링(변경 없으면 리렌더 생략).
  let cmuxState = null, cmuxPoll = null, lastCmuxJSON = "";
  let currentBackend = "cmux";   // 멀티플렉서 백엔드 (cmux 로컬 / herdr 원격 …)
  // cmux 탭은 cmux 전용(백엔드 스위처 없음). 터미널 탭만 currentBackend 로 cmux/herdr 을 고른다.
  function requestCmux(verb, target) { send({ t: "cmux", backend: "cmux", dir: verb || "state", target: target || "" }); }
  // 터미널 탭 백엔드 전환 (term-switch 칩 / herdr 탭의 '터미널 보기'가 호출).
  function setBackend(id) {
    if (!id) return;
    currentBackend = id;
    const scr = document.getElementById("term-screen");
    if (scr) scr.innerHTML = "";             // 백엔드 전환 → 터미널 뷰 초기화
    document.querySelectorAll("#term-switch button").forEach((b) => b.classList.toggle("on", b.dataset.tbk === id));
    if (term.active) requestTermGrid();
  }
  // 카드 워크스페이스 사이드바 필 조회 — list-status가 ws당 ~0.4s라 20초 스로틀 + 카드 ws만
  let wsStatuses = {}, lastStatusesJSON = "", lastStatusReq = 0;
  function requestStatuses() {
    if (Date.now() - lastStatusReq < 20000) return;
    const ids = [...new Set(sessAttention().map((c) => c.ws).filter(Boolean))].slice(0, 6);
    if (!ids.length) return;
    lastStatusReq = Date.now();
    send({ t: "cmux", backend: "cmux", dir: "statuses", target: ids.join(",") });
  }
  function startCmuxPoll() {
    stopCmuxPoll();
    requestCmux(); requestOmni();
    cmuxPoll = setInterval(() => {
      if (document.visibilityState === "visible") { requestCmux(); requestOmni(); requestStatuses(); }
    }, 4000);
  }
  function stopCmuxPoll() { if (cmuxPoll) clearInterval(cmuxPoll); cmuxPoll = null; }
  function cmuxChip(label, on, color, handler) {
    const b = document.createElement("button");
    b.className = "cmux-chip" + (on ? " on" : "");
    if (color && !on) b.style.borderColor = color;
    b.textContent = label;
    b.addEventListener("click", () => { buzz(); handler(); });
    return b;
  }
  // ⑤ 에이전트 알림 ("지금 나를 기다리는 세션") — cmux notifications[] 렌더.
  const NOTIF_LABEL = { waiting: "대기", permission: "승인", completed: "완료", other: "" };
  function relTime(iso) {
    const t = Date.parse(iso || ""); if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "방금"; if (s < 3600) return Math.floor(s / 60) + "분 전";
    if (s < 86400) return Math.floor(s / 3600) + "시간 전"; return Math.floor(s / 86400) + "일 전";
  }
  function cmuxNotifRow(n) {
    const row = document.createElement("button");
    row.className = "notif-row cat-" + (n.cat || "other") + (n.read ? "" : " unread");
    const dot = document.createElement("span"); dot.className = "notif-dot";
    const main = document.createElement("span"); main.className = "notif-main";
    const ws = document.createElement("span"); ws.className = "notif-ws"; ws.textContent = n.wsTitle || "세션";
    const cat = document.createElement("span"); cat.className = "notif-cat st-" + (n.cat || "other");
    cat.textContent = NOTIF_LABEL[n.cat] || "";
    main.appendChild(ws); main.appendChild(cat);
    const time = document.createElement("span"); time.className = "notif-time"; time.textContent = relTime(n.ts);
    row.appendChild(dot); row.appendChild(main); row.appendChild(time);
    // 탭 → 그 세션으로 포커스 + cmux 알림 읽음처리(open-notification) → 다음 폴에서 목록에서 빠짐.
    row.addEventListener("click", () => { buzz(); requestCmux("open-notif", n.id); });
    return row;
  }
  function renderCmux() {
    const root = document.getElementById("cmux-remote");
    if (!root) return;
    if (uiQuiet()) { lastCmuxJSON = ""; return; }   // 조작 중 정지 — 끝나면 다음 폴에서 갱신
    if (!cmuxState) { root.innerHTML = '<div class="cmux-empty">에이전트 상태 불러오는 중…</div>'; return; }
    if (cmuxState.available === false) {
      root.innerHTML = '<div class="cmux-empty">' + (cmuxState.backend || "백엔드") + '가 설치/설정되어 있지 않습니다</div>'; return;
    }
    if (cmuxState.denied) {
      const msg = cmuxState.backend === "herdr"
        ? 'herdr에 연결할 수 없습니다 — 원격에 herdr가 떠 있는지·SSH 연결을 확인하세요 (↻ 재시도)'
        : 'cmux 소켓 권한 대기 중 — cmux를 한 번 재시작하면 활성화됩니다 (↻로 재확인)';
      root.innerHTML = '<div class="cmux-empty">' + msg + '</div>'; return;
    }
    root.innerHTML = "";
    const notifs = cmuxState.notifications || [];
    if (notifs.length) {
      const lbl = document.createElement("div");
      lbl.className = "cmux-sub notif-head";
      lbl.textContent = "⏳ 나를 기다리는 세션 (" + notifs.length + ")";
      root.appendChild(lbl);
      const list = document.createElement("div");
      list.className = "notif-list";
      notifs.forEach((n) => list.appendChild(cmuxNotifRow(n)));
      root.appendChild(list);
    }
    (cmuxState.windows || []).forEach((win) => {
      const row = document.createElement("div");
      row.className = "cmux-row";
      const wbtn = cmuxChip("창 " + ((win.index || 0) + 1), !!win.key, "", () => requestCmux("focus-window", win.id));
      wbtn.classList.add("win");
      row.appendChild(wbtn);
      const wrap = document.createElement("div");
      wrap.className = "cmux-chips";
      (win.workspaces || []).forEach((ws) => {
        wrap.appendChild(cmuxChip(ws.title || "(무제)", !!ws.selected, ws.color || "", () => requestCmux("select-workspace", ws.id)));
      });
      row.appendChild(wrap);
      root.appendChild(row);
    });
    if (cmuxState.tabs && cmuxState.tabs.length) {
      const lbl = document.createElement("div");
      lbl.className = "cmux-sub";
      lbl.textContent = "탭 · 에이전트 (현재 워크스페이스)";
      root.appendChild(lbl);
      const wrap = document.createElement("div");
      wrap.className = "cmux-chips";
      cmuxState.tabs.forEach((tb) => {
        const chip = cmuxChip(tb.title || "터미널", !!tb.focused, "", () => requestCmux("focus-tab", tb.id));
        chip.classList.add("tab");
        if (tb.state) {                       // ⑤ 에이전트 상태 배지 (herdr 등 네이티브 상태)
          chip.classList.add("has-state");
          const dot = document.createElement("span");
          dot.className = "mux-dot st-" + tb.state;
          chip.insertBefore(dot, chip.firstChild);
        }
        wrap.appendChild(chip);
      });
      root.appendChild(wrap);
    }
  }
  document.getElementById("cmux-refresh").addEventListener("click", () => { buzz(); requestCmux(); requestOmni(); });

  // ═════════ 대기 결정 카드 + 세션 상세 시트 ═════════
  // OmniControl pending(요약 headline 보유) + cmux notifications(수신함) + sessions(전체 탭)를
  // 워크스페이스 키로 병합. "지금 나를 기다리는 세션"만 카드로 — 나머지는 아래 칩 UI가 담당.
  let omniState = null, lastOmniJSON = "";
  function requestOmni() { send({ t: "omni" }); }

  /// cmux sessions[]에서 워크스페이스/탭 제목·색·그룹 룩업을 만든다 — 카드의 세션 구분 정보원.
  function sessLookups() {
    const wsTitle = new Map(), tabTitle = new Map(), wsColor = new Map(), wsGroup = new Map();
    ((cmuxState && cmuxState.sessions) || []).forEach((w) => {
      if (w.id) {
        wsTitle.set(w.id, w.title || "");
        if (w.color) wsColor.set(w.id, w.color);
        if (w.group) wsGroup.set(w.id, w.group);
      }
      (w.terminals || []).forEach((t) => { if (t.id) tabTitle.set(t.id, t.title || ""); });
    });
    // windows[].workspaces[]에도 색이 있다 — sessions에 색이 비면 폴백.
    ((cmuxState && cmuxState.windows) || []).forEach((win) => {
      (win.workspaces || []).forEach((ws) => {
        if (ws.id && ws.color && !wsColor.has(ws.id)) wsColor.set(ws.id, ws.color);
      });
    });
    return { wsTitle, tabTitle, wsColor, wsGroup };
  }

  /// SF Symbol 이름 → 이모지 근사 (필 아이콘 렌더용, 모르면 ●)
  function pillIcon(sf) {
    if (!sf) return "●";
    if (sf.startsWith("questionmark")) return "💬";
    if (sf.startsWith("exclamationmark")) return "⚠️";
    if (sf.startsWith("bolt")) return "⚡";
    if (sf.startsWith("calendar")) return "📅";
    if (sf.startsWith("checkmark")) return "✓";
    if (sf.startsWith("moon") || sf.startsWith("zzz")) return "💤";
    return "●";
  }

  /// 카드 목록 계산 — 오래 기다린 세션이 위 (결정 부채가 큰 순).
  /// 키는 surface(탭) 우선 — 같은 워크스페이스의 다른 탭 세션들을 각각의 카드로 구분한다.
  function sessAttention() {
    const cards = new Map();   // surface || ws || session → card
    const keyOf = (surface, ws, sid) => surface || ws || ("sess:" + sid);
    const notifs = (cmuxState && cmuxState.notifications) || [];
    notifs.forEach((n) => {
      if (n.cat !== "waiting" && n.cat !== "permission") return;
      const key = keyOf(n.surface, n.ws, n.id);
      if (cards.has(key)) return;   // CLI가 최신순 → 첫 항목이 대표
      cards.set(key, {
        ws: n.ws || "", surface: n.surface || "", title: n.wsTitle || "세션",
        cat: n.cat, headline: n.body || "", ts: Date.parse(n.ts) / 1000 || 0,
      });
    });
    const pending = (omniState && omniState.available && omniState.state
                     && omniState.state.pending) || [];
    pending.forEach((p) => {
      const key = keyOf(p.surface, p.workspace, p.session);
      const prev = cards.get(key);
      if (prev) {   // omni 요약이 있으면 headline을 더 좋은 것으로 교체
        if (p.headline) prev.headline = p.headline;
        if (p.ts) prev.ts = Math.min(prev.ts || p.ts, p.ts);
        prev.label = p.label; prev.cwd = p.cwd || "";
        prev.decisions = p.decisions || [];
        if (!prev.surface && p.surface) prev.surface = p.surface;
      } else {
        cards.set(key, {
          ws: p.workspace || "", surface: p.surface || "", title: p.label || "세션",
          cat: "waiting", headline: p.headline || "", ts: p.ts || 0,
          label: p.label, cwd: p.cwd || "", decisions: p.decisions || [],
        });
      }
    });
    return [...cards.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));   // 최신이 맨 위
  }

  // ── 세션 캐시: 같은 탭 새로고침 직후 마지막 상태로 그리기(stale-while-revalidate) ──
  // 카드·세션 화면·작성 중 프롬프트는 민감할 수 있으므로 sessionStorage에만 보존한다.
  // 브라우저/PWA 세션을 닫으면 사라지고, 켜진 동안에는 라이브 데이터가 캐시를 교체한다.
  const CACHE_KEY = "omniCache.v1";
  // 이전 버전이 장기 저장한 민감 캐시는 업데이트 시 1회 제거한다.
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem("srchRecent.v1");
  } catch (e) {}
  let omniCache = (() => {
    try { return JSON.parse(sessionStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; }
  })();
  let cacheDirty = false, lastLiveAt = 0;
  function saveCacheSoon() { cacheDirty = true; }
  setInterval(() => {
    if (!cacheDirty) return;
    cacheDirty = false;
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(omniCache)); }
    catch (e) { omniCache.screens = {}; }   // 용량 초과 시 화면 캐시부터 비움
  }, 3000);

  function clearSensitiveSessionData() {
    sensitiveAuthorized = false; omniCache = {}; cacheDirty = false; lastLiveAt = 0;
    try {
      sessionStorage.removeItem(CACHE_KEY);
      sessionStorage.removeItem("srchRecent.v1");
    } catch (e) {}
    stopCmuxPoll(); stopTermPoll(); stopHerdrPoll();
    fastOmniUntil = 0; resetPttHoldState();
    if (sheetPoll) clearInterval(sheetPoll);
    sheetPoll = null; sheetTarget = null;
    cmuxState = null; omniState = null; herdrState = null; wsStatuses = {};
    lastCmuxJSON = ""; lastOmniJSON = ""; lastHerdrJSON = ""; lastStatusesJSON = "";
    lastStatusReq = 0; lastCardsSig = ""; quietUntil = 0; prefetched.clear();
    srchRecent = [];
    clearTimeout(srchTimer); srchTimer = null;
    srchActiveID = ""; srchView = { mode: "projects", cwd: "" };
    ["sess-cards", "srch-results", "srch-recent", "term-screen",
     "herdr-ws", "herdr-agents"].forEach((id) => {
      const el = document.getElementById(id); if (el) el.replaceChildren();
    });
    if (srchInput) srchInput.value = "";
    const termInput = document.getElementById("term-input"); if (termInput) termInput.value = "";
    const term = document.getElementById("ss-term"); if (term) term.textContent = "";
    const draft = document.getElementById("ss-input"); if (draft) draft.value = "";
    const sheetTitle = document.getElementById("ss-title"); if (sheetTitle) sheetTitle.textContent = "";
    const sheetSub = document.getElementById("ss-sub"); if (sheetSub) sheetSub.textContent = "";
    const sheet = document.getElementById("sess-sheet"); if (sheet) sheet.hidden = true;
    const ptt = document.getElementById("ptt-banner"); if (ptt) ptt.hidden = true;
    const pttText = document.getElementById("pb-text"); if (pttText) pttText.textContent = "";
    const pttSessions = document.getElementById("pb-sessions"); if (pttSessions) pttSessions.replaceChildren();
    const pttSend = document.getElementById("pb-send"); if (pttSend) pttSend.onclick = null;
    const pttCancel = document.getElementById("pb-cancel"); if (pttCancel) pttCancel.onclick = null;
    const voice = document.getElementById("voice-pill");
    if (voice) { voice.hidden = true; voice.replaceChildren(); }
    ["qb-voice", "qb-dict"].forEach((id) => {
      document.getElementById(id)?.classList.remove("rec", "proc");
    });
    const mux = document.getElementById("cmux-remote");
    if (mux) mux.innerHTML = '<div class="cmux-empty">PIN 페어링 필요</div>';
    const cap = document.getElementById("cap-result"); if (cap) cap.replaceChildren();
    const mirrorInput = document.getElementById("mirror-input"); if (mirrorInput) mirrorInput.value = "";
    mirror.generation += 1; mirror.pending = null;
    if (mirror.canvas && mirror.ctx) mirror.ctx.clearRect(0, 0, mirror.canvas.width, mirror.canvas.height);
  }

  function restoreSensitiveSessionData() {
    if (!sensitiveAuthorized) return;
    if (omniCache.cmux) { cmuxState = omniCache.cmux; renderCmux(); }
    if (omniCache.omni) { omniState = omniCache.omni; }
    if (omniCache.cmux || omniCache.omni) renderSessCards();
    if (currentTab === "search") renderSrchRecent();
  }

  /// 대기 세션 화면 프리페치 — 카드 탭 즉시 표시의 재료. 카드당 60초에 1회.
  const prefetched = new Map();
  function prefetchScreens() {
    requestStatuses();   // 카드 ws 필 조회 (20s 스로틀 내장)
    sessAttention().slice(0, 5).forEach((c) => {
      // 읽기는 워크스페이스 스코프가 안전 (비활성 탭은 cmux가 읽기 거부)
      const scope = c.ws ? "workspace" : (c.surface ? "surface" : null);
      const id = c.ws || c.surface;
      if (!scope || !id) return;
      const last = prefetched.get(id) || 0;
      if (Date.now() - last < 60000) return;
      prefetched.set(id, Date.now());
      send({ t: "csess", action: "read", name: scope, target: id, count: 300 });
    });
  }

  // ── 조용히 모드: 사용자가 보고/만지는 동안엔 리렌더로 화면을 흔들지 않는다 ──
  // 에이전트 패널 터치·스크롤 후 10초간 카드/칩 리렌더 보류 (데이터는 계속 수신,
  // 조용 시간이 끝난 다음 폴에서 최신 상태로 그려짐).
  let quietUntil = 0;
  const agentPanel = document.getElementById("panel-agent");
  if (agentPanel) {
    ["touchstart", "scroll", "wheel"].forEach((ev) =>
      agentPanel.addEventListener(ev, () => { quietUntil = Date.now() + 10000; }, { passive: true }));
  }
  function uiQuiet() { return Date.now() < quietUntil; }
  let lastCardsSig = "";

  function renderSessCards() {
    const root = document.getElementById("sess-cards");
    if (!root) return;
    if (sheetTarget || uiQuiet()) return;   // 시트 열림·사용자 조작 중엔 흔들지 않음
    const cards = sessAttention();
    // 카드에 실제로 보이는 필드만으로 변경 감지 — 무관한 상태 변화로 리렌더하지 않음
    const lk0 = sessLookups();
    const sig = JSON.stringify(cards.map((c) => [
      c.ws && lk0.wsTitle.get(c.ws) || c.title,
      c.surface && lk0.tabTitle.get(c.surface) || c.cwd || "",
      c.cat, c.headline, Math.floor((c.ts || 0) / 60),
      lk0.wsColor.get(c.ws) || "", lk0.wsGroup.get(c.ws) || "",
      wsStatuses[c.ws] || null, c.decisions || null,
    ]));
    if (sig === lastCardsSig) return;
    lastCardsSig = sig;
    root.innerHTML = "";
    const head = document.createElement("div");
    head.className = "agent-sec sess-head";
    // 라이브 데이터가 아직이면(부팅 직후 캐시 표시 중) 캐시 시점을 밝힌다
    const stale = !lastLiveAt && omniCache.ts
      ? " · " + relTime(new Date(omniCache.ts).toISOString()) + " 캐시" : "";
    head.textContent = (cards.length
      ? "🟡 결정 대기 (" + cards.length + ")"
      : "결정 대기 없음 ✓") + stale;
    root.appendChild(head);
    const lk = sessLookups();
    cards.forEach((c) => {
      const card = document.createElement("button");
      card.className = "sess-card cat-" + c.cat;
      // 워크스페이스 색 매칭: 좌측 액센트 바 + 제목 점을 cmux 워크스페이스 색으로
      const wsColor = lk.wsColor.get(c.ws) || "";
      if (wsColor) card.style.borderLeftColor = wsColor;
      const top = document.createElement("div");
      top.className = "sc-top";
      const title = document.createElement("span");
      title.className = "sc-title";
      if (wsColor) {
        const dot = document.createElement("span");
        dot.className = "sc-wsdot"; dot.style.background = wsColor;
        title.appendChild(dot);
      }
      title.appendChild(document.createTextNode((c.ws && lk.wsTitle.get(c.ws)) || c.title));
      const group = lk.wsGroup.get(c.ws) || "";
      if (group) {   // 소속 그룹 (cmux 사이드바 섹션)
        const g = document.createElement("span");
        g.className = "sc-group"; g.textContent = group;
        title.appendChild(g);
      }
      const badge = document.createElement("span");
      badge.className = "sc-badge";
      badge.textContent = c.cat === "permission" ? "권한 요청" : "입력 대기";
      const time = document.createElement("span");
      time.className = "sc-time";
      time.textContent = c.ts ? relTime(new Date(c.ts * 1000).toISOString()) : "";
      top.append(title, badge, time);
      card.appendChild(top);
      // cmux 사이드바 필(결정 힌트·사분면·Running)을 색 그대로 코멘터리 줄로
      const pills = wsStatuses[c.ws] || [];
      if (pills.length) {
        const row = document.createElement("div");
        row.className = "sc-pills";
        pills.slice(0, 3).forEach((p) => {
          const s = document.createElement("span");
          s.className = "sc-pill";
          if (p.color) s.style.color = p.color;
          s.textContent = pillIcon(p.icon) + " " + (p.text || "");
          row.appendChild(s);
        });
        card.appendChild(row);
      }
      // 세션(탭) 구분 줄: 탭 제목(에이전트 진행상황이 실림) > cwd 폴더명(cmux 밖 세션) 순.
      const tab = (c.surface && lk.tabTitle.get(c.surface)) || "";
      const cwdBase = (c.cwd || "").split("/").filter(Boolean).pop() || "";
      const subText = tab || (cwdBase && "📁 " + cwdBase);
      if (subText) {
        const sub = document.createElement("div");
        sub.className = "sc-tab"; sub.textContent = subText;
        card.appendChild(sub);
      }
      if (c.headline) {
        const h = document.createElement("div");
        h.className = "sc-headline"; h.textContent = c.headline;
        card.appendChild(h);
      }
      // 원클릭 답장 칩: 요약기가 뽑은 결정 항목(에이전트의 후속 제안)을 탭 한 번에 전송.
      // 카드가 <button>이라 자식 button 불가 — span[role=button] + stopPropagation.
      if ((c.decisions || []).length) {
        const row = document.createElement("div");
        row.className = "sc-actions";
        c.decisions.slice(0, 3).forEach((d) => {
          const chip = document.createElement("span");
          chip.className = "sc-act"; chip.setAttribute("role", "button");
          chip.textContent = "↩ " + d;
          chip.addEventListener("click", (e) => {
            e.stopPropagation(); buzz();
            const tgt = sessTargetOf(c);
            if (!tgt.id) { toast("cmux 밖 세션 — 전송 불가"); return; }
            send({ t: "csess", action: "send", name: tgt.scope,
                   target: tgt.id, text: d.replace(/\r?\n/g, " ").trim(), submit: true });
            toast("전송됨: " + d.slice(0, 40));
          });
          row.appendChild(chip);
        });
        card.appendChild(row);
      }
      card.addEventListener("click", () => {
        buzz(); openSessSheet({ ...c, title: title.textContent, tab: subText });
      });
      root.appendChild(card);
    });
  }

  // ═════════ 세션 검색 탭 (OmniControl 세션 코퍼스 — cmux-voice search의 모바일판) ═════════
  // 빈 입력 = 작업폴더 브라우즈(projects → sessions), 2자+ = 풀텍스트 검색.
  // 결과 탭 = 데몬 /focus(session·cwd·revive) — 살아있는 탭 포커스, 닫힌 세션은 부활.
  const srchInput = document.getElementById("srch-input");
  const srchResults = document.getElementById("srch-results");
  let srchTimer = null, srchSeq = 0, srchActiveID = "";
  let srchView = { mode: "projects", cwd: "" };
  let srchRecent = (() => {
    try { return JSON.parse(sessionStorage.getItem("srchRecent.v1")) || []; } catch (e) { return []; }
  })();

  function srchGo() {
    const q = (srchInput.value || "").trim();
    srchSeq += 1;
    srchActiveID = "s" + srchSeq;
    if (q.length >= 2) {
      srchView = { mode: "hits", cwd: "" };
      send({ t: "omniSearch", id: srchActiveID, text: q });
    } else if (srchView.mode === "sessions" && srchView.cwd) {
      send({ t: "omniSearch", id: srchActiveID, dir: "sessions", name: srchView.cwd });
    } else {
      srchView = { mode: "projects", cwd: "" };
      send({ t: "omniSearch", id: srchActiveID, dir: "projects" });
    }
    document.getElementById("srch-clear").hidden = !q;
  }
  function srchDebounced() {
    clearTimeout(srchTimer);
    srchTimer = setTimeout(srchGo, 350);
  }
  srchInput?.addEventListener("input", srchDebounced);
  srchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(srchTimer); srchGo(); srchInput.blur(); }
  });
  document.getElementById("srch-clear")?.addEventListener("click", () => {
    srchInput.value = ""; srchView = { mode: "projects", cwd: "" }; srchGo();
  });

  function srchRememberQuery(q) {
    if (!q || q.length < 2) return;
    srchRecent = [q, ...srchRecent.filter((x) => x !== q)].slice(0, 8);
    try { sessionStorage.setItem("srchRecent.v1", JSON.stringify(srchRecent)); } catch (e) {}
    renderSrchRecent();
  }
  function renderSrchRecent() {
    const box = document.getElementById("srch-recent");
    if (!box) return;
    box.innerHTML = "";
    if (srchInput.value.trim() || !srchRecent.length) return;   // 입력 중엔 숨김
    srchRecent.forEach((q) => {
      const chip = document.createElement("button");
      chip.className = "srch-chip"; chip.textContent = q;
      chip.addEventListener("click", () => {
        buzz(); srchInput.value = q; clearTimeout(srchTimer); srchGo();
      });
      box.appendChild(chip);
    });
  }

  /// «하이라이트» 마커를 accent <b>로 (textContent 기반 — HTML 인젝션 불가)
  function snippetNode(text) {
    const div = document.createElement("div");
    div.className = "srch-snip";
    String(text || "").split("«").forEach((part, i) => {
      if (i === 0) { div.appendChild(document.createTextNode(part)); return; }
      const close = part.indexOf("»");
      const b = document.createElement("b");
      b.textContent = close >= 0 ? part.slice(0, close) : part;
      div.appendChild(b);
      if (close >= 0) div.appendChild(document.createTextNode(part.slice(close + 1)));
    });
    return div;
  }

  function srchRow(main, sub, onTap) {
    const b = document.createElement("button");
    b.className = "srch-row";
    const m = document.createElement("div");
    m.className = "srch-main"; m.textContent = main;
    b.appendChild(m);
    if (sub) {
      const s = document.createElement("div");
      s.className = "srch-sub"; s.textContent = sub;
      b.appendChild(s);
    }
    b.addEventListener("click", () => { buzz(); onTap(b); });
    return b;
  }

  function openHit(sessionId, cwd, btn) {
    btn.classList.add("busy");
    toast("맥에서 여는 중… (닫힌 세션은 부활 ~2초)");
    send({ t: "omniFocus", target: sessionId, name: cwd });
  }

  function renderSearch(res) {
    if (!srchResults) return;
    if (!res || res.id !== srchActiveID) return;   // 늦게 도착한 이전 검색 응답은 폐기
    srchResults.innerHTML = "";
    const empty = (msg) => {
      const d = document.createElement("div");
      d.className = "cmux-empty"; d.textContent = msg;
      srchResults.appendChild(d);
    };
    if (!res || res.available === false) {
      empty(res && res.code === 503
        ? "세션 코퍼스 인덱스가 아직 없어요 — 맥에서 `cmux-voice corpus reindex`"
        : "검색 서비스에 연결 못 함 (OmniControl 데몬 확인)");
      return;
    }
    const r = res.result || {};
    if (r.results) {   // ── 풀텍스트 히트 ──
      srchRememberQuery(r.query);
      if (!r.results.length) { empty("결과 없음: " + r.query); return; }
      r.results.forEach((h) => {
        const folder = (h.cwd || "").split("/").filter(Boolean).pop() || "";
        const row = srchRow(h.title || "(무제 세션)",
          "📁 " + folder + " · " + relTime(h.last_ts) + " · " + h.hits + "곳",
          (btn) => openHit(h.session_id, h.cwd || "", btn));
        (h.snippets || []).slice(0, 2).forEach((sn) => row.appendChild(snippetNode(sn.text)));
        srchResults.appendChild(row);
      });
    } else if (r.sessions) {   // ── 폴더 안 세션 브라우즈 ──
      const back = srchRow("← 작업폴더 전체", "", () => {
        srchView = { mode: "projects", cwd: "" }; srchGo();
      });
      back.classList.add("srch-back");
      srchResults.appendChild(back);
      const folder = (r.cwd || "").split("/").filter(Boolean).pop() || r.cwd;
      const head = document.createElement("div");
      head.className = "agent-sec"; head.textContent = "📁 " + folder + " — 세션 " + r.sessions.length + "개";
      srchResults.appendChild(head);
      r.sessions.forEach((s) => {
        srchResults.appendChild(srchRow(s.title || "(무제 세션)",
          relTime(s.last_ts) + " · 메시지 " + (s.msg_count || 0),
          (btn) => openHit(s.session_id, s.cwd || r.cwd || "", btn)));
      });
    } else if (r.projects) {   // ── 작업폴더 목록 (빈 검색창 기본 화면) ──
      const head = document.createElement("div");
      head.className = "agent-sec"; head.textContent = "작업폴더 " + r.projects.length + "개 — 최근 순";
      srchResults.appendChild(head);
      r.projects.forEach((p) => {
        srchResults.appendChild(srchRow(p.name || p.cwd,
          relTime(p.last_ts) + " · 세션 " + p.sessions + " · 메시지 " + p.msgs,
          () => { srchView = { mode: "sessions", cwd: p.cwd }; srchGo(); }));
      });
    } else {
      empty("결과 없음");
    }
  }

  // ═════════ PTT 전송 확인 배너 (맥 확인 카드의 모바일 미러) ═════════
  // 퀵바 '음성 지시' 직후 40초간 1초 폴링으로 confirming을 빠르게 잡고,
  // 배너가 뜨는 순간 hold를 보내 맥 카운트다운을 멈춘다 (앱 45초 상한 자동 재개).
  let fastOmniUntil = 0, pttHeldTs = 0, pttCardTs = 0;
  let pttHoldAttempts = 0, pttHoldPending = false, pttHoldRequestID = "";
  let pttHoldTimer = null, pendingPttDecision = null;
  // 퀵바 음성 버튼 탭 → 40초간 빠른 폴링 (녹음/인식 상태·confirming을 놓치지 않게)
  ["qb-voice", "qb-dict"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => {
      fastOmniUntil = Date.now() + 40000;
    });
  });

  /// 맥의 음성 입력 라이브 상태 (state.voice) → 상단 필 + 퀵바 버튼 하이라이트.
  /// 맥북 화면을 안 봐도 "지금 음성 지시인지 받아쓰기인지, 듣는 중인지"가 폰에 보인다.
  function renderVoicePill() {
    const pill = document.getElementById("voice-pill");
    if (!pill) return;
    const v = omniState && omniState.available && omniState.state && omniState.state.voice;
    const fresh = v && v.ts && (Date.now() / 1000 - v.ts) < 90;   // stale 방어
    const qbVoice = document.getElementById("qb-voice");
    const qbDict = document.getElementById("qb-dict");
    [qbVoice, qbDict].forEach((b) => b && b.classList.remove("rec", "proc"));
    if (!fresh || v.state === "confirming") {   // confirming은 전송 배너가 담당
      pill.hidden = true;
      return;
    }
    const laneName = v.lane === "dictation" ? "✍️ 받아쓰기" : "🎙 음성 지시";
    const btn = v.lane === "dictation" ? qbDict : qbVoice;
    if (v.state === "recording") {
      btn?.classList.add("rec");
      pill.classList.remove("processing");
      pill.innerHTML = "";
      const dot = document.createElement("span"); dot.className = "vp-dot";
      pill.append(dot, document.createTextNode(
        laneName + " — 듣는 중" + (v.toggled ? " (버튼 다시 탭 = 종료)" : "")));
      pill.hidden = false;
      fastOmniUntil = Math.max(fastOmniUntil, Date.now() + 15000);   // 상태 추적 유지
    } else if (v.state === "processing") {
      btn?.classList.add("proc");
      pill.classList.add("processing");
      pill.innerHTML = "";
      const dot = document.createElement("span"); dot.className = "vp-dot";
      pill.append(dot, document.createTextNode(laneName + " — 인식 중…"));
      pill.hidden = false;
      fastOmniUntil = Math.max(fastOmniUntil, Date.now() + 15000);
    } else {
      pill.hidden = true;
    }
  }
  setInterval(() => {
    if (sensitiveAuthorized && Date.now() < fastOmniUntil
        && document.visibilityState === "visible") requestOmni();
  }, 1000);
  function omniPtt(action, ref, successMessage) {
    const requestID = "ptt" + Math.random().toString(36).slice(2, 10);
    if (action === "hold") pttHoldRequestID = requestID;
    if (successMessage) pendingPttDecision = { id: requestID, action, successMessage };
    send({ t: "omniPtt", id: requestID, dir: action, target: ref || "" });
  }
  function resetPttHoldState() {
    if (pttHoldTimer) clearTimeout(pttHoldTimer);
    pttHoldTimer = null; pttHeldTs = 0; pttCardTs = 0;
    pttHoldAttempts = 0; pttHoldPending = false; pttHoldRequestID = "";
    pendingPttDecision = null;
  }
  function attemptPttHold() {
    if (!pttCardTs || pttHeldTs === pttCardTs || pttHoldPending || pttHoldAttempts >= 3) return;
    pttHoldPending = true; pttHoldAttempts += 1;
    omniPtt("hold");
    if (pttHoldTimer) clearTimeout(pttHoldTimer);
    pttHoldTimer = setTimeout(() => {
      if (!pttHoldPending) return;
      pttHoldPending = false;
      if (pttHoldAttempts < 3) attemptPttHold();
      else toast("카운트다운 보류 응답 없음 — Mac 확인이 필요합니다");
    }, 1200);
  }
  function handleOmniPttAck(message) {
    if (message.action === "hold") {
      if (!pttHoldPending || message.id !== pttHoldRequestID) return;
      if (pttHoldTimer) clearTimeout(pttHoldTimer);
      pttHoldTimer = null;
      pttHoldPending = false;
      if (message.ok) {
        pttHeldTs = pttCardTs;
      } else if (pttHoldAttempts < 3) {
        setTimeout(attemptPttHold, 350);
      } else {
        toast("카운트다운 보류 실패 — Mac 확인이 필요합니다");
      }
      return;
    }
    if (!pendingPttDecision || pendingPttDecision.id !== message.id
        || pendingPttDecision.action !== message.action) return;
    const pending = pendingPttDecision;
    pendingPttDecision = null;
    if (message.ok) {
      const el = document.getElementById("ptt-banner"); if (el) el.hidden = true;
      toast(pending.successMessage);
      setTimeout(requestOmni, 800);
    } else {
      toast("결정 반영 실패 — 로컬 통합 상태를 확인하세요");
    }
  }
  function renderPttBanner() {
    const el = document.getElementById("ptt-banner");
    if (!el) return;
    const ptt = omniState && omniState.available && omniState.state && omniState.state.ptt;
    if (!ptt || !ptt.text) {
      el.hidden = true; resetPttHoldState();
      return;
    }
    el.hidden = false;
    if (pttCardTs !== ptt.ts) {
      resetPttHoldState(); pttCardTs = ptt.ts;
    }
    if (pttHeldTs !== ptt.ts) {
      attemptPttHold();
      fastOmniUntil = Math.max(fastOmniUntil, Date.now() + 60000);  // 결정까지 상태 추적
    }
    document.getElementById("pb-text").textContent = "“" + ptt.text + "”"
      + (ptt.engine ? "  〰 " + ptt.engine : "");
    const list = document.getElementById("pb-sessions");
    list.innerHTML = "";
    const lk = sessLookups();
    (ptt.sessions || []).forEach((s) => {
      const b = document.createElement("button");
      b.className = "pb-sess" + (s.ref === ptt.target ? " on" : "");
      const color = lk.wsColor.get(s.ref);
      if (color) {
        const dot = document.createElement("span");
        dot.className = "sc-wsdot"; dot.style.background = color;
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(
        (s.name || s.ref) + (s.ref === ptt.target ? " · 기본" : "")));
      b.addEventListener("click", () => {
        buzz(); omniPtt("send", s.ref, "전송: " + (s.name || "세션"));
        toast("처리 중…");
      });
      list.appendChild(b);
    });
    document.getElementById("pb-send").onclick = () => {
      buzz(); omniPtt("send", ptt.target || "", "전송됨");
      toast("처리 중…");
    };
    document.getElementById("pb-cancel").onclick = () => {
      buzz(); omniPtt("cancel", "", "취소됨");
      toast("처리 중…");
    };
  }

  // ── 세션 상세 시트: 포커스 안 뺏는 read-screen + 세션별 send ──
  let sheetTarget = null, sheetPoll = null;   // {scope,id,ws,title}

  function sessTargetOf(c) {
    // notif에 surface가 있으면 그 탭을 정밀 타깃, 없으면 워크스페이스(포커스된 탭)로.
    return c.surface ? { scope: "surface", id: c.surface }
                     : { scope: "workspace", id: c.ws };
  }

  function openSessSheet(c) {
    const tgt = sessTargetOf(c);
    if (!tgt.id) { toast("cmux 밖 세션 — 워크스페이스 정보 없음"); return; }
    // 읽기와 입력을 분리: 입력은 탭(surface) 정밀 타깃 유지, 읽기는 실패 시
    // 워크스페이스 활성 화면으로 폴백 (cmux는 비활성 탭의 화면을 읽지 못한다).
    sheetTarget = { ...tgt, ws: c.ws, title: c.title, lastSig: "",
                    readScope: tgt.scope, readId: tgt.id };
    document.getElementById("ss-title").textContent = c.title;
    document.getElementById("ss-sub").textContent =
      [c.tab, c.headline].filter(Boolean).join(" · ");
    const t = document.getElementById("ss-term");
    // 캐시된 화면이 있으면 즉시 표시 (프리페치 덕에 대부분 즉답) → 라이브 갱신이 교체
    const scr = (omniCache.screens || {});
    const cached = scr[sheetTarget.readId] || (sheetTarget.ws && scr[sheetTarget.ws]);
    if (cached && cached.html) { t.innerHTML = cached.html; t.style.background = cached.bg || ""; }
    else if (cached && cached.text) { t.textContent = cached.text; t.style.background = ""; }
    else { t.textContent = "화면 불러오는 중…"; t.style.background = ""; }
    requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; });
    // 작성 중이던 프롬프트 복원 (앱이 죽어도 살아남음)
    const draft = ((omniCache.drafts || {})[sheetTarget.id]) || "";
    const inp = document.getElementById("ss-input");
    if (inp) inp.value = draft;
    document.getElementById("sess-sheet").hidden = false;
    stopCmuxPoll();   // 시트가 전체 화면 — 뒤의 카드/칩 폴링은 소음일 뿐
    sessRead();
    sheetPoll = setInterval(() => {
      if (document.visibilityState === "visible") sessRead();
    }, 3000);
  }

  function closeSessSheet() {
    document.getElementById("sess-sheet").hidden = true;
    if (sheetPoll) clearInterval(sheetPoll);
    sheetPoll = null; sheetTarget = null;
    startCmuxPoll();   // 카드/칩 갱신 재개
  }

  function sessRead() {
    if (!sheetTarget) return;
    send({ t: "csess", action: "read", name: sheetTarget.readScope,
           target: sheetTarget.readId, count: 1000 });
  }

  /// 바닥 근처에서만 자동 스크롤 — 위로 올려 읽는 중엔 위치를 지킨다.
  function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }

  function onSessRead(m) {
    // 시트 표시 여부와 무관하게 화면 캐시에 적재 (프리페치 응답 포함)
    if (!m.error && m.id) {
      let entry;
      if (m.grid) { const o = gridToHTML(m.grid); entry = { html: o.html, bg: o.bg, ts: Date.now() }; }
      else entry = { text: (m.text || "").slice(-30000), ts: Date.now() };
      omniCache.screens = omniCache.screens || {};
      omniCache.screens[m.id] = entry;
      const ks = Object.keys(omniCache.screens);
      if (ks.length > 10) {   // 용량 관리: 오래된 화면부터 제거
        ks.sort((a, b) => omniCache.screens[a].ts - omniCache.screens[b].ts);
        delete omniCache.screens[ks[0]];
      }
      saveCacheSoon();
    }
    if (!sheetTarget || m.id !== sheetTarget.readId) return;
    const el = document.getElementById("ss-term");
    if (m.error) {
      // 비활성 탭은 cmux가 화면을 못 읽는다 → 그 워크스페이스의 활성 화면으로 폴백
      if (sheetTarget.readScope === "surface" && sheetTarget.ws) {
        sheetTarget.readScope = "workspace"; sheetTarget.readId = sheetTarget.ws;
        sessRead(); return;
      }
      if (!sheetTarget.lastSig) el.textContent = "화면을 읽지 못했습니다 (cmux 연결 확인)";
      return;
    }
    const stick = nearBottom(el);
    if (m.grid) {   // 포커스된 탭 = cmux 뷰와 동일한 컬러 그리드
      const out = gridToHTML(m.grid);
      const sig2 = "g:" + out.html.length + ":" + out.html.slice(-80);
      if (sig2 === sheetTarget.lastSig) return;
      sheetTarget.lastSig = sig2;
      el.style.background = out.bg;
      el.innerHTML = out.html;
    } else {
      const text = m.text || "(빈 화면)";
      if (text === sheetTarget.lastSig) return;   // 변경 없으면 화면 안 흔듦
      sheetTarget.lastSig = text;
      el.style.background = "";
      el.textContent = text;
    }
    if (stick) el.scrollTop = el.scrollHeight;
  }

  // 시트 요소가 없어도(HTML/JS 버전 스큐 — PWA가 옛 index를 캐시한 경우) 앱 전체가
  // 죽지 않게 null-safe로 묶는다. connect()가 파일 끝에 있어 여기서 죽으면 연결 자체가 안 됨.
  const ssEl = (id) => document.getElementById(id);
  ssEl("ss-close")?.addEventListener("click", () => { buzz(); closeSessSheet(); });

  // ── 뒤로가기 스와이프: 왼쪽 가장자리에서 오른쪽으로 밀면 시트 닫기 (iOS 내비 관성) ──
  (function setupSheetSwipeBack() {
    const sheet = document.getElementById("sess-sheet");
    if (!sheet) return;
    let startX = 0, startY = 0, tracking = false, swiping = false;
    sheet.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      tracking = startX <= 28;   // 가장자리에서 시작한 터치만 (터미널 스크롤과 충돌 방지)
      swiping = false;
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (!swiping) {
        if (Math.abs(dy) > Math.abs(dx) || dx < 12) return;   // 수직 스크롤 우선
        swiping = true;
        sheet.style.transition = "none";
      }
      sheet.style.transform = "translateX(" + Math.max(0, dx) + "px)";
    }, { passive: true });
    sheet.addEventListener("touchend", (e) => {
      if (!swiping) { tracking = false; return; }
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      sheet.style.transition = "transform .18s ease-out";
      if (dx > 90) {   // 충분히 밀었으면 닫기
        sheet.style.transform = "translateX(100%)";
        setTimeout(() => {
          closeSessSheet();
          sheet.style.transition = ""; sheet.style.transform = "";
        }, 180);
      } else {         // 스프링백
        sheet.style.transform = "translateX(0)";
        setTimeout(() => { sheet.style.transition = ""; sheet.style.transform = ""; }, 200);
      }
      tracking = false; swiping = false;
    }, { passive: true });
  })();
  ssEl("ss-goto")?.addEventListener("click", () => {
    if (!sheetTarget) return;
    buzz();
    if (sheetTarget.ws) requestCmux("select-workspace", sheetTarget.ws);
    if (sheetTarget.scope === "surface") requestCmux("focus-tab", sheetTarget.id);
    toast("맥에서 세션으로 전환했습니다");
  });
  document.querySelectorAll("#sess-sheet .ss-keys button").forEach((b) => {
    b.addEventListener("click", () => {
      if (!sheetTarget) return;
      buzz();
      send({ t: "csess", action: "key", name: sheetTarget.scope,
             target: sheetTarget.id, text: b.dataset.k });
      setTimeout(sessRead, 600);   // 키 반영된 화면 바로 재읽기
    });
  });
  ssEl("ss-send")?.addEventListener("click", () => {
    if (!sheetTarget) return;
    const input = document.getElementById("ss-input");
    if (!input) return;
    // 실제 개행은 Claude Code에서 조기 제출이 될 수 있어 공백으로 눌러 보낸다.
    const text = input.value.replace(/\r?\n/g, " ").trim();
    if (!text) return;
    buzz();
    send({ t: "csess", action: "send", name: sheetTarget.scope,
           target: sheetTarget.id, text, submit: true });
    input.value = "";
    if (omniCache.drafts) { delete omniCache.drafts[sheetTarget.id]; saveCacheSoon(); }
    toast("프롬프트 전송됨");
    setTimeout(sessRead, 900);
  });
  // 프롬프트 초안 실시간 보존
  ssEl("ss-input")?.addEventListener("input", (e) => {
    if (!sheetTarget) return;
    omniCache.drafts = omniCache.drafts || {};
    omniCache.drafts[sheetTarget.id] = e.target.value;
    saveCacheSoon();
  });

  // ═════════ herdr 전용 탭 (원격 에이전트 상태 대시보드) ═════════
  // backend=herdr 로 같은 상태 프로토콜을 재사용하되, tabs[]를 '에이전트 상태 카드'로 렌더.
  // herdr의 킬러 기능 = 네이티브 agent 상태(idle/working/blocked/done)를 한눈에.
  let herdrState = null, herdrPoll = null, lastHerdrJSON = "";
  const HERDR_ORDER = { blocked: 0, done: 1, working: 2, idle: 3, "": 4 };   // 나를 기다리는 게 위로
  const HERDR_LABEL = { blocked: "차단", done: "완료", working: "작업 중", idle: "대기", "": "" };
  function requestHerdr(verb, target) { send({ t: "cmux", backend: "herdr", dir: verb || "state", target: target || "" }); }
  function startHerdrPoll() {
    stopHerdrPoll(); requestHerdr();
    herdrPoll = setInterval(() => { if (document.visibilityState === "visible") requestHerdr(); }, 4000);
  }
  function stopHerdrPoll() { if (herdrPoll) clearInterval(herdrPoll); herdrPoll = null; }
  function renderHerdr() {
    const wsRoot = document.getElementById("herdr-ws");
    const root = document.getElementById("herdr-agents");
    if (!root || !wsRoot) return;
    if (!herdrState) { root.innerHTML = '<div class="cmux-empty">herdr 상태 불러오는 중…</div>'; wsRoot.innerHTML = ""; return; }
    if (herdrState.available === false) {
      root.innerHTML = '<div class="cmux-empty">herdr 미설치/미배포 — <code>./deploy.sh</code> 재빌드 + herdr 설치 후 활성화됩니다</div>'; wsRoot.innerHTML = ""; return;
    }
    if (herdrState.denied) {
      root.innerHTML = '<div class="cmux-empty">herdr에 연결 못 함 — 원격 herdr가 라이브인지·SSH 연결을 확인하세요 (↻)</div>'; wsRoot.innerHTML = ""; return;
    }
    wsRoot.innerHTML = "";
    (herdrState.windows || []).forEach((win) => (win.workspaces || []).forEach((ws) => {
      wsRoot.appendChild(cmuxChip(ws.title || "(무제)", !!ws.selected, ws.color || "", () => requestHerdr("select-workspace", ws.id)));
    }));
    const agents = (herdrState.tabs || []).slice().sort((a, b) => (HERDR_ORDER[a.state || ""] - HERDR_ORDER[b.state || ""]));
    root.innerHTML = "";
    if (!agents.length) { root.innerHTML = '<div class="cmux-empty">현재 워크스페이스에 에이전트가 없습니다</div>'; return; }
    agents.forEach((ag) => {
      const card = document.createElement("button");
      card.className = "herdr-card" + (ag.focused ? " on" : "");
      const dot = document.createElement("span"); dot.className = "mux-dot st-" + (ag.state || "idle");
      const name = document.createElement("span"); name.className = "herdr-name"; name.textContent = ag.title || "에이전트";
      const st = document.createElement("span"); st.className = "herdr-st st-" + (ag.state || "idle"); st.textContent = HERDR_LABEL[ag.state || ""] || "";
      card.appendChild(dot); card.appendChild(name); card.appendChild(st);
      card.addEventListener("click", () => { buzz(); requestHerdr("focus-tab", ag.id); });
      root.appendChild(card);
    });
  }
  function herdrCtrl(act) {
    const seq = act === "enter" ? "\r" : act === "esc" ? "\x1b" : "\x03";
    send({ t: "cterm", backend: "herdr", action: "input", text: seq }); buzz();
  }
  document.querySelectorAll("#panel-herdr [data-hact]").forEach((b) => b.addEventListener("click", () => herdrCtrl(b.dataset.hact)));
  document.getElementById("herdr-refresh").addEventListener("click", () => { buzz(); requestHerdr(); });
  document.getElementById("herdr-term").addEventListener("click", () => { setBackend("herdr"); selectTab("term"); });

  // 터미널 탭 백엔드 스위처 (cmux / herdr)
  document.querySelectorAll("#term-switch button").forEach((b) => b.addEventListener("click", () => { buzz(); setBackend(b.dataset.tbk); }));

  // ═════════ 덱 ═════════
  const STORE_KEY = "macpilot.deck.v2";
  let deck = loadDeck();
  let activeFolder = 0;
  let editMode = false;
  let installedApps = null, appsPickerRefresh = null;

  function loadDeck() {
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
    return defaultDeck();
  }
  function saveLocal() { try { localStorage.setItem(STORE_KEY, JSON.stringify(deck)); } catch (e) {} }
  function pushDeckToServer() { send({ t: "saveDeck", deckJson: JSON.stringify(deck) }); }
  function saveDeck() { saveLocal(); pushDeckToServer(); }   // 폰 캐시 + 맥 서버 동시 저장
  function sc(label, keyCode, mods) { return { id: uid(), type: "shortcut", label, keyCode, mods }; }
  function defaultDeck() {
    return { folders: [
      { id: uid(), name: "기본", items: [
        sc("복사", 8, ["command"]), sc("붙여넣기", 9, ["command"]), sc("잘라내기", 7, ["command"]),
        sc("실행취소", 6, ["command"]), sc("다시실행", 6, ["command","shift"]), sc("전체선택", 0, ["command"]),
        sc("저장", 1, ["command"]), sc("찾기", 3, ["command"]), sc("새로고침", 15, ["command"]),
      ]},
      { id: uid(), name: "앱/창", items: [
        sc("새 탭", 17, ["command"]), sc("탭 닫기", 13, ["command"]), sc("스팟라이트", 49, ["command"]),
        sc("앱 전환", 48, ["command"]),
        { id: uid(), type: "launch", label: "미션컨트롤", target: "/System/Applications/Mission Control.app" },
      ]},
      { id: uid(), name: "매크로", items: [
        { id: uid(), type: "macro", label: "전체선택→복사", steps: [
          { type:"key", keyCode:0, mods:["command"] }, { type:"delay", ms:80 }, { type:"key", keyCode:8, mods:["command"] } ] },
        { id: uid(), type: "macro", label: "복사→앱전환→붙여넣기", steps: [
          { type:"key", keyCode:8, mods:["command"] }, { type:"delay", ms:120 },
          { type:"key", keyCode:48, mods:["command"] }, { type:"delay", ms:300 },
          { type:"key", keyCode:9, mods:["command"] } ] },
      ]},
      { id: uid(), name: "내 것", items: [] },
    ]};
  }

  function pageSize() { return Math.max(1, deckCols * deckRows); }
  const pagesEl = document.getElementById("deck-pages");
  const dotsEl = document.getElementById("page-dots");
  const tabsEl = document.getElementById("folder-tabs");
  const toolbarEl = document.getElementById("deck-toolbar");

  document.getElementById("deck-edit").addEventListener("click", () => {
    editMode = !editMode;
    document.getElementById("deck-edit").classList.toggle("on", editMode);
    toolbarEl.classList.toggle("on", editMode);
    renderDeck();
  });

  // 음량 / 밝기
  document.querySelectorAll("#media-bar button").forEach((b) => {
    b.addEventListener("click", () => { buzz(); send({ t: b.dataset.m, dir: b.dataset.d }); });
  });

  function runItem(item) {
    buzz();
    if (item.type === "shortcut") send({ t: "key", keyCode: item.keyCode, mods: item.mods || [] });
    else if (item.type === "text") send({ t: "text", text: item.text || "" });
    else if (item.type === "launch") send({ t: "launch", target: item.target || "" });
    else if (item.type === "macro") send({ t: "macro", steps: item.steps || [] });
  }
  function cellSub(item) {
    if (item.type === "shortcut") return comboLabel(item.keyCode, item.mods);
    if (item.type === "macro") return "매크로 " + (item.steps ? item.steps.length : 0) + "단계";
    if (item.type === "text") return "텍스트";
    if (item.type === "launch") return "앱/링크";
    return "";
  }

  function renderDeck() {
    if (activeFolder >= deck.folders.length) activeFolder = 0;
    renderFolderTabs();
    renderToolbar();
    renderPages();
  }
  function renderFolderTabs() {
    tabsEl.innerHTML = "";
    deck.folders.forEach((f, i) => {
      const t = document.createElement("button");
      t.className = "folder-tab" + (i === activeFolder ? " active" : "");
      t.textContent = f.name;
      t.addEventListener("click", () => { activeFolder = i; renderDeck(); });
      tabsEl.appendChild(t);
    });
    if (editMode) {
      const add = document.createElement("button");
      add.className = "folder-tab add"; add.textContent = "＋폴더";
      add.addEventListener("click", () => {
        const name = prompt("새 폴더 이름"); if (!name) return;
        deck.folders.push({ id: uid(), name, items: [] }); activeFolder = deck.folders.length - 1; saveDeck(); renderDeck();
      });
      tabsEl.appendChild(add);
    }
  }
  function renderToolbar() {
    toolbarEl.innerHTML = "";
    if (!editMode) return;
    const rename = document.createElement("button");
    rename.textContent = "✎ 폴더 이름";
    rename.addEventListener("click", () => {
      const f = deck.folders[activeFolder]; const name = prompt("폴더 이름", f.name); if (!name) return;
      f.name = name; saveDeck(); renderDeck();
    });
    const del = document.createElement("button");
    del.className = "danger"; del.textContent = "🗑 폴더 삭제";
    del.addEventListener("click", () => {
      if (deck.folders.length <= 1) { alert("폴더는 최소 1개 필요합니다"); return; }
      if (!confirm("이 폴더와 버튼을 삭제할까요?")) return;
      deck.folders.splice(activeFolder, 1); activeFolder = 0; saveDeck(); renderDeck();
    });
    toolbarEl.appendChild(rename); toolbarEl.appendChild(del);
  }
  // 앱 런치 위주 폴더 판별: 항목의 다수(60%+)가 launch 타입일 때만.
  // (이름 힌트만으론 '앱/창' 같은 단축키 혼합 폴더까지 오인 → 단축키 힌트가 사라짐)
  function folderIsApps(folder) {
    if (!folder) return false;
    const items = folder.items || [];
    if (items.length < 2) return false;
    const launch = items.filter((it) => it.type === "launch").length;
    return launch >= Math.ceil(items.length * 0.6);
  }
  function renderPages() {
    const keepScroll = pagesEl.scrollLeft;
    pagesEl.innerHTML = "";
    const folder = deck.folders[activeFolder];
    const items = folder ? folder.items : [];
    const apps = folderIsApps(folder);
    const cells = items.map((item, i) => renderCell(item, i));
    if (editMode) cells.push(renderAddCell());
    const pages = [];
    // 앱 폴더는 셀을 키우고 한 페이지에 3행 정도만 노출(아이콘+이름 가독성)
    const per = apps ? Math.max(1, deckCols * Math.min(deckRows, 3)) : pageSize();
    for (let i = 0; i < cells.length; i += per) pages.push(cells.slice(i, i + per));
    if (pages.length === 0) pages.push([]);
    pages.forEach((pc) => {
      const page = document.createElement("div");
      page.className = "deck-page" + (apps ? " apps" : "");
      pc.forEach((c) => page.appendChild(c));
      pagesEl.appendChild(page);
    });
    pagesEl.scrollLeft = keepScroll;
    renderDots(pages.length);
  }
  function renderCell(item, idx) {
    const btn = document.createElement("button");
    btn.className = "deck-btn" + (item.type === "macro" ? " macro" : "");
    btn.dataset.idx = idx;
    if (item.color) btn.style.background = item.color;
    if (dragState && dragState.item === item) btn.classList.add("drag-src");
    if (item.icon) {
      if (item.icon.indexOf("data:") === 0) { const im = document.createElement("img"); im.className = "ic-img"; im.src = item.icon; btn.appendChild(im); }
      else { const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = item.icon; btn.appendChild(ic); }
    }
    const main = document.createElement("span"); main.className = "nm"; main.textContent = item.label || "(이름없음)"; btn.appendChild(main);
    const sub = cellSub(item);
    if (sub) { const s = document.createElement("span"); s.className = "sub"; s.textContent = sub; btn.appendChild(s); }
    if (editMode) {
      btn.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        dragCandidate = { item, btn, x: t.clientX, y: t.clientY, armed: false };
        dragTimer = setTimeout(() => { if (dragCandidate) { dragCandidate.armed = true; btn.classList.add("lift"); } }, 220);
      }, { passive: true });
    } else {
      btn.addEventListener("click", () => runItem(item));
    }
    return btn;
  }
  function renderAddCell() {
    const btn = document.createElement("button");
    btn.className = "deck-btn add"; btn.textContent = "＋";
    btn.addEventListener("click", () => openEditor(null));
    return btn;
  }
  function renderDots(count) {
    dotsEl.innerHTML = "";
    if (count <= 1) return;
    for (let i = 0; i < count; i++) { const d = document.createElement("span"); d.className = "pd" + (i === 0 ? " on" : ""); dotsEl.appendChild(d); }
  }
  pagesEl.addEventListener("scroll", () => {
    const w = pagesEl.clientWidth; if (!w) return;
    const idx = Math.round(pagesEl.scrollLeft / w);
    dotsEl.querySelectorAll(".pd").forEach((d, i) => d.classList.toggle("on", i === idx));
  });

  // ── 드래그 재정렬 (편집 모드: 길게 눌러 집고 끌어서 이동) ──
  let dragCandidate = null, dragState = null, dragTimer = null;
  function clearCandidate() {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    if (dragCandidate && dragCandidate.btn) dragCandidate.btn.classList.remove("lift");
    dragCandidate = null;
  }
  function beginDrag(t) {
    const btn = dragCandidate.btn, item = dragCandidate.item;
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    dragCandidate = null;
    const rect = btn.getBoundingClientRect();
    const ghost = btn.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.cssText += "position:fixed;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;margin:0;z-index:60;pointer-events:none;";
    document.body.appendChild(ghost);
    dragState = { item: item, ghost: ghost, offX: t.clientX - rect.left, offY: t.clientY - rect.top };
    renderPages();
  }
  function moveDrag(t) {
    const g = dragState.ghost;
    g.style.left = (t.clientX - dragState.offX) + "px";
    g.style.top = (t.clientY - dragState.offY) + "px";
    g.style.visibility = "hidden";
    const el = document.elementFromPoint(t.clientX, t.clientY);
    g.style.visibility = "visible";
    const target = el && el.closest ? el.closest(".deck-btn") : null;
    if (!target || target.classList.contains("add") || target.classList.contains("drag-ghost")) return;
    const targetIdx = parseInt(target.dataset.idx, 10);
    if (isNaN(targetIdx)) return;
    const folder = deck.folders[activeFolder];
    const curIdx = folder.items.indexOf(dragState.item);
    if (curIdx < 0 || targetIdx === curIdx) return;
    folder.items.splice(curIdx, 1);
    folder.items.splice(targetIdx, 0, dragState.item);
    renderPages();
  }
  function endDrag() { if (dragState.ghost) dragState.ghost.remove(); dragState = null; saveDeck(); renderPages(); }

  document.addEventListener("touchmove", (e) => {
    if (dragState) { e.preventDefault(); moveDrag(e.touches[0]); return; }
    if (!dragCandidate) return;
    const t = e.touches[0];
    if (dragCandidate.armed) { e.preventDefault(); beginDrag(t); }
    else if (Math.hypot(t.clientX - dragCandidate.x, t.clientY - dragCandidate.y) > 10) clearCandidate();
  }, { passive: false });
  document.addEventListener("touchend", () => {
    if (dragState) { endDrag(); return; }
    if (dragCandidate) { const it = dragCandidate.item; clearCandidate(); openEditor(it); }
  });

  // ═════════ 버튼 에디터 (모달) ═════════
  const modalRoot = document.getElementById("modal-root");
  let draft = null;       // 편집 중 항목
  let draftIndex = -1;    // 폴더 내 인덱스 (-1=신규)

  function openEditor(item) {
    draftIndex = item ? deck.folders[activeFolder].items.indexOf(item) : -1;
    draft = item ? JSON.parse(JSON.stringify(item))
                 : { id: uid(), type: "shortcut", label: "", keyCode: 8, mods: ["command"] };
    if (!draft.mods) draft.mods = [];
    renderModal();
  }
  function closeEditor() { modalRoot.innerHTML = ""; draft = null; appsPickerRefresh = null; }

  function renderModal() {
    modalRoot.innerHTML =
      '<div class="modal-bg"></div><div class="modal-card">' +
      '<div class="modal-head"><div class="modal-title">' + (draftIndex >= 0 ? "버튼 편집" : "버튼 추가") + '</div><button id="ed-close" class="modal-x">✕</button></div>' +
      '<div class="seg" id="ed-type">' +
        '<button data-type="shortcut">단축키</button><button data-type="text">텍스트</button>' +
        '<button data-type="launch">앱/링크</button><button data-type="macro">매크로</button></div>' +
      '<input id="ed-label" class="ed-input" placeholder="버튼 이름">' +
      '<div class="ed-row"><input id="ed-icon" class="ed-input ed-icon" maxlength="2" placeholder="🙂 아이콘"><select id="ed-folder" class="ed-input"></select></div>' +
      '<div class="ed-colors" id="ed-colors"></div>' +
      '<div id="ed-body"></div>' +
      '<div class="modal-actions">' +
        (draftIndex >= 0 ? '<button id="ed-delete" class="danger">삭제</button>' : '') +
        '<span style="flex:1"></span><button id="ed-cancel">취소</button><button id="ed-save" class="primary">저장</button>' +
      '</div></div>';

    modalRoot.querySelector(".modal-bg").addEventListener("click", closeEditor);
    modalRoot.querySelector("#ed-cancel").addEventListener("click", closeEditor);
    modalRoot.querySelector("#ed-close").addEventListener("click", closeEditor);
    const lab = modalRoot.querySelector("#ed-label");
    lab.value = draft.label || "";
    lab.addEventListener("input", () => { draft.label = lab.value; });

    // 아이콘
    const iconEl = modalRoot.querySelector("#ed-icon");
    iconEl.value = (draft.icon && draft.icon.indexOf("data:") !== 0) ? draft.icon : "";
    iconEl.addEventListener("input", () => { draft.icon = iconEl.value || null; });
    // 폴더 이동
    const folderEl = modalRoot.querySelector("#ed-folder");
    deck.folders.forEach((f, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = "📁 " + f.name; if (i === activeFolder) o.selected = true; folderEl.appendChild(o); });
    // 색상
    const COLORS = ["", "#2a3b4d", "#3a2a4d", "#4d2a2a", "#2a4d34", "#4d442a", "#2a4d4d", "#3a3a42"];
    const colorsEl = modalRoot.querySelector("#ed-colors");
    COLORS.forEach((c) => {
      const sw = document.createElement("button");
      sw.className = "swatch" + ((draft.color || "") === c ? " on" : "");
      sw.style.background = c || "#1c1c20";
      if (!c) sw.textContent = "✕";
      sw.addEventListener("click", () => { draft.color = c || null; colorsEl.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on")); sw.classList.add("on"); });
      colorsEl.appendChild(sw);
    });

    modalRoot.querySelectorAll("#ed-type button").forEach((b) => {
      b.classList.toggle("on", b.dataset.type === draft.type);
      b.addEventListener("click", () => { changeType(b.dataset.type); });
    });
    if (draftIndex >= 0) modalRoot.querySelector("#ed-delete").addEventListener("click", () => {
      deck.folders[activeFolder].items.splice(draftIndex, 1); saveDeck(); closeEditor(); renderDeck();
    });
    modalRoot.querySelector("#ed-save").addEventListener("click", saveDraft);
    renderBody();
  }
  function changeType(type) {
    draft.type = type;
    if (type === "shortcut") { if (draft.keyCode == null) draft.keyCode = 8; if (!draft.mods) draft.mods = ["command"]; }
    if (type === "text" && draft.text == null) draft.text = "";
    if (type === "launch" && draft.target == null) draft.target = "";
    if (type === "macro" && !draft.steps) draft.steps = [];
    modalRoot.querySelectorAll("#ed-type button").forEach((b) => b.classList.toggle("on", b.dataset.type === type));
    renderBody();
  }
  function renderBody() {
    const body = modalRoot.querySelector("#ed-body");
    if (draft.type === "shortcut") body.innerHTML = comboBuilderHTML("");
    else if (draft.type === "text") body.innerHTML = '<div class="ed-label">입력할 텍스트</div><textarea id="ed-text" class="ed-input" placeholder="예: 이메일 주소, 자주 쓰는 문구"></textarea>';
    else if (draft.type === "launch") body.innerHTML =
      '<div class="ed-label">앱 이름 · 경로 · 링크(URL)</div>' +
      '<input id="ed-target" class="ed-input" placeholder="Notes · https://… · shortcuts://…" autocapitalize="off" autocorrect="off">' +
      '<div class="ed-label">설치된 앱에서 선택</div>' +
      '<input id="ed-appsearch" class="ed-input" placeholder="앱 검색…" autocapitalize="off" autocorrect="off">' +
      '<div class="ed-apps" id="ed-apps"></div>';
    else if (draft.type === "macro") body.innerHTML = '<div class="ed-label">매크로 단계 (순서대로 실행)</div><div class="ed-steps" id="ed-steps"></div><button class="ed-addstep" id="ed-addstep">+ 단계 추가</button>';
    wireBody();
  }
  function wireBody() {
    if (draft.type === "shortcut") wireComboBuilder("", draft, () => {});
    else if (draft.type === "text") { const t = modalRoot.querySelector("#ed-text"); t.value = draft.text || ""; t.addEventListener("input", () => draft.text = t.value); }
    else if (draft.type === "launch") {
      const t = modalRoot.querySelector("#ed-target");
      t.value = draft.target || "";
      t.addEventListener("input", () => draft.target = t.value);
      const search = modalRoot.querySelector("#ed-appsearch");
      const appsEl = modalRoot.querySelector("#ed-apps");
      const renderApps = () => {
        appsEl.innerHTML = "";
        if (!installedApps) { appsEl.textContent = "앱 목록 불러오는 중…"; return; }
        const f = (search.value || "").toLowerCase();
        installedApps.filter((a) => a.name.toLowerCase().includes(f)).slice(0, 300).forEach((a) => {
          const b = document.createElement("button");
          b.className = "app-tile";
          if (a.icon) { const im = document.createElement("img"); im.className = "app-ic"; im.src = a.icon; b.appendChild(im); }
          const nm = document.createElement("span"); nm.textContent = a.name; b.appendChild(nm);
          b.addEventListener("click", () => { draft.target = a.path; t.value = a.path; if (a.icon) draft.icon = a.icon; });
          appsEl.appendChild(b);
        });
      };
      search.addEventListener("input", renderApps);
      appsPickerRefresh = renderApps;
      renderApps();
      if (!installedApps) send({ t: "getApps" });
    }
    else if (draft.type === "macro") { renderSteps(); modalRoot.querySelector("#ed-addstep").addEventListener("click", () => { draft.steps.push({ type:"key", keyCode:8, mods:["command"] }); renderSteps(); }); }
  }

  // 조합키 빌더 (단축키 + 매크로 step 공용). prefix 로 id 충돌 방지.
  function comboBuilderHTML(prefix) {
    return '' +
      '<div class="ed-mods" id="' + prefix + 'mods">' +
        '<button data-mod="command">⌘</button><button data-mod="control">⌃</button>' +
        '<button data-mod="shift">⇧</button><button data-mod="option">⌥</button></div>' +
      '<div class="ed-label">키 (직접 입력 또는 아래에서 선택)</div>' +
      '<input id="' + prefix + 'keychar" class="ed-input" maxlength="1" placeholder="a, 1, = …" autocapitalize="off" autocorrect="off">' +
      '<div class="ed-special" id="' + prefix + 'special"></div>' +
      '<div class="ed-preview" id="' + prefix + 'preview"></div>';
  }
  function wireComboBuilder(prefix, target, onChange) {
    const modsEl = modalRoot.querySelector("#" + prefix + "mods");
    const charEl = modalRoot.querySelector("#" + prefix + "keychar");
    const specialEl = modalRoot.querySelector("#" + prefix + "special");
    const previewEl = modalRoot.querySelector("#" + prefix + "preview");
    function refresh() { previewEl.textContent = comboLabel(target.keyCode, target.mods); onChange(); }

    modsEl.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", (target.mods || []).includes(b.dataset.mod));
      b.addEventListener("click", () => {
        const m = b.dataset.mod;
        if (!target.mods) target.mods = [];
        if (target.mods.includes(m)) target.mods = target.mods.filter((x) => x !== m); else target.mods.push(m);
        b.classList.toggle("on"); refresh();
      });
    });
    // 직접 입력
    const cur = keyLabel(target.keyCode);
    if (cur.length === 1) charEl.value = cur.toLowerCase();
    charEl.addEventListener("input", () => {
      const kc = keyCodeForChar(charEl.value);
      if (kc !== null) { target.keyCode = kc; specialEl.querySelectorAll("button").forEach((x) => x.classList.remove("on")); refresh(); }
    });
    // 특수키 그리드
    SPECIAL_KEYS.forEach((sp) => {
      const b = document.createElement("button");
      b.textContent = sp.label; b.classList.toggle("on", target.keyCode === sp.keyCode);
      b.addEventListener("click", () => {
        target.keyCode = sp.keyCode; charEl.value = "";
        specialEl.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); refresh();
      });
      specialEl.appendChild(b);
    });
    refresh();
  }

  // 매크로 단계 렌더
  function renderSteps() {
    const wrap = modalRoot.querySelector("#ed-steps");
    wrap.innerHTML = "";
    draft.steps.forEach((step, idx) => {
      const row = document.createElement("div");
      row.className = "ed-step";
      const head = document.createElement("div");
      head.className = "ed-step-head";
      const sel = document.createElement("select");
      [["key","단축키"],["text","텍스트"],["delay","딜레이"],["launch","앱/링크"]].forEach(([v,l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l; if (step.type === v) o.selected = true; sel.appendChild(o);
      });
      sel.addEventListener("change", () => { step.type = sel.value; if (step.type==="key" && step.keyCode==null){step.keyCode=8;step.mods=["command"];} renderSteps(); });
      const rm = document.createElement("button"); rm.className = "rm"; rm.textContent = "✕";
      rm.addEventListener("click", () => { draft.steps.splice(idx, 1); renderSteps(); });
      head.appendChild(sel); head.appendChild(rm); row.appendChild(head);

      const bodyId = "step" + idx + "_";
      const sb = document.createElement("div");
      if (step.type === "key") { sb.innerHTML = comboBuilderHTML(bodyId); }
      else if (step.type === "text") { sb.innerHTML = '<input class="ed-input" placeholder="입력할 텍스트">'; }
      else if (step.type === "delay") { sb.innerHTML = '<input class="ed-input" type="number" placeholder="밀리초 (예: 200)">'; }
      else if (step.type === "launch") { sb.innerHTML = '<input class="ed-input" placeholder="앱 이름 · 경로 · https://… · shortcuts://…" autocapitalize="off" autocorrect="off">'; }
      row.appendChild(sb); wrap.appendChild(row);

      if (step.type === "key") { if (!step.mods) step.mods = []; wireComboBuilder(bodyId, step, () => {}); }
      else if (step.type === "text") { const i = sb.querySelector("input"); i.value = step.text||""; i.addEventListener("input",()=>step.text=i.value); }
      else if (step.type === "delay") { const i = sb.querySelector("input"); i.value = step.ms||""; i.addEventListener("input",()=>step.ms=parseInt(i.value,10)||0); }
      else if (step.type === "launch") { const i = sb.querySelector("input"); i.value = step.target||""; i.addEventListener("input",()=>step.target=i.value); }
    });
  }

  function saveDraft() {
    if (!draft.label) draft.label = defaultLabel(draft);
    const folderEl = modalRoot.querySelector("#ed-folder");
    let dest = folderEl ? parseInt(folderEl.value, 10) : activeFolder;
    if (isNaN(dest) || dest < 0 || dest >= deck.folders.length) dest = activeFolder;
    const srcItems = deck.folders[activeFolder].items;
    if (draftIndex >= 0) {
      if (dest === activeFolder) { srcItems[draftIndex] = draft; }
      else { srcItems.splice(draftIndex, 1); deck.folders[dest].items.push(draft); activeFolder = dest; }
    } else {
      deck.folders[dest].items.push(draft); activeFolder = dest;
    }
    saveDeck(); closeEditor(); renderDeck();
  }
  function defaultLabel(d) {
    if (d.type === "shortcut") return comboLabel(d.keyCode, d.mods);
    if (d.type === "text") return (d.text || "텍스트").slice(0, 8);
    if (d.type === "launch") return "앱";
    if (d.type === "macro") return "매크로";
    return "버튼";
  }

  // ═════════ 설정 모달 ═════════
  function fmt(key) {
    if (key === "accel" || key === "pointerSmoothing") return Math.round(settings[key] * 100) + "%";
    if (key === "pointerHz") return Math.round(settings[key]) + "Hz";
    return settings[key].toFixed(2).replace(/\.00$/, "") + "×";
  }
  function sliderHTML(id, label, min, max, step) {
    return '<div class="set-row"><label>' + label + '</label><span class="set-val" id="sv-' + id + '"></span></div>' +
      '<input type="range" class="set-slider" id="set-' + id + '" min="' + min + '" max="' + max + '" step="' + step + '">';
  }
  function openSettings() {
    modalRoot.innerHTML =
      '<div class="modal-bg"></div><div class="modal-card">' +
      '<div class="modal-head"><div class="modal-title">설정</div><button id="set-close" class="modal-x">✕</button></div>' +
      '<div class="set-section">테마</div>' +
      '<div class="seg" id="set-theme"><button data-theme="system">시스템</button><button data-theme="light">라이트</button><button data-theme="dark">다크</button></div>' +
      '<div class="set-section">화면 모드</div>' +
      '<div class="seg" id="set-layout"><button data-lay="auto">자동</button><button data-lay="phone">폰</button><button data-lay="tablet">태블릿</button></div>' +
      '<div class="set-section">Obsidian 볼트 (이 기기에만 저장)</div>' +
      '<div class="gesture-row"><label for="set-vault-primary">볼트 1</label><input class="set-text" id="set-vault-primary" placeholder="선택 사항" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="gesture-row"><label for="set-vault-secondary">볼트 2</label><input class="set-text" id="set-vault-secondary" placeholder="선택 사항" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="set-section">제스처 할당</div>' +
      GESTURE_SLOTS.map(function (slot) {
        return '<div class="gesture-row"><label>' + slot[1] + '</label><select data-gkey="' + slot[0] + '">' +
          Object.keys(GESTURE_ACTIONS).map(function (a) { return '<option value="' + a + '">' + GESTURE_ACTIONS[a].label + '</option>'; }).join("") +
          '</select></div>';
      }).join("") +
      '<div class="set-section">네트워크/주사율</div>' +
      '<div class="seg net-presets" id="set-network"><button data-net="auto">자동</button><button data-net="fast">빠른 Wi-Fi</button><button data-net="balanced">균형</button><button data-net="stable">불안정</button><button data-net="manual">수동</button></div>' +
      '<div class="latency-card"><span>현재 지연율</span><b id="set-latency">' + (latencyMs ? latencyMs + "ms" : "측정 중") + '</b></div>' +
      sliderHTML("hz", "전송 주사율", 24, 120, 1) +
      sliderHTML("smooth", "움직임 보정", 0, 0.45, 0.01) +
      sliderHTML("resolution", "해상도 배율", 0.5, 2, 0.05) +
      '<div class="set-section">미러 화질 (미러 탭 열려 있을 때만 동작 · 최대는 대역폭·부하↑)</div>' +
      '<div class="seg" id="set-mirror"><button data-mq="auto">자동</button><button data-mq="high">고화질</button><button data-mq="max">최대(원본급)</button></div>' +
      '<div class="set-section">트랙패드</div>' +
      sliderHTML("move", "커서 속도", 0.4, 3, 0.1) +
      sliderHTML("accel", "포인터 가속", 0, 0.15, 0.01) +
      sliderHTML("scroll", "스크롤 속도", 0.3, 3, 0.1) +
      sliderHTML("air", "에어마우스 감도", 0.3, 3, 0.1) +
      '<div class="set-row"><label>스크롤 방향 반전</label><input type="checkbox" id="set-scrolldir"></div>' +
      '<div class="modal-actions"><button id="set-reset" class="danger">기본값</button><span style="flex:1"></span><button id="set-done" class="primary">완료</button></div>' +
      '<div class="about"><img class="logo-img about-logo" alt="CmdSpace"><div class="copyright">CmdSpace Pilot · fork of MacPilot</div></div>' +
      '</div>';
    const close = () => { modalRoot.innerHTML = ""; networkUIRefresh = null; };
    modalRoot.querySelector(".modal-bg").addEventListener("click", close);
    modalRoot.querySelector("#set-close").addEventListener("click", close);
    modalRoot.querySelector("#set-done").addEventListener("click", close);

    const bind = (id, key, manualOnInput) => {
      const el = modalRoot.querySelector("#set-" + id);
      const val = modalRoot.querySelector("#sv-" + id);
      el.value = settings[key];
      val.textContent = fmt(key);
      el.addEventListener("input", () => {
        settings[key] = parseFloat(el.value);
        if (manualOnInput) settings.networkPreset = "manual";
        val.textContent = fmt(key);
        saveSettings();
        refreshNetworkButtons();
      });
    };
    bind("move", "moveSpeed");
    bind("accel", "accel");
    bind("scroll", "scrollSpeed");
    bind("air", "airSensitivity");
    bind("hz", "pointerHz", true);
    bind("smooth", "pointerSmoothing", true);
    bind("resolution", "resolutionScale", true);

    [["primary", "vaultPrimary"], ["secondary", "vaultSecondary"]].forEach(([id, key]) => {
      const el = modalRoot.querySelector("#set-vault-" + id);
      el.value = settings[key] || "";
      el.addEventListener("input", () => { settings[key] = el.value; saveSettings(); });
    });

    function syncNetworkSliders() {
      [["hz","pointerHz"],["smooth","pointerSmoothing"],["resolution","resolutionScale"]].forEach(([id, key]) => {
        const el = modalRoot.querySelector("#set-" + id);
        const val = modalRoot.querySelector("#sv-" + id);
        if (el && val) { el.value = settings[key]; val.textContent = fmt(key); }
      });
    }
    function refreshNetworkButtons() {
      modalRoot.querySelectorAll("#set-network button").forEach((b) => {
        b.classList.toggle("on", b.dataset.net === (settings.networkPreset || "balanced"));
      });
      const lat = modalRoot.querySelector("#set-latency");
      if (lat) lat.textContent = latencyMs ? latencyMs + "ms" : "측정 중";
    }
    modalRoot.querySelectorAll("#set-network button").forEach((b) => {
      b.addEventListener("click", () => {
        settings.networkPreset = b.dataset.net;
        applyNetworkPreset(settings.networkPreset);
        saveSettings();
        syncNetworkSliders();
        refreshNetworkButtons();
      });
    });
    refreshNetworkButtons();
    // 미러 화질 세그
    function refreshMirrorButtons() {
      modalRoot.querySelectorAll("#set-mirror button").forEach((b) => b.classList.toggle("on", b.dataset.mq === (settings.mirrorQuality || "auto")));
    }
    modalRoot.querySelectorAll("#set-mirror button").forEach((b) => {
      b.addEventListener("click", () => {
        settings.mirrorQuality = b.dataset.mq; saveSettings(); refreshMirrorButtons();
        if (mirror.active) startMirror();   // 미러 켜져 있으면 즉시 반영
      });
    });
    refreshMirrorButtons();
    networkUIRefresh = () => { syncNetworkSliders(); refreshNetworkButtons(); };   // 자동 프리셋 조정 시 모달 갱신

    const dir = modalRoot.querySelector("#set-scrolldir");
    dir.checked = settings.scrollDir === -1;
    dir.addEventListener("change", () => { settings.scrollDir = dir.checked ? -1 : 1; saveSettings(); });

    modalRoot.querySelectorAll(".gesture-row select").forEach((sel) => {
      sel.value = settings.gestures[sel.dataset.gkey] || "none";
      sel.addEventListener("change", () => { settings.gestures[sel.dataset.gkey] = sel.value; saveSettings(); });
    });

    modalRoot.querySelectorAll("#set-layout button").forEach((b) => {
      b.classList.toggle("on", b.dataset.lay === (settings.layoutMode || "auto"));
      b.addEventListener("click", () => {
        settings.layoutMode = b.dataset.lay;
        saveSettings(); document.documentElement.__layoutSig = ""; applyDeviceClass(false); renderDeck();
        modalRoot.querySelectorAll("#set-layout button").forEach((x) => x.classList.toggle("on", x === b));
      });
    });

    modalRoot.querySelectorAll("#set-theme button").forEach((b) => {
      b.classList.toggle("on", b.dataset.theme === (settings.theme || "dark"));
      b.addEventListener("click", () => {
        settings.theme = b.dataset.theme; saveSettings(); applyTheme();
        modalRoot.querySelectorAll("#set-theme button").forEach((x) => x.classList.toggle("on", x === b));
      });
    });

    modalRoot.querySelector("#set-reset").addEventListener("click", () => {
      const vaultPrimary = settings.vaultPrimary || "";
      const vaultSecondary = settings.vaultSecondary || "";
      settings = Object.assign({}, SETTINGS_DEFAULTS, {
        vaultPrimary, vaultSecondary,
        gestures: Object.assign({}, DEFAULT_GESTURES),
        gesturesVersion: GESTURES_VERSION
      });
      saveSettings(); applyTheme(); openSettings();
    });
    updateLogos();   // About 로고를 현재 테마에 맞게
  }
  document.getElementById("settings-btn").addEventListener("click", openSettings);

  // ═════════ 트랙패드 ═════════
  const ACCEL_CAP = 30;   // 가속 상한(px/이벤트). 배율/가속량/스크롤은 settings 에서 조절
  const TAP_MS = 250, TAP_MOVE = 8, DOUBLE_MS = 300;
  const FRICTION = 0.92, MOMENTUM_MIN = 0.04;
  const SWIPE3_THRESH = 34, PINCH_DECIDE = 12, ZOOM_STEP = 0.12, SWIPE3_SETTLE = 55;

  const pad = document.getElementById("trackpad");
  let startTime = 0, moved = false, maxTouches = 0;
  let dragging = false, armedForDrag = false;
  let last = null, lastCentroid = null;
  let scrollVX = 0, scrollVY = 0, lastScrollMoveT = 0, momentumRAF = null;
  let lastClickTime = 0, clickCount = 0, lastTapEnd = 0;
  let threeMode = false, g3fired = false, g3start = null, g3last = null, g3startTime = 0;
  let twoMode = null, d0 = 0, c0 = null, lastZoomDist = 0;

  function now() { return performance.now(); }
  function centroid(touches) { let x = 0, y = 0; for (const t of touches) { x += t.clientX; y += t.clientY; } return { x: x / touches.length, y: y / touches.length }; }
  function dist2(touches) { const dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY; return Math.hypot(dx, dy); }
  function stopMomentum() { if (momentumRAF) { cancelAnimationFrame(momentumRAF); momentumRAF = null; } scrollVX = 0; scrollVY = 0; }
  function startMomentum() {
    if (Math.hypot(scrollVX, scrollVY) < MOMENTUM_MIN) return;
    let prev = now();
    const step = (t) => {
      const dt = Math.min(t - prev, 32); prev = t;
      scrollVX *= FRICTION; scrollVY *= FRICTION;
      if (Math.hypot(scrollVX, scrollVY) < MOMENTUM_MIN) { momentumRAF = null; return; }
      queueScroll(scrollVX * dt * settings.scrollSpeed * settings.scrollDir, scrollVY * dt * settings.scrollSpeed * settings.scrollDir);
      momentumRAF = requestAnimationFrame(step);
    };
    momentumRAF = requestAnimationFrame(step);
  }
  // ───────── 제스처 → 기능 할당 ─────────
  // 3·4손가락 스와이프(각 4방향)에 원하는 동작을 설정(⚙ → 제스처 할당)으로 배정한다.
  // 사파리는 동시 터치 5개까지 추적하므로 손가락 수는 touches.length 로 판별.
  const GESTURE_ACTIONS = {
    none: { label: "없음", run: () => {} },
    back: { label: "뒤로 (⌘←)", run: () => send({ t: "key", keyCode: 123, mods: ["command"] }) },
    forward: { label: "앞으로 (⌘→)", run: () => send({ t: "key", keyCode: 124, mods: ["command"] }) },
    mission: { label: "미션 컨트롤 (⌃↑)", run: () => send({ t: "key", keyCode: 126, mods: ["control"] }) },
    expose: { label: "앱 엑스포제 (⌃↓)", run: () => send({ t: "key", keyCode: 125, mods: ["control"] }) },
    spaceLeft: { label: "데스크탑 ← (⌃←)", run: () => send({ t: "key", keyCode: 123, mods: ["control"] }) },
    spaceRight: { label: "데스크탑 → (⌃→)", run: () => send({ t: "key", keyCode: 124, mods: ["control"] }) },
    appswitch: { label: "앱 전환 (⌘⇥)", run: () => send({ t: "key", keyCode: 48, mods: ["command"] }) },
    tabPrev: { label: "이전 탭 (⇧⌘[)", run: () => send({ t: "key", keyCode: 33, mods: ["command", "shift"] }) },
    tabNext: { label: "다음 탭 (⇧⌘])", run: () => send({ t: "key", keyCode: 30, mods: ["command", "shift"] }) },
    spotlightSearch: { label: "스팟라이트 검색 (⌘Space)", run: () => send({ t: "key", keyCode: 49, mods: ["command"] }) },
    raycast: { label: "Raycast (⇧Space)", run: () => send({ t: "key", keyCode: 49, mods: ["shift"] }) },
    whisper: { label: "superwhisper (⌥Space)", run: () => send({ t: "key", keyCode: 49, mods: ["option"] }) },
    presSpot: { label: "발표 스팟라이트 토글", run: () => send({ t: "launch", target: "macpilot://spotlight" }) },
    volUp: { label: "음량 올리기", run: () => send({ t: "volume", dir: "up" }) },
    volDown: { label: "음량 내리기", run: () => send({ t: "volume", dir: "down" }) },
    mute: { label: "음소거", run: () => send({ t: "volume", dir: "mute" }) },
    capture: { label: "영역 캡처 (⇧⌘4)", run: () => send({ t: "key", keyCode: 21, mods: ["command", "shift"] }) }
  };
  const GESTURE_SLOTS = [
    ["s3left", "3손가락 ←"], ["s3right", "3손가락 →"], ["s3up", "3손가락 ↑"], ["s3down", "3손가락 ↓"],
    ["s4left", "4손가락 ←"], ["s4right", "4손가락 →"], ["s4up", "4손가락 ↑"], ["s4down", "4손가락 ↓"]
  ];
  // 매직 트랙패드 표준 배치: 3손가락=탐색/탭, 4손가락=공간/미션컨트롤/엑스포제
  const DEFAULT_GESTURES = {
    s3left: "back", s3right: "forward", s3up: "tabPrev", s3down: "tabNext",
    s4left: "spaceLeft", s4right: "spaceRight", s4up: "mission", s4down: "expose"
  };
  // 기본 매핑 개정 시 1회 재시드(옛 기본값 사용자를 새 표준으로 갱신). 이후 버전에선 커스텀 보존.
  const GESTURES_VERSION = 2;
  if (settings.gesturesVersion !== GESTURES_VERSION) {
    settings.gestures = Object.assign({}, DEFAULT_GESTURES);   // 새 표준으로 1회 리셋
    settings.gesturesVersion = GESTURES_VERSION;
    saveSettings();
  } else {
    settings.gestures = Object.assign({}, DEFAULT_GESTURES, settings.gestures);   // 커스텀 병합
  }

  let gFingers = 3;   // 이번 제스처의 손가락 수 (3 또는 4+)
  // 트랙패드·미러 공유: 손가락 수+방향 → 배정된 제스처 실행 (GESTURE_ACTIONS는 런타임 참조)
  function fireGesture(fingers, dir) {
    const action = GESTURE_ACTIONS[settings.gestures["s" + Math.min(fingers, 4) + dir]] || GESTURE_ACTIONS.none;
    buzz();
    action.run();
  }
  function fireSwipeIfNeeded() {
    if (g3fired || !g3start || !g3last) return;
    const dx = g3last.x - g3start.x, dy = g3last.y - g3start.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) < SWIPE3_THRESH) return;   // 우세축 기준 = 상하/좌우 축정렬 스와이프에 민감(매직트랙패드 감도)
    const dir = adx > ady ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
    flushMotion(true);
    fireGesture(gFingers, dir);
    g3fired = true;
  }

  pad.addEventListener("touchstart", (e) => {
    e.preventDefault(); stopMomentum(); flushMotion(true);
    const n = e.touches.length;
    if (n === 1) {
      startTime = now(); moved = false; maxTouches = 1; dragging = false;
      threeMode = false; g3fired = false; g3start = null; g3last = null; twoMode = null;
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      resetMotionFilter();   // 스트로크 시작 — 1€ 속도 스파이크 방지
      armedForDrag = !buttonHeld() && (now() - lastTapEnd) < DOUBLE_MS;
    } else { maxTouches = Math.max(maxTouches, n); armedForDrag = false; }
    if (n === 2) { twoMode = null; d0 = dist2(e.touches); c0 = centroid(e.touches); lastZoomDist = d0; }
    if (n >= 3) {
      if (!threeMode) { threeMode = true; g3fired = false; gFingers = n; }
      else { gFingers = Math.max(gFingers, n); }   // 3→4손가락 추가 감지
      g3start = centroid(e.touches); g3last = g3start;   // 손가락 추가마다 재기준(추가 손가락 무게중심 점프 무시)
      g3startTime = now();                               // 정착 창 리셋
    }
    lastCentroid = centroid(e.touches);
  }, { passive: false });

  pad.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const len = e.touches.length;
    if (threeMode) {
      if (len >= 3) {
        const c = centroid(e.touches);
        if (now() - g3startTime < SWIPE3_SETTLE) g3start = c;   // 착지 정착 창: 기준을 따라가 지터 흡수(오발화 방지)
        g3last = c;
        fireSwipeIfNeeded();
      }
      moved = true; return;
    }
    if (len === 2) {
      const c = centroid(e.touches), d = dist2(e.touches);
      if (twoMode === null) {
        const distChange = Math.abs(d - d0), transChange = c0 ? Math.hypot(c.x - c0.x, c.y - c0.y) : 0;
        if (Math.max(distChange, transChange) > PINCH_DECIDE) { twoMode = distChange > transChange ? "pinch" : "scroll"; if (twoMode === "pinch") lastZoomDist = d; }
      }
      if (twoMode === "pinch") {
        const ratio = d / lastZoomDist;
        if (ratio > 1 + ZOOM_STEP) { send({ t: "zoom", dir: "in" }); lastZoomDist = d; }
        else if (ratio < 1 - ZOOM_STEP) { send({ t: "zoom", dir: "out" }); lastZoomDist = d; }
      } else if (twoMode === "scroll") {
        if (lastCentroid) {
          const dx = c.x - lastCentroid.x, dy = c.y - lastCentroid.y;
          const t = now(), dt = Math.max(t - lastScrollMoveT, 1);
          scrollVX = 0.6 * scrollVX + 0.4 * (dx / dt); scrollVY = 0.6 * scrollVY + 0.4 * (dy / dt); lastScrollMoveT = t;
          if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) queueScroll(dx * settings.scrollSpeed * settings.scrollDir, dy * settings.scrollSpeed * settings.scrollDir);
        }
      }
      lastCentroid = c; moved = true; armedForDrag = false;
    } else if (len === 1 && last) {
      const x = e.touches[0].clientX, y = e.touches[0].clientY;
      const dx = x - last.x, dy = y - last.y;
      if (Math.abs(dx) > TAP_MOVE || Math.abs(dy) > TAP_MOVE) moved = true;
      if (armedForDrag && !dragging && moved) { dragging = true; send({ t: "down", button: "left" }); }
      if (dx !== 0 || dy !== 0) {
        if (dragging) queueMove(dx * settings.moveSpeed, dy * settings.moveSpeed);
        else { const speed = Math.hypot(dx, dy); const f = settings.moveSpeed * (1 + Math.min(speed, ACCEL_CAP) * settings.accel); queueMove(dx * f, dy * f); }
      }
      last = { x, y };
    }
  }, { passive: false });

  pad.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (threeMode) {
      fireSwipeIfNeeded();
      if (e.touches.length === 0) { threeMode = false; g3fired = false; g3start = null; g3last = null; twoMode = null; last = null; lastCentroid = null; maxTouches = 0; armedForDrag = false; }
      return;
    }
    if (e.touches.length === 0) {
      if (dragging) { flushMotion(true); send({ t: "up", button: "left" }); dragging = false; }
      else {
        const duration = now() - startTime;
        if (!moved && duration < TAP_MS && !buttonHeld()) {
          if (maxTouches >= 2) { send({ t: "click", button: "right" }); clickCount = 0; lastClickTime = 0; }
          else { const t = now(); clickCount = (t - lastClickTime < DOUBLE_MS) ? clickCount + 1 : 1; lastClickTime = t; send({ t: "click", button: "left", count: clickCount }); }
          lastTapEnd = now();
        } else if (moved && twoMode === "scroll" && (now() - lastScrollMoveT) < 120) { flushMotion(true); startMomentum(); }
      }
      flushMotion(true);
      last = null; lastCentroid = null; maxTouches = 0; armedForDrag = false; twoMode = null;
    } else {
      if (e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      lastCentroid = centroid(e.touches);
    }
  }, { passive: false });

  pad.addEventListener("touchcancel", () => {
    if (threeMode) fireSwipeIfNeeded();
    if (dragging) { flushMotion(true); send({ t: "up", button: "left" }); dragging = false; }
    threeMode = false; g3fired = false; g3start = null; g3last = null; twoMode = null;
    last = null; lastCentroid = null; maxTouches = 0; armedForDrag = false;
  }, { passive: false });

  applyDeviceClass(true);               // 기기 구분/도킹 클래스 (sheetEl 정의 후 안전)
  renderDeck();
  setSheetPos(sheetPos, false);         // 시작 시 기억된 높이로 (기본: 풀화면)
  // 민감 캐시는 서버가 현재 PIN epoch를 승인한 뒤에만 복원한다.
  connect();
})();
