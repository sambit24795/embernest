'use strict';
// Stand-in for ComfyUI's main.py: argv[2] is the port. Used by supervisor tests.
const { startFakeComfy } = require('./fake-comfy');

startFakeComfy({ port: Number(process.argv[2]) }).then(() => console.log('fake comfy ready'));
