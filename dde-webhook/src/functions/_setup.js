// Enables true streaming HTTP request bodies (request.body as a live
// ReadableStream fed incrementally from the incoming connection, rather
// than a pre-buffered blob) -- off by default in @azure/functions v4.
// Required by streamRecordingLive.js, which needs to forward audio to
// Dragon Copilot as it arrives from the app, not after the whole upload
// finishes. Requires Azure Functions Host v4.28+; this file's only job is
// to run this line during startup, before any function is invoked -- it
// matches the same `src/functions/*.js` glob every other function file
// does (see package.json's "main"), so the Functions runtime loads it the
// same way, no separate wiring needed.
const { app } = require('@azure/functions');

app.setup({ enableHttpStream: true });
