import Fastify from "fastify";
import fastifyPostgres from "fastify-postgres";
import fastifyCors from "fastify-cors";
import fastifyStatic from "fastify-static";
import * as path from "path";
import axios from "axios";
import * as zoom from "./oauth/zoom.js";

import { authUser } from "./auth.js";
import { getAccessToken, getUser } from "./oauth/zoom.js";
import { keysToCamel } from "./utils.js";

const __dirname = path.resolve();

// import Bugsnag from "@bugsnag/js";
// Bugsnag.start({
//   apiKey: "f1e11c9bf8115a600106376040bc50cc",
//   releaseStage: process.env.LIT_GATEWAY_ENVIRONMENT,
// });

const fastify = Fastify();

const dbConfig = {
  connectionString: process.env.LIT_PROTOCOL_OAUTH_DB_URL,
};

if (
  process.env.LIT_PROTOCOL_OAUTH_ZOOM_ENVIRONMENT === "production" ||
  process.env.LIT_PROTOCOL_OAUTH_ZOOM_ENVIRONMENT === "development"
) {
  dbConfig.ssl = { rejectUnauthorized: false };
}

fastify.register(fastifyPostgres, dbConfig);
fastify.register(fastifyCors, {
  origin: "*",
  methods: ["POST", "GET", "DELETE", "PUT", "PATCH"],
});

const BuildPath = path.join(__dirname, "..", "build");
fastify.register(fastifyStatic, {
  root: BuildPath,
});

fastify.setErrorHandler((error, request, reply) => {
  console.log("Fastify error: ", error);
  if (process.env.LIT_GATEWAY_ENVIRONMENT !== "local") {
    Bugsnag.notify(error);
  }
  reply.send({ error });
});

fastify.post("/api/oauth/zoom/login", async (request, reply) => {
  const { authSig } = request.body;

  if (!authUser(authSig)) {
    reply.code(400);
    return { error: "Invalid signature" };
  }

  const q = {
    response_type: "code",
    client_id: process.env.LIT_PROTOCOL_OAUTH_ZOOM_CLIENT_ID,
    redirect_uri: process.env.LIT_PROTOCOL_OAUTH_ZOOM_REDIRECT_URL,
    state: JSON.stringify({
      authSig,
    }),
  };

  reply.send({
    redirectTo:
      "https://zoom.us/oauth/authorize?" + new URLSearchParams(q).toString(),
  });
});

fastify.get("/api/oauth/zoom/callback", async (request, reply) => {
  const { state } = request.query;
  console.log("state from zoom", state);
  const { authSig } = JSON.parse(state);
  console.log("authSig from zoom", authSig);

  if (!authUser(authSig)) {
    reply.code(400);
    return { error: "Invalid signature" };
  }
  const userId = authSig.address;

  const data = await zoom.getAccessToken({ code: request.query.code });
  const accessToken = data.access_token;

  const user = await zoom.getUser({ accessToken });
  console.log("user", user);

  // if access token already stored, replace it
  await fastify.pg.transact(async (client) => {
    // will resolve to an id, or reject with an error
    const id = await client.query(
      "DELETE FROM connected_services WHERE user_id=$1 AND service_name=$2 AND id_on_service=$3",
      [userId, "zoom", user.id]
    );

    // potentially do something with id
    return id;
  });

  // store access token and user info
  await fastify.pg.transact(async (client) => {
    // will resolve to an id, or reject with an error
    const id = await client.query(
      "INSERT INTO connected_services(user_id, service_name, id_on_service, email, created_at, access_token, refresh_token, extra_data) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
      [
        authSig.address,
        "zoom",
        user.id,
        user.email,
        new Date(),
        data.access_token,
        data.refresh_token,
        JSON.stringify({ token: data, user }),
      ]
    );

    // potentially do something with id
    return id;
  });

  reply.redirect(process.env.LIT_PROTOCOL_OAUTH_FRONTEND_HOST);
});

fastify.post("/api/zoom/meetings", async (request, reply) => {
  const { authSig } = request.body;

  if (!authUser(authSig)) {
    reply.code(400);
    return { error: "Invalid signature" };
  }
  const userId = authSig.address;

  const services = (
    await fastify.pg.query(
      "SELECT * FROM connected_services WHERE user_id=$1 and service_name=$2",
      [userId, "zoom"]
    )
  ).rows;

  const meetings = await Promise.all(
    services.map((s) =>
      zoom.getMeetings({
        accessToken: s.access_token,
        refreshToken: s.refresh_token,
        connectedServiceId: s.id,
      })
    )
  );

  return {
    meetings,
  };
});

fastify.post("/api/zoom/shareMeeting", async (request, reply) => {
  const { authSig, meeting, accessControlConditions } = request.body;

  if (!authUser(authSig)) {
    reply.code(400);
    return { error: "Invalid signature" };
  }
  const userId = authSig.address;

  await fastify.pg.transact(async (client) => {
    // will resolve to an id, or reject with an error
    const id = await client.query(
      "DELETE FROM shares WHERE user_id=$1 AND connected_service_id=$2",
      [meeting.connectedServiceId, meeting.connectedServiceId]
    );

    // potentially do something with id
    return id;
  });

  // store the share
  await fastify.pg.transact(async (client) => {
    // will resolve to an id, or reject with an error
    const id = await client.query(
      "INSERT INTO shares(user_id, connected_service_id, asset_id_on_service, access_control_conditions, name) VALUES($1, $2, $3, $4, $5) RETURNING id",
      [
        authSig.address,
        meeting.connectedServiceId,
        meeting.id,
        JSON.stringify(accessControlConditions),
        meeting.topic,
      ]
    );

    // potentially do something with id
    return id;
  });

  return {
    success: true,
  };
});

fastify.post("/api/connectedServices", async (request, reply) => {
  const { authSig } = request.body;

  if (!authUser(authSig)) {
    reply.code(400);
    return { error: "Invalid signature" };
  }
  const userId = authSig.address;

  const services = (
    await fastify.pg.query(
      "SELECT service_name, email, created_at FROM connected_services WHERE user_id=$1",
      [userId]
    )
  ).rows;

  return {
    services: services.map((s) => keysToCamel(s)),
  };
});

fastify.listen(process.env.PORT || 4000, "0.0.0.0", (err) => {
  if (err) throw err;
  console.log(`server listening on ${fastify.server.address().port}`);
});
