import type { SupabaseClient, User } from "https://esm.sh/@supabase/supabase-js@2";

type MinimalUser = Pick<User, "id" | "email">;

export async function acceptPendingOrgInviteForUser(
  client: SupabaseClient,
  user: MinimalUser,
  via = "runtime",
): Promise<{ accepted: boolean; organizationId: string | null; teamId: string | null }> {
  const email = String(user.email ?? "").trim().toLowerCase();
  if (!email) return { accepted: false, organizationId: null, teamId: null };

  const { data: invites, error: inviteError } = await client
    .from("organization_member_invites")
    .select("id,organization_id,role,team_id,invited_by,expires_at,created_at")
    .eq("email", email)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(10);
  if (inviteError) throw new Error(`pending invite lookup failed: ${inviteError.message}`);

  const now = Date.now();
  const invite = (invites ?? []).find((row: any) => {
    if (!row.expires_at) return true;
    const expiresAt = Date.parse(row.expires_at);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
  if (!invite) return { accepted: false, organizationId: null, teamId: null };

  const nowIso = new Date().toISOString();
  const organizationId = String((invite as any).organization_id);
  const teamId = (invite as any).team_id ? String((invite as any).team_id) : null;
  const invitedBy = (invite as any).invited_by ? String((invite as any).invited_by) : null;
  const role = (invite as any).role === "org_admin" ? "org_admin" : "member";

  const { error: membershipError } = await client.from("organization_memberships").upsert(
    {
      organization_id: organizationId,
      user_id: user.id,
      role,
      status: "active",
      invited_by: invitedBy,
      joined_at: nowIso,
      approved_at: nowIso,
      approved_by: invitedBy,
      source: "invite",
      team_id: teamId,
      updated_at: nowIso,
    },
    { onConflict: "organization_id,user_id" },
  );
  if (membershipError) throw new Error(`pending invite activation failed: ${membershipError.message}`);

  const { error: inviteUpdateError } = await client
    .from("organization_member_invites")
    .update({
      status: "accepted",
      accepted_by: user.id,
      accepted_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", (invite as any).id);
  if (inviteUpdateError) throw new Error(`pending invite accept failed: ${inviteUpdateError.message}`);

  const { error: profileError } = await client
    .from("profiles")
    .update({
      organization_id: organizationId,
      account_type: "org_user",
      updated_at: nowIso,
    })
    .eq("user_id", user.id);
  if (profileError) throw new Error(`profile org attach failed: ${profileError.message}`);

  const { error: activityError } = await client.from("workspace_activity").insert({
    user_id: user.id,
    organization_id: organizationId,
    class_id: teamId,
    activity_type: "enrollment",
    metadata: { source: "invite", via },
  });
  if (activityError) {
    console.warn("[orgInvite] activity insert skipped:", activityError.message);
  }

  return { accepted: true, organizationId, teamId };
}
