const latestUrl = "data/latest.json";
const historyUrl = "data/history.json";
const colors = ["#2563eb", "#16803c", "#b45309", "#0f766e", "#6d28d9", "#c62828"];

const state = {
  latest: null,
  history: [],
  trendDays: 7,
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
  return {
    time: snapshot.generated_at,
    occupied: gpus.filter(gpuIsOccupied).length,
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
          </td>
          <td class="gpu-bar-cell">
            <div class="gpu-bar-head">
              <span class="gpu-bar-label">${escapeHtml(formatBytes(gpu.memory_used_bytes))}</span>
              <span class="gpu-bar-value">${escapeHtml(formatPercent(memoryUsedPercent))}</span>
            </div>
            <div class="gpu-bar"><span class="${progressClass(memoryUsedPercent)}" style="width: ${memoryWidth}%"></span></div>
            <span class="gpu-subtle">of ${escapeHtml(formatBytes(gpu.memory_total_bytes))}</span>
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
  const status = latest.status || "no_data";
  byId("overallStatus").className = `status-badge ${statusClass(status)}`;
  byId("overallStatus").textContent = status.replace("_", " ");

  const generatedAt = latest.generated_at ? formatTime(latest.generated_at) : "not collected yet";
  byId("subtitle").textContent = `${latest.host || "h20b"} updated at ${generatedAt}`;
}

function renderTable() {
  const rows = [];
  for (const snapshot of [...state.history].reverse()) {
    for (const item of snapshot.paths || []) {
      rows.push({ snapshot, item });
    }
  }

  const body = byId("historyRows");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6">No history yet.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .slice(0, 30)
    .map(({ snapshot, item }) => {
      const fs = Number.isFinite(item.filesystem_use_percent)
        ? `${item.filesystem_use_percent.toFixed(0)}% on ${item.mountpoint || "-"}`
        : "-";
      const displayStatus = item.status === "ok" ? (item.quota_status || "ok") : (item.status || "unknown");
      return `
        <tr>
          <td>${escapeHtml(formatTime(snapshot.generated_at))}</td>
          <td>${escapeHtml(item.label)}</td>
          <td><code>${escapeHtml(item.path)}</code></td>
          <td>${escapeHtml(item.human || formatBytes(item.bytes))}</td>
          <td>${escapeHtml(fs)}</td>
          <td><span class="pill ${statusClass(displayStatus)}">${escapeHtml(displayStatus)}</span></td>
        </tr>
      `;
    })
    .join("");
}

function trendHistory() {
  const cutoff = Date.now() - state.trendDays * 24 * 60 * 60 * 1000;
  return state.history
    .filter((snapshot) => {
      const time = new Date(snapshot.generated_at).getTime();
      return Number.isFinite(time) && time >= cutoff;
    })
    .map(gpuOccupancyPoint)
    .filter((point) => Number.isFinite(point.occupied) && Number.isFinite(point.total) && point.total > 0);
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
    chartHint.textContent = `No GPU history in the last ${state.trendDays} days.`;
    ctx.fillStyle = "#667085";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("No GPU trend data yet", 24, 42);
    return;
  }

  const latest = points[points.length - 1];
  chartHint.textContent = `${points.length} checks in the last ${state.trendDays} days; latest ${latest.occupied} / ${latest.total} GPUs occupied.`;

  const left = 48;
  const right = 22;
  const top = 28;
  const bottom = 46;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maxGpuCount = Math.max(...points.map((point) => point.total), ...values, 1);
  const maxValue = Math.max(1, Math.ceil(maxGpuCount));
  const sampleCount = Math.max(1, points.length);

  ctx.strokeStyle = "#d9dee7";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, top + innerHeight);
  ctx.lineTo(left + innerWidth, top + innerHeight);
  ctx.stroke();

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

  ctx.strokeStyle = colors[0];
  ctx.fillStyle = colors[0];
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, pointIndex) => {
    const x = sampleCount === 1 ? left + innerWidth / 2 : left + (pointIndex / (sampleCount - 1)) * innerWidth;
    const y = top + innerHeight - (point.occupied / maxValue) * innerHeight;
    if (pointIndex === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  points.forEach((point, pointIndex) => {
    const x = sampleCount === 1 ? left + innerWidth / 2 : left + (pointIndex / (sampleCount - 1)) * innerWidth;
    const y = top + innerHeight - (point.occupied / maxValue) * innerHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  const labelPoints = points.length === 1 ? [points[0]] : [points[0], points[points.length - 1]];
  ctx.fillStyle = "#667085";
  ctx.font = "12px system-ui, sans-serif";
  for (const point of labelPoints) {
    const pointIndex = points.indexOf(point);
    const x = sampleCount === 1 ? left + innerWidth / 2 : left + (pointIndex / (sampleCount - 1)) * innerWidth;
    const text = formatShortTime(point.time);
    const offset = pointIndex === points.length - 1 ? -ctx.measureText(text).width : 0;
    ctx.fillText(text, x + offset, height - 18);
  }

  const legendX = left;
  const legendY = height - 18;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = colors[0];
  ctx.fillRect(legendX, legendY - 9, 10, 10);
  ctx.fillStyle = "#172033";
  ctx.fillText("Occupied GPUs", legendX + 16, legendY);
}

function render() {
  renderHeader();
  renderCards();
  renderTotalOverview();
  renderGpus();
  renderTable();
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
      document.querySelectorAll("[data-trend-days]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
      drawChart();
    });
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

window.addEventListener("resize", drawChart);
setupTrendControls();
byId("refreshButton").addEventListener("click", loadData);
loadData();
setInterval(loadData, 5 * 60 * 1000);
