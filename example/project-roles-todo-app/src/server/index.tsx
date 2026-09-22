import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { renderer } from "./renderer";
import api from "./api";
import { createWebSocketHandler } from "cf-sync-kit/server";
export { ProjectRoom } from "./do";

import { users } from "../config/users";
const authMiddleware = basicAuth(
  {
    onAuthSuccess: (c, username) => {
      c.set("username", username);
    },
    ...users[0],
  },
  ...users.slice(1),
);

const app = new Hono<{ Bindings: Bindings; Variables: { username: string } }>()

  .use(renderer)
  .get('/logout', (c) => {
    c.status(401);
    return c.render(
      <div style={{ textAlign: 'center', margin: '100px auto' }}>
        <h2>Logging out...</h2>
          <script dangerouslySetInnerHTML={{ __html: `
            (async () => {
              try {
                await fetch('/logout', {
                  method: 'GET',
                  credentials: 'include',
                  cache: 'no-store',
                  headers: { 'Authorization': 'Basic ' + btoa('log:out') }
                });
              } catch (e) {
                console.error('Logout request failed:', e);
              }
              window.location.replace('/');
            })();
          ` }} />
      </div>,
    );
  })
  .use("/*", authMiddleware)
  
  .all("/parties/:party/:roomId", async (c) => {
    return createWebSocketHandler(c.env.PROJECT_ROOM, {
      party: 'todos',
      authorize: () => c.get('username'),
    })(c.req.raw)
  })
  .route("/api", api)

  .get("/", (c) => {
    return c.render(
      <>
        <div id="root"></div>
      </>,
    );
  })

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  const status = (err as any).status || 500
  const message = (err as any).message || 'Internal server error'
  console.error('Server error:', err)
  return c.json({ error: { message } }, status)
})

export default app;
export type AppType = typeof app;
