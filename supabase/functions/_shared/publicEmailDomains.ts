export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.th",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "mail.com",
  "gmx.com",
  "zoho.com",
  "yandex.com",
]);

export function normalizeEmailDomain(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(normalizeEmailDomain(domain));
}

export function assertPrivateEmailDomain(domain: string): string {
  const normalized = normalizeEmailDomain(domain);
  if (isPublicEmailDomain(normalized)) {
    throw new Error(
      "Public email domains cannot be used as organization domains. Invite those users individually instead.",
    );
  }
  return normalized;
}
