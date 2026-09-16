/**
 * Next.js instrumentation hook: runs once per server process.
 * Starts the workflow controller loop when WORKFLOW_CONTROLLER=1 and seeds
 * built-in templates. Only the Node.js runtime is relevant here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { config } = await import('./src/server/config');
  const c = config();
  const { seedBuiltinTemplates } = await import('./src/server/workflow/builtin-templates');
  seedBuiltinTemplates().catch((e) => console.error('template seed failed', e));
  if (c.controllerEnabled) {
    const { startController } = await import('./src/server/workflow/controller');
    startController();
    console.log('[pai] workflow controller started');
  }
}
