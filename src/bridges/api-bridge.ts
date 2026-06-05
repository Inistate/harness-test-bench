/**
 * Direct HTTP client for Inistate API endpoints not exposed via MCP.
 * Reads auth from the same env vars as the MCP server (INISTATE_API_TOKEN,
 * INISTATE_API_URL), so no extra configuration is needed.
 */
export class ApiBridge {
  private baseUrl: string;
  private authHeader: string | null;

  constructor() {
    this.baseUrl = (
      process.env.INISTATE_API_URL ??
      process.env.INISTATE_API_BASE ??
      "https://api.inistate.com"
    ).replace(/\/+$/, "");

    const token =
      process.env.INISTATE_API_TOKEN ??
      process.env.INISTATE_ACCESS_TOKEN ??
      process.env.INISTATE_API_KEY;

    this.authHeader = token ? `fsk ${token}` : null;
  }

  private buildHeaders(workspaceId?: string | null, workspaceName?: string | null): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.authHeader) h["authorization"] = this.authHeader;
    if (workspaceId) h["wsid"] = String(workspaceId);
    if (workspaceName) h["workspace"] = workspaceName;
    return h;
  }

  async post(
    path: string,
    body: unknown,
    workspaceId?: string | null,
    workspaceName?: string | null
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.buildHeaders(workspaceId, workspaceName),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: Record<string, unknown> = {};
      try { parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
      throw Object.assign(
        new Error((parsed["message"] as string) ?? text ?? `HTTP ${res.status}`),
        { status: res.status }
      );
    }
    return text ? JSON.parse(text) : null;
  }

  /** Delete a module by its numeric id. POST /api/studio/delete/ { id: moduleId } */
  async deleteModule(
    workspaceId: string | number,
    workspaceName: string | null,
    moduleId: string | number
  ): Promise<unknown> {
    return this.post(
      "/api/studio/delete/",
      { id: Number(moduleId) },
      String(workspaceId),
      workspaceName
    );
  }
}
