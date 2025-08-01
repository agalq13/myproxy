import { RequestPreprocessor } from "../index";

const DISALLOWED_ORIGIN_SUBSTRINGS = "janitorai.com,janitor.ai,vip.jewproxy.tech,jewproxy.tech".split(",");

class ZoomerForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoomerForbiddenError";
  }
}

/**
 * Blocks requests from Janitor AI users with a fake, scary error message so I
 * stop getting emails asking for tech support.
 */
export const blockZoomerOrigins: RequestPreprocessor = (req) => {
  const origin = req.headers.origin || req.headers.referer || req.headers.host;
  if (origin && DISALLOWED_ORIGIN_SUBSTRINGS.some((s) => origin.includes(s))) {
    // Venus-derivatives send a test prompt to check if the proxy is working.
    // We don't want to block that just yet.
    if (req.body.messages[0]?.content === "Just say TEST") {
      return;
    }

    throw new ZoomerForbiddenError(
      `Your access was terminated due to violation of our policies, please check your email for more information. If you believe this is in error and would like to appeal, please contact us through our help center at help.openai.com.`
    );
  }
};
