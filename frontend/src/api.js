async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    credentials: "same-origin",
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "คำขอไม่สำเร็จ");
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

export const api = {
  me: () => request("/api/auth/me"),
  login: (body) => request("/api/auth/login", { method: "POST", body }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  summary: () => request("/api/dashboard/summary"),
  content: (query = "") => request(`/api/content${query}`),
  contentOne: (id) => request(`/api/content/${id}`),
  createContent: (body) => request("/api/content", { method: "POST", body }),
  updateContent: (id, body) => request(`/api/content/${id}`, { method: "PATCH", body }),
  deleteContent: (id) => request(`/api/content/${id}`, { method: "DELETE" }),
  duplicateContent: (id) => request(`/api/content/${id}/duplicate`, { method: "POST" }),
  cancelContent: (id) => request(`/api/content/${id}/cancel`, { method: "POST" }),
  generate: (body) => request("/api/ai/generate", { method: "POST", body }),
  video: (id) => request(`/api/content/${id}/video`, { method: "POST" }),
  schedule: (id, body) => request(`/api/content/${id}/schedule`, { method: "POST", body }),
  publish: (id, body) => request(`/api/content/${id}/publish`, { method: "POST", body }),
  retryPlatform: (id, platform, accountId) =>
    request(`/api/content/${id}/publishing/${platform}/retry`, { method: "POST", body: accountId ? { account_id: accountId } : {} }),
  publishing: () => request("/api/publishing"),
  approve: (id, body) => request(`/api/content/${id}/approve`, { method: "POST", body }),
  unapprove: (id) => request(`/api/content/${id}/unapprove`, { method: "POST" }),
  tiktokCreator: (accountId) => request(`/api/social/accounts/${accountId}/tiktok-creator`),
  calendar: () => request("/api/calendar"),
  accounts: () => request("/api/social/accounts"),
  connect: (platform, body) => request(`/api/social/${platform}/connect`, { method: "POST", body }),
  testAccount: (id) => request(`/api/social/accounts/${id}/test`, { method: "POST" }),
  disconnect: (id) => request(`/api/social/accounts/${id}/disconnect`, { method: "POST" }),
  setDefaultAccount: (id) => request(`/api/social/accounts/${id}/default`, { method: "POST" }),
  renameAccount: (id, name) => request(`/api/social/accounts/${id}`, { method: "PATCH", body: { account_name: name } }),
  deleteAccount: (id) => request(`/api/social/accounts/${id}`, { method: "DELETE" }),
  automation: () => request("/api/automation/settings"),
  saveAutomation: (body) => request("/api/automation/settings", { method: "PATCH", body }),
  runAutomation: () => request("/api/automation/run-now", { method: "POST" }),
  logs: (query = "") => request(`/api/logs${query}`),
  analytics: () => request("/api/analytics"),
  settings: () => request("/api/settings"),
  saveSettings: (section, body) => request(`/api/settings/${section}`, { method: "PATCH", body }),
  testAi: () => request("/api/settings/ai/test", { method: "POST" }),
};
