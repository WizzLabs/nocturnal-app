// ─── FEEDBACK.JS (Solo Creator Update) ───────────────────────────────────
// Handles the "Feedback" modal and the "Meet the Creator" modal it opens into.

const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSekOk0oBA_b1h0ZQIg9qNx-PIYMooKpNUO6pkhbQveVrv69HA/viewform?usp=publish-editor';

// Team member portfolio links
const TEAM_MEMBER1_PORTFOLIO_URL = 'https://wizzlabs.pages.dev/';
// ❌ Removed TEAM_MEMBER2_PORTFOLIO_URL

// ─── DOM REFS — Feedback modal ──────────────────────────────────────────
const feedbackOverlayEl    = document.getElementById('feedback-overlay');
const feedbackOpenBtn      = document.getElementById('feedback-btn');
const feedbackCloseBtn     = document.getElementById('feedback-close-btn');
const feedbackReportBtn    = document.getElementById('feedback-report-btn');
const feedbackPortfolioBtn = document.getElementById('feedback-portfolio-btn'); 

// ─── DOM REFS — Meet the Creator modal ──────────────────────────────────
const teamOverlayEl   = document.getElementById('team-overlay');
const teamCloseBtn    = document.getElementById('team-close-btn');
const teamMember1Btn  = document.getElementById('team-member1-btn');
// ❌ Removed teamMember2Btn ref

function openFeedbackModal() {
  feedbackOverlayEl.classList.add('open');
}

function closeFeedbackModal() {
  feedbackOverlayEl.classList.remove('open');
}

function openTeamModal() {
  teamOverlayEl.classList.add('open');
}

function closeTeamModal() {
  teamOverlayEl.classList.remove('open');
}

function openInNewTab(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ─── LISTENERS — Feedback modal ─────────────────────────────────────────
if (feedbackOpenBtn) feedbackOpenBtn.addEventListener('click', openFeedbackModal);
if (feedbackCloseBtn) feedbackCloseBtn.addEventListener('click', closeFeedbackModal);
if (feedbackOverlayEl) {
  feedbackOverlayEl.addEventListener('click', (e) => {
    if (e.target === feedbackOverlayEl) closeFeedbackModal(); 
  });
}
if (feedbackReportBtn) {
  feedbackReportBtn.addEventListener('click', () => openInNewTab(FEEDBACK_FORM_URL));
}
if (feedbackPortfolioBtn) {
  feedbackPortfolioBtn.addEventListener('click', openTeamModal); 
}

// ─── LISTENERS — Meet the Creator modal ─────────────────────────────────
if (teamCloseBtn) teamCloseBtn.addEventListener('click', closeTeamModal);
if (teamOverlayEl) {
  teamOverlayEl.addEventListener('click', (e) => {
    if (e.target === teamOverlayEl) closeTeamModal(); 
  });
}
if (teamMember1Btn) {
  teamMember1Btn.addEventListener('click', () => openInNewTab(TEAM_MEMBER1_PORTFOLIO_URL));
}
// ❌ Removed teamMember2Btn listener
