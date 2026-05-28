const latestUrl = "data/latest.json";
const historyUrl = "data/history.json";
const colors = ["#2563eb", "#16803c", "#b45309", "#0f766e", "#6d28d9", "#c62828"];

const state = {
  latest: null,
  history: [],
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

function seriesFromHistory() {
  const names = new Map();
  for (const item of state.latest?.paths || []) {
    names.set(pathKey(item), item.label || item.path);
  }
  for (const snapshot of state.history) {
    for (const item of snapshot.paths || []) {
      names.set(pathKey(item), item.label || item.path);
    }
  }

  return [...names.entries()].map(([key, label], index) => {
    const points = state.history.map((snapshot, snapshotIndex) => {
      const match = (snapshot.paths || []).find((candidate) => pathKey(candidate) === key);
      return {
        index: snapshotIndex,
        time: snapshot.generated_at,
        value: match && Number.isFinite(match.bytes) ? match.bytes : null,
      };
    });
    return { key, label, color: colors[index % colors.length], points };
  });
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

  const series = seriesFromHistory();
  const values = series.flatMap((item) => item.points.map((point) => point.value)).filter(Number.isFinite);
  const chartHint = byId("chartHint");

  if (!values.length) {
    chartHint.textContent = "History will appear after scheduled runs.";
    ctx.fillStyle = "#667085";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("No trend data yet", 24, 42);
    return;
  }

  chartHint.textContent = `${state.history.length} snapshots in local history.`;

  const left = 64;
  const right = 22;
  const top = 28;
  const bottom = 46;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maxValue = Math.max(...values) * 1.08 || 1;
  const sampleCount = Math.max(1, state.history.length);

  ctx.strokeStyle = "#d9dee7";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, top + innerHeight);
  ctx.lineTo(left + innerWidth, top + innerHeight);
  ctx.stroke();

  ctx.fillStyle = "#667085";
  ctx.font = "12px system-ui, sans-serif";
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (maxValue / 4) * tick;
    const y = top + innerHeight - (value / maxValue) * innerHeight;
    ctx.strokeStyle = "#edf0f5";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + innerWidth, y);
    ctx.stroke();
    ctx.fillText(formatBytes(value), 8, y + 4);
  }

  for (const item of series) {
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const point of item.points) {
      if (!Number.isFinite(point.value)) {
        started = false;
        continue;
      }
      const x = sampleCount === 1 ? left + innerWidth / 2 : left + (point.index / (sampleCount - 1)) * innerWidth;
      const y = top + innerHeight - (point.value / maxValue) * innerHeight;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    for (const point of item.points) {
      if (!Number.isFinite(point.value)) {
        continue;
      }
      const x = sampleCount === 1 ? left + innerWidth / 2 : left + (point.index / (sampleCount - 1)) * innerWidth;
      const y = top + innerHeight - (point.value / maxValue) * innerHeight;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let legendX = left;
  const legendY = height - 16;
  ctx.font = "12px system-ui, sans-serif";
  for (const item of series) {
    ctx.fillStyle = item.color;
    ctx.fillRect(legendX, legendY - 9, 10, 10);
    ctx.fillStyle = "#172033";
    ctx.fillText(item.label, legendX + 16, legendY);
    legendX += ctx.measureText(item.label).width + 46;
  }
}

function render() {
  renderHeader();
  renderCards();
  renderTotalOverview();
  renderGpus();
  renderTable();
  drawChart();
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
byId("refreshButton").addEventListener("click", loadData);
loadData();
setInterval(loadData, 5 * 60 * 1000);
