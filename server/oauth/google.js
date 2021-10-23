import { google } from "googleapis";
import LitJsSdk from "lit-js-sdk";
import { authUser } from "../auth.js";
import { parseJwt } from "../utils.js";

export default async function (fastify, opts) {
  const googleRedirectUri = "api/oauth/google/callback";

  // store the user's access token
  fastify.post("/api/google/connect", async (req, res) => {
    const { authSig } = req.body;
    if (!authUser(authSig)) {
      res.code(400);
      return { error: "Invalid signature" };
    }

    // First - get Google Drive refresh token (given acct email and drive)
    const oauth_client = new google.auth.OAuth2(
      process.env.REACT_APP_LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_ID,
      process.env.LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_SECRET,
      "postmessage"
    );
    const { tokens } = await oauth_client.getToken(req.body.token);
    oauth_client.setCredentials(tokens);

    const parsedJwt = parseJwt(tokens.id_token);
    const idOnService = parsedJwt.sub;

    const drive = google.drive({
      version: "v3",
      auth: oauth_client,
    });
    const about_info = await drive.about.get({
      fields: "user",
    });

    const existingRows = await fastify.objection.models.connectedServices
      .query()
      .where("service_name", "=", "google")
      .where("id_on_service", "=", idOnService);

    let connected_service_id;

    if (existingRows.length > 0) {
      // okay the token already exists, just update it
      existingRows[0].patch({
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
      });
      connected_service_id = existingRows[0].id;
    } else {
      // insert
      const query = await fastify.objection.models.connectedServices
        .query()
        .insert({
          id_on_service: idOnService,
          email: about_info.data.user.emailAddress,
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          extra_data: about_info.data.user,
          user_id: authSig.address,
          service_name: "google",
        });
      connected_service_id = query.id;
    }

    console.log('CONNECTED SERVICE DECLARE', connected_service_id)

    const connectedGoogleServices =
      await fastify.objection.models.connectedServices
        .query()
        .where("user_id", "=", authSig.address)
        .where("service_name", "=", "google");
    const serialized = connectedGoogleServices.map((s) => ({
      id: s.id,
      email: s.email,
      idOnService: s.id_on_service,
    }));

    return { connectedServices: serialized };
  });

  fastify.post("/api/google/verifyToken", async (req, res) => {
    const oauth_client = new google.auth.OAuth2(
      process.env.REACT_APP_LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_ID,
    );

    const ticket = await oauth_client.verifyIdToken({
      idToken: req.body.id_token,
      audience: process.env.REACT_APP_LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_ID
    })
    const payload = ticket.getPayload();
    const userId = payload['sub'];

    if (payload.aud !== process.env.REACT_APP_LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_ID) {
      res.code(400);
      return { error: "Invalid signature" };
    } else {
      return userId;
    }
  });

  fastify.post("/api/google/getUserProfile", async (req, res) => {
    const uniqueId = req.body.uniqueId.toString();
    const userProfile = await fastify.objection.models.connectedServices
      .query()
      .where("service_name", "=", "google")
      // .where("id_on_service", "=", uniqueId)
      // .where("user_id", '=', req.body.authSig.address)
    return userProfile
  })

  fastify.post("/api/google/share", async (req, res) => {
    console.log('REQ BODY', req.body)
    const { authSig, connectedServiceId } = req.body;
    if (!authUser(authSig)) {
      res.code(400);
      return { error: "Invalid signature" };
    }

    const connectedService = (
      await fastify.objection.models.connectedServices
        .query()
        .where("user_id", "=", authSig.address)
        .where("id", "=", connectedServiceId)
    )[0];

    const insertToLinksQuery = await fastify.objection.models.shares
      .query()
      .insert({
        asset_id_on_service: req.body.driveId,
        access_control_conditions: JSON.stringify(
          req.body.accessControlConditions
        ),
        connected_service_id: connectedService.id,
        role: req.body.role,
        user_id: authSig.address,
      });

    let uuid = insertToLinksQuery.id;

    return {
      authorizedControlConditions: req.body.accessControlConditions,
      uuid,
    };
  });

  // TODO make this use objectionjs models
  fastify.post("/api/google/delete", async (req, res) => {
    const uuid = req.body.uuid;
    // get email from token
    const oauth_client = new google.auth.OAuth2(
      process.env.LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_ID,
      process.env.LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_SECRET,
      "postmessage"
    );
    const { tokens } = await oauth_client.getToken(req.body.token);
    oauth_client.setCredentials(tokens);

    const drive = google.drive({
      version: "v3",
      auth: oauth_client,
    });

    const about_info = await drive.about.get({
      fields: "user",
    });

    let email = about_info.data.user.emailAddress;
    const query = {
      text: "DELETE FROM links USING links AS l LEFT OUTER JOIN sharers ON l.sharer_id = sharers.id WHERE links.id = l.id AND links.id = $1 AND sharers.email = $2",
      values: [uuid, email],
    };

    let deleted_row = await runQuery(query);

    if (deleted_row === "error") {
      return res.status(400).send();
    } else {
      return res.status(200).send();
    }
  });

  fastify.post("/api/google/conditions", async (req, res) => {
    const uuid = req.body.uuid;

    const share = (
      await fastify.objection.models.shares.query().where("id", "=", uuid)
    )[0];

    return { share };
  });

  fastify.post("/api/google/shareLink", async (req, res) => {
    // Check the supplied JWT
    const requestedEmail = req.body.email;
    const role = req.body.role.toString();
    const uuid = req.body.uuid;
    const jwt = req.body.jwt;
    const { verified, header, payload } = LitJsSdk.verifyJwt({ jwt });
    if (
      !verified ||
      payload.baseUrl !==
        `${process.env.REACT_APP_LIT_PROTOCOL_OAUTH_FRONTEND_HOST}/${googleRedirectUri}` ||
      payload.path !== "/l/" + uuid ||
      payload.orgId !== "" ||
      payload.role !== role ||
      payload.extraData !== ""
    ) {
      res.end("JWT verification failed.");
      return;
    }

    const share = (
      await fastify.objection.models.shares.query().where("id", "=", uuid)
    )[0];

    const connectedService = (
      await fastify.objection.models.connectedServices
        .query()
        .where("id", "=", share.connectedServiceId)
    )[0];

    const oauth_client = new google.auth.OAuth2(
      process.env.LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_ID,
      process.env.LIT_PROTOCOL_OAUTH_GOOGLE_CLIENT_SECRET,
      "postmessage"
    );

    oauth_client.setCredentials({
      access_token: connectedService.accessToken,
      refresh_token: connectedService.refreshToken,
    });
    const roleMap = {
      read: "reader",
      comment: "commenter",
      write: "writer",
    };

    const permission = {
      type: "user",
      role: roleMap[share.role],
      emailAddress: requestedEmail,
    };
    const drive = google.drive({
      version: "v3",
      auth: oauth_client,
    });

    await drive.permissions.create({
      resource: permission,
      fileId: share.asset_id_on_service,
      fields: "id",
    });

    // Send drive ID back and redirect
    return { fileId: share.asset_id_on_service };
  });

  fastify.get("/api/oauth/google/callback", async (request, response) => {
    response.redirect(process.env.LIT_PROTOCOL_OAUTH_FRONTEND_HOST);
  });
}