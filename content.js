// ============================================================
// content.js – AutoApply Content Script
// Detects job application forms, extracts questions, and
// auto-fills answers using the background service worker.
// ============================================================

(() => {
  'use strict';

  // Prevent double injection
  if (window.__autoApplyInjected) return;
  window.__autoApplyInjected = true;

  // =========================================================
  // CONFIG
  // =========================================================
  const FIELD_SELECTORS = [
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="url"]',
    'input[type="number"]',
    'input[type="date"]',
    'input[type="search"]',
    'input:not([type])',
    'textarea',
    'select',
    'input[type="radio"]',
    'input[type="checkbox"]',
  ];

  // Common job-application form selectors (covers LinkedIn, Greenhouse, Lever,
  // Workday, iCIMS, generic forms, etc.)
  const FORM_INDICATORS = [
    'form[action*="apply"]',
    'form[action*="application"]',
    'form[action*="submit"]',
    'form[action*="career"]',
    'form[id*="apply"]',
    'form[id*="application"]',
    'form[class*="apply"]',
    'form[class*="application"]',
    '[data-qa="application-form"]',
    '[class*="job-application"]',
    '[class*="application-form"]',
    '[id*="application-form"]',
    '.jobs-easy-apply-content',          // LinkedIn
    '.postings-btn-wrapper',             // Lever
    '#application_form',                 // Greenhouse
    '[data-automation-id="jobApplication"]', // Workday
  ];

  // =========================================================
  // UTILITIES
  // =========================================================

  /** Get the visible label text for an input/select/textarea */
  function getFieldLabel(el) {
    // 1. <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // 2. Wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      // Remove the input itself from clone to get just the label text
      clone.querySelectorAll('input,select,textarea').forEach((c) => c.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // 3. aria-label / aria-labelledby
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return ref.textContent.trim();
    }

    // 4. Previous sibling or parent text
    const prev = el.previousElementSibling;
    if (prev && ['LABEL', 'SPAN', 'P', 'DIV', 'H3', 'H4', 'H5'].includes(prev.tagName)) {
      const t = prev.textContent.trim();
      if (t && t.length < 200) return t;
    }

    // 5. Placeholder
    if (el.placeholder) return el.placeholder;

    // 6. name attribute as fallback
    if (el.name) return el.name.replace(/[_\-\[\]]/g, ' ').trim();

    return '';
  }

  /**
   * Get the GROUP-level question/label for a radio button group.
   * This is the question text, NOT the individual option labels.
   * e.g. "Are you authorized to work in the US?" not "Yes" / "No"
   */
  function getRadioGroupLabel(radioEl) {
    // 1. <fieldset> + <legend>
    const fieldset = radioEl.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) return legend.textContent.trim();
    }

    // 2. [role="radiogroup"] with aria-label or aria-labelledby
    const radioGroup = radioEl.closest('[role="radiogroup"]');
    if (radioGroup) {
      if (radioGroup.getAttribute('aria-label')) return radioGroup.getAttribute('aria-label');
      const lby = radioGroup.getAttribute('aria-labelledby');
      if (lby) {
        const ref = document.getElementById(lby);
        if (ref) return ref.textContent.trim();
      }
    }

    // 3. Walk up to find a container div/fieldset that has a question-like text node
    //    before the radio buttons
    const container = radioEl.closest('.form-group, .field, .question, [class*="field"], [class*="question"], [data-testid], fieldset, .radio-group') || radioEl.parentElement?.parentElement;
    if (container) {
      // Look for heading/label/span/p/div that appears before any radio input
      for (const child of container.children) {
        // Stop if we hit the radio inputs themselves
        if (child.querySelector('input[type="radio"]') || child.type === 'radio') break;
        if (['LABEL', 'SPAN', 'P', 'DIV', 'H2', 'H3', 'H4', 'H5', 'LEGEND'].includes(child.tagName)) {
          const t = child.textContent.trim();
          if (t && t.length > 3 && t.length < 300) return t;
        }
      }
    }

    // 4. Look for a label/text element immediately before the first radio in the DOM
    const allRadios = radioEl.name
      ? document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioEl.name)}"]`)
      : [radioEl];
    const firstRadio = allRadios[0];
    if (firstRadio) {
      // Walk previous siblings of the radio's container
      let walker = (firstRadio.closest('label') || firstRadio).previousElementSibling;
      while (walker) {
        if (!walker.querySelector('input[type="radio"]')) {
          const t = walker.textContent.trim();
          if (t && t.length > 3 && t.length < 300) return t;
        }
        walker = walker.previousElementSibling;
      }

      // Try parent's previous sibling
      const parentEl = firstRadio.closest('label')?.parentElement || firstRadio.parentElement;
      if (parentEl) {
        const parentPrev = parentEl.previousElementSibling;
        if (parentPrev) {
          const t = parentPrev.textContent.trim();
          if (t && t.length > 3 && t.length < 300) return t;
        }
      }
    }

    // 5. Fall back to name attribute
    if (radioEl.name) return radioEl.name.replace(/[_\-\[\]]/g, ' ').trim();

    return '';
  }

  /**
   * Get the label for an individual radio option (e.g. "Yes", "No", "3-5 years")
   */
  function getRadioOptionLabel(radioEl) {
    // 1. Wrapping <label>
    const parentLabel = radioEl.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input').forEach((c) => c.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // 2. <label for="id">
    if (radioEl.id) {
      const label = document.querySelector(`label[for="${CSS.escape(radioEl.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // 3. Next sibling text
    const next = radioEl.nextElementSibling || radioEl.nextSibling;
    if (next) {
      const t = (next.textContent || '').trim();
      if (t && t.length < 100) return t;
    }

    // 4. aria-label
    if (radioEl.getAttribute('aria-label')) return radioEl.getAttribute('aria-label');

    // 5. Value
    return radioEl.value || '';
  }

  /**
   * Get the label for a <select> field, trying the group/question context
   */
  function getSelectLabel(selectEl) {
    // Try the standard label detection first
    const standard = getFieldLabel(selectEl);
    if (standard) return standard;

    // Walk up to find question context
    const container = selectEl.closest('.form-group, .field, .question, [class*="field"], [class*="question"]');
    if (container) {
      for (const child of container.children) {
        if (child === selectEl || child.contains(selectEl)) break;
        const t = child.textContent.trim();
        if (t && t.length > 2 && t.length < 300) return t;
      }
    }

    return '';
  }

  /** Get available options for a <select> or radio group */
  function getOptions(el) {
    if (el.tagName === 'SELECT') {
      return Array.from(el.options)
        .filter((o) => !o.disabled)
        .map((o) => ({ value: o.value, text: o.textContent.trim() }))
        // Filter out empty placeholder options but keep "Select..." type placeholders
        // so the AI knows what the default looks like
        .filter((o) => o.text || o.value);
    }

    // Radio group — use per-option label extractor (not the group question)
    if (el.type === 'radio' && el.name) {
      return Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
        .map((r) => {
          const lbl = getRadioOptionLabel(r);
          return { value: r.value, text: lbl };
        });
    }

    // Custom dropdown / listbox (divs with role="listbox")
    const listbox = el.closest('[role="listbox"]') || el.querySelector('[role="listbox"]');
    if (listbox) {
      return Array.from(listbox.querySelectorAll('[role="option"]'))
        .map((o) => ({ value: o.dataset.value || o.textContent.trim(), text: o.textContent.trim() }));
    }

    return [];
  }

  /** Known non-application hostnames that should never trigger auto-detect */
  const NON_APP_HOSTS = [
    'mail.google.com',
    'calendar.google.com',
    'docs.google.com',
    'drive.google.com',
    'sheets.google.com',
    'slides.google.com',
    'meet.google.com',
    'chat.google.com',
    'contacts.google.com',
    'keep.google.com',
    'photos.google.com',
    'maps.google.com',
    'www.google.com',
    'accounts.google.com',
    'myaccount.google.com',
    'translate.google.com',
    'news.google.com',
    'www.youtube.com',
    'music.youtube.com',
    'studio.youtube.com',
    'www.facebook.com',
    'www.instagram.com',
    'twitter.com',
    'x.com',
    'www.reddit.com',
    'web.whatsapp.com',
    'www.amazon.com',
    'www.ebay.com',
    'www.netflix.com',
    'www.twitch.tv',
    'discord.com',
    'slack.com',
    'app.slack.com',
    'outlook.live.com',
    'outlook.office.com',
    'outlook.office365.com',
    'login.microsoftonline.com',
    'teams.microsoft.com',
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'stackoverflow.com',
    'www.wikipedia.org',
    'en.wikipedia.org',
  ];

  /** Check if this is likely a job application page */
  function isApplicationPage() {
    // Exclude known non-application sites first
    const host = location.hostname.toLowerCase();
    if (NON_APP_HOSTS.includes(host)) return false;

    // Check URL path/query for application-related keywords
    const url = location.href.toLowerCase();
    if (/apply|application|career|job|hire|recruit/i.test(url)) return true;

    // Check form indicators (specific selectors for known job platforms)
    for (const sel of FORM_INDICATORS) {
      if (document.querySelector(sel)) return true;
    }

    // Check for clusters of form fields — but require a higher threshold and
    // at least one field whose label hints at a job application
    const allFields = document.querySelectorAll(FIELD_SELECTORS.join(','));
    if (allFields.length >= 3) {
      const visible = Array.from(allFields).filter((el) => el.offsetParent !== null);
      if (visible.length >= 5) {
        // Also verify at least one label looks job-related
        const jobLabelPattern = /resum[eé]|cover\s*letter|experience|salary|position|employer|work\s*auth|visa|start\s*date|linkedin|portfolio/i;
        const hasJobLabel = visible.some((el) => {
          const label = getFieldLabel(el);
          return jobLabelPattern.test(label);
        });
        if (hasJobLabel) return true;
      }
    }

    return false;
  }

  /** Extract page context (job title, company, description) */
  function getPageContext() {
    const parts = [];

    // Title
    const h1 = document.querySelector('h1');
    if (h1) parts.push(`Job Title: ${h1.textContent.trim()}`);

    // Company name (common patterns)
    const companyEl =
      document.querySelector('[class*="company-name"]') ||
      document.querySelector('[data-qa="company-name"]') ||
      document.querySelector('[class*="employer"]') ||
      document.querySelector('.jobs-unified-top-card__company-name');
    if (companyEl) parts.push(`Company: ${companyEl.textContent.trim()}`);

    // Job description (grab first 2000 chars)
    const descEl =
      document.querySelector('[class*="job-description"]') ||
      document.querySelector('[class*="jobDescription"]') ||
      document.querySelector('[id*="job-description"]') ||
      document.querySelector('[class*="posting-requirements"]') ||
      document.querySelector('.jobs-description__content') ||
      document.querySelector('article');
    if (descEl) {
      parts.push(`Description: ${descEl.textContent.trim().slice(0, 2000)}`);
    }

    return parts.join('\n\n') || document.title;
  }

  // =========================================================
  // FIELD COLLECTION
  // =========================================================

  /** Collect all fillable fields on the page */
  function collectFields() {
    const elements = document.querySelectorAll(FIELD_SELECTORS.join(','));
    const fields = [];
    const seenRadioGroups = new Set();
    const seenCustomDropdowns = new Set();

    for (const el of elements) {
      // Skip hidden, disabled, already-filled (unless empty)
      if (el.offsetParent === null && el.type !== 'hidden') continue;
      if (el.disabled || el.readOnly) continue;

      // Skip submit/button types
      if (['submit', 'button', 'reset', 'hidden', 'file', 'image'].includes(el.type)) continue;

      // --- Radio buttons: use group-level label + option labels ---
      if (el.type === 'radio') {
        const groupName = el.name;
        if (!groupName || seenRadioGroups.has(groupName)) continue;
        seenRadioGroups.add(groupName);

        // Get the GROUP question (e.g. "Are you authorized to work?")
        const groupLabel = getRadioGroupLabel(el);
        // Get individual option labels (e.g. ["Yes", "No"])
        const options = getOptions(el);

        if (!groupLabel && options.length === 0) continue;

        fields.push({
          element: el,
          label: groupLabel || `Radio choice: ${groupName}`,
          type: 'radio',
          options: options.length > 0 ? options : undefined,
          name: groupName,
          id: el.id || undefined,
        });
        continue;
      }

      // --- Select dropdowns ---
      if (el.tagName === 'SELECT') {
        const label = getSelectLabel(el);
        const options = getOptions(el);

        if (!label && options.length === 0) continue;

        fields.push({
          element: el,
          label: label || `Dropdown: ${el.name || el.id || 'select'}`,
          type: 'select',
          options: options.length > 0 ? options : undefined,
          placeholder: el.options?.[0]?.textContent?.trim() || undefined,
          name: el.name || undefined,
          id: el.id || undefined,
        });
        continue;
      }

      // --- Regular fields ---
      const label = getFieldLabel(el);
      if (!label) continue;

      const options = getOptions(el);
      const fieldType = el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text';

      fields.push({
        element: el,
        label,
        type: fieldType,
        options: options.length > 0 ? options : undefined,
        placeholder: el.placeholder || undefined,
        name: el.name || undefined,
        id: el.id || undefined,
      });
    }

    // --- Also detect custom dropdown components (role="combobox", role="listbox") ---
    const customDropdowns = document.querySelectorAll(
      '[role="combobox"], [role="listbox"], [class*="select-container"], [class*="dropdown-toggle"], [class*="custom-select"]'
    );
    for (const el of customDropdowns) {
      if (el.tagName === 'SELECT') continue; // Already handled above
      const key = el.id || el.getAttribute('aria-labelledby') || el.className;
      if (seenCustomDropdowns.has(key)) continue;
      seenCustomDropdowns.add(key);

      const label = el.getAttribute('aria-label')
        || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim())
        || getFieldLabel(el);
      if (!label) continue;

      // Collect options from the associated listbox
      const listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      let options = [];
      if (listboxId) {
        const listbox = document.getElementById(listboxId);
        if (listbox) {
          options = Array.from(listbox.querySelectorAll('[role="option"]'))
            .map((o) => ({ value: o.dataset.value || o.textContent.trim(), text: o.textContent.trim() }));
        }
      }
      if (options.length === 0) {
        // Try child options
        options = Array.from(el.querySelectorAll('[role="option"]'))
          .map((o) => ({ value: o.dataset.value || o.textContent.trim(), text: o.textContent.trim() }));
      }

      if (options.length > 0) {
        fields.push({
          element: el,
          label,
          type: 'custom-select',
          options,
          name: el.getAttribute('name') || undefined,
          id: el.id || undefined,
        });
      }
    }

    return fields;
  }

  // =========================================================
  // AUTO-FILL LOGIC
  // =========================================================

  // ---- Fuzzy matching helpers for option selection ----

  /** Normalize text for comparison: lowercase, trim, collapse whitespace */
  function norm(s) {
    return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /** Calculate simple token overlap score between two strings (0-1) */
  function tokenOverlap(a, b) {
    const tokensA = new Set(norm(a).split(/\W+/).filter(Boolean));
    const tokensB = new Set(norm(b).split(/\W+/).filter(Boolean));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.max(tokensA.size, tokensB.size);
  }

  /**
   * Find the best matching option from a list.
   * Uses cascading strategies: exact → contains → token overlap → partial.
   * Returns { value, text } or null.
   */
  function bestMatch(answer, options) {
    if (!options || options.length === 0) return null;
    const a = norm(answer);

    // 1. Exact match (value or text)
    for (const o of options) {
      if (norm(o.value) === a || norm(o.text) === a) return o;
    }

    // 2. Exact match ignoring punctuation
    const aClean = a.replace(/[^a-z0-9\s]/g, '');
    for (const o of options) {
      const oClean = norm(o.text).replace(/[^a-z0-9\s]/g, '');
      if (oClean === aClean) return o;
    }

    // 3. One contains the other
    for (const o of options) {
      const oText = norm(o.text);
      if (oText.includes(a) || a.includes(oText)) return o;
    }

    // 4. Token overlap scoring — pick the option with highest overlap
    let bestScore = 0;
    let bestOpt = null;
    for (const o of options) {
      const score = Math.max(tokenOverlap(answer, o.text), tokenOverlap(answer, o.value));
      if (score > bestScore) {
        bestScore = score;
        bestOpt = o;
      }
    }
    if (bestScore >= 0.4) return bestOpt;

    // 5. Starts-with match
    for (const o of options) {
      if (norm(o.text).startsWith(a) || a.startsWith(norm(o.text))) return o;
    }

    return null;
  }

  // ---- Visual feedback helper ----
  function flashOutline(el) {
    el.style.outline = '2px solid #6c5ce7';
    el.style.outlineOffset = '1px';
    setTimeout(() => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    }, 2000);
  }

  /** Dispatch all events that JS frameworks (React, Angular, Vue) listen to */
  function dispatchFrameworkEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    // React 16+ synthetic event
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue('');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Fill a single field with the given value */
  function fillField(field, value) {
    const el = field.element;
    if (!value) return;

    // ---- SELECT (native <select>) ----
    if (el.tagName === 'SELECT') {
      const opts = Array.from(el.options)
        .filter((o) => !o.disabled)
        .map((o) => ({ value: o.value, text: o.textContent.trim() }));

      const match = bestMatch(value, opts);
      if (match) {
        el.value = match.value;
        dispatchFrameworkEvents(el);
        flashOutline(el);
      } else {
        console.warn('AutoApply: no matching option for select', field.label, '→', value, 'options:', opts.map((o) => o.text));
      }
      return;
    }

    // ---- RADIO BUTTONS ----
    if (el.type === 'radio') {
      const radios = el.name
        ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
        : [el];

      const opts = radios.map((r) => ({
        value: r.value,
        text: getRadioOptionLabel(r),
        element: r,
      }));

      const match = bestMatch(value, opts);
      if (match) {
        const target = opts.find((o) => o.value === match.value);
        if (target) {
          // Use click() which is more reliable than setting .checked for frameworks
          target.element.click();
          // Also set checked and dispatch, in case click didn't propagate
          target.element.checked = true;
          target.element.dispatchEvent(new Event('change', { bubbles: true }));
          target.element.dispatchEvent(new Event('click', { bubbles: true }));
          flashOutline(target.element);

          // If the radio has a wrapping label, flash that too
          const wrap = target.element.closest('label');
          if (wrap) flashOutline(wrap);
        }
      } else {
        console.warn('AutoApply: no matching radio for', field.label, '→', value, 'options:', opts.map((o) => o.text));
      }
      return;
    }

    // ---- CHECKBOX ----
    if (el.type === 'checkbox') {
      const should = /^(yes|true|1|checked|y|agree|accept)$/i.test(value.trim());
      if (el.checked !== should) {
        el.click(); // click() is more reliable than toggling .checked
        el.checked = should;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      flashOutline(el);
      return;
    }

    // ---- CUSTOM SELECT (div-based dropdowns) ----
    if (field.type === 'custom-select') {
      const match = bestMatch(value, field.options);
      if (match) {
        // Try to click the trigger to open the dropdown
        const trigger = el.querySelector('[role="button"], button, [class*="trigger"], [class*="toggle"]') || el;
        trigger.click();

        // Wait for options to render, then click the matching one
        setTimeout(() => {
          const listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
          const listbox = listboxId ? document.getElementById(listboxId) : el;
          if (listbox) {
            const optionEls = listbox.querySelectorAll('[role="option"]');
            for (const optEl of optionEls) {
              if (norm(optEl.textContent) === norm(match.text) || norm(optEl.dataset.value || '') === norm(match.value)) {
                optEl.click();
                flashOutline(el);
                break;
              }
            }
          }
        }, 300);
      }
      return;
    }

    // ---- TEXT / TEXTAREA / EMAIL / TEL / URL / NUMBER ----
    // Guard: only set value on elements that actually support .value
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
      console.warn('AutoApply: cannot set value on', el.tagName, 'element for field', field.label);
      return;
    }

    // Use native setter to trigger React/Angular change detection
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSet) {
      nativeSet.call(el, value);
    } else {
      el.value = value;
    }

    dispatchFrameworkEvents(el);
    flashOutline(el);
  }

  // =========================================================
  // FLOATING ACTION BUTTON (FAB)
  // =========================================================

  function createFAB() {
    // Remove existing
    const existing = document.getElementById('autoapply-fab');
    if (existing) existing.remove();

    const fab = document.createElement('div');
    fab.id = 'autoapply-fab';
    fab.innerHTML = `
      <button id="autoapply-fab-btn" title="AutoApply – Fill this form with AI">
        <span class="autoapply-icon">⚡</span>
      </button>
      <div id="autoapply-fab-menu" class="autoapply-hidden">
        <button data-action="fill-all" class="autoapply-menu-item">
          <span>🚀</span> Auto-Fill All Fields
        </button>
        <button data-action="fill-empty" class="autoapply-menu-item">
          <span>📝</span> Fill Empty Fields Only
        </button>
        <button data-action="generate-cover" class="autoapply-menu-item">
          <span>💌</span> Generate Cover Letter
        </button>
        <div class="autoapply-divider"></div>
        <button data-action="close" class="autoapply-menu-item secondary">
          <span>✕</span> Close
        </button>
      </div>
    `;

    document.body.appendChild(fab);

    // Toggle menu
    const btn = fab.querySelector('#autoapply-fab-btn');
    const menu = fab.querySelector('#autoapply-fab-menu');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('autoapply-hidden');
    });

    // Close on outside click
    document.addEventListener('click', () => {
      menu.classList.add('autoapply-hidden');
    });

    menu.addEventListener('click', (e) => e.stopPropagation());

    // Menu actions
    menu.querySelectorAll('.autoapply-menu-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const action = item.dataset.action;
        menu.classList.add('autoapply-hidden');

        if (action === 'close') {
          fab.remove();
          return;
        }

        if (action === 'fill-all' || action === 'fill-empty') {
          await performAutoFill(action === 'fill-empty');
        }

        if (action === 'generate-cover') {
          await generateCoverLetterInPage();
        }
      });
    });
  }

  // =========================================================
  // PERFORM AUTO-FILL
  // =========================================================

  async function performAutoFill(emptyOnly = false) {
    const statusEl = showStatus('Scanning form fields...');

    let fields = collectFields();

    if (emptyOnly) {
      fields = fields.filter((f) => {
        if (f.element.tagName === 'SELECT') return f.element.selectedIndex <= 0;
        if (f.element.type === 'radio') {
          const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(f.element.name)}"]`);
          return !Array.from(group).some((r) => r.checked);
        }
        if (f.element.type === 'checkbox') return false; // Skip checkboxes in empty-only mode
        return !f.element.value.trim();
      });
    }

    if (fields.length === 0) {
      updateStatus(statusEl, 'No empty fields found.', 'info');
      return;
    }

    updateStatus(statusEl, `Found ${fields.length} fields. Asking AI...`);

    const pageContext = getPageContext();

    // Prepare fields for the API (without DOM elements)
    const fieldData = fields.map((f, i) => {
      const fd = {
        fieldId: `field_${i}`,
        label: f.label,
        type: f.type,
      };
      if (f.options && f.options.length > 0) {
        // Send full option text so AI can return an exact match
        fd.options = f.options.map((o) => o.text);
      }
      if (f.placeholder) {
        fd.placeholder = f.placeholder;
      }
      return fd;
    });

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fillForm',
        payload: {
          fields: fieldData,
          pageContext,
        },
      });

      if (!response) {
        updateStatus(statusEl, 'No response from extension. Try reloading the page.', 'error');
        return;
      }

      if (response.error) {
        updateStatus(statusEl, `Error: ${response.error}`, 'error');
        return;
      }

      const answers = response.answers;
      if (!Array.isArray(answers)) {
        updateStatus(statusEl, 'Unexpected response format from AI.', 'error');
        return;
      }

      let filled = 0;

      for (const ans of answers) {
        const idx = parseInt(ans.fieldId.replace('field_', ''), 10);
        if (isNaN(idx) || !fields[idx]) continue;
        if (ans.answer) {
          fillField(fields[idx], ans.answer);
          filled++;
        }
      }

      updateStatus(statusEl, `✓ Filled ${filled}/${fields.length} fields.`, 'success');
    } catch (err) {
      updateStatus(statusEl, `Failed: ${err.message}`, 'error');
    }
  }

  // =========================================================
  // IN-PAGE COVER LETTER GENERATION
  // =========================================================

  async function generateCoverLetterInPage() {
    const statusEl = showStatus('Generating cover letter...');

    const pageContext = getPageContext();

    const data = await chrome.storage.local.get(['resumeText', 'fullName', 'tone', 'model']);

    if (!data.resumeText) {
      updateStatus(statusEl, 'Please save your resume in the extension popup first.', 'error');
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'generateCoverLetter',
        payload: {
          resumeText: data.resumeText,
          fullName: data.fullName || '',
          jobDescription: pageContext,
          extra: '',
          tone: data.tone || 'professional',
          model: data.model || 'gpt-4o-mini',
        },
      });

      if (!response) {
        updateStatus(statusEl, 'No response from extension. Try reloading the page.', 'error');
        return;
      }

      if (response.error) {
        updateStatus(statusEl, `Error: ${response.error}`, 'error');
        return;
      }

      // Find a cover letter textarea and fill it, or show a floating panel
      const coverField = findCoverLetterField();
      if (coverField) {
        fillField({ element: coverField }, response.coverLetter);
        updateStatus(statusEl, '✓ Cover letter inserted!', 'success');
      } else {
        showCoverLetterPanel(response.coverLetter);
        updateStatus(statusEl, '✓ Cover letter generated! See panel.', 'success');
      }
    } catch (err) {
      updateStatus(statusEl, `Failed: ${err.message}`, 'error');
    }
  }

  /** Try to find a "cover letter" textarea in the form */
  function findCoverLetterField() {
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      const label = getFieldLabel(ta).toLowerCase();
      if (/cover\s*letter|motivation|why.*(join|apply|interested)/i.test(label)) {
        return ta;
      }
    }
    return null;
  }

  /** Show cover letter in a floating panel */
  function showCoverLetterPanel(text) {
    const existing = document.getElementById('autoapply-cover-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'autoapply-cover-panel';
    panel.innerHTML = `
      <div class="autoapply-panel-header">
        <span>💌 Generated Cover Letter</span>
        <button id="autoapply-close-panel">✕</button>
      </div>
      <textarea class="autoapply-panel-textarea" rows="14" readonly>${escapeHtml(text)}</textarea>
      <div class="autoapply-panel-actions">
        <button class="autoapply-panel-btn" id="autoapply-copy-cover">📋 Copy</button>
        <button class="autoapply-panel-btn" id="autoapply-close-panel2">Close</button>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector('#autoapply-close-panel').addEventListener('click', () => panel.remove());
    panel.querySelector('#autoapply-close-panel2').addEventListener('click', () => panel.remove());
    panel.querySelector('#autoapply-copy-cover').addEventListener('click', async () => {
      await navigator.clipboard.writeText(text);
      panel.querySelector('#autoapply-copy-cover').textContent = '✓ Copied!';
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // =========================================================
  // PER-FIELD AI BUTTON (next to individual fields)
  // =========================================================

  function addPerFieldButtons() {
    const fields = collectFields();
    for (const field of fields) {
      const el = field.element;
      if (el.dataset.autoapplyBtn) continue; // Already added
      if (['email', 'tel', 'date', 'number'].includes(el.type)) continue; // Simple fields

      // Only add AI button for textareas and text fields with long labels (questions)
      if (el.tagName !== 'TEXTAREA' && field.label.length < 20) continue;

      el.dataset.autoapplyBtn = 'true';

      const btn = document.createElement('button');
      btn.className = 'autoapply-field-btn';
      btn.textContent = '⚡ AI';
      btn.title = 'Generate answer with AI';

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        btn.textContent = '...';
        btn.disabled = true;

        try {
          const pageContext = getPageContext();
          const response = await chrome.runtime.sendMessage({
            action: 'answerSingleField',
            payload: {
              label: field.label,
              fieldType: field.type,
              options: field.options?.map((o) => o.text),
              pageContext,
            },
          });

          if (!response) {
            btn.textContent = '✕';
            console.error('AutoApply: No response from extension.');
          } else if (response.error) {
            btn.textContent = '✕';
            console.error('AutoApply:', response.error);
          } else {
            fillField(field, response.answer);
            btn.textContent = '✓';
          }
        } catch (err) {
          btn.textContent = '✕';
          console.error('AutoApply:', err);
        }

        setTimeout(() => {
          btn.textContent = '⚡ AI';
          btn.disabled = false;
        }, 2000);
      });

      // Insert button after the field (guard against detached elements)
      if (el.parentNode) {
        el.parentNode.insertBefore(btn, el.nextSibling);
      }
    }
  }

  // =========================================================
  // STATUS TOAST (in-page)
  // =========================================================

  function showStatus(msg, type = 'info') {
    const existing = document.getElementById('autoapply-status');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'autoapply-status';
    el.className = `autoapply-status autoapply-status-${type}`;
    el.innerHTML = `<span class="autoapply-status-icon">⚡</span> <span class="autoapply-status-msg">${escapeHtml(msg)}</span>`;
    document.body.appendChild(el);

    return el;
  }

  function updateStatus(el, msg, type = 'info') {
    if (!el || !el.parentNode) return;
    el.className = `autoapply-status autoapply-status-${type}`;
    el.querySelector('.autoapply-status-msg').textContent = msg;

    if (type === 'success' || type === 'error' || type === 'info') {
      setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 4000);
    }
  }

  // =========================================================
  // INIT – Decide whether to show the FAB
  // =========================================================

  // Register message listener ONCE (outside init to prevent duplicates)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'showFAB') {
      createFAB();
      addPerFieldButtons();
    }
  });

  async function init() {
    try {
      const data = await chrome.storage.local.get(['autoDetect', 'openaiKey', 'resumeText']);

      // Only activate if settings exist
      if (!data.openaiKey) return;

      const autoDetect = data.autoDetect !== false; // Default true

      if (autoDetect && isApplicationPage()) {
        createFAB();
        // Add per-field AI buttons after a short delay (for SPAs)
        setTimeout(addPerFieldButtons, 1500);
      }
    } catch (err) {
      // Extension context may have been invalidated (e.g. after update/reload).
      // Silently ignore – the content script can no longer communicate with the extension.
      console.debug('AutoApply: init skipped –', err.message);
    }
  }

  // Run after DOM settles
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }

  // Re-check after SPA navigation (for LinkedIn, etc.)
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 1000);
    }
  });

  const observeTarget = document.body || document.documentElement;
  if (observeTarget) {
    observer.observe(observeTarget, { childList: true, subtree: true });
  }
})();
