import { createCollaborationRuntime } from '../../server/collaboration/runtime.js';
// Read-only protocol/authentication capability checks. Never submits a model prompt.
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), modelRequests: 0, runtimes: await createCollaborationRuntime().probe() }, null, 2));
