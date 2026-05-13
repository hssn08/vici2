// D02 — POST /api/admin/imports/:id/cancel (Phase 2 stub) (PLAN §6.4)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

export function registerCancelImportRoute(app: AnyApp): void {
  app.post(
    "/api/admin/imports/:id/cancel",
    {
      preValidation: [app.requireAuth, app.requirePermission("lead:import")],
    },
    async (_req: AnyApp, reply: AnyApp) => {
      return reply.code(501).send({
        error: "NOT_IMPLEMENTED",
        message: "Import cancellation is a Phase 2 feature.",
      });
    },
  );
}
