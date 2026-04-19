import { Hono } from "hono";
import { renderer } from "./renderer";
import { createSyncApi } from "cf-sync-kit/server";
import { collectionsConfig } from "../../shared/schema";
import { getRoom, ProjectRoom } from "./do";
import completeAll from "./api/complete-all";

export { ProjectRoom };

const app = new Hono<{ Bindings: Bindings }>()

  .all("/parties/:party/:roomId", async (c) => {
    const roomId = c.req.param("roomId");
    const party = c.req.param("party");
    const id = c.env.PROJECT_ROOM.idFromName(roomId);
    const room = c.env.PROJECT_ROOM.get(id);
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-partykit-namespace", party);
    headers.set("x-partykit-room", roomId);
    return room.fetch(new Request(c.req.raw, { headers }));
  })

  .route("/api/complete-all", completeAll)

  const syncApi = createSyncApi(collectionsConfig, getRoom, {
    dbName: 'TODOS_DB',
  });
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
