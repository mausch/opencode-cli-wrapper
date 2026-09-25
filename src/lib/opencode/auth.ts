export interface AuthContext {
  enabled: boolean;
  token: string | null;
}

export function extractAuth(header: string | string[] | undefined): AuthContext {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
  if (raw === "") return { enabled: false, token: null };

  return {
    enabled: true,
    token: raw.replace(/^Bearer(?:\s+|$)/i, "").trim() || null,
  };
}
