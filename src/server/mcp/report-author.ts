import { env } from "cloudflare:workers";
import { DEFAULT_CLIENT_LABEL } from "@/server/mcp/client-label";

/**
 * The author stored on a report or template saved over MCP. A deployment can
 * pin it with REPORT_AUTHOR_LABEL (e.g. the agency's name) so client-facing
 * reports never say which agent wrote them; otherwise it is the label the
 * transport derived from the request.
 */
export function reportAuthorLabel(clientLabel: string | undefined): string {
  return env.REPORT_AUTHOR_LABEL?.trim() || clientLabel || DEFAULT_CLIENT_LABEL;
}
