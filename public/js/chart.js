/* Minimal dependency-free canvas charts (line + bars) with smooth animation. */

const ChartKit = (() => {
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

  function prepare(canvas) {
    const dpr = DPR();
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(240, rect.width || canvas.clientWidth || 400);
    const height = Number(canvas.getAttribute("height")) || 220;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function niceMax(value) {
    if (!value || value <= 0) return 10;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const n = value / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  function rounded(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /**
   * areaChart(canvas, series, opts)
   * series: [{ name, color, values: [n] }]
   * labels: [string]
   */
  function area(canvas, series, labels, opts = {}) {
    if (!canvas) return;
    const { ctx, width, height } = prepare(canvas);
    const pad = { top: 16, right: 12, bottom: 26, left: 44 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const all = series.flatMap((s) => s.values);
    const max = niceMax(Math.max(...all, 0) * 1.12);
    const steps = 4;

    ctx.clearRect(0, 0, width, height);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.fillStyle = "rgba(141,150,178,0.85)";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.lineWidth = 1;
    for (let i = 0; i <= steps; i++) {
      const y = pad.top + (plotH / steps) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y + 0.5);
      ctx.lineTo(pad.left + plotW, y + 0.5);
      ctx.stroke();
      const value = max - (max / steps) * i;
      ctx.fillText(formatTick(value), 6, y + 4);
    }

    // labels (thin out when crowded)
    const every = Math.ceil(labels.length / Math.max(3, Math.floor(plotW / 64)));
    labels.forEach((label, i) => {
      if (i % every !== 0 && i !== labels.length - 1) return;
      const x = pad.left + (plotW / Math.max(1, labels.length - 1)) * i;
      ctx.fillStyle = "rgba(141,150,178,0.8)";
      ctx.textAlign = i === 0 ? "left" : i === labels.length - 1 ? "right" : "center";
      ctx.fillText(label, x, height - 8);
    });
    ctx.textAlign = "left";

    const xFor = (i) => pad.left + (plotW / Math.max(1, labels.length - 1)) * i;
    const yFor = (v) => pad.top + plotH - (Math.max(0, v) / max) * plotH;

    series.forEach((s, index) => {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      gradient.addColorStop(0, hexA(s.color, 0.32));
      gradient.addColorStop(1, hexA(s.color, 0));

      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = xFor(i);
        const y = yFor(v);
        if (i === 0) ctx.moveTo(x, y);
        else {
          const prevX = xFor(i - 1);
          const prevY = yFor(s.values[i - 1]);
          const mid = (prevX + x) / 2;
          ctx.bezierCurveTo(mid, prevY, mid, y, x, y);
        }
      });
      const linePath = new Path2D();
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.2;
      ctx.shadowColor = hexA(s.color, 0.55);
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.restore();

      // fill underneath (redraw path then close down)
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = xFor(i);
        const y = yFor(v);
        if (i === 0) ctx.moveTo(x, y);
        else {
          const prevX = xFor(i - 1);
          const prevY = yFor(s.values[i - 1]);
          const mid = (prevX + x) / 2;
          ctx.bezierCurveTo(mid, prevY, mid, y, x, y);
        }
      });
      ctx.lineTo(xFor(s.values.length - 1), pad.top + plotH);
      ctx.lineTo(xFor(0), pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // end dot
      const lastX = xFor(s.values.length - 1);
      const lastY = yFor(s.values[s.values.length - 1]);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
    });

    // hover tooltip
    if (opts.tooltip !== false) {
      const tip = ensureTip(canvas);
      canvas.onmousemove = (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        if (x < pad.left || x > pad.left + plotW) return hideTip(tip);
        const ratio = (x - pad.left) / plotW;
        const i = Math.round(ratio * (labels.length - 1));
        tip.hidden = false;
        tip.style.left = Math.min(rect.width - 130, Math.max(0, x - 60)) + "px";
        tip.innerHTML =
          `<strong>${labels[i]}</strong>` +
          series
            .map(
              (s) =>
                `<span><i style="background:${s.color}"></i>${s.name}: <b>${formatMoney(s.values[i])}</b></span>`
            )
            .join("");
      };
      canvas.onmouseleave = () => hideTip(tip);
    }
  }

  function bars(canvas, values, labels, opts = {}) {
    if (!canvas) return;
    const { ctx, width, height } = prepare(canvas);
    const pad = { top: 12, right: 10, bottom: 24, left: 10 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(...values, 0) * 1.1) || 1;
    const gap = Math.max(4, plotW / values.length / 4);
    const barW = Math.max(6, plotW / values.length - gap);

    ctx.clearRect(0, 0, width, height);
    values.forEach((value, i) => {
      const h = (Math.max(0, value) / max) * plotH;
      const x = pad.left + (plotW / values.length) * i + gap / 2;
      const y = pad.top + plotH - h;
      const gradient = ctx.createLinearGradient(0, y, 0, y + h);
      gradient.addColorStop(0, opts.color || "#7c5cff");
      gradient.addColorStop(1, hexA(opts.color || "#7c5cff", 0.18));
      rounded(ctx, x, y, barW, Math.max(2, h), 5);
      ctx.fillStyle = gradient;
      ctx.fill();
    });
    ctx.fillStyle = "rgba(141,150,178,0.8)";
    ctx.font = "10px Inter, system-ui, sans-serif";
    labels.forEach((label, i) => {
      if (i % Math.ceil(labels.length / 7) !== 0 && i !== labels.length - 1) return;
      const x = pad.left + (plotW / values.length) * i + barW / 2;
      ctx.fillText(label, x - 8, height - 7);
    });
  }

  function ensureTip(canvas) {
    const wrap = canvas.parentElement;
    let tip = wrap.querySelector(".chart-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "chart-tip";
      wrap.appendChild(tip);
    }
    return tip;
  }

  function hideTip(tip) {
    tip.hidden = true;
  }

  function hexA(hex, alpha) {
    const value = String(hex || "#7c5cff").replace("#", "");
    const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
    const n = parseInt(full.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function formatTick(value) {
    if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function formatMoney(value) {
    const symbol = (window.SITE && window.SITE.wallet && window.SITE.wallet.symbol) || "$";
    return symbol + Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function sparkline(values, color) {
    return `<svg viewBox="0 0 60 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"
        points="${values
          .map((v, i) => {
            const max = Math.max(...values, 1);
            const x = (i / Math.max(1, values.length - 1)) * 58 + 1;
            const y = 22 - (v / max) * 20;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")}" />
    </svg>`;
  }

  return { area, bars, sparkline, formatMoney };
})();
