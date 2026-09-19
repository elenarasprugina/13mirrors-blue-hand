/* =========================================================================
   МАРШРУТ «СИНЯЯ РУКА» — логика приложения
   Ванильный JS, без сборки и без бэкенда. Один живой маршрут, три режима
   входа (Observation / Journey / Immersion), локальное время по Москве.
   ========================================================================= */
(function () {
  "use strict";

  var CFG = window.BH_CONFIG;
  var POINTS = window.BH_POINTS;
  var DAYS = window.BH_DAYS;

  var LS = {
    INTRO_SEEN: "bh_intro_seen",
    MODE: "bh_mode",
    DAY_ENTERED_PREFIX: "bh_day_entered_", // + dayIndex -> "YYYY-MM-DD" (moscow calendar date when first entered)
    FINALE_PLAYED: "bh_finale_played" // "YYYY-MM-DD" of the moscow date it was completed, once
  };

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore (private mode etc.) */ }
  }

  /* ----------------------------- Время по Москве ----------------------------- */

  // Позволяет тестировать разные даты без изменения системных часов:
  // ?debugNow=2026-09-25T10:00:00 в адресной строке.
  function getNow() {
    var params = new URLSearchParams(window.location.search);
    var dbg = params.get("debugNow");
    if (dbg) {
      var d = new Date(dbg);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  function getMoscowParts(date) {
    var fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: CFG.timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });
    var parts = fmt.formatToParts(date);
    var map = {};
    parts.forEach(function (p) { map[p.type] = p.value; });
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      hour: parseInt(map.hour === "24" ? "0" : map.hour, 10),
      minute: parseInt(map.minute, 10),
      second: parseInt(map.second, 10)
    };
  }

  function dateKey(parts) {
    return parts.year + "-" + String(parts.month).padStart(2, "0") + "-" + String(parts.day).padStart(2, "0");
  }

  function calendarUTC(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day);
  }

  function computeRouteState() {
    var now = getNow();
    var parts = getMoscowParts(now);
    var todayUTC = calendarUTC(parts);
    var startUTC = Date.UTC(CFG.startDate.year, CFG.startDate.month - 1, CFG.startDate.day);
    var dayIndex = Math.round((todayUTC - startUTC) / 86400000) + 1;

    var phase, currentDay = null;
    if (dayIndex < 1) {
      phase = "waiting";
    } else if (dayIndex <= CFG.totalDays) {
      phase = "active";
      currentDay = dayIndex;
    } else {
      phase = "finished";
    }
    return {
      phase: phase,
      currentDay: currentDay,
      todayKey: dateKey(parts),
      now: now
    };
  }

  /* ----------------------------- Режим входа ----------------------------- */

  var MODE_LABELS = {
    observation: "Наблюдение",
    journey: "Путешествие",
    immersion: "Погружение"
  };

  function detectMode() {
    var path = window.location.pathname.toLowerCase().replace(/\/+$/, "");
    var params = new URLSearchParams(window.location.search);
    var qMode = (params.get("mode") || "").toLowerCase();

    var fromPath = null;
    if (/(^|\/)(nablyudenie|observation)$/.test(path)) fromPath = "observation";
    else if (/(^|\/)(puteshestvie|journey)$/.test(path)) fromPath = "journey";
    else if (/(^|\/)(pogruzhenie|immersion)$/.test(path)) fromPath = "immersion";

    var fromQuery = null;
    if (qMode === "observation" || qMode === "nablyudenie") fromQuery = "observation";
    else if (qMode === "journey" || qMode === "puteshestvie") fromQuery = "journey";
    else if (qMode === "immersion" || qMode === "pogruzhenie") fromQuery = "immersion";

    var resolved = fromPath || fromQuery;
    if (resolved) {
      lsSet(LS.MODE, resolved);
      return resolved;
    }
    var stored = lsGet(LS.MODE);
    if (stored === "observation" || stored === "journey" || stored === "immersion") return stored;
    return "observation";
  }

  /* ----------------------------- DOM helpers ----------------------------- */

  var screens = {};
  function showScreen(name) {
    Object.keys(screens).forEach(function (k) {
      screens[k].classList.toggle("is-visible", k === name);
    });
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /* ----------------------------- Приложение ----------------------------- */

  var App = {
    mode: null,
    state: null,
    dayCardOpenDay: null,

    init: function () {
      screens.intro = document.getElementById("screen-intro");
      screens.waiting = document.getElementById("screen-waiting");
      screens.scene = document.getElementById("screen-scene");
      screens.finale = document.getElementById("screen-finale");

      this.mode = detectMode();
      this.state = computeRouteState();

      this.renderIntroScreen();
      this.renderWaitingScreen();

      var introSeen = lsGet(LS.INTRO_SEEN) === "1";
      if (!introSeen) {
        showScreen("intro");
      } else {
        this.renderCurrentState();
      }

      this.bindModal();

      // Периодическая проверка смены дня/фазы (полночь по Москве и т.п.)
      var self = this;
      setInterval(function () { self.tick(); }, 30000);
    },

    tick: function () {
      var fresh = computeRouteState();
      var changed = !this.state ||
        fresh.phase !== this.state.phase ||
        fresh.currentDay !== this.state.currentDay;
      this.state = fresh;
      if (changed && lsGet(LS.INTRO_SEEN) === "1") {
        // не прерываем, если открыта карта дня — просто обновим сцену под ней
        this.renderCurrentState();
      }
    },

    renderCurrentState: function () {
      if (this.state.phase === "waiting") {
        showScreen("waiting");
      } else if (this.state.phase === "finished") {
        this.showCompletedFinale();
      } else {
        this.renderScene();
        showScreen("scene");
      }
    },

    /* ---------------- INTRO ---------------- */
    renderIntroScreen: function () {
      var root = screens.intro;
      root.innerHTML = "";
      var bg = el("img", "screen-bg");
      bg.src = "assets/hands_master.jpg";
      bg.alt = "";
      var veil = el("div", "screen-veil");
      var content = el("div", "screen-content");

      var introMd = (window.BH_INTRO_TEXT || "").trim();
      var lines = introMd
        .split("\n")
        .filter(function (l) { return l.trim().length && !/^\*\*Кнопка/i.test(l.trim()); })
        .map(function (l) { return l.replace(/\*\*/g, "").trim(); });

      lines.forEach(function (line) {
        content.appendChild(el("p", null, line));
      });

      var btn = el("button", "btn primary", "Войти в маршрут");
      btn.addEventListener("click", function () {
        lsSet(LS.INTRO_SEEN, "1");
        App.state = computeRouteState();
        App.renderCurrentState();
      });
      content.appendChild(btn);

      root.appendChild(bg);
      root.appendChild(veil);
      root.appendChild(content);
    },

    /* ---------------- WAITING ---------------- */
    renderWaitingScreen: function () {
      var root = screens.waiting;
      root.innerHTML = "";
      var bg = el("img", "screen-bg");
      bg.src = "assets/hands_master.jpg";
      bg.alt = "";
      var veil = el("div", "screen-veil");
      var content = el("div", "screen-content");
      content.appendChild(el("h1", null, CFG.waitingText));
      content.appendChild(el("p", "dim", "Маршрут «Синяя Рука» · 13 дней"));
      root.appendChild(bg);
      root.appendChild(veil);
      root.appendChild(content);
    },

    /* ---------------- MAIN SCENE ---------------- */
    getDayState: function (dayNumber) {
      var current = this.state.currentDay;
      if (dayNumber > current) return "future";
      if (dayNumber < current) return "past";
      // dayNumber === current
      var enteredKey = lsGet(LS.DAY_ENTERED_PREFIX + dayNumber);
      if (enteredKey === this.state.todayKey) return "active";
      return "idle";
    },

    renderScene: function () {
      var root = screens.scene;
      root.innerHTML = "";

      var wrap = el("div", "scene-wrap");
      var bg = el("img", null);
      bg.src = "assets/hands_master.jpg";
      bg.alt = "Маршрут Синяя Рука";
      wrap.appendChild(bg);

      var topbar = el("div", "scene-topbar");
      var pill = el("div", "pill", "День " + this.state.currentDay + " из " + CFG.totalDays + " · " + MODE_LABELS[this.mode]);
      topbar.appendChild(pill);
      wrap.appendChild(topbar);

      var sparkLayer = el("div", "spark-layer");
      wrap.appendChild(sparkLayer);
      this._sparkLayer = sparkLayer;
      this._sceneWrap = wrap;

      for (var i = 1; i <= 13; i++) {
        var p = POINTS[i];
        var dayState = this.getDayState(i);
        var btn = el("button", "hotspot state-" + dayState);
        btn.style.left = p.x + "%";
        btn.style.top = p.y + "%";
        btn.setAttribute("data-day", i);
        btn.setAttribute("aria-label", "День " + i);
        var dot = el("span", "dot");
        btn.appendChild(dot);
        if (dayState === "idle" || dayState === "active") {
          btn.addEventListener("click", this.onDayNodeClick.bind(this, i));
        } else {
          btn.disabled = true;
        }
        wrap.appendChild(btn);
      }

      root.appendChild(wrap);
    },

    onDayNodeClick: function (dayNumber) {
      if (this._animating) return;
      var p = POINTS[dayNumber];
      var target = POINTS[p.target] || p;
      this._animating = true;
      this.playEntryAnimation(p, target, function () {
        lsSet(LS.DAY_ENTERED_PREFIX + dayNumber, App.state.todayKey);
        App.openDayCard(dayNumber);
        App._animating = false;
        // обновим точку на состояние "active" под карточкой
        var wrap = App._sceneWrap;
        if (wrap) {
          var hs = wrap.querySelector('.hotspot[data-day="' + dayNumber + '"]');
          if (hs) hs.className = "hotspot state-active";
        }
      });
    },

    playEntryAnimation: function (from, to, done) {
      var wrap = this._sceneWrap;
      var layer = this._sparkLayer;
      layer.innerHTML = "";

      var rect = wrap.getBoundingClientRect();
      var fx = (from.x / 100) * rect.width;
      var fy = (from.y / 100) * rect.height;
      var tx = (to.x / 100) * rect.width;
      var ty = (to.y / 100) * rect.height;
      var sameSpot = Math.abs(fx - tx) < 2 && Math.abs(fy - ty) < 2;

      // burst at origin node
      var originBurst = el("div", "spark-burst");
      originBurst.style.left = fx + "px";
      originBurst.style.top = fy + "px";
      layer.appendChild(originBurst);
      requestAnimationFrame(function () {
        originBurst.style.transition = "opacity 0.35s ease, transform 0.5s ease";
        originBurst.style.opacity = "1";
        originBurst.style.transform = "scale(1)";
      });

      var totalMs = 2500;

      if (sameSpot) {
        // просто усиливающееся свечение в центре (точки 6/7/13)
        setTimeout(function () {
          originBurst.style.opacity = "0";
        }, totalMs - 250);
        setTimeout(done, totalMs);
        return;
      }

      // path: лёгкая дуга между точками
      var mx = (fx + tx) / 2 + (ty - fy) * 0.12;
      var my = (fy + ty) / 2 - (tx - fx) * 0.12;
      var pathData = "M " + fx + " " + fy + " Q " + mx + " " + my + " " + tx + " " + ty;

      var svgNS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "spark-line");
      svg.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height);
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", pathData);
      svg.appendChild(path);
      layer.appendChild(svg);

      var dot = el("div", "spark-dot");
      layer.appendChild(dot);

      requestAnimationFrame(function () {
        path.style.transition = "opacity 0.2s ease";
        path.style.opacity = "1";
        path.animate(
          [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
          { duration: totalMs * 0.62, delay: 250, fill: "forwards", easing: "ease-in-out" }
        );
      });

      var pathLen = path.getTotalLength ? path.getTotalLength() : null;
      var travelStart = 250;
      var travelDuration = totalMs * 0.62;
      var startTime = null;

      dot.style.opacity = "1";
      dot.style.left = fx + "px";
      dot.style.top = fy + "px";

      function step(ts) {
        if (!startTime) startTime = ts;
        var elapsed = ts - startTime - travelStart;
        if (elapsed < 0) {
          requestAnimationFrame(step);
          return;
        }
        var t = Math.min(1, elapsed / travelDuration);
        var pt;
        if (pathLen) {
          pt = path.getPointAtLength(t * pathLen);
        } else {
          pt = { x: fx + (tx - fx) * t, y: fy + (ty - fy) * t };
        }
        dot.style.left = pt.x + "px";
        dot.style.top = pt.y + "px";
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          // прибытие — усиливаем свечение в целевой точке
          var arrivalBurst = el("div", "spark-burst");
          arrivalBurst.style.left = tx + "px";
          arrivalBurst.style.top = ty + "px";
          arrivalBurst.style.transform = "scale(0.6)";
          arrivalBurst.style.opacity = "1";
          layer.appendChild(arrivalBurst);
          requestAnimationFrame(function () {
            arrivalBurst.style.transition = "opacity 0.6s ease, transform 0.8s ease";
            arrivalBurst.style.transform = "scale(1.6)";
          });
          dot.style.transition = "opacity 0.25s ease";
          dot.style.opacity = "0";
        }
      }
      requestAnimationFrame(step);

      setTimeout(done, totalMs);
    },

    /* ---------------- DAY CARD ---------------- */
    bindModal: function () {
      this.modalBackdrop = document.getElementById("modal-backdrop");
      var self = this;
      this.modalBackdrop.addEventListener("click", function (e) {
        if (e.target === self.modalBackdrop) self.closeDayCard();
      });
    },

    openDayCard: function (dayNumber) {
      this.dayCardOpenDay = dayNumber;
      var day = DAYS[dayNumber - 1];
      var card = document.getElementById("day-card");
      card.innerHTML = "";
      card.scrollTop = 0;

      var header = el("div", "day-card-header");
      header.appendChild(el("h1", null, day.title));
      card.appendChild(header);

      var sPT = el("section");
      var pair = el("div", "pair-block");
      var colSeal = el("div", "col");
      colSeal.appendChild(el("div", "label", "Печать"));
      colSeal.appendChild(el("p", null, day.seal));
      colSeal.appendChild(el("p", "dim", day.sealShort));
      var colTone = el("div", "col");
      colTone.appendChild(el("div", "label", "Тон"));
      colTone.appendChild(el("p", null, day.tone));
      colTone.appendChild(el("p", "dim", day.toneShort));
      pair.appendChild(colSeal);
      pair.appendChild(colTone);
      sPT.appendChild(pair);
      card.appendChild(sPT);

      var sConn = el("section");
      sConn.appendChild(el("div", "label", "Связка"));
      sConn.appendChild(el("p", null, day.connection));
      card.appendChild(sConn);

      var sAbout = el("section");
      sAbout.appendChild(el("div", "label", "О чём этот день"));
      sAbout.appendChild(el("p", null, day.about));
      card.appendChild(sAbout);

      var sPrac = el("section");
      sPrac.appendChild(el("div", "label", "Практики"));
      var p1 = el("div", "practice-block");
      p1.appendChild(el("h3", null, day.practice1.title));
      p1.appendChild(el("p", null, day.practice1.text));
      var p2 = el("div", "practice-block");
      p2.appendChild(el("h3", null, day.practice2.title));
      p2.appendChild(el("p", null, day.practice2.text));
      sPrac.appendChild(p1);
      sPrac.appendChild(p2);
      card.appendChild(sPrac);

      var sTrace = el("section");
      sTrace.appendChild(el("div", "label", "След"));
      var traceBlock = el("div", "trace-block");
      if (this.mode === "observation") {
        traceBlock.appendChild(el("p", null, "Оставить след доступно в форматах с сопровождением: Путешествие, Погружение."));
      } else {
        var url = this.mode === "journey" ? CFG.links.journey : CFG.links.immersion;
        var linkBtn = el("a", "btn link", "Оставить след");
        linkBtn.href = url;
        linkBtn.target = "_blank";
        linkBtn.rel = "noopener noreferrer";
        traceBlock.appendChild(el("p", "dim", "Сопровождение происходит в Telegram."));
        traceBlock.appendChild(linkBtn);
      }
      sTrace.appendChild(traceBlock);
      card.appendChild(sTrace);

      var actions = el("div", "day-card-actions");
      if (dayNumber === 13 && day.finalCta) {
        var finalBtn = el("button", "btn primary", day.finalCta);
        finalBtn.addEventListener("click", function () {
          App.closeDayCard();
          App.startDay13Finale();
        });
        actions.appendChild(finalBtn);
      }
      var backBtn = el("button", "btn ghost", "Вернуться в пространство маршрута");
      backBtn.addEventListener("click", function () { App.closeDayCard(); });
      actions.appendChild(backBtn);
      card.appendChild(actions);

      this.modalBackdrop.classList.add("is-visible");
      card.scrollTop = 0;
      requestAnimationFrame(function () { card.scrollTop = 0; });
    },

    closeDayCard: function () {
      this.modalBackdrop.classList.remove("is-visible");
      if (this._sparkLayer) this._sparkLayer.innerHTML = "";
    },

    /* ---------------- DAY 13 FINALE ---------------- */
    startDay13Finale: function () {
      var root = screens.finale;
      root.innerHTML = "";

      var stage = el("div", "finale-stage");
      var startImg = el("img", null);
      startImg.src = "assets/day13_start.jpg";
      startImg.alt = "";
      stage.appendChild(startImg);
      root.appendChild(stage);
      showScreen("finale");

      var video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.muted = true;
      video.autoplay = true;
      video.controls = false;
      video.preload = "auto";
      video.style.opacity = "0";
      video.style.transition = "opacity 0.4s ease";
      stage.appendChild(video);

      var revealed = false;
      var fallbackDone = false;
      function reveal() {
        if (revealed) return;
        revealed = true;
        video.style.opacity = "1";
        startImg.style.opacity = "0";
      }
      // Если видео вообще не может проиграться в этом браузере (не тот формат,
      // сеть и т.п.) — не оставляем пользователя на чёрном экране, а сразу
      // показываем финальный кадр и тексты.
      function fallbackToFinal() {
        if (fallbackDone) return;
        fallbackDone = true;
        App.finishFinaleScene(stage, /*fromEnd*/ true);
      }

      video.addEventListener("playing", reveal);
      video.addEventListener("error", fallbackToFinal);
      video.addEventListener("ended", function () {
        App.finishFinaleScene(stage, /*fromEnd*/ true);
      });

      var playAttempted = false;
      function tryPlay() {
        if (playAttempted) return;
        playAttempted = true;
        var p = video.play();
        if (p && p.catch) {
          p.then(reveal).catch(function () {
            if (video.error) { fallbackToFinal(); return; }
            // автоплей заблокирован политикой браузера — показать кнопку запуска
            App.showFinaleTapToPlay(stage, video, startImg, fallbackToFinal);
          });
        } else {
          reveal();
        }
      }

      video.addEventListener("canplay", tryPlay, { once: true });
      setTimeout(tryPlay, 600);
      // если через 6с ничего не произошло (ни воспроизведение, ни ошибка,
      // ни кнопка запуска) — считаем формат неподдерживаемым и идём в финал
      setTimeout(function () {
        if (!revealed && !fallbackDone && !stage.querySelector(".finale-tap-btn")) fallbackToFinal();
      }, 6000);

      video.src = "assets/day13_namaste.mp4";
      video.load();
    },

    showFinaleTapToPlay: function (stage, video, startImg, fallbackToFinal) {
      var btn = el("button", "btn primary finale-tap-btn", "Продолжить");
      btn.addEventListener("click", function () {
        video.muted = false;
        video.play().then(function () {
          video.style.opacity = "1";
          startImg.style.opacity = "0";
          btn.remove();
        }).catch(function () {
          if (video.error) { btn.remove(); fallbackToFinal(); return; }
          video.muted = true;
          video.play();
          video.style.opacity = "1";
          startImg.style.opacity = "0";
          btn.remove();
        });
      });
      stage.appendChild(btn);
    },

    finishFinaleScene: function (stage, fromEnd) {
      // финальный кадр
      var existingVideo = stage.querySelector("video");
      if (existingVideo) existingVideo.style.opacity = "0";
      var finalImg = el("img", null);
      finalImg.src = "assets/day13_final.jpg";
      finalImg.alt = "";
      stage.appendChild(finalImg);

      var overlay = el("div", "finale-text-overlay");
      CFG.finale.lines.forEach(function (line) {
        overlay.appendChild(el("div", "line", line));
      });
      stage.appendChild(overlay);
      requestAnimationFrame(function () {
        setTimeout(function () { overlay.classList.add("is-visible"); }, 250);
      });

      if (fromEnd) {
        lsSet(LS.FINALE_PLAYED, this.state.todayKey);
      }
    },

    /* ---------------- Полностью завершённый маршрут (после 4 октября) ---------------- */
    showCompletedFinale: function () {
      var root = screens.finale;
      root.innerHTML = "";
      var stage = el("div", "finale-stage");
      var finalImg = el("img", null);
      finalImg.src = "assets/day13_final.jpg";
      finalImg.alt = "";
      stage.appendChild(finalImg);

      var overlay = el("div", "finale-text-overlay is-visible");
      CFG.finale.lines.forEach(function (line) {
        overlay.appendChild(el("div", "line", line));
      });
      stage.appendChild(overlay);
      root.appendChild(stage);
      showScreen("finale");
    }
  };

  window.BH_APP = App;
  document.addEventListener("DOMContentLoaded", function () { App.init(); });
})();
