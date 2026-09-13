// ─── FEEDBACK.JS (Sprint 7.2 — Release Candidate polish) ───────────────────
// Handles the "Feedback" modal and the "Meet the Team" modal it opens into.
// No server calls, no stored state. URLs live in one place here so they're
// easy to change later without hunting through the codebase.
//
// Does NOT touch script.js, settings.js, or personality.js.

const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSekOk0oBA_b1h0ZQIg9qNx-PIYMooKpNUO6pkhbQveVrv69HA/viewform?usp=publish-editor';

// Team member portfolio links — Member 2's is a placeholder, swap it in later.
const TEAM_MEMBER1_PORTFOLIO_URL = 'https://wizzlabs.pages.dev/';
const TEAM_MEMBER2_PORTFOLIO_URL = 'https://example.com/sharuux-portfolio'; // TODO: replace with real URL

// ─── DOM REFS — Feedback modal ──────────────────────────────────────────
const feedbackOverlayEl    = document.getElementById('feedback-overlay');
const feedbackOpenBtn      = document.getElementById('feedback-btn');
const feedbackCloseBtn     = document.getElementById('feedback-close-btn');
const feedbackReportBtn    = document.getElementById('feedback-report-btn');
const feedbackPortfolioBtn = document.getElementById('feedback-portfolio-btn'); // now opens the Team modal

// ─── DOM REFS — Meet the Team modal ─────────────────────────────────────
const teamOverlayEl   = document.getElementById('team-overlay');
const teamCloseBtn    = document.getElementById('team-close-btn');
const teamMember1Btn  = document.getElementById('team-member1-btn');
const teamMember2Btn  = document.getElementById('team-member2-btn');

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
    if (e.target === feedbackOverlayEl) closeFeedbackModal(); // click outside modal box
  });
}
if (feedbackReportBtn) {
  feedbackReportBtn.addEventListener('click', () => openInNewTab(FEEDBACK_FORM_URL));
}
if (feedbackPortfolioBtn) {
  feedbackPortfolioBtn.addEventListener('click', openTeamModal); // "Meet the Team" now opens the modal
}

// ─── LISTENERS — Meet the Team modal ────────────────────────────────────
if (teamCloseBtn) teamCloseBtn.addEventListener('click', closeTeamModal);
if (teamOverlayEl) {
  teamOverlayEl.addEventListener('click', (e) => {
    if (e.target === teamOverlayEl) closeTeamModal(); // click outside modal box
  });
}
if (teamMember1Btn) {
  teamMember1Btn.addEventListener('click', () => openInNewTab(TEAM_MEMBER1_PORTFOLIO_URL));
}
if (teamMember2Btn) {
  teamMember2Btn.addEventListener('click', () => openInNewTab(TEAM_MEMBER2_PORTFOLIO_URL));
}
