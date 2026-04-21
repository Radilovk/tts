// Pre-configured API key injected at build time via GitHub Actions secret GEMINI_API_KEY.
// If the placeholder is not replaced, the app falls back to the user-entered key in settings.
window.PRECONFIGURED_API_KEY = '__GEMINI_API_KEY__';
