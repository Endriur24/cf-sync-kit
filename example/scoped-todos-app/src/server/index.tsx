import { Hono } from "hono";
import { renderer } from "./renderer";
import { createSyncApi } from "cf-sync-kit/server";
import { collectionsConfig } from "../../shared/schema";
import { getRoom, ProjectRoom } from "./do";
import { createWebSocketHandler } from "cf-sync-kit/server";

export { ProjectRoom };

const app = new Hono<{ Bindings: Bindings }>()

  .all(
    "/parties/:party/:roomId",
    async (c) => {
      return createWebSocketHandler(c.env.PROJECT_ROOM, { public: true })(c.req.raw)
    },
  )

  const syncApi = createSyncApi(collectionsConfig, getRoom);
  app.route("/api", syncApi)

  .use(renderer)
  .get("/", (c) => {
    return c.render(
      <>
        <div id="root"></div>
      </>,
    );
  });

app.onError((err, c) => {
  const status = (err as any).status || 500
  const message = (err as any).message || 'Internal server error'
  console.error('Server error:', err)
  return c.json({ error: { message } }, status)
})

export default app;
export type AppType = typeof app;
