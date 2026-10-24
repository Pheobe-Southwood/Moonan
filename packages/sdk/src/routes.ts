import { defineRegistry } from "@earendil-works/chord";
import type { Ctx } from "@earendil-works/chord";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * One HTTP handler a plugin contributes.
 *
 * `ctx` is the root the substrate opened for this request: a handler that calls into an
 * object passes it along, so the call belongs to the request and ends with it. Handlers
 * are short — a response that needs to outlive the request (a stream, a long poll) is
 * the wrong shape here, and should hold its state in a cell and answer in another call.
 */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse, ctx: Ctx) => void | Promise<void>;

/**
 * The server-side way out of the object protocol.
 *
 * Chord covers everything object-to-object; it has no opinion about plain HTTP, and the
 * substrate serves exactly one port for both. This registry is the hook between them:
 * the keys are `"GET /path"` for one method, or `"/path"` for any. A request that matches
 * nothing falls through to the built-in endpoints, the plugin assets and the shell.
 */
export const Routes = defineRegistry<RouteHandler>("moonan.routes", { conflict: "error" });
