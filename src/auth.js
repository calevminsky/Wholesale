// Simple HTTP Basic Auth gate. Off when WHOLESALE_PASSWORD isn't set so local
// dev and existing deployments keep working unchanged.
//
// Username is ignored; only the password is checked. Browsers cache the
// credentials for the session, so the wholesale manager logs in once.
//
// Public routes (paths in `publicPaths`) bypass the gate. Use this for the
// future customer-facing approval link.
import crypto from "crypto";

function timingSafeEq(a, b) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createBasicAuth({ publicPaths = [] } = {}) {
  const password = process.env.WHOLESALE_PASSWORD || "";
  const realm = process.env.WHOLESALE_AUTH_REALM || "Wholesale";

  if (!password) {
    return (_req, _res, next) => next();
  }

  const isPublic = (urlPath) => {
    for (const p of publicPaths) {
      if (typeof p === "string" && (urlPath === p || urlPath.startsWith(p + "/"))) return true;
      if (p instanceof RegExp && p.test(urlPath)) return true;
    }
    return false;
  };

  return (req, res, next) => {
    if (isPublic(req.path)) return next();

    const header = req.headers["authorization"] || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const provided = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (timingSafeEq(provided, password)) return next();
    }

    res.setHeader("WWW-Authenticate", `Basic realm="${realm}"`);
    res.status(401).send("Authentication required.");
  };
}
