const latestUrl = "data/latest.json";
const historyUrl = "data/history.json";
const chartColors = {
  line: { r: 37, g: 99, b: 235 },
  ours: { r: 22, g: 128, b: 60 },
  other: { r: 198, g: 40, b: 40 },
  empty: { r: 208, g: 213, b: 221 },
};

const state = {
  latest: null,
  history: [],
  trendDays: 7,
  chartHoverIndex: null,
  chartPoints: [],
};

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let amount = value;
  let unitIndex = 0;
  while (Math.abs(amount) >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${amount.toFixed(0)} ${units[unitIndex]}`;
  }
  return `${amount.toFixed(2)} ${units[unitIndex]}`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, {
    month: "2-digit",
    day: "2-digit",
  });
}

function formatGpuCount(value) {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  return Number.isInteger(Number(value)) ? String(Number(value)) : Number(value).toFixed(1);
}

function statusClass(status) {
  const normalized = String(status || "muted").toLowerCase();
  return `status-${normalized}`;
}

function fetchJson(url) {
  return fetch(`${url}?t=${Date.now()}`, { cache: "no-store" }).then((response) => {
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return response.json();
  });
}

function pathKey(item) {
  return `${item.label || ""}|${item.path || ""}`;
}

function previousValueFor(item) {
  const key = pathKey(item);
  const samples = [];
  for (const snapshot of state.history) {
    const match = (snapshot.paths || []).find((candidate) => pathKey(candidate) === key);
    if (match && Number.isFinite(match.bytes)) {
      samples.push(match.bytes);
    }
  }
  return samples.length >= 2 ? samples[samples.length - 2] : null;
}

function deltaText(item) {
  const previous = previousValueFor(item);
  if (!Number.isFinite(previous) || !Number.isFinite(item.bytes)) {
    return "No previous sample";
  }
  const delta = item.bytes - previous;
  if (delta === 0) {
    return "No change since previous sample";
  }
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${formatBytes(Math.abs(delta))} since previous sample`;
}

function progressClass(percent) {
  if (!Number.isFinite(percent)) {
    return "";
  }
  if (percent >= 100) {
    return "error";
  }
  if (percent >= 90) {
    return "warn";
  }
  return "";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : "-";
}

function gpuOwnerStatus(gpu) {
  const status = String(gpu.owner_status || "").toLowerCase();
  if (status === "ours" || status === "other" || status === "free") {
    return status;
  }
  return Number(gpu.process_count) > 0 ? "other" : "free";
}

function gpuOwnerLabel(status) {
  if (status === "ours") {
    return "OURS";
  }
  if (status === "other") {
    return "OTHER";
  }
  return "EMPTY";
}

function gpuIsOccupied(gpu) {
  const processCount = Number(gpu.process_count);
  if (Number.isFinite(processCount)) {
    return processCount > 0;
  }
  const status = gpuOwnerStatus(gpu);
  if (status === "ours" || status === "other") {
    return true;
  }
  if (status === "free") {
    return false;
  }
  const util = Number(gpu.gpu_util_percent);
  if (Number.isFinite(util) && util > 0) {
    return true;
  }
  const memoryUsed = Number(gpu.memory_used_bytes);
  return Number.isFinite(memoryUsed) && memoryUsed > 512 * 1024 * 1024;
}

function gpuOccupancyPoint(snapshot) {
  const gpus = Array.isArray(snapshot?.gpu_summary?.items) ? snapshot.gpu_summary.items : [];
  const ownerCounts = gpus.reduce(
    (counts, gpu) => {
      if (!gpuIsOccupied(gpu)) {
        return counts;
      }
      counts.occupied += 1;
      const status = gpuOwnerStatus(gpu);
      if (status === "ours" || status === "other") {
        counts[status] += 1;
      }
      return counts;
    },
    { occupied: 0, ours: 0, other: 0 },
  );
  return {
    time: snapshot.generated_at,
    occupied: ownerCounts.occupied,
    ours: ownerCounts.ours,
    other: ownerCounts.other,
    free: Math.max(0, gpus.length - ownerCounts.occupied),
    total: gpus.length,
  };
}

function renderTotalOverview() {
  const container = byId("totalOverview");
  const summary = state.latest?.filesystem_summary || {};
  const paths = state.latest?.paths || [];
  const totalUsed = paths.reduce((total, item) => total + (Number(item.bytes) || 0), 0);
  const totalQuota = paths.reduce((total, item) => total + (Number(item.quota_bytes) || 0), 0);
  const quotaRemaining = totalQuota > 0 ? totalQuota - totalUsed : null;
  const owner = state.latest?.owner_label || "xiaoqingguo";
  const diskAvailable = summary.total_available_bytes;
  const filesystemUse = Number.isFinite(summary.max_use_percent) ? `${summary.max_use_percent.toFixed(0)}% filesystem used` : "filesystem use unavailable";

  if (!paths.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="total-block">
      <div class="total-label">${escapeHtml(owner)} total used</div>
      <div class="total-value">${escapeHtml(formatBytes(totalUsed))}</div>
      <div class="total-subtext">Across ${escapeHtml(paths.length)} monitored folders; total quota ${escapeHtml(formatBytes(totalQuota))}</div>
    </div>
    <div class="total-block">
      <div class="total-label">Disk remaining</div>
      <div class="total-value">${escapeHtml(formatBytes(diskAvailable))}</div>
      <div class="total-subtext">${escapeHtml(filesystemUse)}; quota balance ${escapeHtml(formatBytes(quotaRemaining))}</div>
    </div>
  `;
}

function renderGpus() {
  const overview = byId("gpuOverview");
  const hint = byId("gpuHint");
  const summary = state.latest?.gpu_summary || {};
  const gpus = Array.isArray(summary.items) ? summary.items : [];

  if (!gpus.length) {
    hint.textContent = summary.error || "No GPU rows are available.";
    overview.innerHTML = `<div class="empty">${escapeHtml(summary.status || "no_data")}</div>`;
    return;
  }

  const activeCount = gpus.filter((gpu) => Number(gpu.gpu_util_percent) > 0).length;
  const utilValues = gpus.map((gpu) => Number(gpu.gpu_util_percent)).filter(Number.isFinite);
  const memoryUsed = gpus.reduce((total, gpu) => total + (Number(gpu.memory_used_bytes) || 0), 0);
  const memoryTotal = gpus.reduce((total, gpu) => total + (Number(gpu.memory_total_bytes) || 0), 0);
  const memoryPercent = memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : null;
  const avgUtil = utilValues.length ? utilValues.reduce((sum, value) => sum + value, 0) / utilValues.length : null;
  const maxUtil = utilValues.length ? Math.max(...utilValues) : null;
  const ownerRoot = state.latest?.owned_process_root || "/home/xiaoqingguo/";
  const ownerCounts = gpus.reduce(
    (counts, gpu) => {
      counts[gpuOwnerStatus(gpu)] += 1;
      return counts;
    },
    { ours: 0, other: 0, free: 0 },
  );
  const excluded = Array.isArray(summary.excluded_indices) && summary.excluded_indices.length
    ? `Excluded GPU ${summary.excluded_indices.join(", ")}`
    : "No GPUs excluded";

  hint.textContent = `${gpus.length} GPUs counted; ${activeCount} active; ${ownerCounts.ours} ours, ${ownerCounts.other} other, ${ownerCounts.free} empty. Owned root: ${ownerRoot}. ${excluded}.`;

  const rows = [...gpus]
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((gpu) => {
      const gpuUtil = Number(gpu.gpu_util_percent);
      const memoryUsedPercent = Number(gpu.memory_used_percent);
      const gpuWidth = Number.isFinite(gpuUtil) ? Math.max(0, Math.min(100, gpuUtil)) : 0;
      const memoryWidth = Number.isFinite(memoryUsedPercent) ? Math.max(0, Math.min(100, memoryUsedPercent)) : 0;
      const powerText = Number.isFinite(gpu.power_draw_watts)
        ? `${gpu.power_draw_watts.toFixed(0)} W`
        : "-";
      const powerLimit = Number.isFinite(gpu.power_limit_watts)
        ? `${gpu.power_limit_watts.toFixed(0)} W limit`
        : "";
      const tempClass = Number(gpu.temperature_c) >= 80 ? "status-error" : Number(gpu.temperature_c) >= 70 ? "status-warn" : "status-muted";
      const ownerStatus = gpuOwnerStatus(gpu);
      const ownerUser = String(gpu.owner_user || "").trim();
      return `
        <tr>
          <td class="gpu-owner-cell">
            <span class="owner-pill owner-${escapeHtml(ownerStatus)}">${escapeHtml(gpuOwnerLabel(ownerStatus))}</span>
            ${ownerUser ? `<span class="owner-user">${escapeHtml(ownerUser)}</span>` : ""}
          </td>
          <td>
            <span class="gpu-id">GPU ${escapeHtml(gpu.index ?? "-")}</span>
          </td>
          <td>
            <span class="gpu-name">${escapeHtml(gpu.name || "GPU")}</span>
          </td>
          <td class="gpu-bar-cell">
            <div class="gpu-bar-head">
              <span class="gpu-bar-label">Compute</span>
              <span class="gpu-bar-value">${escapeHtml(formatPercent(gpuUtil))}</span>
            </div>
            <div class="gpu-bar"><span class="${progressClass(gpuUtil)}" style="width: ${gpuWidth}%"></span></div>
            <span class="gpu-subtle">Current GPU load</span>
          </td>
          <td class="gpu-bar-cell">
            <div class="gpu-bar-head">
              <span class="gpu-bar-label">Memory</span>
              <span class="gpu-bar-value">${escapeHtml(formatPercent(memoryUsedPercent))}</span>
            </div>
            <div class="gpu-bar"><span class="${progressClass(memoryUsedPercent)}" style="width: ${memoryWidth}%"></span></div>
            <span class="gpu-subtle">${escapeHtml(formatBytes(gpu.memory_used_bytes))} / ${escapeHtml(formatBytes(gpu.memory_total_bytes))}</span>
          </td>
          <td>
            <span class="pill ${tempClass}">${escapeHtml(Number.isFinite(gpu.temperature_c) ? `${gpu.temperature_c.toFixed(0)} C` : "-")}</span>
          </td>
          <td>
            <span class="gpu-number">${escapeHtml(powerText)}</span>
            <span class="gpu-subtle">${escapeHtml(powerLimit)}</span>
          </td>
        </tr>
      `;
    })
    .join("");

  overview.innerHTML = `
    <div class="gpu-dashboard">
      <div class="gpu-stat-strip">
        <div class="gpu-stat">
          <div class="gpu-stat-label">Active</div>
          <div class="gpu-stat-value">${escapeHtml(activeCount)} / ${escapeHtml(gpus.length)}</div>
          <div class="gpu-stat-subtext">Non-zero compute</div>
        </div>
        <div class="gpu-stat">
          <div class="gpu-stat-label">Average use</div>
          <div class="gpu-stat-value">${escapeHtml(formatPercent(avgUtil))}</div>
          <div class="gpu-stat-subtext">Across counted GPUs</div>
        </div>
        <div class="gpu-stat">
          <div class="gpu-stat-label">Peak use</div>
          <div class="gpu-stat-value">${escapeHtml(formatPercent(maxUtil))}</div>
          <div class="gpu-stat-subtext">Highest current load</div>
        </div>
        <div class="gpu-stat">
          <div class="gpu-stat-label">Memory</div>
          <div class="gpu-stat-value">${escapeHtml(formatPercent(memoryPercent))}</div>
          <div class="gpu-stat-subtext">${escapeHtml(formatBytes(memoryUsed))} / ${escapeHtml(formatBytes(memoryTotal))}</div>
        </div>
      </div>
      <div class="gpu-table-wrap">
        <table class="gpu-table">
          <colgroup>
            <col class="gpu-col-owner">
            <col class="gpu-col-id">
            <col class="gpu-col-device">
            <col class="gpu-col-metric">
            <col class="gpu-col-metric">
            <col class="gpu-col-temp">
            <col class="gpu-col-power">
          </colgroup>
          <thead>
            <tr>
              <th>Owner</th>
              <th>ID</th>
              <th>Device</th>
              <th>GPU</th>
              <th>Memory</th>
              <th>Temp</th>
              <th>Power</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCards() {
  const cards = byId("cards");
  const paths = state.latest?.paths || [];
  if (!paths.length) {
    cards.innerHTML = `<div class="empty">No storage data has been collected yet.</div>`;
    return;
  }

  cards.innerHTML = paths
    .map((item) => {
      const percent = Number(item.quota_used_percent);
      const percentLabel = Number.isFinite(percent) ? `${percent.toFixed(0)}%` : "-";
      const width = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
      const size = item.human || formatBytes(item.bytes);
      const quota = item.quota_human || formatBytes(item.quota_bytes) || "-";
      const remaining = Number(item.quota_remaining_bytes);
      const over = Number(item.quota_over_bytes);
      const quotaNote = Number.isFinite(over) && over > 0
        ? `Over ${formatBytes(over)}`
        : `Remaining ${formatBytes(remaining)}`;
      const status = item.status === "ok" ? (item.quota_status || "ok") : (item.status || "unknown");
      const errorText = item.error ? `<div class="delta">${escapeHtml(item.error)}</div>` : "";

      return `
        <article class="metric-card">
          <div class="card-top">
            <div class="folder-label">${escapeHtml(item.label)}</div>
            <span class="pill ${statusClass(status)}">${escapeHtml(status)}</span>
          </div>
          <div class="folder-path">${escapeHtml(item.path)}</div>
          <div class="size">${escapeHtml(size)}</div>
          <div class="delta">${escapeHtml(deltaText(item))}</div>
          ${errorText}
          <div class="meta-row">
            <span>Quota ${escapeHtml(percentLabel)}</span>
            <span>${escapeHtml(quotaNote)}</span>
          </div>
          <div class="meta-row">
            <span>Limit ${escapeHtml(quota)}</span>
            <span>Filesystem ${escapeHtml(Number.isFinite(item.filesystem_use_percent) ? `${item.filesystem_use_percent.toFixed(0)}%` : "-")}</span>
          </div>
          <div class="progress" aria-label="Quota usage">
            <span class="${progressClass(percent)}" style="width: ${width}%"></span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderHeader() {
  const latest = state.latest || {};
  const generatedAt = latest.generated_at ? formatTime(latest.generated_at) : "not collected yet";
  byId("subtitle").textContent = `${latest.host || "h20b"} updated at ${generatedAt}`;
}

function rawTrendHistory() {
  const cutoff = Date.now() - state.trendDays * 24 * 60 * 60 * 1000;
  return state.history
    .filter((snapshot) => {
      const time = new Date(snapshot.generated_at).getTime();
      return Number.isFinite(time) && time >= cutoff;
    })
    .map(gpuOccupancyPoint)
    .filter((point) => Number.isFinite(point.occupied) && Number.isFinite(point.total) && point.total > 0);
}

function dayKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayMidpointIso(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

function dailyAverage(points) {
  const groups = new Map();
  for (const point of points) {
    const key = dayKey(point.time);
    const group = groups.get(key) || {
      key,
      samples: 0,
      occupied: 0,
      ours: 0,
      other: 0,
      free: 0,
      total: 0,
    };
    group.samples += 1;
    group.occupied += Number(point.occupied) || 0;
    group.ours += Number(point.ours) || 0;
    group.other += Number(point.other) || 0;
    group.free += Number(point.free) || 0;
    group.total += Number(point.total) || 0;
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((group) => ({
      time: dayMidpointIso(group.key),
      occupied: group.occupied / group.samples,
      ours: group.ours / group.samples,
      other: group.other / group.samples,
      free: group.free / group.samples,
      total: group.total / group.samples,
      samples: group.samples,
      isAverage: true,
    }));
}

function smoothDailyTrend(points) {
  return points.map((point, index) => {
    const window = points.slice(Math.max(0, index - 1), Math.min(points.length, index + 2));
    const average = (field) => window.reduce((total, item) => total + (Number(item[field]) || 0), 0) / window.length;
    return {
      ...point,
      occupied: average("occupied"),
      ours: average("ours"),
      other: average("other"),
      free: average("free"),
      total: average("total"),
      samples: window.reduce((total, item) => total + (Number(item.samples) || 0), 0),
      isSmoothed: true,
    };
  });
}

function trendHistory() {
  const points = rawTrendHistory();
  return state.trendDays >= 30 ? smoothDailyTrend(dailyAverage(points)) : points;
}

function chartColor(name, alpha = 1) {
  const color = chartColors[name];
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function timeToX(timeMs, minTime, maxTime, left, right) {
  if (maxTime <= minTime) {
    return (left + right) / 2;
  }
  return left + ((timeMs - minTime) / (maxTime - minTime)) * (right - left);
}

function firstDayMarker(minTime) {
  const date = new Date(minTime);
  date.setHours(0, 0, 0, 0);
  if (date.getTime() <= minTime) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}

function drawTimeMarkers(ctx, left, right, top, bottom, labelY, minTime, maxTime, rangeDays) {
  const marker = firstDayMarker(minTime);
  const stepDays = rangeDays >= 30 ? 5 : 1;
  const minLabelGap = right - left < 520 ? 72 : 52;
  let lastLabelX = -Infinity;

  ctx.save();
  ctx.font = "12px system-ui, sans-serif";
  while (marker.getTime() < maxTime) {
    const markerMs = marker.getTime();
    const x = timeToX(markerMs, minTime, maxTime, left, right);
    if (x > left + 4 && x < right - 4) {
      ctx.strokeStyle = rangeDays >= 30 ? "#edf0f5" : "#e4e8ef";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      if (x - lastLabelX >= minLabelGap) {
        const label = formatShortDate(marker);
        ctx.fillStyle = "#667085";
        ctx.fillText(label, x - ctx.measureText(label).width / 2, labelY);
        lastLabelX = x;
      }
    }
    marker.setDate(marker.getDate() + stepDays);
  }
  ctx.restore();
}

function drawOwnershipStrip(ctx, chartPoints, left, right, y) {
  const height = 8;
  const firstTime = chartPoints[0]?.timeMs;
  const lastTime = chartPoints[chartPoints.length - 1]?.timeMs;
  const nominalMs = chartPoints.some((point) => point.isAverage) ? 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const nominalWidth = lastTime > firstTime ? ((right - left) * nominalMs) / (lastTime - firstTime) : right - left;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(left, y, right - left, height, 4);
  } else {
    ctx.rect(left, y, right - left, height);
  }
  ctx.clip();
  ctx.fillStyle = chartColor("empty", 0.55);
  ctx.fillRect(left, y, right - left, height);

  chartPoints.forEach((point) => {
    const start = Math.max(left, point.x - nominalWidth / 2);
    const end = Math.min(right, point.x + nominalWidth / 2);
    const width = Math.max(0, end - start);
    const total = Math.max(1, Number(point.total) || 0);
    const oursWidth = width * ((Number(point.ours) || 0) / total);
    const otherWidth = width * ((Number(point.other) || 0) / total);
    let x = start;

    if (oursWidth > 0.5) {
      ctx.fillStyle = chartColor("ours", 0.9);
      ctx.fillRect(x, y, oursWidth, height);
      x += oursWidth;
    }
    if (otherWidth > 0.5) {
      ctx.fillStyle = chartColor("other", 0.9);
      ctx.fillRect(x, y, otherWidth, height);
    }
  });
  ctx.restore();
}

function chartSegments(chartPoints) {
  const maxGapMs = maxChartGapMs(chartPoints);
  const segments = [];
  let segment = [];

  for (const point of chartPoints) {
    const previous = segment[segment.length - 1];
    if (previous && point.timeMs - previous.timeMs > maxGapMs) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length) {
    segments.push(segment);
  }
  return segments;
}

function maxChartGapMs(chartPoints) {
  return chartPoints.some((point) => point.isAverage)
    ? 36 * 60 * 60 * 1000
    : 6 * 60 * 60 * 1000;
}

function drawNoDataGaps(ctx, chartPoints, top, bottom) {
  const maxGapMs = maxChartGapMs(chartPoints);

  ctx.save();
  ctx.font = "800 11px system-ui, sans-serif";
  for (let index = 1; index < chartPoints.length; index += 1) {
    const previous = chartPoints[index - 1];
    const current = chartPoints[index];
    if (current.timeMs - previous.timeMs <= maxGapMs) {
      continue;
    }

    const x = previous.x;
    const width = current.x - previous.x;
    if (width <= 8) {
      continue;
    }

    ctx.fillStyle = "rgba(242, 244, 247, 0.72)";
    ctx.fillRect(x, top, width, bottom - top);
    ctx.strokeStyle = "rgba(152, 162, 179, 0.45)";
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.moveTo(x + width, top);
    ctx.lineTo(x + width, bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    if (width >= 68) {
      const label = "No data";
      const labelWidth = ctx.measureText(label).width + 16;
      const labelX = x + width / 2 - labelWidth / 2;
      const labelY = top + 14;
      ctx.fillStyle = "rgba(255, 255, 255, 0.86)";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, labelWidth, 22, 6);
        ctx.fill();
      } else {
        ctx.fillRect(labelX, labelY, labelWidth, 22);
      }
      ctx.fillStyle = "#667085";
      ctx.fillText(label, labelX + 8, labelY + 15);
    }

    ctx.strokeStyle = "rgba(102, 112, 133, 0.75)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    drawGapCurve(ctx, previous, current);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawTrendPath(ctx, chartPoints) {
  if (!chartPoints.length) {
    return;
  }

  ctx.beginPath();
  ctx.moveTo(chartPoints[0].x, chartPoints[0].y);
  for (let index = 0; index < chartPoints.length - 1; index += 1) {
    const p0 = chartPoints[index - 1] || chartPoints[index];
    const p1 = chartPoints[index];
    const p2 = chartPoints[index + 1];
    const p3 = chartPoints[index + 2] || p2;
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.max(minY, Math.min(maxY, p1.y + (p2.y - p0.y) / 6));
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.max(minY, Math.min(maxY, p2.y - (p3.y - p1.y) / 6));
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

function drawGapCurve(ctx, previous, current) {
  const dx = current.x - previous.x;
  const cp1x = previous.x + dx * 0.38;
  const cp2x = current.x - dx * 0.38;

  ctx.beginPath();
  ctx.moveTo(previous.x, previous.y);
  ctx.bezierCurveTo(cp1x, previous.y, cp2x, current.y, current.x, current.y);
}

function drawTooltip(ctx, point, width, top, bottom) {
  const title = point.isAverage
    ? `${formatShortDate(point.time)} (${point.samples} checks)`
    : formatTime(point.time);
  const prefix = point.isSmoothed ? "3-day avg " : point.isAverage ? "Avg " : "";
  const value = `${prefix}${formatGpuCount(point.occupied)} / ${formatGpuCount(point.total)} GPUs occupied`;
  const ownerText = `OURS ${formatGpuCount(point.ours)}, OTHER ${formatGpuCount(point.other)}, EMPTY ${formatGpuCount(point.free)}`;
  const paddingX = 10;
  const tooltipHeight = 68;
  ctx.font = "800 12px system-ui, sans-serif";
  const valueWidth = ctx.measureText(value).width;
  ctx.font = "12px system-ui, sans-serif";
  const tooltipWidth = Math.max(ctx.measureText(title).width, ctx.measureText(ownerText).width, valueWidth) + paddingX * 2;
  let tooltipX = point.x + 14;
  let tooltipY = point.y - tooltipHeight - 14;

  if (tooltipX + tooltipWidth > width - 8) {
    tooltipX = point.x - tooltipWidth - 14;
  }
  tooltipX = Math.max(8, Math.min(width - tooltipWidth - 8, tooltipX));
  if (tooltipY < 8) {
    tooltipY = point.y + 14;
  }
  tooltipY = Math.max(8, Math.min(bottom - tooltipHeight + 28, tooltipY));

  ctx.save();
  ctx.strokeStyle = "rgba(102, 112, 133, 0.45)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(point.x, top);
  ctx.lineTo(point.x, bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#d9dee7";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight, 8);
  } else {
    ctx.rect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#172033";
  ctx.font = "800 12px system-ui, sans-serif";
  ctx.fillText(value, tooltipX + paddingX, tooltipY + 20);
  ctx.fillStyle = "#475467";
  ctx.fillText(ownerText, tooltipX + paddingX, tooltipY + 38);
  ctx.fillStyle = "#667085";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(title, tooltipX + paddingX, tooltipY + 56);

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = chartColor("line");
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawChart() {
  const canvas = byId("trendCanvas");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(280, Math.floor(rect.height || 320));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = trendHistory();
  const values = points.map((point) => point.occupied).filter(Number.isFinite);
  const chartHint = byId("chartHint");

  if (!values.length) {
    state.chartPoints = [];
    state.chartHoverIndex = null;
    chartHint.textContent = `No GPU history in the last ${state.trendDays} days.`;
    ctx.fillStyle = "#667085";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("No GPU trend data yet", 24, 42);
    return;
  }

  const latest = points[points.length - 1];
  chartHint.textContent = latest.isAverage
    ? `${points.length} daily trend points in the last ${state.trendDays} days; latest 3-day avg ${formatGpuCount(latest.occupied)} / ${formatGpuCount(latest.total)} GPUs occupied; OURS ${formatGpuCount(latest.ours)}, OTHER ${formatGpuCount(latest.other)}, EMPTY ${formatGpuCount(latest.free)}.`
    : `${points.length} checks in the last ${state.trendDays} days; latest ${formatGpuCount(latest.occupied)} / ${formatGpuCount(latest.total)} GPUs occupied; OURS ${formatGpuCount(latest.ours)}, OTHER ${formatGpuCount(latest.other)}, EMPTY ${formatGpuCount(latest.free)}.`;

  const left = 48;
  const right = 22;
  const top = 42;
  const bottom = 46;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maxGpuCount = Math.max(...points.map((point) => point.total), ...values, 1);
  const maxValue = Math.max(1, Math.ceil(maxGpuCount));
  const chartBottom = top + innerHeight;
  const timeValues = points.map((point) => new Date(point.time).getTime()).filter(Number.isFinite);
  const minTime = Math.min(...timeValues);
  const maxTime = Math.max(...timeValues);
  const chartPoints = points.map((point, pointIndex) => ({
    ...point,
    timeMs: timeValues[pointIndex],
    x: timeToX(timeValues[pointIndex], minTime, maxTime, left, left + innerWidth),
    y: chartBottom - (point.occupied / maxValue) * innerHeight,
  }));
  state.chartPoints = chartPoints;
  const segments = chartSegments(chartPoints);

  ctx.strokeStyle = "#d9dee7";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, chartBottom);
  ctx.lineTo(left + innerWidth, chartBottom);
  ctx.stroke();

  drawTimeMarkers(ctx, left, left + innerWidth, top, chartBottom, height - 18, minTime, maxTime, state.trendDays);
  drawNoDataGaps(ctx, chartPoints, top, chartBottom);

  ctx.fillStyle = "#667085";
  ctx.font = "12px system-ui, sans-serif";
  const tickCount = Math.min(4, maxValue);
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const value = Math.round((maxValue / tickCount) * tick);
    const y = top + innerHeight - (value / maxValue) * innerHeight;
    ctx.strokeStyle = "#edf0f5";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + innerWidth, y);
    ctx.stroke();
    ctx.fillText(String(value), 18, y + 4);
  }

  if (chartPoints.length > 1) {
    const fillGradient = ctx.createLinearGradient(0, top, 0, chartBottom);
    fillGradient.addColorStop(0, chartColor("line", 0.16));
    fillGradient.addColorStop(1, chartColor("line", 0.02));
    ctx.fillStyle = fillGradient;
    for (const segment of segments) {
      if (segment.length < 2) {
        continue;
      }
      drawTrendPath(ctx, segment);
      ctx.lineTo(segment[segment.length - 1].x, chartBottom);
      ctx.lineTo(segment[0].x, chartBottom);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.strokeStyle = chartColor("line");
  ctx.lineWidth = 3;
  for (const segment of segments) {
    drawTrendPath(ctx, segment);
    ctx.stroke();
  }

  chartPoints.forEach((point, pointIndex) => {
    const isActive = pointIndex === state.chartHoverIndex;
    ctx.beginPath();
    ctx.arc(point.x, point.y, isActive ? 5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? "#ffffff" : chartColor("line");
    ctx.fill();
    if (isActive) {
      ctx.strokeStyle = chartColor("line");
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });

  drawOwnershipStrip(ctx, chartPoints, left, left + innerWidth, chartBottom + 4);

  const legendX = left;
  const legendY = 22;
  ctx.font = "12px system-ui, sans-serif";
  ctx.strokeStyle = chartColor("line");
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(legendX, legendY - 4);
  ctx.lineTo(legendX + 12, legendY - 4);
  ctx.stroke();
  ctx.fillStyle = "#172033";
  ctx.fillText("Occupied", legendX + 18, legendY);
  ctx.fillStyle = chartColor("ours");
  ctx.fillRect(legendX + 88, legendY - 9, 10, 10);
  ctx.fillStyle = "#172033";
  ctx.fillText("OURS", legendX + 104, legendY);
  ctx.fillStyle = chartColor("other");
  ctx.fillRect(legendX + 150, legendY - 9, 10, 10);
  ctx.fillStyle = "#172033";
  ctx.fillText("OTHER", legendX + 166, legendY);

  const activePoint = chartPoints[state.chartHoverIndex];
  if (activePoint) {
    drawTooltip(ctx, activePoint, width, top, chartBottom);
  }
}

function render() {
  renderHeader();
  renderCards();
  renderTotalOverview();
  renderGpus();
  drawChart();
}

function setupTrendControls() {
  document.querySelectorAll("[data-trend-days]").forEach((button) => {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.trendDays);
      if (!Number.isFinite(days)) {
        return;
      }
      state.trendDays = days;
      state.chartHoverIndex = null;
      document.querySelectorAll("[data-trend-days]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
      drawChart();
    });
  });
}

function setupChartHover() {
  const canvas = byId("trendCanvas");
  canvas.addEventListener("pointermove", (event) => {
    if (!state.chartPoints.length) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const nearest = state.chartPoints
      .map((point, index) => ({ index, distance: Math.abs(point.x - x) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const hitRange = Math.max(18, Math.min(48, rect.width / state.chartPoints.length));
    const nextIndex = nearest.distance <= hitRange ? nearest.index : null;
    if (nextIndex !== state.chartHoverIndex) {
      state.chartHoverIndex = nextIndex;
      drawChart();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (state.chartHoverIndex !== null) {
      state.chartHoverIndex = null;
      drawChart();
    }
  });
}

async function loadData() {
  try {
    const [latest, history] = await Promise.all([fetchJson(latestUrl), fetchJson(historyUrl)]);
    state.latest = latest;
    state.history = Array.isArray(history) ? history : [];
    render();
  } catch (error) {
    state.latest = {
      host: "h20b",
      status: "error",
      generated_at: null,
      paths: [],
    };
    render();
    byId("cards").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

window.addEventListener("resize", () => {
  state.chartHoverIndex = null;
  drawChart();
});
setupTrendControls();
setupChartHover();
byId("refreshButton").addEventListener("click", loadData);
loadData();
setInterval(loadData, 5 * 60 * 1000);
