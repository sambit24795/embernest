'use strict';

/** @param {import('express').Express} app @param {object} ctx */
function register(app, ctx) {
  /**
   * POST /api/comfy/restart — managed mode only: the supervisor restarts ComfyUI.
   * With no supervisor (external ComfyUI) the user has to restart it themselves.
   */
  app.post('/api/comfy/restart', async (req, res) => {
    if (!ctx.supervisor) {
      return res.status(400).json({ error: 'ComfyUI is external — restart it yourself' });
    }
    try {
      await ctx.supervisor.restart();
      return res.json({ restarted: true });
    } catch (err) {
      return res.status(500).json({ restarted: false, error: err.message });
    }
  });
}

module.exports = { register };
