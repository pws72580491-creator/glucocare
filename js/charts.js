/*
 * charts.js — Canvas 기반 경량 차트 렌더러 (외부 라이브러리 없음)
 */
const Charts = (() => {
  function setupCanvas(canvas) {
    // canvas's own laid-out width already accounts for the parent's padding
    // (its CSS rule is width:100% of the parent's *content* box) — reading
    // parentElement.clientWidth instead would include the parent's padding
    // twice and make the canvas overflow past the card edge.
    // canvas.height gets overwritten below with a DPR-scaled pixel value, so on a
    // second render it no longer reflects the intended CSS height — cache it once.
    if (!canvas.dataset.baseHeight) canvas.dataset.baseHeight = canvas.getAttribute('height') || '160';
    const cssHeight = Number(canvas.dataset.baseHeight);

    canvas.style.width = ''; // drop any inline width from a previous render before re-measuring
    const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function niceRange(min, max, pad = 0.12) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    return { min: min - span * pad, max: max + span * pad };
  }

  const PAD = { l: 34, r: 12, t: 10, b: 22 };

  function lineChart(canvas, series, opts = {}) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const allPoints = series.flatMap((s) => s.points);
    if (allPoints.length === 0) {
      ctx.fillStyle = '#8B9089';
      ctx.font = '13px Pretendard, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('표시할 기록이 없습니다', width / 2, height / 2);
      return;
    }

    const ts = allPoints.map((p) => p.t);
    const xMin = Math.min(...ts), xMax = Math.max(...ts);

    let yMin = opts.yMin, yMax = opts.yMax;
    if (yMin === undefined || yMax === undefined) {
      const vs = allPoints.map((p) => p.v);
      const r = niceRange(Math.min(...vs), Math.max(...vs));
      yMin = yMin ?? r.min;
      yMax = yMax ?? r.max;
    }

    const xToPx = (t) => PAD.l + ((t - xMin) / (xMax - xMin || 1)) * (width - PAD.l - PAD.r);
    const yToPx = (v) => height - PAD.b - ((v - yMin) / (yMax - yMin || 1)) * (height - PAD.t - PAD.b);

    // target band
    if (opts.targetMin !== undefined && opts.targetMax !== undefined) {
      ctx.fillStyle = opts.targetColor || 'rgba(63,122,86,0.10)';
      const yTop = yToPx(opts.targetMax);
      const yBot = yToPx(opts.targetMin);
      ctx.fillRect(PAD.l, yTop, width - PAD.l - PAD.r, yBot - yTop);
    }

    // gridlines + y labels
    ctx.strokeStyle = '#E1DFD4';
    ctx.fillStyle = '#8B9089';
    ctx.font = '10.5px Pretendard, sans-serif';
    ctx.textAlign = 'right';
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const v = yMin + ((yMax - yMin) * i) / gridSteps;
      const y = yToPx(v);
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(width - PAD.r, y);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillText(Math.round(v).toString(), PAD.l - 6, y + 3);
    }

    // x labels (first / last date)
    ctx.textAlign = 'left';
    ctx.fillText(fmtDate(xMin), PAD.l, height - 6);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDate(xMax), width - PAD.r, height - 6);

    // series lines
    series.forEach((s) => {
      if (s.points.length === 0) return;
      const pts = [...s.points].sort((a, b) => a.t - b.t);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = xToPx(p.t), y = yToPx(p.v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();

      pts.forEach((p) => {
        const x = xToPx(p.t), y = yToPx(p.v);
        const outOfRange = opts.targetMin !== undefined && (p.v < opts.targetMin || p.v > opts.targetMax);
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = outOfRange ? '#B24632' : s.color;
        ctx.fill();
      });
    });
  }

  function barChart(canvas, labels, values, colors) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const max = Math.max(1, ...values);
    const n = values.length;
    const gap = 14;
    const barW = (width - PAD.l - PAD.r - gap * (n - 1)) / n;

    ctx.font = '10.5px Pretendard, sans-serif';
    values.forEach((v, i) => {
      const x = PAD.l + i * (barW + gap);
      const h = ((height - PAD.t - PAD.b) * v) / max;
      const y = height - PAD.b - h;
      ctx.fillStyle = colors[i] || '#1F5C52';
      roundRectTop(ctx, x, y, barW, h, 6);
      ctx.fill();

      ctx.fillStyle = '#232420';
      ctx.textAlign = 'center';
      ctx.fillText(String(v), x + barW / 2, y - 6);
      ctx.fillStyle = '#8B9089';
      ctx.fillText(labels[i], x + barW / 2, height - 6);
    });
  }

  function roundRectTop(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  return { lineChart, barChart };
})();
