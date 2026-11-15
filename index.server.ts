import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerAskHandlers, startAskWatcher } from "./server/ask";

export default function contribute(server: PluginServerContext): () => void {
  registerAskHandlers(server);
  return startAskWatcher(server);
}
