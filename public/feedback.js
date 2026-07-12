// ─── FEEDBACK.JS (Sprint 7.2 — Release Candidate polish) ───────────────────
// Handles the "Feedback" modal: two static outbound links, no server calls,
// no stored state. URLs live in one place here so they're easy to change
// later without hunting through the codebase.
//
// Does NOT touch script.js, settings.js, or personality.js.

const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSekOk0oBA_b1h0ZQIg9qNx-PIYMooKpNUO6pkhbQveVrv69HA/viewform?usp=publish-editor';
const CREATOR_PORTFOLIO_URL = 'https://wizzbot-offi.vercel.app/';

// ─── DOM REFS ───────────────────────────────────────────────────────────
const feedbackOverlayEl   = document.getElementById('feedback-overlay');
const feedbackOpenBtn     = document.getElementById('feedback-btn');
const feedbackCloseBtn    = document.getElementById('feedback-close-btn');
const feedbackReportBtn   = document.getElementById('feedback-report-btn');
const feedbackPortfolioBtn = document.getElementById('feedback-portfolio-btn');

function openFeedbackModal() {
  feedbackOverlayEl.classList.add('open');
}

function closeFeedbackModal() {
  feedbackOverlayEl.classList.remove('open');
}

function openInNewTab(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ─── LISTENERS ────────────────────────────────────────────────────────────
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
  feedbackPortfolioBtn.addEventListener('click', () => openInNewTab(CREATOR_PORTFOLIO_URL));
}
