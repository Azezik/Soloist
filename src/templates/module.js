const DEFAULT_STAGE_TEMPLATE = {
  introText: "Hi [Name],",
  populateName: true,
  bodyText: "",
  outroText: "Best,",
};

const LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER = "Add a template email to this stage in the settings tab";
const SETTINGS_TEMPLATE_BODY_PLACEHOLDER = "add text";

function normalizeStageTemplateConfig(input = {}, fallback = DEFAULT_STAGE_TEMPLATE) {
  return {
    introText: String(input?.introText ?? fallback.introText),
    populateName: input?.populateName !== undefined ? input.populateName === true : fallback.populateName,
    bodyText: String(input?.bodyText ?? fallback.bodyText),
    outroText: String(input?.outroText ?? fallback.outroText),
  };
}

function getContactFirstName(contactName = "") {
  const trimmedName = String(contactName || "").trim();
  if (!trimmedName) return "";

  const [firstPart] = trimmedName.split(/\s+/);
  return firstPart || "";
}

function renderTemplateWithLead(templateConfig, leadContactName = "") {
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

  return parts.join("\n\n");
}

function buildStageTemplateSettingsMarkup(stage, index, escapeHtml) {
  const config = normalizeStageTemplateConfig(stage);

  return `
    <div class="template-settings-card detail-grid">
      <p><strong>Template</strong></p>
      <label>Intro
        <input name="template-intro-${index}" value="${escapeHtml(config.introText)}" />
      </label>
      <label class="template-checkbox-row">
        <input type="checkbox" name="template-populate-name-${index}" ${config.populateName ? "checked" : ""} />
        <span>Populate name</span>
      </label>
      <label>Body
        <textarea name="template-body-${index}" rows="4" placeholder="${SETTINGS_TEMPLATE_BODY_PLACEHOLDER}">${escapeHtml(config.bodyText)}</textarea>
      </label>
      <label>Outro
        <input name="template-outro-${index}" value="${escapeHtml(config.outroText)}" />
      </label>
    </div>
  `;
}

export {
  DEFAULT_STAGE_TEMPLATE,
  LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER,
  SETTINGS_TEMPLATE_BODY_PLACEHOLDER,
  buildStageTemplateSettingsMarkup,
  getContactFirstName,
  normalizeStageTemplateConfig,
  renderTemplateWithLead,
};
