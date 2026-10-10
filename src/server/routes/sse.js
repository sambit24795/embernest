'use strict';

const TERMINAL = ['done', 'error', 'cancelled', 'blocked'];

/**
 * Stream a job's snapshots as Server-Sent Events until it reaches a terminal
 * status or the client disconnects.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object|null} job        current snapshot, or null for 404
 * @param {Function} subscribe     (id, cb) => unsubscribe | null
 * @param {string} notFound        404 message
 */
function streamEvents(req, res, job, subscribe, notFound) {
  if (!job) return res.status(404).json({ error: notFound });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  send(job);
  if (TERMINAL.includes(job.status)) return res.end();

  const unsubscribe = subscribe(job.id, (snap) => {
    send(snap);
    if (TERMINAL.includes(snap.status)) res.end();
  });
  req.on('close', () => { if (unsubscribe) unsubscribe(); });
  return undefined;
}

module.exports = { streamEvents };
