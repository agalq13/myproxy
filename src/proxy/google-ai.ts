import { Request, RequestHandler, Router, Response, NextFunction } from "express";
import { v4 } from "uuid";
import { GoogleAIKey, keyPool } from "../shared/key-management";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import {
  createPreprocessorMiddleware,
  finalizeSignedRequest,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { addGoogleAIKey } from "./middleware/request/mutators/add-google-ai-key";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import axios from "axios";

let modelsCache: any = null;
let modelsCacheTime = 0;

// Cache for native Google AI models
let nativeModelsCache: any = null;
let nativeModelsCacheTime = 0;

// https://ai.google.dev/models/gemini
// TODO: list models https://ai.google.dev/tutorials/rest_quickstart#list_models

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.googleAIKey) return { object: "list", data: [] };

  const keys = keyPool
    .list()
    .filter((k) => k.service === "google-ai") as GoogleAIKey[];
  if (keys.length === 0) {
    modelsCache = { object: "list", data: [] };
    modelsCacheTime = new Date().getTime();
    return modelsCache;
  }

  // Get all model IDs from keys, excluding any with "bard" in the name
  const modelIds = Array.from(
    new Set(keys.map((k) => k.modelIds).flat())
  ).filter((id) => id.startsWith("models/") && !id.includes("bard"));
  
  // Strip "models/" prefix from IDs before creating model objects
  const models = modelIds.map((id) => ({
    // Strip "models/" prefix from ID for consistency with request processing
    id: id.startsWith("models/") ? id.slice("models/".length) : id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "google",
    permission: [],
    root: "google",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

// Function to fetch native models from Google AI API
const getNativeModelsResponse = async () => {
  // Return cached value if it was refreshed in the last minute
  if (new Date().getTime() - nativeModelsCacheTime < 1000 * 60) {
    return nativeModelsCache;
  }

  /*
   * The official Google API requires an API key.  However SillyTavern only needs
   * a list of model IDs and does not care about any other model metadata.  We
   * can therefore generate a **synthetic** response from the keys already
   * loaded into the proxy (same source we use for the OpenAI-compatible
   * endpoint) and completely avoid the outbound request.  This removes the
   * need for the frontend to supply the proxy password as an API key and
   * prevents 4xx/5xx errors when the real Google API is unreachable or the key
   * is missing.
   */
  const openaiStyle = getModelsResponse();
  const models = (openaiStyle.data || []).map((m: any) => ({
    // Google AI Studio returns names in the format "models/<id>"
    name: `models/${m.id}`,
    supportedGenerationMethods: ["generateContent"],
  }));

  nativeModelsCache = { models };
  nativeModelsCacheTime = new Date().getTime();
  return nativeModelsCache;
};

const handleModelRequest: RequestHandler = (_req: Request, res: any) => {
  res.status(200).json(getModelsResponse());
};

// Native Gemini API model list request
const handleNativeModelRequest: RequestHandler = async (_req: Request, res: any) => {
  try {
    const modelsResponse = await getNativeModelsResponse();
    res.status(200).json(modelsResponse);
  } catch (error) {
    console.error("Error in handleNativeModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

const googleAIBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.inboundApi === "openai") {
    req.log.info("Transforming Google AI response to OpenAI format");
    newBody = transformGoogleAIResponse(body, req);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function transformGoogleAIResponse(
  resBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  
  // Handle the case where content might have different structures
  let content = "";
  
  // Check if the response has the expected structure
  if (resBody.candidates && resBody.candidates[0]) {
    const candidate = resBody.candidates[0];
    
    // Extract content text with multiple fallbacks
    if (candidate.content?.parts && candidate.content.parts[0]?.text) {
      // Regular format with parts array containing text
      content = candidate.content.parts[0].text;
    } else if (candidate.content?.text) {
      // Alternate format with direct text property
      content = candidate.content.text;
    } else if (typeof candidate.content?.parts?.[0] === 'string') {
      // Some formats might have string parts
      content = candidate.content.parts[0];
    }
    
    // Apply cleanup to the content if needed
    content = content.replace(/^(.{0,50}?): /, () => "");
  }
  
  return {
    id: "goo-" + v4(),
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: resBody.candidates?.[0]?.finishReason || "STOP",
        index: 0,
      },
    ],
  };
}

const googleAIProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }: { signedRequest: any }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    const { protocol, hostname} = signedRequest;
    return `${protocol}//${hostname}`;
  },
  mutations: [addGoogleAIKey, finalizeSignedRequest],
  blockingResponseHandler: googleAIBlockingResponseHandler,
});

const googleAIRouter = Router();
googleAIRouter.get("/v1/models", handleModelRequest);
googleAIRouter.get("/:apiVersion(v1alpha|v1beta)/models", handleNativeModelRequest);

/**
 * Processes the thinking budget for Gemini 2.5 Flash model.
 * Validation has been disabled - budget is passed through without limits.
 */
function processThinkingBudget(req: Request) {
  // Validation disabled - budget is passed through without any range limits
  // Previously enforced 0-24576 token limit
}

function setStreamFlag(req: Request) {
  const isStreaming = req.url.includes("streamGenerateContent");
  if (isStreaming) {
    req.body.stream = true;
    req.isStreaming = true;
  } else {
    req.body.stream = false;
    req.isStreaming = false;
  }
}

/**
 * Strips 'models/' prefix from the beginning of model IDs if present.
 * No longer forces redirection to gemini-1.5-pro-latest for non-Gemini models.
 **/
function maybeReassignModel(req: Request) {
  // Ensure model is on body as a lot of middleware will expect it.
  const model = req.body.model || req.url.split("/").pop()?.split(":").shift();
  if (!model) {
    throw new Error("You must specify a model with your request.");
  }
  req.body.model = model;

  // Only strip the 'models/' prefix if present
  if (model.startsWith("models/")) {
    req.body.model = model.slice("models/".length);
    req.log.info({ originalModel: model, updatedModel: req.body.model }, "Stripped 'models/' prefix from model ID");
  }
  
  // No longer redirecting non-Gemini models to gemini-1.5-pro-latest
  // This allows the original model to be passed through to the API
  // If it's an invalid model, the Google AI API will return the appropriate error
}

/**
 * Middleware to check for and block requests to experimental models.
 * This function is intended to be used as a RequestPreprocessor.
 * It throws an error if an experimental model is detected, which should be
 * caught by the proxy's onError handler.
 */
function checkAndBlockExperimentalModels(req: Request) { // Changed signature
  const modelId = req.body.model as string | undefined;

  // Check if the model ID contains "exp" (case-insensitive)
  if (modelId && modelId.toLowerCase().includes("exp")) {
    req.log.warn({ modelId }, "Blocking request to experimental Google AI model.");
    const err: any = new Error("Experimental models are too unstable to be supported in proxy code. Please use preview models instead.");
    err.statusCode = 400;
    throw err;
  }
  // If no experimental model, do nothing, allowing request to proceed.
}

// Native Google AI chat completion endpoint
googleAIRouter.post(
  "/:apiVersion(v1alpha|v1beta)/models/:modelId:(generateContent|streamGenerateContent)",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "google-ai", outApi: "google-ai", service: "google-ai" },
    { 
      beforeTransform: [maybeReassignModel], 
      afterTransform: [checkAndBlockExperimentalModels, setStreamFlag, processThinkingBudget] 
    }
  ),
  googleAIProxy
);

// OpenAI-to-Google AI compatibility endpoint.
googleAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "google-ai", service: "google-ai" },
    { 
      afterTransform: [maybeReassignModel, checkAndBlockExperimentalModels, processThinkingBudget] 
    }
  ),
  googleAIProxy
);

export const googleAI = googleAIRouter;
