// ============================================================
// popup.js – AutoApply Chrome Extension popup logic
// ============================================================

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Tabs
const tabs = $$('.tab');
const panels = $$('.tab-panel');

// Settings
const apiKeyInput = $('#apiKey');
const toggleKeyBtn = $('#toggleKeyVisibility');
const modelSelect = $('#modelSelect');
const toneSelect = $('#tone');
const autoDetectCheckbox = $('#autoDetect');
const saveSettingsBtn = $('#saveSettings');
const settingsToast = $('#settingsToast');
const statusBadge = $('#statusBadge');

// Resume
const fullNameInput = $('#fullName');
const emailInput = $('#email');
const phoneInput = $('#phone');
const locationInput = $('#location');
const linkedinInput = $('#linkedin');
const portfolioInput = $('#portfolio');
const resumeTextArea = $('#resumeText');
const resumeWordCount = $('#resumeWordCount');
const saveResumeBtn = $('#saveResume');
const resumeToast = $('#resumeToast');

// Cover Letter
const jobDescTextArea = $('#jobDescription');
const coverExtraInput = $('#coverLetterExtra');
const generateCoverBtn = $('#generateCover');
const coverResultWrap = $('#coverResultWrap');
const coverResult = $('#coverResult');
const copyCoverBtn = $('#copyCover');
const editCoverBtn = $('#editCover');
const coverSpinner = $('#coverSpinner');
const coverToast = $('#coverToast');

// ============================================================
// Tab switching
// ============================================================
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ============================================================
// API key visibility toggle
// ============================================================
toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? '🔒' : '👁';
});

// ============================================================
// Word count for resume
// ============================================================
resumeTextArea.addEventListener('input', () => {
  const words = resumeTextArea.value.trim().split(/\s+/).filter(Boolean).length;
  resumeWordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
});

// ============================================================
// Flash a toast notification
// ============================================================
function showToast(el, durationMs = 2000) {
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), durationMs);
}

// ============================================================
// Update status badge
// ============================================================
function updateBadge(hasKey, hasResume) {
  if (hasKey && hasResume) {
    statusBadge.textContent = 'Ready';
    statusBadge.classList.add('ready');
  } else if (hasKey) {
    statusBadge.textContent = 'Need resume';
    statusBadge.classList.remove('ready');
  } else {
    statusBadge.textContent = 'Not configured';
    statusBadge.classList.remove('ready');
  }
}

// ============================================================
// Load saved data from chrome.storage.local
// ============================================================
async function loadAll() {
  const data = await chrome.storage.local.get([
    'openaiKey',
    'model',
    'tone',
    'autoDetect',
    'fullName',
    'email',
    'phone',
    'location',
    'linkedin',
    'portfolio',
    'resumeText',
  ]);

  if (data.openaiKey) apiKeyInput.value = data.openaiKey;
  if (data.model) modelSelect.value = data.model;
  if (data.tone) toneSelect.value = data.tone;
  if (data.autoDetect !== undefined) autoDetectCheckbox.checked = data.autoDetect;

  if (data.fullName) fullNameInput.value = data.fullName;
  if (data.email) emailInput.value = data.email;
  if (data.phone) phoneInput.value = data.phone;
  if (data.location) locationInput.value = data.location;
  if (data.linkedin) linkedinInput.value = data.linkedin;
  if (data.portfolio) portfolioInput.value = data.portfolio;
  if (data.resumeText) {
    resumeTextArea.value = data.resumeText;
    resumeTextArea.dispatchEvent(new Event('input'));
  }

  updateBadge(!!data.openaiKey, !!data.resumeText);
}

// ============================================================
// Save settings
// ============================================================
saveSettingsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    openaiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
    tone: toneSelect.value,
    autoDetect: autoDetectCheckbox.checked,
  });
  showToast(settingsToast);
  const data = await chrome.storage.local.get(['openaiKey', 'resumeText']);
  updateBadge(!!data.openaiKey, !!data.resumeText);
});

// ============================================================
// Save resume
// ============================================================
saveResumeBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    fullName: fullNameInput.value.trim(),
    email: emailInput.value.trim(),
    phone: phoneInput.value.trim(),
    location: locationInput.value.trim(),
    linkedin: linkedinInput.value.trim(),
    portfolio: portfolioInput.value.trim(),
    resumeText: resumeTextArea.value.trim(),
  });
  showToast(resumeToast);
  const data = await chrome.storage.local.get(['openaiKey', 'resumeText']);
  updateBadge(!!data.openaiKey, !!data.resumeText);
});

// ============================================================
// Generate cover letter
// ============================================================
generateCoverBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get([
    'openaiKey',
    'model',
    'tone',
    'resumeText',
    'fullName',
  ]);

  if (!data.openaiKey) {
    alert('Please save your OpenAI API key in Settings first.');
    return;
  }
  if (!data.resumeText) {
    alert('Please save your resume in the Resume tab first.');
    return;
  }

  const jobDesc = jobDescTextArea.value.trim();
  if (!jobDesc) {
    alert('Please paste the job description.');
    return;
  }

  // Show spinner, hide previous result
  coverSpinner.style.display = 'flex';
  coverResultWrap.style.display = 'none';
  generateCoverBtn.disabled = true;

  try {
    // Send message to background service worker
    const response = await chrome.runtime.sendMessage({
      action: 'generateCoverLetter',
      payload: {
        resumeText: data.resumeText,
        fullName: data.fullName || '',
        jobDescription: jobDesc,
        extra: coverExtraInput.value.trim(),
        tone: data.tone || 'professional',
        model: data.model || 'gpt-4o-mini',
      },
    });

    if (response.error) {
      alert(`Error: ${response.error}`);
    } else {
      coverResult.value = response.coverLetter;
      coverResultWrap.style.display = 'block';
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
  } finally {
    coverSpinner.style.display = 'none';
    generateCoverBtn.disabled = false;
  }
});

// Copy cover letter
copyCoverBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(coverResult.value);
  showToast(coverToast);
});

// Enable editing
editCoverBtn.addEventListener('click', () => {
  coverResult.readOnly = !coverResult.readOnly;
  editCoverBtn.textContent = coverResult.readOnly ? '✏️ Edit' : '🔒 Lock';
});

// ============================================================
// Init
// ============================================================
loadAll();
