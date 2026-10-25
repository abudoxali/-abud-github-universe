/* ABUD Universe experience layer: a dependency-free 3D world selector and future agent surface. */
(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const worlds = {
    core: {
      index: "01", ar: "Core / المنتجات", en: "Core / Products", typeAr: "نظام المنتجات", typeEn: "PRODUCT SYSTEM",
      descriptionAr: "المشاريع الأساسية والأدوات التي تبني عليها شغلك اليومي.", descriptionEn: "The products and tools that support your daily work.", countAr: "الأساس", countEn: "FOUNDATION"
    },
    games: {
      index: "02", ar: "Games / العوالم", en: "Games / Worlds", typeAr: "مختبر العوالم", typeEn: "WORLD LAB",
      descriptionAr: "التجارب التفاعلية، الألعاب، وبناء عوالم قابلة للّعب والاستكشاف.", descriptionEn: "Interactive experiments, games and playable worlds in progress.", countAr: "تجارب", countEn: "EXPERIMENTS"
    },
    studio: {
      index: "03", ar: "Studio / الاستوديو", en: "Studio / Media", typeAr: "خط الإنتاج الإبداعي", typeEn: "CREATIVE PIPELINE",
      descriptionAr: "الفيديو، الحركة، والأدوات التي تحول الفكرة إلى مادة قابلة للنشر.", descriptionEn: "Motion, video and tools that turn ideas into publishable work.", countAr: "إنتاج", countEn: "PRODUCTION"
    }
  };
  let selected = "core";

  function english() { return document.documentElement.lang === "en"; }
  function text(ar, en) { return english() ? en : ar; }

  function updateReadout() {
    const world = worlds[selected];
    const stage = $("#worldStage");
    if (!stage || !world) return;
    stage.dataset.activeWorld = selected;
    document.querySelectorAll("[data-world-focus]").forEach((button) => {
      const active = button.dataset.worldFocus === selected;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("#worldReadoutIndex").textContent = world.index;
    $("#worldSelectedName").textContent = text(world.ar, world.en);
    $("#worldSelectedDescription").textContent = text(world.descriptionAr, world.descriptionEn);
    $("#worldSelectedType").textContent = text(world.typeAr, world.typeEn);
    $("#worldSelectedCount").textContent = text(world.countAr, world.countEn);
    $("#worldStageStatus").textContent = text(`العالم ${world.index}`, `WORLD ${world.index}`);
    const link = $("#worldOpenLink");
    if (link) {
      link.href = localHost ? "#worlds" : "#map";
      link.textContent = text("افتح ملفات العالم ↗", "Explore this world ↗");
    }
  }

  function bindStage() {
    const stage = $("#worldStage");
    if (!stage) return;
    document.querySelectorAll("[data-world-focus]").forEach((button) => {
      button.addEventListener("click", () => { selected = button.dataset.worldFocus; updateReadout(); });
    });
    stage.addEventListener("keydown", (event) => {
      const order = Object.keys(worlds);
      const index = order.indexOf(selected);
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      selected = order[(index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + order.length) % order.length];
      updateReadout();
      document.querySelector(`[data-world-focus="${selected}"]`)?.focus();
      event.preventDefault();
    });
    stage.addEventListener("pointermove", (event) => {
      if (reduceMotion()) return;
      const rect = stage.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width - .5) * 2;
      const y = ((event.clientY - rect.top) / rect.height - .5) * 2;
      stage.style.setProperty("--stage-tilt-x", `${(-y * 4).toFixed(2)}deg`);
      stage.style.setProperty("--stage-tilt-y", `${(x * 5).toFixed(2)}deg`);
    });
    stage.addEventListener("pointerleave", () => {
      stage.style.setProperty("--stage-tilt-x", "0deg");
      stage.style.setProperty("--stage-tilt-y", "0deg");
    });
    updateReadout();
  }

  window.addEventListener("DOMContentLoaded", bindStage, { once: true });
  window.addEventListener("abud:language", updateReadout);
})();
