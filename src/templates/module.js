const DEFAULT_STAGE_TEMPLATE_NAME = "Default";

const DEFAULT_STAGE_TEMPLATE = {
  subjectText: "",
  introText: "Hi [Name],",
  populateName: true,
  bodyText: "",
  outroText: "Best,",
};

const LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER = "Add a template email to this stage in the settings tab";
const SETTINGS_TEMPLATE_BODY_PLACEHOLDER = "add text";

function buildTemplateId(stageId = "stage", templateIndex = 0) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${stageId}-template-${templateIndex + 1}`;
}

function normalizeStageTemplateConfig(input = {}, fallback = DEFAULT_STAGE_TEMPLATE) {
  return {
    subjectText: String(input?.subjectText ?? fallback.subjectText),
    introText: String(input?.introText ?? fallback.introText),
    populateName: input?.populateName !== undefined ? input.populateName === true : fallback.populateName,
    bodyText: String(input?.bodyText ?? fallback.bodyText),
    outroText: String(input?.outroText ?? fallback.outroText),
  };
}

function normalizeStageTemplateEntry(input = {}, { stageId = "stage", templateIndex = 0 } = {}) {
  const normalizedTemplate = normalizeStageTemplateConfig(input);
  return {
    id: String(input?.id || buildTemplateId(stageId, templateIndex)),
    name: String(input?.name || (templateIndex === 0 ? DEFAULT_STAGE_TEMPLATE_NAME : `Template ${templateIndex + 1}`)),
    order: Number.isInteger(input?.order) ? input.order : templateIndex,
    ...normalizedTemplate,
  };
}

function normalizeStageTemplates(stage = {}, fallbackStage = {}) {
  const stageId = String(stage?.id || fallbackStage?.id || "stage");

  if (Array.isArray(stage?.templates) && stage.templates.length > 0) {
    return stage.templates.map((template, index) => normalizeStageTemplateEntry(template, { stageId, templateIndex: index }));
  }

  const legacyTemplate = normalizeStageTemplateConfig(stage, normalizeStageTemplateConfig(fallbackStage));
  return [
    normalizeStageTemplateEntry(
      {
        ...legacyTemplate,
        name: stage?.name || DEFAULT_STAGE_TEMPLATE_NAME,
      },
      { stageId, templateIndex: 0 }
    ),
  ];
}

function getContactFirstName(contactName = "") {
  const trimmedName = String(contactName || "").trim();
  if (!trimmedName) return "";

  const [firstPart] = trimmedName.split(/\s+/);
  return firstPart || "";
}

function applyContactPlaceholders(templateText = "", contactData = null) {
  const sourceText = String(templateText ?? "");
  if (!sourceText.includes("[") || !contactData || typeof contactData !== "object") {
    return sourceText;
  }

  const normalizedContactFields = Object.entries(contactData).reduce((acc, [key, value]) => {
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!normalizedKey || value == null) return acc;

    const normalizedValue = String(value).trim();
    if (!normalizedValue) return acc;

    acc[normalizedKey] = normalizedValue;
    return acc;
  }, {});

  return sourceText.replace(/\[([^\]]+)\]/g, (token, rawFieldName) => {
    const normalizedFieldName = String(rawFieldName || "").trim().toLowerCase();
    if (!normalizedFieldName || normalizedFieldName === "name") return token;

    return Object.prototype.hasOwnProperty.call(normalizedContactFields, normalizedFieldName)
      ? normalizedContactFields[normalizedFieldName]
      : token;
  });
}

function renderTemplateWithLead(templateConfig, leadContactName = "", contactData = null) {
  const config = normalizeStageTemplateConfig(templateConfig);
  const firstName = getContactFirstName(leadContactName);
  const introText = config.introText.trim();
  const bodyText = config.bodyText.trim();
  const outroText = config.outroText.trim();

  const parts = [];

  if (config.populateName && introText) {
    const resolvedIntro = introText.replaceAll("[Name]", firstName || "").replace(/\s+,/g, ",").trim();
    parts.push(resolvedIntro);
  }

  if (bodyText) {
    parts.push(bodyText);
  }

  if (outroText) {
    parts.push(outroText);
  }

  const assembledTemplate = parts.join("\n\n").trimEnd();
  const resolvedTemplate = applyContactPlaceholders(assembledTemplate, contactData);
  return resolvedTemplate ? `${resolvedTemplate}\n` : "";
}

function normalizePromotionTemplateConfig(input = {}) {
  const normalizedStageTemplate = normalizeStageTemplateConfig({
    subjectText: input?.subjectText ?? input?.subject,
    introText: input?.introText ?? input?.opening,
    populateName: input?.populateName,
    bodyText: input?.bodyText ?? input?.body,
    outroText: input?.outroText ?? input?.closing,
  });

  return {
    ...normalizedStageTemplate,
    subject: normalizedStageTemplate.subjectText,
    opening: normalizedStageTemplate.introText,
    body: normalizedStageTemplate.bodyText,
    closing: normalizedStageTemplate.outroText,
  };
}

function toPromotionTemplatePayload(templateConfig = {}) {
  const normalized = normalizePromotionTemplateConfig(templateConfig);
  return {
    subject: normalized.subjectText,
    opening: normalized.introText,
    body: normalized.bodyText,
    closing: normalized.outroText,
    subjectText: normalized.subjectText,
    introText: normalized.introText,
    populateName: normalized.populateName,
    bodyText: normalized.bodyText,
    outroText: normalized.outroText,
  };
}

function buildStageTemplateSettingsMarkup(stage, stageIndex, escapeHtml) {
  const templates = normalizeStageTemplates(stage);

  return `
    <div class="template-settings-card detail-grid">
      <p><strong>Templates</strong></p>
      <div class="stage-templates-list" data-stage-templates="${stageIndex}">
        ${templates
          .map((template, templateIndex) => {
            const config = normalizeStageTemplateEntry(template, { stageId: stage.id, templateIndex });
            return `
              <div class="template-settings-block" data-template-index="${templateIndex}">
                <input type="hidden" name="template-id-${stageIndex}-${templateIndex}" value="${escapeHtml(config.id)}" />
                <label>Template name
                  <input name="template-name-${stageIndex}-${templateIndex}" value="${escapeHtml(config.name)}" />
                </label>
                <label>Subject
                  <input name="template-subject-${stageIndex}-${templateIndex}" value="${escapeHtml(config.subjectText)}" placeholder="add subject" />
                </label>
                <label>Intro
                  <input name="template-intro-${stageIndex}-${templateIndex}" value="${escapeHtml(config.introText)}" />
                </label>
                <label class="template-checkbox-row">
                  <input type="checkbox" name="template-populate-name-${stageIndex}-${templateIndex}" ${config.populateName ? "checked" : ""} />
                  <span>Populate name</span>
                </label>
                <label>Body
                  <textarea name="template-body-${stageIndex}-${templateIndex}" rows="4" placeholder="${SETTINGS_TEMPLATE_BODY_PLACEHOLDER}">${escapeHtml(config.bodyText)}</textarea>
                </label>
                <label>Outro
                  <input name="template-outro-${stageIndex}-${templateIndex}" value="${escapeHtml(config.outroText)}" />
                </label>
              </div>
            `;
          })
          .join("")}
      </div>
      <button type="button" class="secondary-btn" data-add-template-stage-index="${stageIndex}">Add alternate template</button>
      <button type="button" data-save-stage-index="${stageIndex}">Save ${escapeHtml(stage.label)}</button>
    </div>
  `;
}

export {
  DEFAULT_STAGE_TEMPLATE,
  DEFAULT_STAGE_TEMPLATE_NAME,
  LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER,
  SETTINGS_TEMPLATE_BODY_PLACEHOLDER,
  buildTemplateId,
  buildStageTemplateSettingsMarkup,
  getContactFirstName,
  normalizeStageTemplateConfig,
  normalizeStageTemplateEntry,
  normalizeStageTemplates,
  normalizePromotionTemplateConfig,
  applyContactPlaceholders,
  renderTemplateWithLead,
  toPromotionTemplatePayload,
};
