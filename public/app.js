const state = {
  inputMode: "url", // "url" | "file"
  activeJobId: null,
  activeJob: null,
  pollTimer: null,
};

const els = {
  modeTabs: document.querySelectorAll(".mode-tab"),
  urlModeSection: document.getElementById("urlModeSection"),
  fileModeSection: document.getElementById("fileModeSection"),
  quickSamplesRow: document.getElementById("quickSamplesRow"),
  captionsToggleRow: document.getElementById("captionsToggleRow"),

  form: document.getElementById("transcribeForm"),
  urlInput: document.getElementById("videoUrl"),
  mediaFile: document.getElementById("mediaFile"),
  engineSelect: document.getElementById("engineSelect"),
  whisperModelSelect: document.getElementById("whisperModelSelect"),
  whisperModelField: document.getElementById("whisperModelField"),
  languageSelect: document.getElementById("languageSelect"),
  preferCaptions: document.getElementById("preferCaptions"),
  submitBtn: document.getElementById("submitBtn"),
  uploadSubmitBtn: document.getElementById("uploadSubmitBtn"),
  detectedPlatformBadge: document.getElementById("detectedPlatformBadge"),
  engineStatusPill: document.getElementById("engineStatusPill"),
  formError: document.getElementById("formError"),

  activeJobCard: document.getElementById("activeJobCard"),
  jobPlatformBadge: document.getElementById("jobPlatformBadge"),
  jobStatusBadge: document.getElementById("jobStatusBadge"),
  jobEngineBadge: document.getElementById("jobEngineBadge"),
  jobLangBadge: document.getElementById("jobLangBadge"),
  jobTitle: document.getElementById("jobTitle"),
  jobSubmeta: document.getElementById("jobSubmeta"),
  openSourceLink: document.getElementById("openSourceLink"),
  progressWrap: document.getElementById("progressWrap"),
  progressBar: document.getElementById("progressBar"),
  stageMessage: document.getElementById("stageMessage"),
  jobErrorBox: document.getElementById("jobErrorBox"),
  retryPanel: document.getElementById("retryPanel"),
  retryStepInfo: document.getElementById("retryStepInfo"),
  retryEngineSelect: document.getElementById("retryEngineSelect"),
  retryJobBtn: document.getElementById("retryJobBtn"),

  transcriptPanel: document.getElementById("transcriptPanel"),
  searchInput: document.getElementById("searchInput"),
  copyTimestampedBtn: document.getElementById("copyTimestampedBtn"),
  copyPlainBtn: document.getElementById("copyPlainBtn"),
  dlSrt: document.getElementById("dlSrt"),
  dlVtt: document.getElementById("dlVtt"),
  dlTxt: document.getElementById("dlTxt"),
  dlJson: document.getElementById("dlJson"),
  segmentCount: document.getElementById("segmentCount"),
  segmentsList: document.getElementById("segmentsList"),

  historyList: document.getElementById("historyList"),
  refreshHistoryBtn: document.getElementById("refreshHistoryBtn"),
  toast: document.getElementById("toast"),
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => els.toast.classList.add("hidden"), 2500);
}

function setMode(mode) {
  state.inputMode = mode;
  els.formError.classList.add("hidden");
  els.modeTabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  els.urlModeSection.classList.toggle("hidden", mode !== "url");
  els.fileModeSection.classList.toggle("hidden", mode !== "file");
  els.quickSamplesRow.classList.toggle("hidden", mode !== "url");
  els.captionsToggleRow.classList.toggle("hidden", mode !== "url");
}

function updateWhisperModelVisibility() {
  const show = ["auto", "faster_whisper"].includes(els.engineSelect.value);
  els.whisperModelField.classList.toggle("hidden", !show);
}

function formatClock(sec) {
  const total = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function detectPlatformFromText(url) {
  const lower = (url || "").toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  if (lower.includes("facebook.com") || lower.includes("fb.watch")) return "facebook";
  if (lower.includes("instagram.com") || lower.includes("instagr.am")) return "instagram";
  return null;
}

function updateDetectedPlatformBadge() {
  const platform = detectPlatformFromText(els.urlInput.value);
  if (!platform) {
    els.detectedPlatformBadge.classList.add("hidden");
    return;
  }
  els.detectedPlatformBadge.textContent = platform;
  els.detectedPlatformBadge.className = `platform-badge platform-${platform}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightText(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${escapedQuery})`, "gi"), "<mark>$1</mark>");
}

function buildJumpUrl(job, startSeconds) {
  const sec = Math.floor(startSeconds || 0);
  if (job.platform === "youtube" && job.video_id) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(job.video_id)}&t=${sec}s`;
  }
  if (job.platform === "local") {
    return null;
  }
  return job.canonical_url;
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const ready = Object.entries(data.available_engines)
      .filter(([name, ok]) => ok && name !== "demo")
      .map(([name]) => name.replace("_", " "));
    els.engineStatusPill.textContent = ready.length
      ? `Ready: ${ready.join(", ")}`
      : "Demo mode ready (install faster-whisper or add API key)";
    if (data.default_whisper_model) {
      els.whisperModelSelect.value = data.default_whisper_model;
    }
  } catch {
    els.engineStatusPill.textContent = "API offline";
  }
}

async function loadHistory() {
  try {
    const res = await fetch("/api/jobs?limit=25");
    const data = await res.json();
    renderHistory(data.jobs || []);
  } catch {
    // Ignore transient errors
  }
}

function renderHistory(jobs) {
  if (!jobs.length) {
    els.historyList.innerHTML = `<p class="muted small">No transcriptions yet. Paste a link or upload a file to get started.</p>`;
    return;
  }

  els.historyList.innerHTML = "";
  for (const job of jobs) {
    const item = document.createElement("div");
    item.className = `history-item${job.id === state.activeJobId ? " active" : ""}`;
    const retryBtnHtml =
      job.status === "failed" && job.can_retry
        ? `<button type="button" class="retry-icon-btn" title="Retry from ${job.cached_audio_ready ? "transcribing (cached audio)" : job.failed_step || "failed"} step" data-retry="${job.id}">&#x21bb;</button>`
        : "";
    const metaSub =
      job.status === "failed" && job.failed_step
        ? `Failed at ${job.failed_step}${job.cached_audio_ready ? " • audio cached" : ""}${job.retry_count ? ` • ${job.retry_count}x retried` : ""}`
        : `${job.segments.length} segments${job.duration_sec ? ` • ${formatClock(job.duration_sec)}` : ""}`;

    item.innerHTML = `
      <div class="history-item-top">
        <span class="platform-badge platform-${job.platform}">${job.platform}</span>
        <span class="status-badge status-${job.status}">${job.status}</span>
        <span class="history-item-actions">
          ${retryBtnHtml}
          <button type="button" class="delete-btn" title="Delete job" data-delete="${job.id}">&times;</button>
        </span>
      </div>
      <p class="history-item-title">${escapeHtml(job.title || job.canonical_url)}</p>
      <p class="muted small" style="margin:0">${escapeHtml(metaSub)}</p>
    `;

    item.addEventListener("click", (e) => {
      if (e.target.dataset.delete || e.target.dataset.retry) return;
      selectJob(job.id);
    });

    const retryBtn = item.querySelector("[data-retry]");
    if (retryBtn) {
      retryBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await retryJob(job.id);
      });
    }

    const delBtn = item.querySelector("[data-delete]");
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (state.activeJobId === job.id) {
        state.activeJobId = null;
        state.activeJob = null;
        els.activeJobCard.classList.add("hidden");
      }
      loadHistory();
      showToast("Job deleted");
    });

    els.historyList.appendChild(item);
  }
}

async function retryJob(jobId, overrideEngine = "") {
  try {
    els.retryJobBtn.disabled = true;
    els.retryJobBtn.textContent = "Resuming...";
    const body = {};
    if (overrideEngine) {
      body.engine = overrideEngine;
    }
    const res = await fetch(`/api/jobs/${jobId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Failed to retry job.");
    }
    els.retryEngineSelect.value = "";
    showToast(
      data.cached_audio_ready
        ? "Resuming from transcribing step (cached audio)"
        : "Retrying from extracting step",
    );
    await selectJob(jobId);
  } catch (err) {
    showToast(err.message || "Retry failed");
  } finally {
    els.retryJobBtn.disabled = false;
    els.retryJobBtn.textContent = "Retry Failed Step";
  }
}

async function selectJob(jobId) {
  clearInterval(state.pollTimer);
  state.activeJobId = jobId;
  await fetchAndRenderJob(jobId);
  loadHistory();
}

async function fetchAndRenderJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) return;
  const job = await res.json();
  state.activeJob = job;
  renderActiveJob(job);

  if (["queued", "extracting", "transcribing"].includes(job.status)) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => fetchAndRenderJob(jobId), 1500);
  } else {
    clearInterval(state.pollTimer);
    loadHistory();
  }
}

function renderActiveJob(job) {
  els.activeJobCard.classList.remove("hidden");

  els.jobPlatformBadge.textContent = job.platform;
  els.jobPlatformBadge.className = `platform-badge platform-${job.platform}`;

  els.jobStatusBadge.textContent = job.status;
  els.jobStatusBadge.className = `status-badge status-${job.status}`;

  if (job.engine_used) {
    els.jobEngineBadge.textContent = job.engine_used;
    els.jobEngineBadge.classList.remove("hidden");
  } else {
    els.jobEngineBadge.classList.add("hidden");
  }

  if (job.language) {
    els.jobLangBadge.textContent = `Lang: ${job.language}`;
    els.jobLangBadge.classList.remove("hidden");
  } else {
    els.jobLangBadge.classList.add("hidden");
  }

  els.jobTitle.textContent = job.title || job.canonical_url;
  const metaParts = [];
  if (job.uploader) metaParts.push(job.uploader);
  if (job.duration_sec) metaParts.push(`Duration: ${formatClock(job.duration_sec)}`);
  els.jobSubmeta.textContent = metaParts.join(" • ") || job.canonical_url;

  if (job.platform === "local") {
    els.openSourceLink.classList.add("hidden");
  } else {
    els.openSourceLink.classList.remove("hidden");
    els.openSourceLink.href = job.canonical_url;
  }

  const isRunning = ["queued", "extracting", "transcribing"].includes(job.status);
  els.progressWrap.classList.toggle("hidden", !isRunning);
  els.progressBar.style.width = `${job.progress || 0}%`;
  els.stageMessage.textContent = job.stage_message || "";

  if (job.status === "failed") {
    els.jobErrorBox.textContent = job.error || "Unknown error occurred.";
    els.jobErrorBox.classList.remove("hidden");
    els.transcriptPanel.classList.add("hidden");
    if (job.can_retry) {
      const stepLabel = job.failed_step || "transcribing";
      const cacheNote = job.cached_audio_ready
        ? "Audio cached — retry skips download & ffmpeg"
        : "Retry will resume from extraction";
      const attemptsNote = job.retry_count > 0 ? ` • Retried ${job.retry_count}x` : "";
      els.retryStepInfo.textContent = `Failed at step: ${stepLabel} • ${cacheNote}${attemptsNote}`;
      els.retryJobBtn.textContent = job.cached_audio_ready
        ? "Retry Transcribing Only"
        : "Retry Extracting";
      els.retryPanel.classList.remove("hidden");
    } else {
      els.retryPanel.classList.add("hidden");
    }
    return;
  }

  els.jobErrorBox.classList.add("hidden");
  els.retryPanel.classList.add("hidden");

  if (job.status === "completed") {
    els.transcriptPanel.classList.remove("hidden");
    els.dlSrt.href = `/api/jobs/${job.id}/export?fmt=srt`;
    els.dlVtt.href = `/api/jobs/${job.id}/export?fmt=vtt`;
    els.dlTxt.href = `/api/jobs/${job.id}/export?fmt=txt`;
    els.dlJson.href = `/api/jobs/${job.id}/export?fmt=json`;
    renderSegments(job, els.searchInput.value.trim());
  } else {
    els.transcriptPanel.classList.add("hidden");
  }
}

function renderSegments(job, query = "") {
  const lowerQ = query.toLowerCase();
  const filtered = lowerQ
    ? job.segments.filter((s) => s.text.toLowerCase().includes(lowerQ))
    : job.segments;

  els.segmentCount.textContent = lowerQ
    ? `${filtered.length} of ${job.segments.length} segments`
    : `${job.segments.length} segments`;

  els.segmentsList.innerHTML = "";
  if (!filtered.length) {
    els.segmentsList.innerHTML = `<p class="muted small">No matching segments found.</p>`;
    return;
  }

  for (const seg of filtered) {
    const row = document.createElement("div");
    row.className = "segment-row";
    const jumpUrl = buildJumpUrl(job, seg.start);
    const tsHtml = jumpUrl
      ? `<a class="timestamp-btn" href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener" title="Jump to ${formatClock(seg.start)}">${formatClock(seg.start)}</a>`
      : `<span class="timestamp-btn">${formatClock(seg.start)}</span>`;
    row.innerHTML = `${tsHtml}<div class="segment-text">${highlightText(seg.text, query)}</div>`;
    els.segmentsList.appendChild(row);
  }
}

els.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

els.urlInput.addEventListener("input", updateDetectedPlatformBadge);
els.engineSelect.addEventListener("change", updateWhisperModelVisibility);

document.querySelectorAll("[data-sample]").forEach((btn) => {
  btn.addEventListener("click", () => {
    setMode("url");
    els.urlInput.value = btn.dataset.sample;
    els.engineSelect.value = "demo";
    updateDetectedPlatformBadge();
    updateWhisperModelVisibility();
  });
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.formError.classList.add("hidden");

  const activeBtn = state.inputMode === "file" ? els.uploadSubmitBtn : els.submitBtn;
  const origLabel = activeBtn.textContent;

  try {
    let res;
    if (state.inputMode === "file") {
      const file = els.mediaFile.files[0];
      if (!file) {
        throw new Error("Please select a local MP4, MOV, MKV, MP3, or WAV file.");
      }
      activeBtn.disabled = true;
      activeBtn.textContent = "Uploading...";
      const fd = new FormData();
      fd.append("file", file);
      fd.append("engine", els.engineSelect.value);
      fd.append("whisper_model", els.whisperModelSelect.value);
      if (els.languageSelect.value) {
        fd.append("language", els.languageSelect.value);
      }
      res = await fetch("/api/transcribe/upload", { method: "POST", body: fd });
    } else {
      const url = els.urlInput.value.trim();
      if (!url) {
        throw new Error("Please paste a YouTube, Facebook, or Instagram video URL.");
      }
      activeBtn.disabled = true;
      activeBtn.textContent = "Submitting...";
      res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          engine: els.engineSelect.value,
          whisper_model: els.whisperModelSelect.value,
          language: els.languageSelect.value || null,
          prefer_captions: els.preferCaptions.checked,
        }),
      });
    }

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Failed to start transcription.");
    }
    els.searchInput.value = "";
    await selectJob(data.id);
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.classList.remove("hidden");
  } finally {
    activeBtn.disabled = false;
    activeBtn.textContent = origLabel;
  }
});

els.searchInput.addEventListener("input", () => {
  if (state.activeJob) {
    renderSegments(state.activeJob, els.searchInput.value.trim());
  }
});

els.copyTimestampedBtn.addEventListener("click", async () => {
  if (!state.activeJob) return;
  const text = state.activeJob.segments
    .map((s) => `[${formatClock(s.start)} - ${formatClock(s.end)}] ${s.text}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  showToast("Copied timestamped transcript");
});

els.copyPlainBtn.addEventListener("click", async () => {
  if (!state.activeJob) return;
  await navigator.clipboard.writeText(state.activeJob.full_text || "");
  showToast("Copied plain transcript");
});

els.retryJobBtn.addEventListener("click", () => {
  if (!state.activeJobId) return;
  retryJob(state.activeJobId, els.retryEngineSelect.value);
});

els.refreshHistoryBtn.addEventListener("click", loadHistory);

updateWhisperModelVisibility();
checkHealth();
loadHistory();
